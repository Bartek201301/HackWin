// The lock file of the Gate (7.5 step 2): one Gate per clone, and so per project on the Lead's
// laptop (G2). The lock names the process that holds it; a lock whose process no longer runs was
// left by a crash and is replaced.
//
// A pid alone does not name a process for good: after a reboot, or once the pids wrap around, an
// unrelated process may get the pid of a Gate that crashed. So the lock also records by when its
// process had started, from the elapsed time that `ps` reports, and it counts as held only while
// a process with its pid runs that started no later than that. A restart then recovers with
// `hackwin gate` alone (scope change on #24, from the Lead's review of PR #52). Where `ps` gives
// no answer, and for a lock without that time, the pid alone decides.
//
// A lock appears in one step: the record is written to a temporary file first and then linked to
// the lock's name, which fails when a lock exists. So a reader never sees half a record.

import { randomBytes } from 'node:crypto'
import { link, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { exec } from '../../core/runtime/index.js'
import { parseJson, readText } from '../../core/state/index.js'
import { GATE_SCHEMA, isObject } from './state.js'

/**
 * @typedef {object} LockRecord
 * @property {number} schema
 * @property {number} pid The process of the Gate.
 * @property {string} started_at ISO 8601.
 * @property {string} token Tells this Gate's lock from a later one of the same process.
 * @property {string | null} [process_started_by] ISO 8601: the process had started by then, as
 *   `ps` reported when the lock was taken; null when `ps` gave no answer.
 */

/**
 * @typedef {{ acquired: true, record: LockRecord, replaced: LockRecord | null }
 *   | { acquired: false, holder: LockRecord | null }} LockResult
 *   `replaced` is the lock of a dead process that was replaced; `holder` the running Gate.
 */

/**
 * Take the lock for this process.
 * @param {string} file
 * @param {{ pid: number, now: Date }} owner
 * @returns {Promise<LockResult>}
 */
export async function acquireLock(file, { pid, now }) {
  await mkdir(dirname(file), { recursive: true })
  const started = await processStartedAt(pid)
  /** @type {LockRecord} */
  const record = {
    schema: GATE_SCHEMA,
    pid,
    started_at: now.toISOString(),
    token: randomBytes(8).toString('hex'),
    process_started_by: started === null ? null : new Date(started.latest).toISOString(),
  }
  const temporary = `${file}.${pid}.${record.token}.tmp`
  await writeFile(temporary, `${JSON.stringify(record)}\n`)
  try {
    /** @type {LockRecord | null} */
    let replaced = null
    // A second attempt follows the removal of a dead process's lock; a third, a lost race.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await link(temporary, file)
        return { acquired: true, record, replaced }
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
      }
      const holder = await readLock(file)
      if (holder !== null && (await holds(holder))) return { acquired: false, holder }
      // Left by a dead process, or not a lock record at all.
      await rm(file, { force: true })
      replaced = holder
    }
    return { acquired: false, holder: await readLock(file) }
  } finally {
    await rm(temporary, { force: true })
  }
}

/**
 * Remove the lock when it is still this Gate's own.
 * @param {string} file
 * @param {LockRecord} record
 * @returns {Promise<void>}
 */
export async function releaseLock(file, record) {
  const current = await readLock(file)
  if (current !== null && current.token === record.token) await rm(file, { force: true })
}

/**
 * The lock of the Gate running on this machine, or null when no Gate runs.
 * @param {string} file
 * @returns {Promise<LockRecord | null>}
 */
export async function runningGate(file) {
  const holder = await readLock(file)
  return holder !== null && (await holds(holder)) ? holder : null
}

/**
 * The lock record, or null when there is none or the file holds no lock record.
 * @param {string} file
 * @returns {Promise<LockRecord | null>}
 */
export async function readLock(file) {
  const text = await readText(file)
  const record = text === null ? null : parseJson(text)
  if (!isObject(record) || record.schema !== GATE_SCHEMA) return null
  if (!Number.isInteger(record.pid) || record.pid < 1) return null
  if (typeof record.token !== 'string' || typeof record.started_at !== 'string') return null
  return /** @type {LockRecord} */ (record)
}

/**
 * True while a process with this pid exists. A process of another user (EPERM) counts as
 * running: the lock is kept rather than taken from a Gate that may still run.
 * @param {number} pid
 * @returns {boolean}
 */
export function isRunning(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/**
 * True while the lock's process still holds it: a process with its pid runs, and it did not
 * start after the time the lock recorded. A process that started later got the pid of a Gate
 * that ended.
 * @param {LockRecord} record
 * @returns {Promise<boolean>}
 */
export async function holds(record) {
  if (!isRunning(record.pid)) return false
  const recorded = Date.parse(record.process_started_by ?? '')
  if (Number.isNaN(recorded)) return true
  const started = await processStartedAt(record.pid)
  return started === null || started.earliest <= recorded
}

/**
 * When a process started, from its elapsed time as `ps -o etime=` gives it (`[[dd-]hh:]mm:ss`,
 * on macOS and Linux): the earliest and the latest time it can have started, in milliseconds
 * since the epoch, or null when `ps` gives none. `ps` reports whole seconds and takes time to
 * answer, so the start lies between the two, also on a slow machine.
 * @param {number} pid
 * @returns {Promise<{ earliest: number, latest: number } | null>}
 */
export async function processStartedAt(pid) {
  const before = Date.now()
  try {
    const result = await exec('ps', ['-o', 'etime=', '-p', String(pid)], {
      env: { ...process.env, LC_ALL: 'C' },
      timeoutMs: 10_000,
    })
    const elapsed = result.code === 0 ? parseElapsed(result.stdout.trim()) : null
    if (elapsed === null) return null
    return { earliest: before - elapsed - 1000, latest: Date.now() - elapsed }
  } catch {
    return null
  }
}

/**
 * The milliseconds of an elapsed time of `ps`: `[[dd-]hh:]mm:ss`, or null for any other text.
 * @param {string} text
 * @returns {number | null}
 */
export function parseElapsed(text) {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(text)
  if (!match) return null
  const [days, hours, minutes, seconds] = match.slice(1).map((part) => Number(part ?? 0))
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000
}

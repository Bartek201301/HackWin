// The lock file of the Gate (7.5 step 2): one Gate per clone, and so per project on the Lead's
// laptop (G2). The lock names the process that holds it; a lock whose process no longer runs was
// left by a crash and is replaced.
//
// A lock appears in one step: the record is written to a temporary file first and then linked to
// the lock's name, which fails when a lock exists. So a reader never sees half a record.

import { randomBytes } from 'node:crypto'
import { link, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { GATE_SCHEMA, isObject, parseJson, readText } from './state.js'

/**
 * @typedef {object} LockRecord
 * @property {number} schema
 * @property {number} pid The process of the Gate.
 * @property {string} started_at ISO 8601.
 * @property {string} token Tells this Gate's lock from a later one of the same process.
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
  /** @type {LockRecord} */
  const record = {
    schema: GATE_SCHEMA,
    pid,
    started_at: now.toISOString(),
    token: randomBytes(8).toString('hex'),
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
      if (holder !== null && isRunning(holder.pid)) return { acquired: false, holder }
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
  return holder !== null && isRunning(holder.pid) ? holder : null
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

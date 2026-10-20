// One lock per fixture repository, so that two sessions never run on the same repository at the
// same time. The lock is a directory, created atomically, in the git common directory of the
// HackWin checkout, which every worktree and so every session of this machine shares.
//
// Only processes of this machine use that directory, so the process id decides whether a holder
// is alive; the host name is kept for the message only, because it changes with the network on
// macOS (#94: a lock of `MacBook-Air-Bartus.local` stayed held under `macbook-air-bartus.home`).
// A holder also records when its process started, so that an unrelated process that later gets
// the same process id does not keep the lock.

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** How long a lock directory without its holder file may exist before it counts as abandoned. */
const UNWRITTEN_HOLDER_MS = 30_000

/**
 * How far the start time read for a process id may lie from the one its holder recorded and still
 * be the same process: `ps` gives the elapsed time in whole seconds.
 */
const START_SLACK_MS = 5_000

/**
 * The directory of the harness's local state (locks and run logs): `hackwin-test/` in the git
 * common directory of this checkout, or in the temporary directory outside a checkout.
 * @returns {string}
 */
export function harnessStateDir() {
  /** @type {Record<string, string | undefined>} */
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value
  }
  try {
    const common = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      {
        cwd: REPO_ROOT,
        env: /** @type {NodeJS.ProcessEnv} */ (env),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim()
    return join(common, 'hackwin-test')
  } catch {
    return join(tmpdir(), 'hackwin-test')
  }
}

/**
 * @typedef {object} LockHolder
 * @property {number} pid
 * @property {string} host
 * @property {string} cwd
 * @property {string} since ISO 8601 time.
 * @property {string} [started] ISO 8601 time at which the holder's process started; holder
 *   files written before #94 have none.
 */

/**
 * @typedef {object} LockOptions
 * @property {string} [dir] The directory of the locks; `<harnessStateDir()>/locks` by default.
 * @property {number} [timeoutMs] How long to wait for another holder; 20 minutes by default.
 * @property {number} [pollMs] How often to look again while waiting.
 * @property {(holder: LockHolder | null) => void} [onWait] Called once, the first time the lock is
 *   found held by a live holder, before the timeout can end the wait.
 */

/**
 * Take the lock of a fixture repository. While another live process holds it, wait; a lock whose
 * holder process is gone is taken over. Taking a lock this process already holds is an error.
 * @param {string} name The repository name.
 * @param {LockOptions} [options]
 * @returns {Promise<() => void>} Releases the lock.
 */
export async function acquireLock(name, options = {}) {
  const dir = options.dir ?? join(harnessStateDir(), 'locks')
  const timeoutMs = options.timeoutMs ?? 20 * 60_000
  const pollMs = options.pollMs ?? 1000
  const path = join(dir, `${name}.lock`)
  /** @type {LockHolder} */
  const self = {
    pid: process.pid,
    host: hostname(),
    cwd: process.cwd(),
    since: '',
    started: ownStart(),
  }
  // The wait starts after ownStart(), whose ps call does not count against the timeout (#119).
  const deadline = Date.now() + timeoutMs
  let waiting = false
  mkdirSync(dir, { recursive: true })

  for (;;) {
    try {
      mkdirSync(path)
      self.since = new Date().toISOString()
      writeFileSync(join(path, 'holder.json'), `${JSON.stringify(self)}\n`)
      return () => releaseLock(path, self)
    } catch (error) {
      if (/** @type {any} */ (error).code !== 'EEXIST') throw error
    }
    const holder = readHolder(path)
    if (holder?.pid === process.pid && !startsDiffer(holder, Date.parse(self.started ?? ''))) {
      throw new Error(
        `this process already holds the lock of ${name}; withFixtureRepo calls on one repository do not nest`,
      )
    }
    if (isAbandoned(path, holder)) {
      // Look once more right before removing, so a lock taken over meanwhile stays.
      if (JSON.stringify(readHolder(path)) === JSON.stringify(holder)) {
        rmSync(path, { recursive: true, force: true })
      }
      continue
    }
    // The wait is reported before the deadline can end it, however long the round took (#119).
    if (!waiting) {
      waiting = true
      options.onWait?.(holder)
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `the fixture repository ${name} is still locked after ${Math.round(timeoutMs / 1000)} s by ${describeHolder(holder)}; the lock is ${path}`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

/**
 * @param {LockHolder | null} holder
 * @returns {string}
 */
export function describeHolder(holder) {
  if (!holder) return 'a process that has not written its holder file yet'
  return `process ${holder.pid} on ${holder.host}, started in ${holder.cwd} at ${holder.since}`
}

/**
 * @param {string} path
 * @param {LockHolder} self
 */
function releaseLock(path, self) {
  const holder = readHolder(path)
  if (holder && holder.pid === self.pid && holder.since === self.since) {
    rmSync(path, { recursive: true, force: true })
  }
}

/**
 * @param {string} path
 * @returns {LockHolder | null}
 */
function readHolder(path) {
  try {
    return JSON.parse(readFileSync(join(path, 'holder.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * True when the holder's process is gone, when its process id now belongs to a process that
 * started at another time, or when the holder file was never written. The host name does not
 * count (see the top of this file).
 * @param {string} path
 * @param {LockHolder | null} holder
 */
function isAbandoned(path, holder) {
  if (!holder) {
    try {
      return Date.now() - statSync(path).mtimeMs > UNWRITTEN_HOLDER_MS
    } catch {
      return true
    }
  }
  try {
    process.kill(holder.pid, 0)
  } catch (error) {
    return /** @type {any} */ (error).code === 'ESRCH'
  }
  // Without a recorded start there is nothing to compare, so ps is not asked (#119).
  if (typeof holder.started !== 'string') return false
  const now = processStart(holder.pid)
  return now !== null && startsDiffer(holder, now)
}

/**
 * When this process started, as ISO 8601, from the same source as the check of another holder
 * (`processStart`, the wall clock through `ps`), so that both sides of the comparison agree.
 * `process.uptime()` runs on a monotonic clock, which on macOS may not advance while the machine
 * sleeps (the Lead's review of PR #110); it is used only when `ps` cannot be read.
 * @returns {string}
 */
function ownStart() {
  const start = processStart(process.pid) ?? Date.now() - process.uptime() * 1000
  return new Date(start).toISOString()
}

/**
 * True when the holder recorded a start time and it lies more than START_SLACK_MS from `start`.
 * @param {LockHolder} holder
 * @param {number} start Milliseconds since the epoch.
 */
function startsDiffer(holder, start) {
  if (typeof holder.started !== 'string') return false
  const recorded = Date.parse(holder.started)
  if (Number.isNaN(recorded) || Number.isNaN(start)) return false
  return Math.abs(recorded - start) > START_SLACK_MS
}

/**
 * When the process with this id started, in milliseconds since the epoch, from the elapsed time
 * `ps -o etime=` prints (`[[dd-]hh:]mm:ss`, on macOS and Linux); null when it cannot be read.
 * @param {number} pid
 * @returns {number | null}
 */
export function processStart(pid) {
  try {
    const text = execFileSync('ps', ['-o', 'etime=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text)
    if (!match) return null
    const [, days, hours, minutes, seconds] = match
    const elapsed =
      ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds)
    return Date.now() - elapsed * 1000
  } catch {
    return null
  }
}

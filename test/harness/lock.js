// One lock per fixture repository, so that two sessions never run on the same repository at the
// same time. The lock is a directory, created atomically, in the git common directory of the
// HackWin checkout, which every worktree and so every session of this machine shares.

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** How long a lock directory without its holder file may exist before it counts as abandoned. */
const UNWRITTEN_HOLDER_MS = 30_000

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
 */

/**
 * @typedef {object} LockOptions
 * @property {string} [dir] The directory of the locks; `<harnessStateDir()>/locks` by default.
 * @property {number} [timeoutMs] How long to wait for another holder; 20 minutes by default.
 * @property {number} [pollMs] How often to look again while waiting.
 * @property {(holder: LockHolder | null) => void} [onWait] Called once when the lock is taken.
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
  const deadline = Date.now() + timeoutMs
  /** @type {LockHolder} */
  const self = { pid: process.pid, host: hostname(), cwd: process.cwd(), since: '' }
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
    if (holder?.pid === process.pid && holder.host === self.host) {
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
    if (Date.now() >= deadline) {
      throw new Error(
        `the fixture repository ${name} is still locked after ${Math.round(timeoutMs / 1000)} s by ${describeHolder(holder)}; the lock is ${path}`,
      )
    }
    if (!waiting) {
      waiting = true
      options.onWait?.(holder)
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
 * True when the holder's process is gone, or when the holder file was never written.
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
  if (holder.host !== hostname()) return false
  try {
    process.kill(holder.pid, 0)
    return false
  } catch (error) {
    return /** @type {any} */ (error).code === 'ESRCH'
  }
}

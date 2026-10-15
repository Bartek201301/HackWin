// The Gate's scratch worktree and its install cache (9.2 stage 7, A11). The merge test and the
// smoke test run in a detached worktree under `gate/worktrees/`, never in a checkout of the Lead.
// The Gate tests one pull request at a time (G17), so one path serves every run, and an install
// always lives at the same absolute path, whichever cache entry it comes from.
//
// The install cache is keyed by the hash of the lockfiles (`paths.lockfiles`) and the install
// command. After an install the Gate records what it added to the worktree: every untracked path,
// such as `node_modules/` for npm. When the worktree closes, those paths move into
// `gate/cache/<key>/`, and the next worktree with the same key gets them back by a move instead of
// an install. A move within one file system takes no time, whatever the size. Only an install
// that ended well is recorded, so the cache holds complete installs only; a worktree that a crash
// left behind gives back what it recorded when the next run clears it. Without a lockfile every
// run installs.

import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createMatcher } from '../../core/config/index.js'
import { runInstall } from '../../core/project/index.js'
import { parseJson, readText, writeAtomic } from './state.js'

/** @import { Config } from '../../core/config/index.js' */
/** @import { Git } from '../../core/git/index.js' */
/** @import { ProjectRun } from '../../core/project/index.js' */
/** @import { Gate } from './gate.js' */

/** The name of the scratch worktree under `gate/worktrees/`. */
const SCRATCH = 'scratch'

/** How many installs the cache keeps; the one used longest ago goes first. */
const CACHE_ENTRIES = 3

/** The identity of the merge commit of the merge test, which never leaves the Lead's clone. */
const MERGE_IDENTITY = Object.freeze({
  GIT_AUTHOR_NAME: 'HackWin Gate',
  GIT_AUTHOR_EMAIL: 'gate@hackwin.invalid',
  GIT_COMMITTER_NAME: 'HackWin Gate',
  GIT_COMMITTER_EMAIL: 'gate@hackwin.invalid',
})

/** Variables that hold a GitHub token, which the project's commands never get (A38). */
const TOKEN_VARIABLES = Object.freeze([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
])

/**
 * @typedef {object} Scratch
 * @property {string} path The worktree.
 * @property {Git} git Git in the worktree, with the member hooks off and the identity of the
 *   Gate's merge commit.
 */

/**
 * What a worktree borrowed from the cache or recorded after its install.
 * @typedef {object} Lent
 * @property {number} schema
 * @property {string} key
 * @property {string[]} entries Paths relative to the worktree.
 */

/**
 * @typedef {object} InstallResult
 * @property {boolean} ok
 * @property {ProjectRun | null} run The install that ran; null for a cached or skipped one.
 * @property {boolean} cached The install came from the cache.
 * @property {string | null} notice Why nothing was installed, when nothing was.
 */

/**
 * The environment of the project's commands: the Gate's own, without GitHub tokens. The commands
 * run the code of a pull request, and `commands.check` must pass without secrets (A38).
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string | undefined>}
 */
export function projectEnv(env) {
  const result = { ...env }
  for (const name of TOKEN_VARIABLES) delete result[name]
  return result
}

/**
 * Open the scratch worktree at a commit, detached, after clearing what an earlier run left.
 * @param {Gate} gate
 * @param {string} commit A full SHA.
 * @returns {Promise<Scratch>}
 */
export async function openScratch(gate, commit) {
  await closeScratch(gate)
  const path = join(gate.files.worktrees, SCRATCH)
  await mkdir(gate.files.worktrees, { recursive: true })
  await gate.git.worktreeAdd(path, { detach: true, startPoint: commit })
  const env = { ...(gate.git.options.env ?? process.env), ...MERGE_IDENTITY }
  return { path, git: gate.git.with({ cwd: path, env }) }
}

/**
 * Give what the scratch worktree borrowed back to the cache and remove the worktree. Nothing
 * happens when there is none.
 * @param {Gate} gate
 * @returns {Promise<void>}
 */
export async function closeScratch(gate) {
  const path = join(gate.files.worktrees, SCRATCH)
  const record = lentFile(gate)
  const lent = /** @type {Lent | null} */ (parseJson((await readText(record)) ?? ''))
  if (lent !== null && lent.schema === 1 && (await exists(path))) {
    try {
      await giveBack(gate, path, lent)
    } catch (error) {
      gate.line(
        `the install of the scratch worktree did not go back to the cache, the next run installs again: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  await rm(record, { force: true })
  await gate.git.run(['worktree', 'remove', '--force', path], { allowFailure: true })
  await rm(path, { recursive: true, force: true })
  await gate.git.run(['worktree', 'prune'], { allowFailure: true })
}

/**
 * Install the dependencies in the scratch worktree: from the cache when an install of the same
 * key is there (A11), else with `commands.install`, which is skipped while no manifest exists
 * (A62).
 * @param {Gate} gate
 * @param {Scratch} scratch
 * @param {{ config: Config, timeoutMs: number, logFile: string, env: Record<string, string | undefined> }} options
 * @returns {Promise<InstallResult>}
 */
export async function installInScratch(gate, scratch, { config, timeoutMs, logFile, env }) {
  const key = await installKey(scratch, config)
  if (key !== null && (await borrow(gate, scratch.path, key))) {
    return { ok: true, run: null, cached: true, notice: null }
  }
  const run = await runInstall({ cwd: scratch.path, config, timeoutMs, logFile, env })
  if ('skipped' in run) return { ok: true, run: null, cached: false, notice: run.notice }
  if (!run.ok || key === null) return { ok: run.ok, run, cached: false, notice: null }
  const listing = await scratch.git.run(['ls-files', '-z', '--others', '--directory'])
  const entries = listing.stdout
    .split('\0')
    .filter(Boolean)
    .map((entry) => entry.replace(/\/$/, ''))
  // An install that left nothing in the worktree has nothing to keep.
  if (entries.length > 0) await writeLent(gate, { schema: 1, key, entries })
  return { ok: true, run, cached: false, notice: null }
}

/**
 * The cache key of a worktree: the hash of the install command and of every tracked lockfile,
 * or null when it has none.
 * @param {Scratch} scratch
 * @param {Config} config
 * @returns {Promise<string | null>}
 */
async function installKey(scratch, config) {
  const isLockfile = createMatcher(config.hackwin.paths.lockfiles ?? [])
  const tracked = await scratch.git.run(['ls-files', '-z'])
  const lockfiles = tracked.stdout
    .split('\0')
    .filter((path) => path !== '' && isLockfile(path))
    .sort()
  if (lockfiles.length === 0) return null
  const hash = createHash('sha256').update(`${config.hackwin.commands.install}\0`)
  for (const path of lockfiles) {
    hash.update(`${path}\0`)
    hash.update(await readFile(join(scratch.path, path)))
    hash.update('\0')
  }
  return hash.digest('hex').slice(0, 32)
}

/**
 * Move a cached install into the worktree. False when the cache has no complete install of this
 * key, or when it cannot be moved; the worktree then installs, and the entry is dropped.
 * @param {Gate} gate
 * @param {string} path
 * @param {string} key
 * @returns {Promise<boolean>}
 */
async function borrow(gate, path, key) {
  const entry = join(gate.files.cache, key)
  const stored = /** @type {Lent | null} */ (
    parseJson((await readText(join(entry, 'entries.json'))) ?? '')
  )
  if (stored === null || !Array.isArray(stored.entries)) return false
  for (const name of stored.entries) {
    if (!(await exists(join(entry, 'files', name)))) return false
  }
  /** @type {string[]} */
  const moved = []
  try {
    for (const name of stored.entries) {
      if (await exists(join(path, name))) throw new Error(`${name} exists in the worktree`)
      await mkdir(dirname(join(path, name)), { recursive: true })
      await rename(join(entry, 'files', name), join(path, name))
      moved.push(name)
    }
  } catch (error) {
    for (const name of moved) await rm(join(path, name), { recursive: true, force: true })
    await rm(entry, { recursive: true, force: true })
    gate.line(
      `the cached install ${key} could not be moved into the scratch worktree, so the Gate installs: ${error instanceof Error ? error.message : String(error)}`,
    )
    return false
  }
  await writeLent(gate, { schema: 1, key, entries: stored.entries })
  await writeAtomic(
    join(entry, 'entries.json'),
    `${JSON.stringify({ ...stored, used_at: gate.ctx.clock.now().toISOString() })}\n`,
  )
  return true
}

/**
 * Move what the worktree recorded into the cache, unless the cache already holds that key, and
 * keep at most CACHE_ENTRIES installs.
 * @param {Gate} gate
 * @param {string} path
 * @param {Lent} lent
 * @returns {Promise<void>}
 */
async function giveBack(gate, path, lent) {
  const entry = join(gate.files.cache, lent.key)
  const files = join(entry, 'files')
  if (await exists(entry)) {
    const stored = parseJson((await readText(join(entry, 'entries.json'))) ?? '')
    const complete = stored !== null && (await allExist(files, lent.entries))
    if (complete) return
    await rm(entry, { recursive: true, force: true })
  }
  for (const name of lent.entries) {
    if (!(await exists(join(path, name)))) return
  }
  for (const name of lent.entries) {
    await mkdir(dirname(join(files, name)), { recursive: true })
    await rename(join(path, name), join(files, name))
  }
  await writeAtomic(
    join(entry, 'entries.json'),
    `${JSON.stringify({ schema: 1, key: lent.key, entries: lent.entries, used_at: gate.ctx.clock.now().toISOString() })}\n`,
  )
  await prune(gate)
}

/**
 * Keep the CACHE_ENTRIES installs used last.
 * @param {Gate} gate
 * @returns {Promise<void>}
 */
async function prune(gate) {
  /** @type {Array<{ key: string, usedAt: number }>} */
  const entries = []
  for (const key of await readdir(gate.files.cache).catch(() => [])) {
    const stored = parseJson((await readText(join(gate.files.cache, key, 'entries.json'))) ?? '')
    const usedAt = Date.parse(/** @type {any} */ (stored)?.used_at ?? '')
    entries.push({ key, usedAt: Number.isNaN(usedAt) ? 0 : usedAt })
  }
  entries.sort((a, b) => b.usedAt - a.usedAt)
  for (const { key } of entries.slice(CACHE_ENTRIES)) {
    await rm(join(gate.files.cache, key), { recursive: true, force: true })
  }
}

/** @param {Gate} gate */
function lentFile(gate) {
  return join(gate.files.worktrees, `${SCRATCH}.install.json`)
}

/**
 * @param {Gate} gate
 * @param {Lent} lent
 */
async function writeLent(gate, lent) {
  await writeAtomic(lentFile(gate), `${JSON.stringify(lent)}\n`)
}

/**
 * @param {string} root
 * @param {string[]} names
 */
async function allExist(root, names) {
  for (const name of names) if (!(await exists(join(root, name)))) return false
  return true
}

/** @param {string} path */
async function exists(path) {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

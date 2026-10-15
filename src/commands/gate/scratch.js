// The Gate's scratch worktree, its install cache and the environment of the project's commands
// (9.2 stages 7 and 11, A11). The merge test and the smoke test run in a detached worktree under
// `gate/worktrees/`, never in a checkout of the Lead. The Gate tests one pull request at a time
// (G17), so one path serves every run, and an install always lives at the same absolute path.
//
// The install cache is keyed by the hash of the install command, the lockfiles
// (`paths.lockfiles`) and the manifests (`paths.manifests`) of a tree. It holds only installs made
// on main itself: right after such an install, before any other command runs, the Gate copies
// what it added to the worktree (every untracked path, such as `node_modules/`) into
// `gate/cache/<key>/`. A merge test whose tree has main's key, or a smoke test on main, gets a
// copy of that install; every other tree installs, and its install is never kept. The worktree,
// with whatever its commands changed, is removed after each run, so no run starts from files that
// the commands of a pull request changed. A copy clones the files where the file system can.
//
// The project's commands run code of a pull request on the Lead's laptop, under the account that
// merges. They get an environment as CI gives one, without credentials (A38): only the variables
// of KEPT_VARIABLES, a home of the Gate's own (`gate/home/`), so that gh finds no login and npm no
// `.npmrc` of the Lead, and git without the system and global configuration, so without a
// credential helper, and without SSH. This is no sandbox: the commands still run as the Lead's
// user and can read the Lead's files by their paths.

import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { cp, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createMatcher } from '../../core/config/index.js'
import { runInstall } from '../../core/project/index.js'
import { parseJson, readText, writeAtomic } from '../../core/state/index.js'

/** @import { Config } from '../../core/config/index.js' */
/** @import { Git } from '../../core/git/index.js' */
/** @import { ProjectRun } from '../../core/project/index.js' */
/** @import { Gate } from './gate.js' */

/** The name of the scratch worktree under `gate/worktrees/`. */
const SCRATCH = 'scratch'

/** How many installs the cache keeps; the one used longest ago goes first. */
const CACHE_ENTRIES = 3

/** The identity of the commits the Gate's merge test and the project's commands make. */
const GATE_IDENTITY = Object.freeze({ name: 'HackWin Gate', email: 'gate@hackwin.invalid' })

/** The variables of the Lead's environment that the project's commands get. */
const KEPT_VARIABLES = Object.freeze([
  'PATH',
  'LANG',
  'LANGUAGE',
  'TZ',
  'TERM',
  'COLORTERM',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SHELL',
  'USER',
  'LOGNAME',
  // Where version managers keep the tools on PATH; no credential.
  'NVM_DIR',
  'NVM_BIN',
  'NVM_INC',
  'VOLTA_HOME',
  'ASDF_DIR',
  'ASDF_DATA_DIR',
  'MISE_DATA_DIR',
  'FNM_DIR',
  'N_PREFIX',
  'PNPM_HOME',
  'BUN_INSTALL',
  'COREPACK_HOME',
])

/**
 * @typedef {object} Scratch
 * @property {string} path The worktree.
 * @property {Git} git Git in the worktree, with the member hooks off and the Gate's identity.
 */

/**
 * @typedef {object} InstallResult
 * @property {boolean} ok
 * @property {ProjectRun | null} run The install that ran; null for a cached or skipped one.
 * @property {boolean} cached The install is a copy of a cached one.
 * @property {string | null} notice Why nothing was installed, when nothing was.
 */

/**
 * The environment of the project's commands, as CI gives one (A38): the variables of
 * KEPT_VARIABLES and `LC_*`, the Gate's own home, and git without the system and global
 * configuration and without SSH. It holds no token and no SSH agent of the Lead.
 * @param {Gate} gate
 * @returns {Promise<Record<string, string>>}
 */
export async function projectEnv(gate) {
  const home = join(gate.files.root, 'home')
  const config = join(home, '.config')
  await mkdir(join(config, 'gh'), { recursive: true })
  const gitconfig = join(home, '.gitconfig')
  if ((await readText(gitconfig)) === null) {
    await writeFile(
      gitconfig,
      `[user]\n\tname = ${GATE_IDENTITY.name}\n\temail = ${GATE_IDENTITY.email}\n`,
    )
  }
  /** @type {Record<string, string>} */
  const env = {}
  for (const [name, value] of Object.entries(gate.ctx.env)) {
    if (value === undefined) continue
    if (KEPT_VARIABLES.includes(name) || name.startsWith('LC_')) env[name] = value
  }
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    GH_CONFIG_DIR: join(config, 'gh'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: 'false',
  }
}

/**
 * Open the scratch worktree at a commit, detached, after removing what an earlier run left.
 * @param {Gate} gate
 * @param {string} commit A full SHA.
 * @returns {Promise<Scratch>}
 */
export async function openScratch(gate, commit) {
  await closeScratch(gate)
  const path = join(gate.files.worktrees, SCRATCH)
  await mkdir(gate.files.worktrees, { recursive: true })
  await gate.git.worktreeAdd(path, { detach: true, startPoint: commit })
  const env = {
    ...(gate.git.options.env ?? process.env),
    GIT_AUTHOR_NAME: GATE_IDENTITY.name,
    GIT_AUTHOR_EMAIL: GATE_IDENTITY.email,
    GIT_COMMITTER_NAME: GATE_IDENTITY.name,
    GIT_COMMITTER_EMAIL: GATE_IDENTITY.email,
  }
  return { path, git: gate.git.with({ cwd: path, env }) }
}

/**
 * Remove the scratch worktree with everything in it. Nothing happens when there is none.
 * @param {Gate} gate
 * @returns {Promise<void>}
 */
export async function closeScratch(gate) {
  const path = join(gate.files.worktrees, SCRATCH)
  await gate.git.run(['worktree', 'remove', '--force', path], { allowFailure: true })
  await rm(path, { recursive: true, force: true })
  await gate.git.run(['worktree', 'prune'], { allowFailure: true })
}

/**
 * At a start, remove what a Gate that stopped during a run left: the scratch worktree, which the
 * next merge test or smoke test builds again (7.5 step 5), and the half made copies in the
 * install cache.
 * @param {Gate} gate
 * @returns {Promise<boolean>} True when a scratch worktree was there.
 */
export async function recoverScratch(gate) {
  const path = join(gate.files.worktrees, SCRATCH)
  const listed = (await gate.git.worktreeList()).some((worktree) => worktree.path === path)
  const left = listed || (await readdir(path).catch(() => null)) !== null
  await closeScratch(gate)
  await prune(gate)
  return left
}

/**
 * The cache key of a tree: the hash of the install command and of its lockfiles and manifests, or
 * null when it has no lockfile, which leaves nothing to key an install by.
 * @param {Git} git
 * @param {string} tree A commit or tree.
 * @param {Config} config
 * @returns {Promise<string | null>}
 */
export async function installKey(git, tree, config) {
  const { lockfiles = [], manifests = [] } = config.hackwin.paths
  const isLockfile = createMatcher(lockfiles)
  const isInput = createMatcher([...lockfiles, ...manifests])
  const listing = await git.run(['ls-tree', '-r', '-z', '--name-only', tree])
  const paths = listing.stdout.split('\0').filter(Boolean)
  if (!paths.some((path) => isLockfile(path))) return null
  const hash = createHash('sha256').update(`${config.hackwin.commands.install}\0`)
  for (const path of paths.filter((each) => isInput(each)).sort()) {
    const blob = await git.run(['rev-parse', `${tree}:${path}`])
    hash.update(`${path}\0${blob.stdout.trim()}\0`)
  }
  return hash.digest('hex').slice(0, 32)
}

/**
 * True when the cache holds a complete install of this key.
 * @param {Gate} gate
 * @param {string} key
 * @returns {Promise<boolean>}
 */
export async function isCached(gate, key) {
  return (await storedEntries(gate, key)) !== null
}

/**
 * Install the dependencies in the scratch worktree. With `key`, a cached install of that key is
 * copied in when there is one (A11); otherwise `commands.install` runs, skipped while no manifest
 * exists (A62). With `store`, for a worktree of main alone, a fresh install is copied into the
 * cache under `key` before anything else runs in the worktree.
 * @param {Gate} gate
 * @param {Scratch} scratch
 * @param {{ config: Config, key: string | null, store: boolean, timeoutMs: number, logFile: string, env: Record<string, string> }} options
 * @returns {Promise<InstallResult>}
 */
export async function installInScratch(gate, scratch, options) {
  const { config, key, store, timeoutMs, logFile, env } = options
  if (key !== null && (await copyIn(gate, scratch.path, key))) {
    return { ok: true, run: null, cached: true, notice: null }
  }
  const run = await runInstall({ cwd: scratch.path, config, timeoutMs, logFile, env })
  if ('skipped' in run) return { ok: true, run: null, cached: false, notice: run.notice }
  if (run.ok && store && key !== null) await copyOut(gate, scratch, key)
  return { ok: run.ok, run, cached: false, notice: null }
}

/**
 * The paths of a complete cached install, or null.
 * @param {Gate} gate
 * @param {string} key
 * @returns {Promise<string[] | null>}
 */
async function storedEntries(gate, key) {
  const stored = parseJson((await readText(join(gate.files.cache, key, 'entries.json'))) ?? '')
  const entries = /** @type {any} */ (stored)?.entries
  return Array.isArray(entries) ? entries : null
}

/**
 * Copy a cached install into the worktree. False when the cache has none of this key, or when
 * the copy fails; the entry is then dropped, and the worktree installs.
 * @param {Gate} gate
 * @param {string} path
 * @param {string} key
 * @returns {Promise<boolean>}
 */
async function copyIn(gate, path, key) {
  const entries = await storedEntries(gate, key)
  if (entries === null) return false
  const entry = join(gate.files.cache, key)
  try {
    for (const name of entries) await copy(join(entry, 'files', name), join(path, name))
  } catch (error) {
    for (const name of entries) await rm(join(path, name), { recursive: true, force: true })
    await rm(entry, { recursive: true, force: true })
    gate.line(
      `the cached install ${key} could not be copied into the scratch worktree, so the Gate installs: ${error instanceof Error ? error.message : String(error)}`,
    )
    return false
  }
  await writeEntries(join(entry, 'entries.json'), gate, key, entries)
  return true
}

/**
 * Copy what an install on main added to the worktree into the cache, unless the cache holds that
 * key already, and keep at most CACHE_ENTRIES installs. The entry appears complete or not at all.
 * @param {Gate} gate
 * @param {Scratch} scratch
 * @param {string} key
 * @returns {Promise<void>}
 */
async function copyOut(gate, scratch, key) {
  if (await isCached(gate, key)) return
  const listing = await scratch.git.run(['ls-files', '-z', '--others', '--directory'])
  const entries = listing.stdout
    .split('\0')
    .filter(Boolean)
    .map((name) => name.replace(/\/$/, ''))
  // An install that left nothing in the worktree has nothing to keep.
  if (entries.length === 0) return
  const building = join(gate.files.cache, `.${key}.${randomBytes(6).toString('hex')}`)
  try {
    for (const name of entries) await copy(join(scratch.path, name), join(building, 'files', name))
    await writeEntries(join(building, 'entries.json'), gate, key, entries)
    await rm(join(gate.files.cache, key), { recursive: true, force: true })
    await rename(building, join(gate.files.cache, key))
  } catch (error) {
    gate.line(
      `the install on main was not kept in the cache, the next run installs again: ${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    await rm(building, { recursive: true, force: true })
  }
  await prune(gate)
}

/**
 * Copy a file or directory, cloning where the file system can, and keeping symbolic links as
 * they are.
 * @param {string} from
 * @param {string} to
 * @returns {Promise<void>}
 */
async function copy(from, to) {
  await cp(from, to, {
    recursive: true,
    verbatimSymlinks: true,
    errorOnExist: true,
    force: false,
    mode: constants.COPYFILE_FICLONE,
  })
}

/**
 * @param {string} file
 * @param {Gate} gate
 * @param {string} key
 * @param {string[]} entries
 */
async function writeEntries(file, gate, key, entries) {
  const usedAt = gate.ctx.clock.now().toISOString()
  await writeAtomic(file, `${JSON.stringify({ schema: 1, key, entries, used_at: usedAt })}\n`)
}

/**
 * Keep the CACHE_ENTRIES installs used last, and nothing that a copy left half done.
 * @param {Gate} gate
 * @returns {Promise<void>}
 */
async function prune(gate) {
  /** @type {Array<{ key: string, usedAt: number }>} */
  const entries = []
  for (const name of await readdir(gate.files.cache).catch(() => [])) {
    // A copy under way has a name that starts with a dot; only a crash leaves one behind.
    if (name.startsWith('.')) {
      await rm(join(gate.files.cache, name), { recursive: true, force: true })
      continue
    }
    const stored = parseJson((await readText(join(gate.files.cache, name, 'entries.json'))) ?? '')
    const usedAt = Date.parse(/** @type {any} */ (stored)?.used_at ?? '')
    entries.push({ key: name, usedAt: Number.isNaN(usedAt) ? 0 : usedAt })
  }
  entries.sort((a, b) => b.usedAt - a.usedAt)
  for (const { key } of entries.slice(CACHE_ENTRIES)) {
    await rm(join(gate.files.cache, key), { recursive: true, force: true })
  }
}

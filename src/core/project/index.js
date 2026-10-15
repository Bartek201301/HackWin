// The project's own commands from hackwin.yml, as join, take, ship, CI and the Gate run them:
// install (skipped while no manifest exists, A62), the full check, the acceptance tests (T5), the
// format check of the changed files only (E14) and the generated file check (E10). Each run has a
// timeout and returns its exit status and the last lines of its log. See
// docs/build/contracts.md, section 4.9.

import { mkdirSync } from 'node:fs'
import { lstat, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import picomatch from 'picomatch'
import { createGit } from '../git/index.js'
import { ConfigError } from '../runtime/errors.js'
import { execShell, quoteShellArg } from '../runtime/exec.js'

/** @import { Config } from '../config/index.js' */
/** @import { Git } from '../git/index.js' */

/** The timeout of a project command when the caller names none: 20 minutes, as `gate.step_timeout_minutes` (6.3). */
export const PROJECT_TIMEOUT_MS = 20 * 60 * 1000

/**
 * The result of one project command.
 * @typedef {object} ProjectRun
 * @property {boolean} ok True when the command exited 0 within its timeout.
 * @property {string} command The command line that ran, with the appended files.
 * @property {number | null} code The exit code; null when a signal ended it.
 * @property {boolean} timedOut
 * @property {string[]} tail The last lines of the output.
 * @property {number} durationMs
 * @property {string | null} logFile The file with the whole output, when the caller named one.
 */

/**
 * The environment of every process a run starts, the project command and git alike: the whole
 * environment of the child, `process.env` by default. A caller that must keep a variable from the
 * project's code, such as the token of a CI run, passes an environment without it.
 * @typedef {Record<string, string | undefined>} ProjectEnv
 */

/**
 * @typedef {object} RunOptions
 * @property {string} cwd The top-level directory of the checkout or worktree to run in.
 * @property {Config} config
 * @property {number} [timeoutMs] PROJECT_TIMEOUT_MS by default.
 * @property {string} [logFile] Receives the whole output; its directory is created.
 * @property {ProjectEnv} [env] The environment of the command and of git; `process.env` by
 *   default.
 */

/**
 * Run `commands.install`. While no file of the checkout matches `paths.manifests`, as in an empty
 * repository before the foundation, nothing runs and the result is a notice (A62).
 * @param {RunOptions} options
 * @returns {Promise<ProjectRun | { skipped: true, notice: string }>}
 */
export async function runInstall({ cwd, config, timeoutMs, logFile, env }) {
  const install = projectCommand(config, 'install')
  const manifests = config.hackwin.paths?.manifests ?? []
  if (!(await hasManifest(cwd, manifests, env))) {
    const globs = manifests.length === 0 ? 'it is empty' : manifests.join(', ')
    return {
      skipped: true,
      notice: `install skipped: no file matches paths.manifests (${globs})`,
    }
  }
  return runCommand(install, { cwd, timeoutMs, logFile, env })
}

/**
 * Run `commands.check`, the full check.
 * @param {RunOptions} options
 * @returns {Promise<ProjectRun>}
 */
export async function runCheck({ cwd, config, timeoutMs, logFile, env }) {
  return runCommand(projectCommand(config, 'check'), { cwd, timeoutMs, logFile, env })
}

/**
 * Run the task's acceptance tests with `commands.test`. Every entry is a file path from the
 * top-level directory; an entry that is not an existing file of the checkout fails before
 * anything runs, also when it looks like a test id (T5). Without entries nothing runs.
 * @param {RunOptions & { files: string[] }} options `files` is the task's `acceptance_tests`.
 * @returns {Promise<{ ok: boolean, missing: string[], run: ProjectRun | null }>}
 */
export async function runAcceptanceTests({ cwd, config, files, timeoutMs, logFile, env }) {
  const entries = files ?? []
  /** @type {string[]} */
  const missing = []
  for (const entry of entries) {
    if (!(await isFileInside(cwd, entry))) missing.push(entry)
  }
  if (missing.length > 0) return { ok: false, missing, run: null }
  if (entries.length === 0) return { ok: true, missing, run: null }
  const command = withFiles(projectCommand(config, 'test'), entries)
  const run = await runCommand(command, { cwd, timeoutMs, logFile, env })
  return { ok: run.ok, missing, run }
}

/**
 * The format check of the changed files only (E14): runs `commands.format` on them and compares
 * each file before and after. Every file the formatter changed is unformatted; its original
 * content is restored, so the check never changes the checkout. A file that no longer exists,
 * such as a deleted one, is not checked.
 * @param {{ cwd: string, config: Config, files: string[], env?: ProjectEnv }} options
 * @returns {Promise<{ ok: boolean, unformatted: string[], run: ProjectRun | null }>}
 */
export async function formatCheck({ cwd, config, files, env }) {
  const format = projectCommand(config, 'format')
  /** @type {Map<string, Buffer>} */
  const before = new Map()
  for (const path of new Set(files ?? [])) {
    const content = await fileContent(cwd, path)
    if (content !== null) before.set(path, content)
  }
  if (before.size === 0) return { ok: true, unformatted: [], run: null }

  /** @type {string[]} */
  const unformatted = []
  /** @type {ProjectRun} */
  let run
  try {
    run = await runCommand(withFiles(format, [...before.keys()]), { cwd, env })
  } finally {
    for (const [path, content] of before) {
      const after = await fileContent(cwd, path)
      if (after !== null && after.equals(content)) continue
      unformatted.push(path)
      await writeFile(resolve(cwd, path), content)
    }
  }
  return { ok: run.ok && unformatted.length === 0, unformatted, run }
}

/**
 * The generated file check (E10): runs `commands.generate` and fails when it changes a tracked
 * file. Changes that were in the checkout before the run do not count. Every tracked file the
 * command changed is restored. `ok` without a run when `commands.generate` is null.
 * @param {{ cwd: string, config: Config, git: Git, env?: ProjectEnv }} options `git` may run in
 *   any worktree of the clone; the check runs in `cwd`. With `env`, its git calls run with `env`
 *   in place of the environment of `git`.
 * @returns {Promise<{ ok: boolean, changed: string[], run: ProjectRun | null }>}
 */
export async function generatedFileCheck({ cwd, config, git, env }) {
  const generate = config.hackwin.commands?.generate ?? null
  if (generate === null) return { ok: true, changed: [], run: null }
  if (typeof generate !== 'string' || generate.trim() === '') {
    throw new ConfigError('commands.generate must be a command or null', {
      key: 'commands.generate',
    })
  }
  const repo = git.with(env === undefined ? { cwd } : { cwd, env })
  const before = await trackedChanges(repo, cwd)

  /** @type {string[]} */
  const changed = []
  /** @type {ProjectRun} */
  let run
  try {
    run = await runCommand(generate, { cwd, env })
  } finally {
    const after = await trackedChanges(repo, cwd)
    /** @type {string[]} */
    const fromHead = []
    for (const path of new Set([...before.keys(), ...after.keys()])) {
      const old = before.get(path)
      const now = after.get(path)
      if (old !== undefined && now !== undefined && sameContent(old, now)) continue
      changed.push(path)
      if (old === undefined) fromHead.push(path)
      else await restore(cwd, path, old)
    }
    if (fromHead.length > 0) {
      await repo.run(['restore', '--source=HEAD', '--worktree', '--', ...fromHead])
    }
  }
  changed.sort()
  return { ok: run.ok && changed.length === 0, changed, run }
}

// Helpers.

/**
 * A required command of hackwin.yml. A missing one is a ConfigError naming its key.
 * @param {Config} config
 * @param {'install' | 'check' | 'test' | 'format'} name
 * @returns {string}
 */
function projectCommand(config, name) {
  const command = config?.hackwin?.commands?.[name]
  if (typeof command !== 'string' || command.trim() === '') {
    throw new ConfigError(`commands.${name} is empty`, { key: `commands.${name}` })
  }
  return command
}

/**
 * @param {string} command
 * @param {string[]} files
 * @returns {string}
 */
function withFiles(command, files) {
  return [command, ...files.map(quoteShellArg)].join(' ')
}

/**
 * @param {string} command
 * @param {{ cwd: string, timeoutMs?: number, logFile?: string, env?: ProjectEnv }} options
 * @returns {Promise<ProjectRun>}
 */
async function runCommand(command, { cwd, timeoutMs = PROJECT_TIMEOUT_MS, logFile, env }) {
  if (logFile) mkdirSync(dirname(logFile), { recursive: true })
  const result = await execShell(command, { cwd, timeoutMs, logFile, env })
  return {
    ok: result.code === 0 && !result.timedOut,
    command,
    code: result.code,
    timedOut: result.timedOut,
    tail: result.tail,
    durationMs: result.durationMs,
    logFile: logFile ?? null,
  }
}

/**
 * True when a tracked or untracked, not ignored file of the checkout matches one of the globs.
 * @param {string} cwd
 * @param {string[]} globs
 * @param {ProjectEnv} [env] The environment of git; `process.env` by default.
 * @returns {Promise<boolean>}
 */
async function hasManifest(cwd, globs, env) {
  if (globs.length === 0) return false
  const isManifest = picomatch(globs, { dot: true })
  const listing = await createGit({ cwd, env }).run([
    'ls-files',
    '-z',
    '--cached',
    '--others',
    '--exclude-standard',
  ])
  return listing.stdout.split('\0').some((path) => path !== '' && isManifest(path))
}

/**
 * True when `entry` names an existing file inside the checkout.
 * @param {string} cwd
 * @param {unknown} entry
 * @returns {Promise<boolean>}
 */
async function isFileInside(cwd, entry) {
  if (typeof entry !== 'string' || entry === '' || isAbsolute(entry)) return false
  const path = resolve(cwd, entry)
  const inside = relative(resolve(cwd), path)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return false
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * The content of a regular file of the checkout, or null when it is missing or not a regular
 * file (a directory, a symbolic link).
 * @param {string} cwd
 * @param {string} path
 * @returns {Promise<Buffer | null>}
 */
async function fileContent(cwd, path) {
  const file = resolve(cwd, path)
  try {
    if (!(await lstat(file)).isFile()) return null
    return await readFile(file)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
    throw error
  }
}

/**
 * What a tracked path holds in the working tree: its content, `absent` or `other` (not a
 * regular file, such as a submodule or a symbolic link).
 * @typedef {Buffer | 'absent' | 'other'} PathState
 */

/**
 * The tracked paths whose working tree differs from HEAD, with what each holds.
 * @param {Git} git
 * @param {string} cwd
 * @returns {Promise<Map<string, PathState>>}
 */
async function trackedChanges(git, cwd) {
  /** @type {Map<string, PathState>} */
  const states = new Map()
  for (const file of await git.changedFiles({ base: 'HEAD' })) {
    for (const path of [file.path, file.oldPath]) {
      if (path !== null && !states.has(path)) states.set(path, await pathState(cwd, path))
    }
  }
  return states
}

/**
 * @param {string} cwd
 * @param {string} path
 * @returns {Promise<PathState>}
 */
async function pathState(cwd, path) {
  const file = resolve(cwd, path)
  try {
    return (await lstat(file)).isFile() ? await readFile(file) : 'other'
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return 'absent'
    throw error
  }
}

/**
 * @param {PathState} a
 * @param {PathState} b
 * @returns {boolean}
 */
function sameContent(a, b) {
  if (Buffer.isBuffer(a) && Buffer.isBuffer(b)) return a.equals(b)
  return a === b
}

/**
 * Put a path back to what it held before the run.
 * @param {string} cwd
 * @param {string} path
 * @param {PathState} state
 * @returns {Promise<void>}
 */
async function restore(cwd, path, state) {
  const file = resolve(cwd, path)
  if (state === 'other') return
  if (state === 'absent') {
    await rm(file, { force: true })
    return
  }
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, state)
}

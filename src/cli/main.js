// The runner: parses the command line, builds the context, loads the command module lazily,
// runs it, and maps the result or the error to output and an exit code (CM2, CM6).

import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  ConfigError,
  EXIT,
  HackwinError,
  NotBuiltError,
  PreconditionError,
  UsageError,
  exitCodeOf,
} from '../core/runtime/errors.js'
import { createOutput, formatError, runIn } from '../core/runtime/output.js'
import { systemClock } from '../core/runtime/clock.js'
import {
  checkVersion,
  fastForwardMainCheckout,
  installCommand,
  loadConfig,
  resolveIdentity,
} from '../core/config/index.js'
import { HACKWIN_FILE, pinnedVersionOf } from '../core/config/load.js'
import { phaseOf } from '../core/config/version.js'
import { COMMANDS, resolveCommand } from './registry.js'
import { PACKAGE_ROOT, REPOSITORY_URL, VERSION, createContext } from './context.js'

/** @import { CommandEntry } from './registry.js' */
/** @import { CommandContext, CommandResult, CommandRun } from './context.js' */
/** @import { GhExecutor } from '../core/github/index.js' */
/** @import { Clock } from '../core/runtime/clock.js' */
/** @import { Output, Writer } from '../core/runtime/output.js' */
/** @import { Config, VersionStatus } from '../core/config/index.js' */
/** @import { Git } from '../core/git/index.js' */

/**
 * Everything main() takes from the process. Tests replace any of it.
 * @typedef {object} MainOptions
 * @property {string} [cwd]
 * @property {Record<string, string | undefined>} [env]
 * @property {NodeJS.ReadableStream & { isTTY?: boolean }} [stdin]
 * @property {Writer & { isTTY?: boolean }} [stdout]
 * @property {Writer} [stderr]
 * @property {Clock} [clock]
 * @property {GhExecutor} [ghExecutor] Replaces the real gh executor (the seam of task 1.3d).
 * @property {string} [moduleRoot] The directory that the registry's module paths resolve against;
 *   the package root by default.
 */

/**
 * @typedef {object} CommandLine
 * @property {boolean} json
 * @property {boolean} help
 * @property {boolean} version
 * @property {CommandEntry | null} entry
 * @property {string[]} args
 * @property {Record<string, string | boolean | undefined>} flags
 */

/**
 * Run hackwin with these arguments and return the exit code.
 * @param {string[]} argv The arguments after `hackwin`.
 * @param {MainOptions} [options]
 * @returns {Promise<number>}
 */
export async function main(argv, options = {}) {
  const env = options.env ?? process.env
  const stdin = options.stdin ?? process.stdin
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr
  const debug = env.HACKWIN_DEBUG === '1'

  /** @type {CommandLine} */
  let line
  try {
    line = parseCommandLine(argv)
  } catch (error) {
    const out = createOutput({ stdout, stderr, json: argv.includes('--json') })
    return report(error, { out, stdout, stderr, command: undefined, debug })
  }
  if (line.version) {
    stdout.write(`${VERSION}\n`)
    return EXIT.OK
  }
  if (line.help || line.entry === null) {
    stdout.write(helpText(line.entry))
    return EXIT.OK
  }

  const entry = line.entry
  const out = createOutput({ stdout, stderr, json: line.json })
  try {
    const ctx = await createContext({
      command: entry.name,
      args: line.args,
      flags: line.flags,
      cwd: options.cwd ?? process.cwd(),
      env,
      stdin,
      stdoutIsTTY: Boolean(stdout.isTTY),
      out,
      clock: options.clock ?? systemClock,
      ghExecutor: options.ghExecutor,
    })
    await prepareContext(ctx, entry)
    const run = await loadCommand(entry, options.moduleRoot ?? fileURLToPath(PACKAGE_ROOT))
    const result = checkResult(entry, await run(ctx))
    const exitCode = result.exitCode ?? EXIT.OK
    if (out.json) {
      writeJson(stdout, {
        command: entry.name,
        ok: exitCode === EXIT.OK,
        exitCode,
        lines: result.lines ?? [],
        data: result.data ?? null,
        warnings: out.warnings,
      })
    } else {
      for (const text of result.lines ?? []) stdout.write(`${text}\n`)
    }
    return exitCode
  } catch (error) {
    return report(error, { out, stdout, stderr, command: entry.name, debug })
  }
}

/**
 * Prepare the context before a command runs (contracts section 3.6, step 4): fetch and load the
 * configuration from origin/main and validate it (CM9), check the CLI version (CM12), resolve
 * the caller's identity (5.4) and fast-forward the main checkout (CM10). `setup` on a repository
 * without hackwin.yml on origin/main skips all of it.
 *
 * `hackwin internal ...` is skipped as well: the git hooks and the Claude Code hooks other than
 * SessionStart must not use the network (10.4), and in CI the caller is not a team member and
 * origin/main may not be fetched yet. Each of them loads what it needs through src/core/config.
 * @param {CommandContext} ctx
 * @param {CommandEntry} entry
 * @returns {Promise<void>}
 */
export async function prepareContext(ctx, entry) {
  if (entry.plumbing) return
  const ref = await mainRef(ctx.git)
  const setup = entry.name === 'setup'
  if (setup && !(await isConfigured(ctx.git, ref))) return
  const config = await loadCheckedConfig(ctx, ref, { fetch: !setup })
  ctx.config = config
  ctx.identity = resolveIdentity(config, await ctx.github.login())
  const defaultBranch = config.hackwin.project.default_branch
  const { status } = await fastForwardMainCheckout(ctx.git, { defaultBranch })
  if (status === 'behind') {
    ctx.out.warn(
      `the main checkout is behind origin/${defaultBranch} and was not fast-forwarded, because it has local changes or is not on ${defaultBranch}; to update it, ${runIn(`git merge --ff-only origin/${defaultBranch}`, ctx.repoRoot)}`,
    )
  }
}

/**
 * The version check as the runner applies it (CM12): an older CLI, or one of another phase,
 * is a PreconditionError (exit 2) that prints the install command of the pinned version; a
 * newer release of the same phase prints a one-line warning and continues (20.6).
 * @param {object} versions
 * @param {string} versions.running
 * @param {string} versions.pinned `cli_version` of hackwin.yml on origin/main.
 * @param {Output | null} versions.out Receives the warning; null prints none.
 * @param {string} [versions.repositoryUrl] `repository.url` of package.json.
 * @returns {VersionStatus}
 */
export function enforceVersion({ running, pinned, out, repositoryUrl = REPOSITORY_URL }) {
  const { status } = checkVersion({ running, pinned })
  if (status === 'older' || status === 'other-phase') {
    const message =
      status === 'older'
        ? `hackwin ${running} is older than ${pinned}, the version pinned in hackwin.yml on origin/main`
        : `hackwin ${running} is a release of phase ${phaseOf(running)}, but this project is on phase ${phaseOf(pinned)}: hackwin.yml on origin/main pins ${pinned}`
    throw new PreconditionError(message, {
      resolve: { command: installCommand(pinned, repositoryUrl), dir: 'any directory' },
    })
  }
  if (status === 'newer-patch') {
    out?.warn(
      `hackwin ${running} is newer than ${pinned}, the version pinned in hackwin.yml; continuing`,
    )
  }
  return status
}

/**
 * Load the configuration and check the version. When the configuration is invalid, the version
 * is checked first from the raw file, so that a CLI of another phase says which version to
 * install instead of failing on keys it does not know.
 * @param {CommandContext} ctx
 * @param {string} ref
 * @param {{ fetch: boolean }} options
 * @returns {Promise<Config>}
 */
async function loadCheckedConfig(ctx, ref, { fetch }) {
  /** @type {Config} */
  let config
  try {
    config = await loadConfig(ctx.git, { ref, fetch })
  } catch (error) {
    if (error instanceof ConfigError) {
      const text = await ctx.git.showFile(ref, HACKWIN_FILE).catch(() => null)
      const pinned = text === null ? null : pinnedVersionOf(text)
      if (pinned !== null) enforceVersion({ running: ctx.version, pinned, out: null })
    }
    throw error
  }
  enforceVersion({ running: ctx.version, pinned: config.hackwin.cli_version, out: ctx.out })
  return config
}

/**
 * The remote-tracking ref of the default branch: what `origin/HEAD` points to, or `origin/main`.
 * @param {Git} git
 * @returns {Promise<string>}
 */
async function mainRef(git) {
  const result = await git.run(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], {
    allowFailure: true,
  })
  const ref = result.stdout.trim()
  return result.code === 0 && ref.startsWith('origin/') ? ref : 'origin/main'
}

/**
 * True when origin has hackwin.yml on its default branch, after a fetch. A clone without a
 * remote origin is not configured; `setup` reports its own preconditions.
 * @param {Git} git
 * @param {string} ref
 * @returns {Promise<boolean>}
 */
async function isConfigured(git, ref) {
  if ((await git.remoteUrl('origin')) === null) return false
  await git.fetch({ remote: 'origin' })
  const sha = await git.tryRevParse(ref)
  return sha !== null && (await git.showFile(sha, HACKWIN_FILE)) !== null
}

/**
 * Load the entry module of a command. A module that does not exist yet exits 2 and names it.
 * @param {CommandEntry} entry
 * @param {string} moduleRoot
 * @returns {Promise<CommandRun>}
 */
export async function loadCommand(entry, moduleRoot) {
  const file = join(moduleRoot, entry.module)
  if (!existsSync(file)) throw new NotBuiltError(entry.name, entry.module)
  const module = await import(pathToFileURL(file).href)
  if (typeof module.run !== 'function') {
    throw new NotBuiltError(
      entry.name,
      entry.module,
      `${entry.module} does not export a run function`,
    )
  }
  return module.run
}

/**
 * Split the command line into global flags, the command, its arguments and its flags. Global
 * flags may stand anywhere before `--`.
 * @param {string[]} argv
 * @returns {CommandLine}
 */
export function parseCommandLine(argv) {
  /** @type {Record<string, boolean>} */
  const global = { json: false, help: false, version: false }
  /** @type {string[]} */
  const words = []
  let endOfOptions = false
  for (const token of argv) {
    const name = endOfOptions ? undefined : globalFlagName(token)
    if (name) global[name] = true
    else words.push(token)
    if (token === '--') endOfOptions = true
  }
  const base = {
    json: global.json,
    help: global.help,
    version: global.version,
    args: [],
    flags: {},
  }
  if (global.version || (global.help && words.length === 0)) return { ...base, entry: null }
  if (words[0]?.startsWith('-')) {
    throw new UsageError(`unknown option: ${words[0]}`, {
      resolve: { command: 'hackwin --help', dir: 'any directory' },
    })
  }
  const { entry, rest } = resolveCommand(words)
  if (global.help) return { ...base, entry }

  /** @type {{ values: Record<string, string | boolean | undefined>, positionals: string[] }} */
  let parsed
  try {
    parsed = parseArgs({ args: rest, options: entry.flags, allowPositionals: true, strict: true })
  } catch (error) {
    // parseArgs explains at length; its first sentence is enough.
    const reason = error.message.split('. ')[0].replace(/\.$/, '')
    throw new UsageError(`${reason}; usage: ${entry.usage}`)
  }
  if (parsed.positionals.length > entry.maxArgs) {
    throw new UsageError(
      `too many arguments: ${parsed.positionals.slice(entry.maxArgs).join(' ')}; usage: ${entry.usage}`,
    )
  }
  return { ...base, entry, args: parsed.positionals, flags: { ...parsed.values } }
}

/**
 * The help of hackwin, or of one command. Lists only the commands of this phase, never the
 * plumbing namespace (AC67, A10).
 * @param {CommandEntry | null} entry
 * @returns {string}
 */
export function helpText(entry) {
  if (entry) return `Usage: ${entry.usage}\n\n${entry.summary}.\n`
  const width = Math.max(...COMMANDS.map((command) => command.name.length))
  return [
    'Usage: hackwin <command> [options]',
    '',
    'Commands:',
    ...COMMANDS.map((command) => `  ${command.name.padEnd(width)}  ${command.summary}`),
    '',
    'Options:',
    '  --json     Print the full result as JSON',
    "  --help     Show help; with a command, the command's usage",
    '  --version  Show the version',
    '',
  ].join('\n')
}

/**
 * @param {string} token
 * @returns {'json' | 'help' | 'version' | undefined}
 */
function globalFlagName(token) {
  if (token === '--json') return 'json'
  if (token === '--help' || token === '-h') return 'help'
  if (token === '--version') return 'version'
  return undefined
}

/**
 * @param {CommandEntry} entry
 * @param {CommandResult | void} result
 * @returns {CommandResult}
 */
function checkResult(entry, result) {
  const checked = result ?? {}
  const exitCode = checked.exitCode ?? EXIT.OK
  if (exitCode !== EXIT.OK && exitCode !== EXIT.BLOCKED) {
    throw new TypeError(
      `hackwin ${entry.name} returned exit code ${exitCode}; exit codes 2 and 3 are thrown errors`,
    )
  }
  return checked
}

/**
 * Print an error and return its exit code.
 * @param {unknown} error
 * @param {object} options
 * @param {Output} options.out
 * @param {Writer} options.stdout
 * @param {Writer} options.stderr
 * @param {string | undefined} options.command
 * @param {boolean} options.debug
 * @returns {number}
 */
function report(error, { out, stdout, stderr, command, debug }) {
  const exitCode = exitCodeOf(error)
  if (out.json) {
    writeJson(stdout, {
      command: command ?? null,
      ok: false,
      exitCode,
      error:
        error instanceof HackwinError
          ? error.toJSON()
          : { kind: 'internal', message: error instanceof Error ? error.message : String(error) },
      warnings: out.warnings,
    })
    if (debug && error instanceof Error && !(error instanceof HackwinError)) {
      stderr.write(`${error.stack}\n`)
    }
  } else {
    for (const text of formatError(error, { command, stack: debug })) stderr.write(`${text}\n`)
  }
  return exitCode
}

/**
 * @param {Writer} stdout
 * @param {unknown} value
 */
function writeJson(stdout, value) {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

// The runner: parses the command line, builds the context, loads the command module lazily,
// runs it, and maps the result or the error to output and an exit code (CM2, CM6). When GitHub is
// unreachable while it prepares the context, a command can still print what it knows locally
// through the `unreachable` export of its module.

import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  EXIT,
  HackwinError,
  NotBuiltError,
  RemoteError,
  UsageError,
  exitCodeOf,
} from '../core/runtime/errors.js'
import { createOutput, formatError, runIn } from '../core/runtime/output.js'
import { systemClock } from '../core/runtime/clock.js'
import {
  HACKWIN_FILE,
  enforceVersion as enforcePinnedVersion,
  fastForwardMainCheckout,
  loadCheckedConfig,
  mainRef,
  resolveIdentity,
} from '../core/config/index.js'
import { COMMANDS, resolveCommand } from './registry.js'
import { PACKAGE_ROOT, REPOSITORY_URL, VERSION, createContext } from './context.js'

/** @import { CommandEntry } from './registry.js' */
/** @import { CommandContext, CommandResult, CommandRun, CommandUnreachable, UnreachableResult } from './context.js' */
/** @import { GhExecutor } from '../core/github/index.js' */
/** @import { Clock } from '../core/runtime/clock.js' */
/** @import { Output, Writer } from '../core/runtime/output.js' */
/** @import { VersionStatus } from '../core/config/index.js' */
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
  const moduleRoot = options.moduleRoot ?? fileURLToPath(PACKAGE_ROOT)
  /** @type {UnreachableResult | null} */
  let unreachable = null
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
    try {
      await prepareContext(ctx, entry)
    } catch (error) {
      unreachable = await runUnreachable(ctx, entry, error, moduleRoot)
      throw error
    }
    const run = await loadCommand(entry, moduleRoot)
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
    return report(error, { out, stdout, stderr, command: entry.name, debug, unreachable })
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
  const config = await loadCheckedConfig(ctx.git, {
    ref,
    fetch: !setup,
    running: ctx.version,
    repositoryUrl: REPOSITORY_URL,
    out: ctx.out,
  })
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
 * The version check of CM12 with `repository.url` of this package (src/core/config,
 * `enforceVersion`): an older CLI, or one of another phase, is a PreconditionError (exit 2) that
 * prints the install command of the pinned version; a newer release of the same phase prints a
 * one-line warning and continues (20.6).
 * @param {object} versions
 * @param {string} versions.running
 * @param {string} versions.pinned `cli_version` of hackwin.yml on origin/main.
 * @param {Output | null} versions.out Receives the warning; null prints none.
 * @param {string} [versions.repositoryUrl] `repository.url` of package.json.
 * @returns {VersionStatus}
 */
export function enforceVersion({ running, pinned, out, repositoryUrl = REPOSITORY_URL }) {
  return enforcePinnedVersion({ running, pinned, repositoryUrl, out })
}

/**
 * True when origin has hackwin.yml on its default branch, after a fetch that prunes, as the
 * fetch of loadConfig does. A clone without a remote origin is not configured; `setup` reports
 * its own preconditions.
 * @param {Git} git
 * @param {string} ref
 * @returns {Promise<boolean>}
 */
async function isConfigured(git, ref) {
  if ((await git.remoteUrl('origin')) === null) return false
  await git.fetch({ remote: 'origin', prune: true })
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
  const module = await importCommand(entry, moduleRoot)
  if (module === null) throw new NotBuiltError(entry.name, entry.module)
  if (typeof module.run !== 'function') {
    throw new NotBuiltError(
      entry.name,
      entry.module,
      `${entry.module} does not export a run function`,
    )
  }
  return /** @type {CommandRun} */ (module.run)
}

/**
 * What a user command still prints when preparing its context failed with a RemoteError
 * (contracts section 3.2): the runner loads the command's module anyway and calls its
 * `unreachable(ctx, error)` with the context it built, without config and identity. Null when
 * the error is another one, the command is plumbing, or its module does not exist yet or exports
 * no `unreachable`; the runner then prints the error alone. An error that the module or the hook
 * throws is reported in place of the RemoteError, as an error of `run` is.
 * @param {CommandContext} ctx
 * @param {CommandEntry} entry
 * @param {unknown} error The error of prepareContext.
 * @param {string} moduleRoot
 * @returns {Promise<UnreachableResult | null>}
 */
async function runUnreachable(ctx, entry, error, moduleRoot) {
  if (entry.plumbing || !(error instanceof RemoteError)) return null
  const module = await importCommand(entry, moduleRoot)
  if (typeof module?.unreachable !== 'function') return null
  delete ctx.config
  delete ctx.identity
  const hook = /** @type {CommandUnreachable} */ (module.unreachable)
  return (await hook(ctx, error)) ?? {}
}

/**
 * The entry module of a command, or null when it does not exist yet.
 * @param {CommandEntry} entry
 * @param {string} moduleRoot
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function importCommand(entry, moduleRoot) {
  const file = join(moduleRoot, entry.module)
  if (!existsSync(file)) return null
  return import(pathToFileURL(file).href)
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
 * Print an error and return its exit code. The lines of an `unreachable` hook come first, on
 * stdout; with --json they and the hook's data are fields of the one document.
 * @param {unknown} error
 * @param {object} options
 * @param {Output} options.out
 * @param {Writer} options.stdout
 * @param {Writer} options.stderr
 * @param {string | undefined} options.command
 * @param {boolean} options.debug
 * @param {UnreachableResult | null} [options.unreachable]
 * @returns {number}
 */
function report(error, { out, stdout, stderr, command, debug, unreachable = null }) {
  const exitCode = exitCodeOf(error)
  if (out.json) {
    writeJson(stdout, {
      command: command ?? null,
      ok: false,
      exitCode,
      ...(unreachable === null
        ? {}
        : { lines: unreachable.lines ?? [], data: unreachable.data ?? null }),
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
    for (const text of unreachable?.lines ?? []) stdout.write(`${text}\n`)
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

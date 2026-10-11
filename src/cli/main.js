// The runner: parses the command line, builds the context, loads the command module lazily,
// runs it, and maps the result or the error to output and an exit code (CM2, CM6).

import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  EXIT,
  HackwinError,
  NotBuiltError,
  UsageError,
  exitCodeOf,
} from '../core/runtime/errors.js'
import { createOutput, formatError } from '../core/runtime/output.js'
import { systemClock } from '../core/runtime/clock.js'
import { COMMANDS, resolveCommand } from './registry.js'
import { PACKAGE_ROOT, VERSION, createContext } from './context.js'

/** @import { CommandEntry } from './registry.js' */
/** @import { CommandContext, CommandResult, CommandRun } from './context.js' */
/** @import { GhExecutor } from '../core/github/index.js' */
/** @import { Clock } from '../core/runtime/clock.js' */
/** @import { Output, Writer } from '../core/runtime/output.js' */

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
 * Where task 1.3b prepares the context before a command runs: load and validate the
 * configuration from origin/main, check the CLI version (CM12), resolve the caller's identity,
 * and fast-forward the main checkout (CM10). See docs/build/contracts.md.
 * @param {CommandContext} ctx
 * @param {CommandEntry} entry
 * @returns {Promise<void>}
 */
export async function prepareContext(ctx, entry) {}

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

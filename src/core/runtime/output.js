// Output of a command. Short by default (CM6); with --json stdout carries only the JSON result,
// so progress lines go to stderr. Every "run this" message names its directory (CM4), and every
// block names the rule, the objects and how to resolve it (CM5).

import { BlockedError, ConfigError, HackwinError, RemoteError } from './errors.js'

/** @import { Resolve } from './errors.js' */

/**
 * Anything with a write method, such as process.stdout.
 * @typedef {{ write(chunk: string): unknown }} Writer
 */

/**
 * @typedef {object} Output
 * @property {boolean} json True when the command runs with --json.
 * @property {(text: string) => void} line A progress or report line: stdout without --json, stderr with it.
 * @property {(text: string) => void} write Raw text on the same stream as `line`, for prompts.
 * @property {(text: string) => void} warn A one-line warning on stderr; also part of the JSON result.
 * @property {string[]} warnings The warnings so far.
 */

/**
 * @param {object} options
 * @param {Writer} options.stdout
 * @param {Writer} options.stderr
 * @param {boolean} [options.json]
 * @returns {Output}
 */
export function createOutput({ stdout, stderr, json = false }) {
  const progress = json ? stderr : stdout
  /** @type {string[]} */
  const warnings = []
  return {
    json,
    line: (text) => {
      progress.write(`${text}\n`)
    },
    write: (text) => {
      progress.write(text)
    },
    warn: (text) => {
      warnings.push(text)
      stderr.write(`warning: ${text}\n`)
    },
    warnings,
  }
}

/**
 * The message that tells a human or an agent to run a command, naming the directory (CM4).
 * @param {string} command
 * @param {string} dir
 * @returns {string}
 */
export function runIn(command, dir) {
  if (!command) throw new TypeError('runIn needs a command')
  if (!dir) throw new TypeError(`runIn needs the directory to run \`${command}\` in (CM4)`)
  return `run \`${command}\` in ${dir}`
}

/**
 * @param {Resolve} resolve
 * @returns {string}
 */
export function formatResolve(resolve) {
  return typeof resolve === 'string' ? resolve : runIn(resolve.command, resolve.dir)
}

/**
 * The short form of an error, one line per item, as the runner prints it on stderr.
 * @param {unknown} error
 * @param {object} [options]
 * @param {string} [options.command] The command that failed, for the prefix.
 * @param {boolean} [options.stack] Also print the stack of an unexpected error.
 * @returns {string[]}
 */
export function formatError(error, { command, stack = false } = {}) {
  const prefix = command ? `hackwin ${command}: ` : 'hackwin: '
  if (!(error instanceof HackwinError)) {
    const message = error instanceof Error ? error.message : String(error)
    const lines = [`${prefix}internal error: ${message}`]
    if (stack && error instanceof Error && error.stack) lines.push(error.stack)
    else lines.push('Set HACKWIN_DEBUG=1 to print the stack trace.')
    return lines
  }
  if (error instanceof BlockedError) {
    return [
      `${prefix}blocked: ${error.message}`,
      `  rule: ${error.rule}`,
      ...error.objects.map((object) => `  - ${object}`),
      `  to resolve: ${formatResolve(/** @type {Resolve} */ (error.resolve))}`,
    ]
  }
  const lines = [`${prefix}${error.message}`]
  if (error instanceof ConfigError && error.key) lines.push(`  key: ${error.key}`)
  if (error instanceof RemoteError) {
    const tail = /** @type {string[]} */ (error.details?.tail ?? [])
    for (const line of tail.slice(-5)) lines.push(`  ${line}`)
  }
  if (error.resolve !== undefined) lines.push(`  to resolve: ${formatResolve(error.resolve)}`)
  return lines
}

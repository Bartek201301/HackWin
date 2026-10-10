// Process execution with timeouts and log tails. Every child process of hackwin starts here:
// git, gh and the project's own commands from hackwin.yml.

import { spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { PreconditionError } from './errors.js'

/**
 * @typedef {object} ExecOptions
 * @property {string} [cwd]
 * @property {Record<string, string | undefined>} [env] The whole environment of the child; process.env by default. Undefined values are left out.
 * @property {string} [input] Text written to stdin. Without it stdin is empty.
 * @property {number} [timeoutMs] After this time the child's process group gets SIGTERM, and SIGKILL 5 seconds later.
 * @property {number} [tailLines] How many of the last output lines `tail` keeps; 20 by default.
 * @property {string} [logFile] A file that receives the whole output, stdout and stderr as they arrive.
 */

/**
 * @typedef {object} ExecResult
 * @property {number | null} code The exit code; null when a signal ended the process.
 * @property {string | null} signal
 * @property {string} stdout
 * @property {string} stderr
 * @property {string[]} tail The last lines of stdout and stderr, in the order they arrived.
 * @property {boolean} timedOut
 * @property {number} durationMs
 */

export const DEFAULT_TAIL_LINES = 20
const KILL_GRACE_MS = 5000

/**
 * Run a program without a shell. Resolves with the result whatever the exit code; rejects with a
 * PreconditionError when the program or the working directory does not exist.
 * @param {string} file
 * @param {string[]} args
 * @param {ExecOptions} [options]
 * @returns {Promise<ExecResult>}
 */
export function exec(file, args, options = {}) {
  return run(file, args, false, options)
}

/**
 * Run a command line with `sh -c`, as the commands of hackwin.yml are run. Append arguments with
 * quoteShellArg.
 * @param {string} commandLine
 * @param {ExecOptions} [options]
 * @returns {Promise<ExecResult>}
 */
export function execShell(commandLine, options = {}) {
  return run(commandLine, [], true, options)
}

/**
 * Quote one argument for a POSIX shell command line.
 * @param {string} arg
 * @returns {string}
 */
export function quoteShellArg(arg) {
  if (/^[A-Za-z0-9_/.,:@%+=-]+$/.test(arg)) return arg
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

/**
 * @param {string} file
 * @param {string[]} args
 * @param {boolean} shell
 * @param {ExecOptions} options
 * @returns {Promise<ExecResult>}
 */
function run(file, args, shell, options) {
  const {
    cwd,
    env = process.env,
    input,
    timeoutMs,
    tailLines = DEFAULT_TAIL_LINES,
    logFile,
  } = options
  // With a timeout the child gets its own process group, so the whole tree can be stopped.
  const group = timeoutMs !== undefined && process.platform !== 'win32'
  const started = Date.now()

  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      env: definedOnly(env),
      shell,
      detached: group,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const log = logFile ? createWriteStream(logFile) : null
    const tail = createTail(tailLines)
    let stdout = ''
    let stderr = ''
    let timedOut = false
    /** @type {NodeJS.Timeout | undefined} */
    let timer
    /** @type {NodeJS.Timeout | undefined} */
    let killTimer

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (/** @type {string} */ chunk) => {
      stdout += chunk
      tail.push('out', chunk)
      log?.write(chunk)
    })
    child.stderr.on('data', (/** @type {string} */ chunk) => {
      stderr += chunk
      tail.push('err', chunk)
      log?.write(chunk)
    })

    child.on('error', (error) => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      log?.end()
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
        const message =
          cwd !== undefined && !existsSync(cwd)
            ? `the directory ${cwd} does not exist`
            : `${shell ? 'sh' : file} is not installed or not on PATH`
        reject(new PreconditionError(message, { cause: error }))
      } else {
        reject(error)
      }
    })

    child.on('close', (code, signal) => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      const finish = () =>
        resolve({
          code,
          signal,
          stdout,
          stderr,
          tail: tail.lines(),
          timedOut,
          durationMs: Date.now() - started,
        })
      if (log) log.end(finish)
      else finish()
    })

    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true
        stop(child, group, 'SIGTERM')
        killTimer = setTimeout(() => stop(child, group, 'SIGKILL'), KILL_GRACE_MS)
      }, timeoutMs)
    }

    // A child that exits without reading its input must not fail the run with EPIPE.
    child.stdin.on('error', () => {})
    child.stdin.end(input ?? '')
  })
}

/**
 * @param {import('node:child_process').ChildProcess} child
 * @param {boolean} group
 * @param {NodeJS.Signals} signal
 */
function stop(child, group, signal) {
  try {
    if (group && child.pid !== undefined) process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    // The process is already gone.
  }
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string>}
 */
function definedOnly(env) {
  /** @type {Record<string, string>} */
  const result = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value
  }
  return result
}

/**
 * The last `max` lines of two interleaved streams.
 * @param {number} max
 */
function createTail(max) {
  /** @type {string[]} */
  const lines = []
  /** @type {Record<'out' | 'err', string>} */
  const partial = { out: '', err: '' }
  /** @param {string} line */
  const add = (line) => {
    lines.push(line.replace(/\r$/, ''))
    if (lines.length > max) lines.shift()
  }
  return {
    /**
     * @param {'out' | 'err'} stream
     * @param {string} chunk
     */
    push(stream, chunk) {
      const parts = (partial[stream] + chunk).split('\n')
      partial[stream] = parts.pop() ?? ''
      for (const line of parts) add(line)
    },
    lines() {
      for (const stream of /** @type {const} */ (['out', 'err'])) {
        if (partial[stream] !== '') add(partial[stream])
        partial[stream] = ''
      }
      return max > 0 ? [...lines] : []
    },
  }
}

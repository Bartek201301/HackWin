// The command module contract. Every command is one entry module that exports
//
//   export async function run(ctx) { ... }
//
// It receives a CommandContext, returns a CommandResult (or nothing), or throws a typed error
// from src/core/runtime. The runner turns the result or the error into output and an exit code.

import { readFileSync } from 'node:fs'
import { createGit } from '../core/git/index.js'
import { createGhExecutor, createGitHub, parseGitHubRemote } from '../core/github/index.js'
import { detectCallerKind } from '../core/runtime/caller.js'

/** @import { Git } from '../core/git/index.js' */
/** @import { GhExecutor, GitHub } from '../core/github/index.js' */
/** @import { CallerKind } from '../core/runtime/caller.js' */
/** @import { Clock } from '../core/runtime/clock.js' */
/** @import { Output } from '../core/runtime/output.js' */

/**
 * @typedef {object} CommandContext
 * @property {string} command The command name, for example `take` or `internal hook pre-push`.
 * @property {string[]} args The positional arguments after the command name.
 * @property {Record<string, string | boolean | undefined>} flags The command's own flags, parsed.
 * @property {boolean} json True with --json.
 * @property {string} cwd The directory the command was started in.
 * @property {string} repoRoot The top-level directory of the current checkout or worktree.
 * @property {string} gitCommonDir The git common directory of the clone, absolute; local state lives in `<gitCommonDir>/hackwin/`.
 * @property {Output} out Output lines and warnings.
 * @property {Clock} clock Read the time and wait only through this.
 * @property {CallerKind} caller Who runs the command.
 * @property {Record<string, string | undefined>} env The environment.
 * @property {Git} git Git, run in repoRoot.
 * @property {GitHub} github GitHub through gh, for the repository of `origin`.
 * @property {string} version The version of the running CLI.
 * @property {NodeJS.ReadableStream} stdin For interactive input (CM11) and for readStdin.
 * @property {() => Promise<string>} readStdin All of stdin as text, read once; empty when stdin is a terminal.
 * @property {unknown} [config] From task 1.3b: hackwin.yml and owners.yml from origin/main (docs/build/contracts.md).
 * @property {unknown} [identity] From task 1.3b: the caller's login and team member (docs/build/contracts.md).
 */

/**
 * @typedef {object} CommandResult
 * @property {0 | 1} [exitCode] 0 by default. 1 when the command finished but a check failed, as
 *   `join` does after its checklist. Exit codes 2 and 3 are always thrown errors.
 * @property {string[]} [lines] The short output (CM6), printed one per line without --json.
 * @property {unknown} [data] The full machine-readable result, printed with --json.
 */

/** @typedef {(ctx: CommandContext) => Promise<CommandResult | void>} CommandRun */

/** The root of the hackwin package. */
export const PACKAGE_ROOT = new URL('../../', import.meta.url)

/** The version of the running CLI, from package.json. */
export const VERSION = /** @type {string} */ (
  JSON.parse(readFileSync(new URL('package.json', PACKAGE_ROOT), 'utf8')).version
)

/**
 * @typedef {object} ContextInput
 * @property {string} command
 * @property {string[]} args
 * @property {Record<string, string | boolean | undefined>} flags
 * @property {string} cwd
 * @property {Record<string, string | undefined>} env
 * @property {NodeJS.ReadableStream & { isTTY?: boolean }} stdin
 * @property {boolean} stdoutIsTTY
 * @property {Output} out
 * @property {Clock} clock
 * @property {GhExecutor} [ghExecutor] Replaces the real gh executor.
 */

/**
 * Build the context of a command. Throws a PreconditionError outside a git checkout: every
 * command runs in a clone of the team repository.
 * @param {ContextInput} input
 * @returns {Promise<CommandContext>}
 */
export async function createContext(input) {
  const { command, args, flags, cwd, env, stdin, stdoutIsTTY, out, clock, ghExecutor } = input
  const repoRoot = await createGit({ cwd, env }).topLevel()
  const git = createGit({ cwd: repoRoot, env })
  const gitCommonDir = await git.commonDir()
  const github = createGitHub({
    executor: ghExecutor ?? createGhExecutor({ env }),
    repo: parseGitHubRemote(await git.remoteUrl('origin')),
    cwd: repoRoot,
  })
  return {
    command,
    args,
    flags,
    json: out.json,
    cwd,
    repoRoot,
    gitCommonDir,
    out,
    clock,
    caller: detectCallerKind({ env, stdinIsTTY: Boolean(stdin.isTTY), stdoutIsTTY }),
    env,
    git,
    github,
    version: VERSION,
    stdin,
    readStdin: once(() => readAll(stdin)),
  }
}

/**
 * @template T
 * @param {() => T} fn
 * @returns {() => T}
 */
function once(fn) {
  /** @type {{ value: T } | undefined} */
  let cached
  return () => {
    cached ??= { value: fn() }
    return cached.value
  }
}

/**
 * @param {NodeJS.ReadableStream & { isTTY?: boolean }} stream
 * @returns {Promise<string>}
 */
async function readAll(stream) {
  if (stream.isTTY) return ''
  /** @type {Buffer[]} */
  const chunks = []
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

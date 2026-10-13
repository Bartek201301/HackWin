// Step 7 of `take` (7.7): start the member's agent in the worktree with the prompt as its first
// message, or print the prompt file and the command that starts it.
//
// - In a terminal, Claude Code starts as `claude "<prompt>"` with the worktree as its process
//   directory (docs/verification.md, row 3) and takes over the terminal until it exits [D18].
// - Codex starts from `take` only in Phase 3 (I10); until then `take` prints the command
//   `codex --cd <worktree> "$(cat <prompt file>)"` (docs/verification.md, row A).
// - Called from inside Claude Code (caller kind `claude-code`), the session never moves to the
//   worktree: `take` prints the command for a new terminal (docs/verification.md, row 4).
// - Without a terminal (caller kind `non-interactive`) or with --json, which keeps stdout for the
//   one JSON document, `take` prints the command as well.

import { spawn } from 'node:child_process'
import { quoteShellArg } from '../../core/runtime/index.js'

/** @import { RunIn } from '../../core/runtime/index.js' */
/** @import { CallerKind } from '../../core/runtime/index.js' */

/** The display name of each agent. */
export const AGENT_NAMES = Object.freeze({ claude: 'Claude Code', codex: 'Codex' })

/**
 * Why `take` prints the start command instead of starting the agent.
 * @typedef {'codex' | 'claude-code' | 'non-interactive' | 'json'} PrintReason
 */

/**
 * @typedef {{ started: true, code: number | null, signal: string | null } | { started: false, reason: string }} Launch
 */

/**
 * The command that starts the agent in the worktree with the prompt file as its first message.
 * @param {'claude' | 'codex'} agent
 * @param {{ worktree: string, promptFile: string }} paths
 * @returns {RunIn}
 */
export function startCommand(agent, { worktree, promptFile }) {
  const prompt = `"$(cat ${quoteShellArg(promptFile)})"`
  if (agent === 'codex') {
    return { command: `codex --cd ${quoteShellArg(worktree)} ${prompt}`, dir: 'any directory' }
  }
  return { command: `claude ${prompt}`, dir: worktree }
}

/**
 * Why the agent is not started here, or null when `take` starts it.
 * @param {{ agent: 'claude' | 'codex', caller: CallerKind, json: boolean }} options
 * @returns {PrintReason | null}
 */
export function printReason({ agent, caller, json }) {
  if (agent === 'codex') return 'codex'
  if (caller !== 'terminal') return caller
  return json ? 'json' : null
}

/**
 * Start Claude Code in the worktree with the prompt as its first message, on this terminal, and
 * wait until it exits. While it runs, an interrupt from the keyboard is the agent's, not ours.
 * Resolves `started: false` when the program cannot be started, for example when `claude` is not
 * on PATH.
 * @param {{ worktree: string, prompt: string, env: Record<string, string | undefined> }} options
 * @returns {Promise<Launch>}
 */
export function launchClaude({ worktree, prompt, env }) {
  const ignore = () => {}
  process.on('SIGINT', ignore)
  return new Promise((resolve) => {
    let settled = false
    /** @param {Launch} launch */
    const finish = (launch) => {
      if (settled) return
      settled = true
      process.off('SIGINT', ignore)
      resolve(launch)
    }
    try {
      const child = spawn('claude', [prompt], {
        cwd: worktree,
        env: definedOnly(env),
        stdio: 'inherit',
      })
      child.once('error', (error) => finish({ started: false, reason: reasonOf(error) }))
      child.once('exit', (code, signal) => finish({ started: true, code, signal }))
    } catch (error) {
      finish({ started: false, reason: reasonOf(error) })
    }
  })
}

/**
 * @param {NodeJS.ErrnoException} error
 * @returns {string}
 */
function reasonOf(error) {
  if (error.code === 'ENOENT') return '`claude` is not installed or not on PATH'
  if (error.code === 'E2BIG') return 'the prompt is too long for one command line argument'
  return error.message
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

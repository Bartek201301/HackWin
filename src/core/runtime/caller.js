// The caller kind: who runs this command. `take` prints the prompt inside an agent session
// instead of starting a new one, and `gate` refuses to start anywhere but a terminal.

/** @typedef {'terminal' | 'claude-code' | 'non-interactive'} CallerKind */

/** The variable that the Claude Code command wrappers set (task 1.4c). */
export const CALLER_ENV = 'HACKWIN_CALLER'

/**
 * `claude-code` when HACKWIN_CALLER=claude-code is set; otherwise `terminal` when stdin and stdout
 * are both terminals; otherwise `non-interactive`. Any other value of HACKWIN_CALLER is ignored.
 * @param {object} options
 * @param {Record<string, string | undefined>} options.env
 * @param {boolean} options.stdinIsTTY
 * @param {boolean} options.stdoutIsTTY
 * @returns {CallerKind}
 */
export function detectCallerKind({ env, stdinIsTTY, stdoutIsTTY }) {
  if (env[CALLER_ENV] === 'claude-code') return 'claude-code'
  if (stdinIsTTY && stdoutIsTTY) return 'terminal'
  return 'non-interactive'
}

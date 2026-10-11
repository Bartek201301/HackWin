// The executor seam: the one place where hackwin starts `gh` (CM7). Tests replace it with a fake
// executor (task 1.3d) by passing their own function to createGitHub or to the CLI's main().

import { exec } from '../runtime/exec.js'

/**
 * One call of the executor.
 * @typedef {object} GhCall
 * @property {string} [input] Text on stdin, for example a JSON request body.
 * @property {Record<string, string>} [env] Extra environment variables for this call, such as GH_REPO.
 * @property {string} [cwd]
 */

/**
 * @typedef {object} GhResult
 * @property {number} code The exit code of gh.
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * Runs gh with these arguments. A failure is a result with a non-zero code, never a rejection,
 * except when gh is not installed.
 * @typedef {(args: string[], call?: GhCall) => Promise<GhResult>} GhExecutor
 */

/** Timeout of one gh call. */
export const GH_TIMEOUT_MS = 120_000

/**
 * The real executor: runs the `gh` found on PATH, without prompts or update notices.
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env] The base environment; process.env by default.
 * @param {number} [options.timeoutMs]
 * @returns {GhExecutor}
 */
export function createGhExecutor({ env = process.env, timeoutMs = GH_TIMEOUT_MS } = {}) {
  return async (args, call = {}) => {
    const result = await exec('gh', args, {
      cwd: call.cwd,
      env: {
        ...env,
        GH_PROMPT_DISABLED: '1',
        GH_NO_UPDATE_NOTIFIER: '1',
        NO_COLOR: '1',
        ...call.env,
      },
      input: call.input,
      timeoutMs,
    })
    if (result.timedOut) {
      return {
        code: 1,
        stdout: result.stdout,
        stderr: `${result.stderr}\ngh timed out after ${timeoutMs} ms`,
      }
    }
    return { code: result.code ?? 1, stdout: result.stdout, stderr: result.stderr }
  }
}

// The GitHub token of a CI run. The workflow gives it to `hackwin internal ci` as GH_TOKEN, and
// it must reach only what needs GitHub: the gh calls of internal ci and its fetch of the base
// branch. The project's commands (install, check, test, format, generate) run code from the pull
// request, so they never see it. src/core/project runs them with the environment of the process,
// so the token leaves that environment before anything else runs.

import { createGitHub } from '../../core/github/index.js'

/** @import { CommandContext } from '../../cli/context.js' */
/** @import { GitHub } from '../../core/github/index.js' */

/** The variables through which gh and git tools find a GitHub token. */
export const TOKEN_VARIABLES = Object.freeze(['GH_TOKEN', 'GITHUB_TOKEN'])

/**
 * Take the token out of the command's environment and out of the environment of the process,
 * which the project's commands inherit.
 * @param {CommandContext} ctx
 * @returns {string | null} GH_TOKEN, or GITHUB_TOKEN, or null when neither is set.
 */
export function takeToken(ctx) {
  const token = ctx.env.GH_TOKEN || ctx.env.GITHUB_TOKEN || null
  for (const env of new Set([ctx.env, process.env])) {
    for (const name of TOKEN_VARIABLES) delete env[name]
  }
  return token
}

/**
 * The client of ctx.github whose gh calls, and only those, carry the token. Without a token gh
 * uses its own login.
 * @param {GitHub} github
 * @param {string | null} token
 * @returns {GitHub}
 */
export function githubWithToken(github, token) {
  if (token === null) return github
  const { executor, repo, cwd } = github
  return createGitHub({
    executor: (args, call = {}) =>
      executor(args, { ...call, env: { ...call.env, GH_TOKEN: token } }),
    repo,
    cwd,
  })
}

/**
 * The git configuration, as environment variables for one git process, that sends the token to
 * the host of an https remote, as actions/checkout does when it keeps the credentials. Nothing
 * for another remote or without a token.
 * @param {string | null} url The URL of the remote.
 * @param {string | null} token
 * @returns {Record<string, string>}
 */
export function fetchAuth(url, token) {
  const host = url === null ? null : (/^https:\/\/(?:[^@/]+@)?([^/]+)\//.exec(url)?.[1] ?? null)
  if (token === null || host === null) return {}
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.https://${host}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  }
}

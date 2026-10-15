// The GitHub token of a CI run. The workflow gives it to `hackwin internal ci` as GH_TOKEN, and
// it must reach only what needs GitHub: the gh calls of internal ci and its fetch of the base
// branch. The project's commands (install, check, test, format, generate) run code from the pull
// request, so they never see it, and neither does any other process internal ci starts:
//
// - internal ci goes on with a context whose environment holds no token, which its git runs with
//   and which it gives src/core/project as the `env` of every run;
// - while its steps run, the environment of the process holds no token variable either, so that
//   code which starts a process without an environment of its own, and so with process.env
//   (`hasManifest` of src/core/project runs git that way), passes none on. The variables are put
//   back when the steps end.

import { createGitHub } from '../../core/github/index.js'

/** @import { CommandContext } from '../../cli/context.js' */
/** @import { GitHub } from '../../core/github/index.js' */

/** The variables through which gh and git tools find a GitHub token. */
export const TOKEN_VARIABLES = Object.freeze(['GH_TOKEN', 'GITHUB_TOKEN'])

/**
 * Take the token out of the command's context. The context returned has a copy of the
 * environment without the token variables, and a git that runs with that copy; ctx.github stays,
 * because only gh calls get the token. ctx.env does not change.
 * @param {CommandContext} ctx
 * @returns {{ token: string | null, ctx: CommandContext }} `token` is GH_TOKEN, or GITHUB_TOKEN,
 *   or null when neither is set.
 */
export function takeToken(ctx) {
  const token = ctx.env.GH_TOKEN || ctx.env.GITHUB_TOKEN || null
  const env = Object.fromEntries(
    Object.entries(ctx.env).filter(([name]) => !TOKEN_VARIABLES.includes(name)),
  )
  return { token, ctx: { ...ctx, env, git: ctx.git.with({ env }) } }
}

/**
 * Run the steps while the environment of the process holds no token variable, and put the
 * variables back afterwards, also when a step throws.
 * @template T
 * @param {() => Promise<T>} steps
 * @returns {Promise<T>}
 */
export async function withoutTokenInProcess(steps) {
  /** @type {Array<[string, string]>} */
  const saved = []
  for (const name of TOKEN_VARIABLES) {
    const value = process.env[name]
    if (value === undefined) continue
    saved.push([name, value])
    delete process.env[name]
  }
  try {
    return await steps()
  } finally {
    for (const [name, value] of saved) process.env[name] = value
  }
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

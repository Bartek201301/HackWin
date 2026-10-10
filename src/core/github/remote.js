// The GitHub repository of a git remote URL, in the form that GH_REPO takes.

/**
 * `owner/name` for a github.com remote, `host/owner/name` for another host, or null for a URL
 * that names no GitHub repository, such as a local path.
 * @param {string | null | undefined} url
 * @returns {string | null}
 */
export function parseGitHubRemote(url) {
  if (!url) return null
  const trimmed = url.trim()
  // git@github.com:owner/name.git
  let match = /^[\w.-]+@([\w.-]+):([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(trimmed)
  // https://github.com/owner/name.git, ssh://git@github.com/owner/name.git
  match ??=
    /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(
      trimmed,
    )
  if (!match) return null
  const [, host, owner, name] = match
  return host.toLowerCase() === 'github.com' ? `${owner}/${name}` : `${host}/${owner}/${name}`
}

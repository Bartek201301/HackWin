// The guard in front of every executor that reaches real GitHub. It refuses, before gh runs, a
// call to any repository other than the scenario's fixture repository (`hackwin-sandbox` and the
// build repository above all), a repository deletion, the `delete_repo` scope, every `gh auth`
// command, and any call that would invite, assign or mention a login the harness uses only as a
// name (NAME_ONLY_LOGINS): `builder2`, a real teammate's account, and the fourth member of a team
// of 4, which nobody owns today but anyone may register.
//
// A call passes only when the repository it acts on is known to be the fixture repository: named
// by GH_REPO, `-R`/`--repo`, a repository argument, an endpoint or a full API URL, or the `owner`
// and `name` of a GraphQL request. gh fills `{owner}/{repo}`, and picks the repository of a
// subcommand such as `gh issue create`, from the git remote of the working directory when no
// GH_REPO is set; in a worktree of this build that is Bartek201301/HackWin. So such a call without
// GH_REPO is refused (the incident of 20 October 2026, #106).

import { NAME_ONLY_LOGINS, accounts } from './accounts.js'
import { FIXTURE_REPOS, SANDBOX } from './fixture-repos.js'

/** @import { GhExecutor } from '../../src/core/github/index.js' */

/** How the stderr of a call that the guard refused starts. */
export const REFUSED = 'refused by the test harness: '

/** The repository of this build, which no test may reach. */
export const BUILD_REPO = 'Bartek201301/HackWin'

/** gh commands that act on no repository. */
const REPOSITORY_FREE = new Set(['version', '--version', 'help', '--help', 'search', 'status'])

/**
 * @typedef {object} GuardedCall
 * @property {string} account
 * @property {string[]} args
 * @property {string | null} repo GH_REPO of the call.
 * @property {string | null} refused Why the guard refused the call; null when gh ran.
 * @property {number} code gh's exit code, or 1 when refused.
 */

/**
 * Why the guard refuses this call, or null when it may run.
 * @param {string[]} args
 * @param {{ input?: string, env?: Record<string, string> }} call
 * @param {string} repo The scenario's fixture repository, `owner/name`.
 * @returns {string | null}
 */
export function refusalOf(args, call, repo) {
  const ghRepo = call.env?.GH_REPO ?? null
  const text = args.join(' ')
  if (
    args.some((arg) => arg.toLowerCase().includes(SANDBOX)) ||
    ghRepo?.toLowerCase().endsWith(`/${SANDBOX}`)
  ) {
    return `${SANDBOX} is for the human's live tests; automated tests never touch it`
  }
  if (/delete_repo/i.test(text)) return 'the delete_repo scope is never requested'
  if (args[0] === 'auth') return 'gh auth commands are never run by tests'
  if (args[0] === 'repo' && ['delete', 'archive', 'rename'].includes(args[1])) {
    return 'no repository is ever deleted, archived or renamed by tests'
  }
  if (!FIXTURE_REPOS.some((info) => same(info.repo, repo))) {
    return `${repo} is not a fixture repository, so the guard lets no call through`
  }
  const other = (/** @type {string} */ name) =>
    same(name, BUILD_REPO)
      ? `this scenario calls only ${repo}, not ${BUILD_REPO}: the build repository is never reached by a test`
      : `this scenario calls only ${repo}, not ${name}`
  if (ghRepo !== null && !same(ghRepo, repo)) return other(ghRepo)
  const unresolved = `this call names no repository and GH_REPO is not set, so gh would take the repository from the git remote of the working directory; a scenario's call must name ${repo}`
  if (args[0] === 'api') {
    const endpoint =
      args.find((arg, index) => index > 0 && !arg.startsWith('-') && !isFlagValue(args, index)) ??
      ''
    const path = endpoint
      .replace(/^https?:\/\/api\.github\.com\//i, '')
      .replace(/^\//, '')
      .split('?')[0]
    const named = /^repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path)
    if (named && named[1] === '{owner}' && named[2] === '{repo}') {
      if (ghRepo === null) return unresolved
    } else if (named) {
      if (!same(`${named[1]}/${named[2]}`, repo)) return other(`${named[1]}/${named[2]}`)
    } else if (path === 'graphql') {
      const graphRepo = graphqlRepository(args)
      if (graphRepo !== null && !same(graphRepo, repo)) return other(graphRepo)
    } else if (methodOf(args) !== 'GET') {
      return `a scenario writes only to its fixture repository, not to ${path || 'this endpoint'}`
    }
    if (methodOf(args) === 'DELETE' && named && !named[3]) {
      return 'no repository is ever deleted by tests'
    }
  } else if (!REPOSITORY_FREE.has(args[0] ?? '')) {
    const named = repositoryArgument(args)
    if (named !== null) {
      if (!same(named, repo)) return other(named)
    } else if (ghRepo === null) {
      return unresolved
    }
  }
  for (const login of NAME_ONLY_LOGINS) {
    if (touchesLogin(login, args, call.input)) {
      const who =
        login === accounts.builder2.login
          ? `builder2 (${login}) is a real teammate's account`
          : `${login} is a login the harness uses only as a name`
      return `${who}: it is never invited, assigned or mentioned on real GitHub; scenarios in which it acts run against the fake GitHub`
    }
  }
  return null
}

/**
 * Wrap an executor with the guard. Every call, refused or not, is appended to `calls`.
 * @param {GhExecutor} executor
 * @param {{ repo: string, account: string, calls: GuardedCall[], onCall?: (call: GuardedCall, stderr: string) => void }} options
 * @returns {GhExecutor}
 */
export function guardExecutor(executor, { repo, account, calls, onCall }) {
  return async (args, call = {}) => {
    const refused = refusalOf(args, call, repo)
    /** @type {GuardedCall} */
    const record = { account, args: [...args], repo: call.env?.GH_REPO ?? null, refused, code: 1 }
    calls.push(record)
    if (refused !== null) {
      const stderr = `${REFUSED}${refused}\n`
      onCall?.(record, stderr)
      return { code: 1, stdout: '', stderr }
    }
    const result = await executor(args, call)
    record.code = result.code
    onCall?.(record, result.stderr)
    return result
  }
}

/**
 * @param {string[]} args
 * @param {number} index
 */
function isFlagValue(args, index) {
  return /^(--method|-X|--input|-f|-F|--field|--raw-field|-H|--header|--hostname|--cache|--jq|-q|--template|-t)$/.test(
    args[index - 1] ?? '',
  )
}

/**
 * The HTTP method of a `gh api` call: the one named, or POST when fields or a body are given and
 * none is named, as gh does.
 * @param {string[]} args
 */
function methodOf(args) {
  const index = args.findIndex((arg) => arg === '--method' || arg === '-X')
  if (index !== -1) return String(args[index + 1]).toUpperCase()
  const writes = /^(-f|-F|--field|--raw-field|--input)$/
  return args.some((arg) => writes.test(arg)) ? 'POST' : 'GET'
}

/**
 * True when two repositories are the same, `owner/name` without case; a host in front is ignored.
 * @param {string} a
 * @param {string} b
 */
function same(a, b) {
  const short = (/** @type {string} */ name) => name.toLowerCase().split('/').slice(-2).join('/')
  return short(a) === short(b)
}

/**
 * The repository that a gh subcommand names: the value of `-R` or `--repo`, or the repository
 * argument of `gh repo <action> owner/name`; null when it names none.
 * @param {string[]} args
 * @returns {string | null}
 */
function repositoryArgument(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '-R' || arg === '--repo') return args[index + 1] ?? ''
    if (arg.startsWith('--repo=')) return arg.slice('--repo='.length)
    if (/^-R./.test(arg)) return arg.slice(2)
  }
  if (args[0] === 'repo') {
    const positional = args.slice(2).find((arg) => !arg.startsWith('-') && arg.includes('/'))
    if (positional !== undefined) return positional
  }
  return null
}

/**
 * The repository a `gh api graphql` call names through its `owner` and `name` fields, or in the
 * query as `repository(owner: "...", name: "...")`; null when it names none.
 * @param {string[]} args
 * @returns {string | null}
 */
function graphqlRepository(args) {
  /** @type {Record<string, string>} */
  const fields = {}
  for (let index = 1; index < args.length; index += 1) {
    if (!/^(-f|-F|--field|--raw-field)$/.test(args[index - 1])) continue
    const [key, ...rest] = args[index].split('=')
    fields[key] = rest.join('=')
  }
  if (fields.owner !== undefined && fields.name !== undefined) {
    return `${fields.owner}/${fields.name}`
  }
  const inline = /repository\s*\(\s*owner\s*:\s*"([^"]+)"\s*,\s*name\s*:\s*"([^"]+)"/.exec(
    fields.query ?? '',
  )
  return inline ? `${inline[1]}/${inline[2]}` : null
}

/**
 * True when a call would invite, assign or mention this login: a mention in any argument or in
 * the body, a collaborator or invitation endpoint, an assignee or reviewer flag, or an
 * `assignees`, `reviewers`, `invitee` or `username` field of the JSON body.
 * @param {string} login
 * @param {string[]} args
 * @param {string | undefined} input
 */
function touchesLogin(login, args, input) {
  const name = login.toLowerCase()
  // A login ends where the characters of GitHub logins end.
  const end = '(?![a-z0-9-])'
  const mention = new RegExp(`@${escapeRegExp(name)}${end}`, 'i')
  if (args.some((arg) => mention.test(arg)) || (input !== undefined && mention.test(input))) {
    return true
  }
  const endpoint = new RegExp(`(collaborators|invitations)/${escapeRegExp(name)}${end}`, 'i')
  if (args.some((arg) => endpoint.test(arg))) return true
  const assigning = /^(--(add-)?(assignee|reviewer)|-a|-r)$/
  const named = (/** @type {string} */ arg) =>
    arg
      .toLowerCase()
      .split(',')
      .map((part) => part.trim().replace(/^@/, ''))
      .includes(name)
  if (args.some((arg, index) => assigning.test(args[index - 1] ?? '') && named(arg))) return true
  if (input !== undefined) {
    try {
      const body = JSON.parse(input)
      for (const key of ['assignees', 'reviewers', 'invitee', 'username']) {
        const value = body?.[key]
        const list = Array.isArray(value) ? value : [value]
        if (list.some((entry) => String(entry ?? '').toLowerCase() === name)) return true
      }
    } catch {
      // Not JSON: only the mention check applies.
    }
  }
  return false
}

/** @param {string} text */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

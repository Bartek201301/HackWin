// The guard in front of every executor that reaches real GitHub. It refuses, before gh runs, a
// call to any repository other than the scenario's fixture repository (`hackwin-sandbox` above
// all), a repository deletion, the `delete_repo` scope, every `gh auth` command, and any call
// that would invite, assign or mention a login the harness uses only as a name (NAME_ONLY_LOGINS):
// `builder2`, a real teammate's account, and the fourth member of a team of 4, which nobody owns
// today but anyone may register.

import { NAME_ONLY_LOGINS, accounts } from './accounts.js'
import { SANDBOX } from './fixture-repos.js'

/** @import { GhExecutor } from '../../src/core/github/index.js' */

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
  if (ghRepo !== null && ghRepo.toLowerCase() !== repo.toLowerCase()) {
    return `this scenario calls only ${repo}, not ${ghRepo}`
  }
  if (args[0] === 'api') {
    const endpoint =
      args.find((arg, index) => index > 0 && !arg.startsWith('-') && !isFlagValue(args, index)) ??
      ''
    const path = endpoint.replace(/^\//, '').split('?')[0]
    const named = /^repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path)
    if (named && !(named[1] === '{owner}' && named[2] === '{repo}')) {
      if (`${named[1]}/${named[2]}`.toLowerCase() !== repo.toLowerCase()) {
        return `this scenario calls only ${repo}, not ${named[1]}/${named[2]}`
      }
    }
    if (methodOf(args) === 'DELETE' && named && !named[3]) {
      return 'no repository is ever deleted by tests'
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
      const stderr = `refused by the test harness: ${refused}\n`
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

/** @param {string[]} args */
function methodOf(args) {
  const index = args.findIndex((arg) => arg === '--method' || arg === '-X')
  return index === -1 ? 'GET' : String(args[index + 1]).toUpperCase()
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

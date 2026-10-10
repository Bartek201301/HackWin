// All GitHub access goes through gh (CM7) and through this client. Every typed helper is one or
// more `gh api --method <METHOD> repos/{owner}/{repo}/...` calls with a JSON body on stdin, so a
// fake executor only has to answer REST requests. gh fills {owner} and {repo} from GH_REPO.
// A call that only one lane makes (branch rules, push protection, pinning, CI reruns, the pinned
// merge) goes through GitHub#run or GitHub#api from inside that lane's directory.

import { PreconditionError, RemoteError } from '../runtime/errors.js'

/** @import { GhExecutor, GhResult } from './executor.js' */

const PAGE_SIZE = 100

/**
 * @typedef {object} Issue
 * @property {number} number
 * @property {string} title
 * @property {string} body Empty when the issue has no body.
 * @property {'open' | 'closed'} state
 * @property {string | null} stateReason `completed`, `not_planned`, `reopened` or null.
 * @property {string[]} labels Label names.
 * @property {string[]} assignees Logins.
 * @property {string | null} author Login.
 * @property {string} url
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string | null} closedAt
 * @property {boolean} isPullRequest True for the issue side of a pull request.
 */

/**
 * @typedef {object} PullRequest
 * @property {number} number
 * @property {string} title
 * @property {string} body
 * @property {'open' | 'closed'} state
 * @property {boolean} draft
 * @property {boolean} merged
 * @property {string | null} mergedAt
 * @property {string | null} mergeCommitSha
 * @property {string} headRef The head branch name.
 * @property {string} headSha The full head SHA.
 * @property {string | null} headRepo `owner/name` of the head repository.
 * @property {string} baseRef
 * @property {string[]} labels
 * @property {string | null} author Login.
 * @property {string} url
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string | null} closedAt
 */

/**
 * @typedef {object} PullRequestFile
 * @property {string} path
 * @property {'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged'} status
 * @property {string | null} previousPath The path before a rename.
 */

/**
 * @typedef {object} Comment
 * @property {number} id
 * @property {string} body
 * @property {string | null} author Login.
 * @property {string} url
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {object} Label
 * @property {string} name
 * @property {string} color Six hex digits without `#`.
 * @property {string} description
 */

/**
 * @typedef {object} Repository
 * @property {string} nameWithOwner
 * @property {string} defaultBranch
 * @property {'public' | 'private' | 'internal'} visibility
 * @property {string} url
 * @property {{ admin: boolean, maintain: boolean, push: boolean, triage: boolean, pull: boolean }} permissions
 *   The permissions of the authenticated user.
 */

/**
 * @typedef {object} ApiOptions
 * @property {'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'} [method] GET by default.
 * @property {unknown} [body] Sent as JSON on stdin.
 * @property {Record<string, string | number | undefined>} [query] Appended to the endpoint; undefined values are left out.
 */

export class GitHub {
  /**
   * @param {object} options
   * @param {GhExecutor} options.executor
   * @param {string | null} [options.repo] `owner/name` (or `host/owner/name`), passed to gh as GH_REPO.
   *   Without it gh finds the repository from the remotes of cwd.
   * @param {string} [options.cwd]
   */
  constructor({ executor, repo = null, cwd }) {
    this.executor = executor
    this.repo = repo
    this.cwd = cwd
    /** @type {Promise<string> | undefined} */
    this.loginPromise = undefined
  }

  /**
   * Run gh with these arguments. Throws a RemoteError (exit 3) when gh fails, or a
   * PreconditionError (exit 2) when gh is not logged in.
   * @param {string[]} args
   * @param {{ input?: string }} [options]
   * @returns {Promise<GhResult>}
   */
  async run(args, { input } = {}) {
    const result = await this.executor(args, {
      input,
      cwd: this.cwd,
      env: this.repo ? { GH_REPO: this.repo } : {},
    })
    if (result.code !== 0) throw ghFailure(args, result)
    return result
  }

  /**
   * One REST call through `gh api`. Returns the parsed JSON response, or null for an empty one.
   * @param {string} endpoint For example `repos/{owner}/{repo}/issues/3`.
   * @param {ApiOptions} [options]
   * @returns {Promise<any>}
   */
  async api(endpoint, { method = 'GET', body, query } = {}) {
    const args = ['api', '--method', method, withQuery(endpoint, query)]
    if (body !== undefined) args.push('--input', '-')
    const result = await this.run(args, {
      input: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = result.stdout.trim()
    return text === '' ? null : JSON.parse(text)
  }

  /**
   * Every item of a paginated REST list, 100 per page.
   * @param {string} endpoint
   * @param {{ query?: ApiOptions['query'], maxPages?: number }} [options]
   * @returns {Promise<any[]>}
   */
  async apiPages(endpoint, { query = {}, maxPages = 50 } = {}) {
    const items = []
    for (let page = 1; page <= maxPages; page += 1) {
      const batch = await this.api(endpoint, { query: { ...query, per_page: PAGE_SIZE, page } })
      if (!Array.isArray(batch)) {
        throw new RemoteError(`GitHub returned no list for ${endpoint}`)
      }
      items.push(...batch)
      if (batch.length < PAGE_SIZE) break
    }
    return items
  }

  /**
   * The login gh is authenticated with (5.4, A4). Asked once per client.
   * @returns {Promise<string>}
   */
  login() {
    this.loginPromise ??= this.api('user').then((user) => String(user.login))
    return this.loginPromise
  }

  /** @returns {Promise<Repository>} */
  async repository() {
    const raw = await this.api('repos/{owner}/{repo}')
    const permissions = raw.permissions ?? {}
    return {
      nameWithOwner: raw.full_name,
      defaultBranch: raw.default_branch,
      visibility: raw.visibility ?? (raw.private ? 'private' : 'public'),
      url: raw.html_url,
      permissions: {
        admin: Boolean(permissions.admin),
        maintain: Boolean(permissions.maintain),
        push: Boolean(permissions.push),
        triage: Boolean(permissions.triage),
        pull: Boolean(permissions.pull),
      },
    }
  }

  // Issues. Labels, assignees and comments of a pull request use these helpers with its number.

  /**
   * @param {number} number
   * @returns {Promise<Issue | null>} Null when no such issue exists.
   */
  async getIssue(number) {
    return nullWhenNotFound(async () =>
      toIssue(await this.api(`repos/{owner}/{repo}/issues/${number}`)),
    )
  }

  /**
   * Issues without pull requests.
   * @param {object} [options]
   * @param {'open' | 'closed' | 'all'} [options.state]
   * @param {string[]} [options.labels] Only issues with all of these labels.
   * @param {string} [options.since] Only issues updated at or after this ISO 8601 time.
   * @param {string} [options.assignee] A login, `none` or `*`.
   * @returns {Promise<Issue[]>}
   */
  async listIssues({ state = 'open', labels, since, assignee } = {}) {
    const raw = await this.apiPages('repos/{owner}/{repo}/issues', {
      query: { state, labels: labels?.join(','), since, assignee },
    })
    return raw.filter((item) => !item.pull_request).map(toIssue)
  }

  /**
   * @param {{ title: string, body?: string, labels?: string[], assignees?: string[] }} issue
   * @returns {Promise<Issue>}
   */
  async createIssue({ title, body = '', labels = [], assignees = [] }) {
    return toIssue(
      await this.api('repos/{owner}/{repo}/issues', {
        method: 'POST',
        body: { title, body, labels, assignees },
      }),
    )
  }

  /**
   * @param {number} number
   * @param {{ title?: string, body?: string, state?: 'open' | 'closed', stateReason?: 'completed' | 'not_planned' | 'reopened' }} changes
   * @returns {Promise<Issue>}
   */
  async updateIssue(number, { title, body, state, stateReason }) {
    return toIssue(
      await this.api(`repos/{owner}/{repo}/issues/${number}`, {
        method: 'PATCH',
        body: definedOnly({ title, body, state, state_reason: stateReason }),
      }),
    )
  }

  /**
   * @param {number} number Issue or pull request.
   * @param {string[]} labels
   * @returns {Promise<string[]>} The labels of the issue afterwards.
   */
  async addLabels(number, labels) {
    const raw = await this.api(`repos/{owner}/{repo}/issues/${number}/labels`, {
      method: 'POST',
      body: { labels },
    })
    return raw.map((/** @type {any} */ label) => label.name)
  }

  /**
   * Remove a label; a label the issue does not carry is not an error.
   * @param {number} number Issue or pull request.
   * @param {string} label
   * @returns {Promise<void>}
   */
  async removeLabel(number, label) {
    await nullWhenNotFound(() =>
      this.api(`repos/{owner}/{repo}/issues/${number}/labels/${encodeURIComponent(label)}`, {
        method: 'DELETE',
      }),
    )
  }

  /**
   * @param {number} number Issue or pull request.
   * @param {string[]} logins
   * @returns {Promise<void>}
   */
  async addAssignees(number, logins) {
    await this.api(`repos/{owner}/{repo}/issues/${number}/assignees`, {
      method: 'POST',
      body: { assignees: logins },
    })
  }

  /**
   * @param {number} number Issue or pull request.
   * @param {string[]} logins
   * @returns {Promise<void>}
   */
  async removeAssignees(number, logins) {
    await this.api(`repos/{owner}/{repo}/issues/${number}/assignees`, {
      method: 'DELETE',
      body: { assignees: logins },
    })
  }

  // Comments of issues and pull requests.

  /**
   * @param {number} number Issue or pull request.
   * @returns {Promise<Comment[]>} Oldest first.
   */
  async listComments(number) {
    return (await this.apiPages(`repos/{owner}/{repo}/issues/${number}/comments`)).map(toComment)
  }

  /**
   * @param {number} number Issue or pull request.
   * @param {string} body
   * @returns {Promise<Comment>}
   */
  async createComment(number, body) {
    return toComment(
      await this.api(`repos/{owner}/{repo}/issues/${number}/comments`, {
        method: 'POST',
        body: { body },
      }),
    )
  }

  /**
   * @param {number} id
   * @param {string} body
   * @returns {Promise<Comment>}
   */
  async updateComment(id, body) {
    return toComment(
      await this.api(`repos/{owner}/{repo}/issues/comments/${id}`, {
        method: 'PATCH',
        body: { body },
      }),
    )
  }

  // Labels of the repository.

  /** @returns {Promise<Label[]>} */
  async listLabels() {
    return (await this.apiPages('repos/{owner}/{repo}/labels')).map(toLabel)
  }

  /**
   * @param {Label} label
   * @returns {Promise<Label>}
   */
  async createLabel({ name, color, description }) {
    return toLabel(
      await this.api('repos/{owner}/{repo}/labels', {
        method: 'POST',
        body: { name, color, description },
      }),
    )
  }

  /**
   * @param {string} name
   * @param {{ newName?: string, color?: string, description?: string }} changes
   * @returns {Promise<Label>}
   */
  async updateLabel(name, { newName, color, description }) {
    return toLabel(
      await this.api(`repos/{owner}/{repo}/labels/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        body: definedOnly({ new_name: newName, color, description }),
      }),
    )
  }

  /**
   * @param {string} name
   * @returns {Promise<boolean>} False when no such label existed.
   */
  async deleteLabel(name) {
    const deleted = await nullWhenNotFound(async () => {
      await this.api(`repos/{owner}/{repo}/labels/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      })
      return true
    })
    return deleted === true
  }

  // Pull requests.

  /**
   * @param {number} number
   * @returns {Promise<PullRequest | null>} Null when no such pull request exists.
   */
  async getPullRequest(number) {
    return nullWhenNotFound(async () =>
      toPullRequest(await this.api(`repos/{owner}/{repo}/pulls/${number}`)),
    )
  }

  /**
   * @param {object} [options]
   * @param {'open' | 'closed' | 'all'} [options.state]
   * @param {string} [options.head] Only pull requests from this branch name.
   * @param {string} [options.base] Only pull requests into this branch.
   * @returns {Promise<PullRequest[]>}
   */
  async listPullRequests({ state = 'open', head, base } = {}) {
    const raw = await this.apiPages('repos/{owner}/{repo}/pulls', { query: { state, base } })
    const pulls = raw.map(toPullRequest)
    return head === undefined ? pulls : pulls.filter((pull) => pull.headRef === head)
  }

  /**
   * Open a pull request, never as a draft (8.4).
   * @param {{ title: string, head: string, base: string, body: string }} pull
   * @returns {Promise<PullRequest>}
   */
  async createPullRequest({ title, head, base, body }) {
    return toPullRequest(
      await this.api('repos/{owner}/{repo}/pulls', {
        method: 'POST',
        body: { title, head, base, body, draft: false },
      }),
    )
  }

  /**
   * @param {number} number
   * @param {{ title?: string, body?: string, state?: 'open' | 'closed', base?: string }} changes
   * @returns {Promise<PullRequest>}
   */
  async updatePullRequest(number, { title, body, state, base }) {
    return toPullRequest(
      await this.api(`repos/{owner}/{repo}/pulls/${number}`, {
        method: 'PATCH',
        body: definedOnly({ title, body, state, base }),
      }),
    )
  }

  /**
   * The files a pull request changes, as GitHub lists them (at most 3000).
   * @param {number} number
   * @returns {Promise<PullRequestFile[]>}
   */
  async listPullRequestFiles(number) {
    const raw = await this.apiPages(`repos/{owner}/{repo}/pulls/${number}/files`, { maxPages: 30 })
    return raw.map((file) => ({
      path: file.filename,
      status: file.status,
      previousPath: file.previous_filename ?? null,
    }))
  }
}

/**
 * @param {object} options
 * @param {GhExecutor} options.executor
 * @param {string | null} [options.repo]
 * @param {string} [options.cwd]
 * @returns {GitHub}
 */
export function createGitHub(options) {
  return new GitHub(options)
}

/**
 * The error for a failed gh call: not logged in is a precondition (exit 2), everything else a
 * GitHub or network failure (exit 3) with the HTTP status when gh printed one.
 * @param {string[]} args
 * @param {GhResult} result
 * @returns {Error}
 */
export function ghFailure(args, result) {
  const stderr = result.stderr.trim()
  const lines = stderr.split('\n').filter((line) => line.trim() !== '')
  if (result.code === 4 || /gh auth login/.test(stderr)) {
    return new PreconditionError('gh is not logged in to GitHub', {
      resolve: { command: 'gh auth login', dir: 'any directory' },
    })
  }
  const status = /\(HTTP (\d{3})\)/.exec(stderr)?.[1]
  const reason = lines[0] ?? `exit code ${result.code}`
  return new RemoteError(`GitHub call failed: gh ${describeArgs(args)}: ${reason}`, {
    status: status === undefined ? undefined : Number(status),
    tail: lines.slice(-5),
  })
}

/**
 * Run a lookup and turn GitHub's "not found" (HTTP 404) into null.
 * @template T
 * @param {() => Promise<T>} lookup
 * @returns {Promise<T | null>}
 */
export async function nullWhenNotFound(lookup) {
  try {
    return await lookup()
  } catch (error) {
    if (error instanceof RemoteError && error.status === 404) return null
    throw error
  }
}

/**
 * @param {string[]} args
 * @returns {string}
 */
function describeArgs(args) {
  // A request body never reaches the message: it travels on stdin.
  return args.slice(0, 4).join(' ')
}

/**
 * @param {string} endpoint
 * @param {ApiOptions['query']} query
 * @returns {string}
 */
function withQuery(endpoint, query) {
  if (!query) return endpoint
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value))
  }
  const text = params.toString()
  return text === '' ? endpoint : `${endpoint}${endpoint.includes('?') ? '&' : '?'}${text}`
}

/**
 * @param {Record<string, unknown>} object
 * @returns {Record<string, unknown>}
 */
function definedOnly(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined))
}

/**
 * @param {any} raw
 * @returns {string[]}
 */
function labelNames(raw) {
  return (raw ?? []).map((/** @type {any} */ label) =>
    typeof label === 'string' ? label : label.name,
  )
}

/**
 * @param {any} raw
 * @returns {Issue}
 */
function toIssue(raw) {
  return {
    number: raw.number,
    title: raw.title ?? '',
    body: raw.body ?? '',
    state: raw.state,
    stateReason: raw.state_reason ?? null,
    labels: labelNames(raw.labels),
    assignees: (raw.assignees ?? []).map((/** @type {any} */ user) => user.login),
    author: raw.user?.login ?? null,
    url: raw.html_url,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    closedAt: raw.closed_at ?? null,
    isPullRequest: Boolean(raw.pull_request),
  }
}

/**
 * @param {any} raw
 * @returns {PullRequest}
 */
function toPullRequest(raw) {
  return {
    number: raw.number,
    title: raw.title ?? '',
    body: raw.body ?? '',
    state: raw.state,
    draft: Boolean(raw.draft),
    merged: Boolean(raw.merged) || Boolean(raw.merged_at),
    mergedAt: raw.merged_at ?? null,
    mergeCommitSha: raw.merge_commit_sha ?? null,
    headRef: raw.head?.ref,
    headSha: raw.head?.sha,
    headRepo: raw.head?.repo?.full_name ?? null,
    baseRef: raw.base?.ref,
    labels: labelNames(raw.labels),
    author: raw.user?.login ?? null,
    url: raw.html_url,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    closedAt: raw.closed_at ?? null,
  }
}

/**
 * @param {any} raw
 * @returns {Comment}
 */
function toComment(raw) {
  return {
    id: raw.id,
    body: raw.body ?? '',
    author: raw.user?.login ?? null,
    url: raw.html_url,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  }
}

/**
 * @param {any} raw
 * @returns {Label}
 */
function toLabel(raw) {
  return { name: raw.name, color: raw.color, description: raw.description ?? '' }
}

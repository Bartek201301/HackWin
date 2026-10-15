// The fake GitHub: an in-memory repository behind the executor seam of src/core/github
// (docs/build/contracts.md section 4.3). It answers the `gh api` requests of the typed helpers,
// and a few calls of one lane in the form docs/verification.md recorded: the pinned merge
// `gh pr merge <N> --merge --match-head-commit <SHA>`, `gh issue pin`, check runs, and the rule
// sets that `setup` creates and the protection reader and the reset read (rows 5 and 6).
//
// A lane registers handlers for the calls that only it makes from its own test files:
//
//   fake.on('GET repos/{owner}/{repo}/environments', (request) => ({ environments: [] }))
//   fake.on('run rerun', (request) => rawResult({ stdout: '' }))
//
// A handler gets the parsed request and returns the JSON response, nothing for an empty one,
// rawResult() for exact gh output, or throws httpError(status, message). A request that no
// handler answers fails with a message that names it, so a missing handler never passes for a
// 404. Handlers registered later win over earlier ones and over the built-in ones.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { systemClock } from '../../src/core/runtime/clock.js'
import { BUILDER3_LOGIN, accounts } from './accounts.js'

/** @import { GhExecutor } from '../../src/core/github/index.js' */
/** @import { Clock } from '../../src/core/runtime/clock.js' */

/** The repository the fake answers for when the state names none. */
export const DEFAULT_FAKE_REPO = 'hackwin-test/app'

/** The GitHub Actions app, which produces the check runs (docs/verification.md, row 5). */
const ACTIONS_APP = Object.freeze({ id: 15368, slug: 'github-actions', name: 'GitHub Actions' })

const PIN_LIMIT = 3

/** GitHub's answer to every rule set request where it offers none (docs/verification.md, E3). */
export const RULESETS_NOT_OFFERED =
  'Upgrade to GitHub Pro or make this repository public to enable this feature.'

/** The bypass actor of the repository admin role (docs/verification.md, row 6). */
const ADMIN_ROLE_ID = 5
const RAW = Symbol('raw gh result')
const CLOSING_REFERENCE =
  /\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\b:?\s+#(\d+)\b/gi

/** An HTTP error of the fake: gh exits 1 and prints `gh: <message> (HTTP <status>)`. */
export class FakeGitHubError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   */
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/**
 * Throw this from a handler for an HTTP error.
 * @param {number} status
 * @param {string} message
 * @returns {FakeGitHubError}
 */
export function httpError(status, message) {
  return new FakeGitHubError(status, message)
}

/**
 * Return this from a handler for exact gh output.
 * @param {{ code?: number, stdout?: string, stderr?: string }} result
 */
export function rawResult({ code = 0, stdout = '', stderr = '' }) {
  return { [RAW]: true, code, stdout, stderr }
}

/**
 * @typedef {object} FakeComment
 * @property {number} id
 * @property {string} body
 * @property {string} author
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {object} FakePull
 * @property {string} head The head branch.
 * @property {string | null} headRepo The repository of the head branch, `owner/name`: the fake's
 *   own repository, a fork's, or null for a fork that was deleted (`head.repo` null).
 * @property {string | null} headSha Set at creation; follows the head branch while it is open
 *   and the head branch is in the fake's own repository.
 * @property {string} base
 * @property {boolean} draft
 * @property {boolean} merged
 * @property {string | null} mergedAt
 * @property {string | null} mergeCommitSha
 * @property {Array<{ path: string, status: string, previousPath: string | null }> | null} files
 *   The changed files; null computes them from the linked origin.
 */

/**
 * An issue, or the issue side of a pull request (`pull` set). They share the numbers, as on GitHub.
 * @typedef {object} FakeItem
 * @property {number} number
 * @property {string} title
 * @property {string} body
 * @property {'open' | 'closed'} state
 * @property {string | null} stateReason
 * @property {string[]} labels
 * @property {string[]} assignees
 * @property {string} author
 * @property {FakeComment[]} comments
 * @property {boolean} pinned
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string | null} closedAt
 * @property {number | null} milestone The number of its milestone in `state.milestones`, or null.
 * @property {FakePull | null} pull
 */

/**
 * A milestone of the repository, in GitHub's field names. An issue or pull request carries one
 * by its number, and its JSON gives the milestone as GitHub returns it on an issue: with
 * `html_url` and `creator`, and with `open_issues` and `closed_issues` as given, or else counted
 * over the issues and pull requests of the state that carry it, as GitHub counts them.
 * @typedef {object} FakeMilestone
 * @property {number} id
 * @property {number} number
 * @property {string} title
 * @property {'open' | 'closed'} state
 * @property {string | null} description
 * @property {string | null} due_on
 * @property {number} [open_issues]
 * @property {number} [closed_issues]
 * @property {string} creator The creator's login.
 * @property {string} created_at
 * @property {string} updated_at
 * @property {string | null} closed_at
 */

/**
 * @typedef {object} FakeCheckRun
 * @property {number} id
 * @property {string} name
 * @property {'queued' | 'in_progress' | 'completed'} status
 * @property {string | null} conclusion `success`, `failure`, ... or null while not completed.
 */

/**
 * A rule set of the repository, as `POST .../rulesets` takes it and `GET .../rulesets/<id>`
 * returns it. A key set to undefined, such as `bypass_actors` or `current_user_can_bypass`, is
 * left out of every response.
 * @typedef {object} FakeRuleset
 * @property {number} id
 * @property {string} name
 * @property {string} target `branch` by default.
 * @property {'active' | 'disabled' | 'evaluate'} enforcement
 * @property {{ ref_name?: { include?: string[], exclude?: string[] } }} [conditions] Without
 *   them the rule set targets no branch.
 * @property {Array<{ type: string, parameters?: object }>} rules
 * @property {Array<{ actor_id: number | null, actor_type: string, bypass_mode: string }>} [bypass_actors]
 * @property {string} [current_user_can_bypass] Given, it is returned for every caller; otherwise
 *   it is `always` for an admin of the repository when the admin role is a bypass actor, and
 *   `never` for everyone else.
 * @property {string} source_type
 * @property {string} source
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * @typedef {object} FakeState
 * @property {string} repo `owner/name`.
 * @property {string} login The caller's login, for `fake.executor`.
 * @property {string} defaultBranch
 * @property {'public' | 'private'} visibility
 * @property {Record<string, string>} collaborators Login to permission: `admin`, `maintain`,
 *   `write`, `triage` or `read`.
 * @property {Array<{ id: number, login: string, permission: string, inviter: string }>} invitations
 * @property {Array<{ name: string, color: string, description: string }>} labels
 * @property {FakeMilestone[]} milestones
 * @property {FakeItem[]} items Issues and pull requests, by number.
 * @property {Record<string, string>} branches Branch to SHA; with `origin`, a branch missing
 *   here is read from the origin.
 * @property {Record<string, FakeCheckRun[]>} checks Check runs by commit SHA.
 * @property {string[]} requiredChecks Check names a merge into the default branch requires.
 * @property {FakeRuleset[]} rulesets The repository's rule sets, in the order they were created.
 * @property {boolean} rulesetsOffered False answers every rule set request with HTTP 403, as
 *   GitHub does on a private repository of a personal account without GitHub Pro.
 * @property {string | null} origin A bare repository that holds the branches; merges then make
 *   real merge commits in it.
 * @property {number} nextNumber
 * @property {number} nextId
 * @property {number} nextRulesetId
 * @property {number} nextMilestoneNumber
 */

/**
 * The request a handler gets.
 * @typedef {object} FakeRequest
 * @property {string[]} args The gh arguments.
 * @property {string | undefined} input stdin.
 * @property {Record<string, string>} env The extra environment of the call.
 * @property {string} login Who calls.
 * @property {string | null} method The HTTP method of `gh api`, else null.
 * @property {string | null} endpoint The path of `gh api` with `{owner}/{repo}`, without the query.
 * @property {Record<string, string>} params The `:name` parts of the matched pattern.
 * @property {Record<string, string>} query
 * @property {any} body The JSON on stdin, or the `-f`/`-F` fields.
 * @property {Record<string, string>} fields The `-f`/`-F` fields as given.
 * @property {FakeState} state
 */

/**
 * @typedef {(request: FakeRequest) => unknown} FakeHandler
 */

/**
 * @typedef {object} FakeCall
 * @property {string} login
 * @property {string[]} args
 * @property {string | null} method
 * @property {string | null} endpoint
 * @property {any} body
 * @property {number} code
 */

/**
 * Create a fake GitHub. Every field of the state is optional:
 *
 *   createFakeGitHub({
 *     repo: 'acme/app', login: 'lead',
 *     collaborators: { lead: 'admin', 'test-bot-builder': 'write' },
 *     labels: ['ready', { name: 'in-review', color: '1d76db' }],
 *     milestones: [{ number: 1, title: 'Wave 1', due_on: '2026-10-25T10:00:00Z' }],
 *     issues: [{ number: 12, title: 'Task', body, labels: ['ready'], milestone: 1 }],
 *     pulls: [{ number: 13, title, head: 'task/12-task', headSha, body, draft: false }],
 *     branches: { main: sha }, checks: { [sha]: [{ name: 'hackwin', conclusion: 'success' }] },
 *     requiredChecks: ['hackwin'], rulesets: [ruleset], rulesetsOffered: true,
 *     origin: fixture.origin, nextNumber: 40, clock,
 *   })
 * @param {object} [initial]
 * @param {string} [initial.repo]
 * @param {string} [initial.login]
 * @param {string} [initial.defaultBranch]
 * @param {'public' | 'private'} [initial.visibility]
 * @param {Record<string, string>} [initial.collaborators]
 * @param {Array<string | { name: string, color?: string, description?: string }>} [initial.labels]
 * @param {Array<Partial<FakeMilestone> & { title: string }>} [initial.milestones] Milestone
 *   bodies; `number` is given when missing. An issue or pull request names one with `milestone`,
 *   its number.
 * @param {Array<Partial<FakeItem> & { title: string }>} [initial.issues]
 * @param {Array<Partial<FakeItem> & Partial<FakePull> & { title: string, head: string }>} [initial.pulls]
 *   `headRepo` is the fake's repository unless given; a pull request from a fork gives the
 *   fork's `owner/name`, or null for a deleted fork, with its `headSha` and `files`.
 * @param {Record<string, string>} [initial.branches]
 * @param {Record<string, Array<Partial<FakeCheckRun> & { name: string }>>} [initial.checks]
 * @param {string[]} [initial.requiredChecks]
 * @param {Array<Partial<FakeRuleset> & { name: string }>} [initial.rulesets] Rule set bodies;
 *   `id` is given when missing.
 * @param {boolean} [initial.rulesetsOffered] True by default.
 * @param {string} [initial.origin]
 * @param {number} [initial.nextNumber] The number of the next issue or pull request.
 * @param {Clock} [initial.clock]
 */
export function createFakeGitHub(initial = {}) {
  const clock = initial.clock ?? systemClock
  const now = () =>
    clock
      .now()
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z')

  /** @type {FakeState} */
  const state = {
    repo: initial.repo ?? DEFAULT_FAKE_REPO,
    login: initial.login ?? accounts.lead.login,
    defaultBranch: initial.defaultBranch ?? 'main',
    visibility: initial.visibility ?? 'public',
    collaborators: initial.collaborators ?? {
      [accounts.lead.login]: 'admin',
      [accounts.builder1.login]: 'write',
      [accounts.builder2.login]: 'write',
      [BUILDER3_LOGIN]: 'write',
    },
    invitations: [],
    labels: [],
    milestones: [],
    items: [],
    branches: { ...initial.branches },
    checks: {},
    requiredChecks: [...(initial.requiredChecks ?? [])],
    rulesets: [],
    rulesetsOffered: initial.rulesetsOffered ?? true,
    origin: initial.origin ?? null,
    nextNumber: 1,
    nextId: 1,
    nextRulesetId: 1,
    nextMilestoneNumber: 1,
  }

  const nextId = () => state.nextId++
  const nextNumber = () => state.nextNumber++

  // The initial state.

  for (const label of initial.labels ?? []) {
    ensureLabel(typeof label === 'string' ? { name: label } : label)
  }
  for (const milestone of initial.milestones ?? []) addMilestone(milestone)
  const numbered = [...(initial.issues ?? []), ...(initial.pulls ?? [])]
  state.nextNumber = Math.max(
    initial.nextNumber ?? 1,
    ...numbered.map((item) => (item.number ?? 0) + 1),
  )
  for (const issue of initial.issues ?? []) addItem(issue, null)
  for (const pull of initial.pulls ?? []) {
    const headRepo = pull.headRepo === undefined ? state.repo : pull.headRepo
    addItem(pull, {
      head: pull.head,
      headRepo,
      headSha: pull.headSha ?? (headRepo === state.repo ? branchSha(pull.head) : null),
      base: pull.base ?? state.defaultBranch,
      draft: pull.draft ?? false,
      merged: pull.merged ?? false,
      mergedAt: pull.mergedAt ?? null,
      mergeCommitSha: pull.mergeCommitSha ?? null,
      files: pull.files ?? null,
    })
  }
  state.items.sort((a, b) => a.number - b.number)
  for (const [sha, runs] of Object.entries(initial.checks ?? {})) {
    for (const run of runs) addCheckRun(sha, run)
  }
  for (const ruleset of initial.rulesets ?? []) addRuleset(ruleset)

  /**
   * @param {Partial<FakeItem> & { title: string }} input
   * @param {FakePull | null} pull
   */
  function addItem(input, pull) {
    const time = now()
    const state_ = input.state ?? 'open'
    /** @type {FakeItem} */
    const item = {
      number: input.number ?? nextNumber(),
      title: input.title,
      body: input.body ?? '',
      state: state_,
      stateReason: input.stateReason ?? (state_ === 'closed' && !pull ? 'completed' : null),
      labels: [...(input.labels ?? [])],
      assignees: [...(input.assignees ?? [])],
      author: input.author ?? state.login,
      comments: (input.comments ?? []).map((comment) => ({
        id: comment.id ?? nextId(),
        body: comment.body ?? '',
        author: comment.author ?? state.login,
        createdAt: comment.createdAt ?? time,
        updatedAt: comment.updatedAt ?? comment.createdAt ?? time,
      })),
      pinned: input.pinned ?? false,
      createdAt: input.createdAt ?? time,
      updatedAt: input.updatedAt ?? input.createdAt ?? time,
      closedAt: input.closedAt ?? (state_ === 'closed' ? time : null),
      milestone: input.milestone ?? null,
      pull,
    }
    if (state.items.some((other) => other.number === item.number)) {
      throw new Error(`fake GitHub: #${item.number} exists twice in the initial state`)
    }
    if (item.milestone !== null) findMilestone(item.milestone)
    for (const name of item.labels) ensureLabel({ name })
    state.items.push(item)
    return item
  }

  /** @param {{ name: string, color?: string, description?: string }} label */
  function ensureLabel({ name, color = 'ededed', description = '' }) {
    const existing = findLabel(name)
    if (existing) return existing
    const label = { name, color, description }
    state.labels.push(label)
    return label
  }

  /** @param {string} name */
  function findLabel(name) {
    return state.labels.find((label) => label.name.toLowerCase() === name.toLowerCase())
  }

  /**
   * Add a milestone as `POST .../milestones` creates it: open, without a description or a due
   * date unless the body names them, with the next free number unless it names one.
   * @param {Partial<FakeMilestone> & { title: string }} body
   * @returns {FakeMilestone}
   */
  function addMilestone(body) {
    const time = now()
    const number = body.number ?? state.nextMilestoneNumber
    if (state.milestones.some((other) => other.number === number)) {
      throw new Error(`fake GitHub: milestone ${number} exists twice`)
    }
    state.nextMilestoneNumber = Math.max(state.nextMilestoneNumber, number + 1)
    const milestoneState = body.state ?? 'open'
    /** @type {FakeMilestone} */
    const milestone = {
      id: body.id ?? nextId(),
      number,
      title: body.title,
      state: milestoneState,
      description: body.description ?? null,
      due_on: body.due_on ?? null,
      open_issues: body.open_issues,
      closed_issues: body.closed_issues,
      creator: body.creator ?? state.login,
      created_at: body.created_at ?? time,
      updated_at: body.updated_at ?? body.created_at ?? time,
      closed_at: body.closed_at ?? (milestoneState === 'closed' ? time : null),
    }
    state.milestones.push(milestone)
    return milestone
  }

  /**
   * The milestone with this number. An item of the state that names a missing one is a mistake
   * of the test, so it throws a plain error, not an HTTP one.
   * @param {number} number
   */
  function findMilestone(number) {
    const found = state.milestones.find((milestone) => milestone.number === number)
    if (!found) throw new Error(`fake GitHub: there is no milestone ${number} in the state`)
    return found
  }

  /**
   * @param {string} sha
   * @param {Partial<FakeCheckRun> & { name: string }} run
   */
  function addCheckRun(sha, run) {
    const status = run.status ?? 'completed'
    /** @type {FakeCheckRun} */
    const check = {
      id: run.id ?? nextId(),
      name: run.name,
      status,
      conclusion: run.conclusion ?? (status === 'completed' ? 'success' : null),
    }
    ;(state.checks[sha] ??= []).push(check)
    return check
  }

  /**
   * Add a rule set as `POST .../rulesets` creates it: a branch rule set without rules or bypass
   * actors unless the body names them.
   * @param {Partial<FakeRuleset> & { name: string }} body
   * @returns {FakeRuleset}
   */
  function addRuleset(body) {
    const time = now()
    const id = body.id ?? state.nextRulesetId
    state.nextRulesetId = Math.max(state.nextRulesetId, id + 1)
    /** @type {FakeRuleset} */
    const ruleset = {
      target: 'branch',
      enforcement: 'active',
      rules: [],
      bypass_actors: [],
      ...body,
      id,
      source_type: 'Repository',
      source: state.repo,
      created_at: time,
      updated_at: time,
    }
    state.rulesets.push(ruleset)
    return ruleset
  }

  // Branches: the state's own map first, then the linked origin.

  /**
   * @param {string} branch
   * @returns {string | null}
   */
  function branchSha(branch) {
    if (state.branches[branch] !== undefined) return state.branches[branch]
    if (!state.origin) return null
    try {
      return originGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]).trim()
    } catch {
      return null
    }
  }

  /**
   * @param {string} branch
   * @param {string | null} sha Null deletes the branch.
   */
  function setBranch(branch, sha) {
    if (state.origin && state.branches[branch] === undefined) {
      if (sha === null) originGit(['update-ref', '-d', `refs/heads/${branch}`])
      else originGit(['update-ref', `refs/heads/${branch}`, sha])
      return
    }
    if (sha === null) delete state.branches[branch]
    else state.branches[branch] = sha
  }

  /**
   * Git in the linked origin, without the user's configuration.
   * @param {string[]} args
   * @returns {string}
   */
  function originGit(args) {
    /** @type {Record<string, string | undefined>} */
    const env = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (!key.startsWith('GIT_')) env[key] = value
    }
    Object.assign(env, {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'GitHub',
      GIT_AUTHOR_EMAIL: 'noreply@github.com',
      GIT_COMMITTER_NAME: 'GitHub',
      GIT_COMMITTER_EMAIL: 'noreply@github.com',
      LC_ALL: 'C',
    })
    return execFileSync('git', args, {
      cwd: /** @type {string} */ (state.origin),
      env: /** @type {NodeJS.ProcessEnv} */ (env),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }

  /**
   * The tree of a clean merge in the linked origin, or null when the merge has conflicts.
   * @param {string} base
   * @param {string} head
   * @returns {string | null}
   */
  function mergeTreeInOrigin(base, head) {
    try {
      return originGit(['merge-tree', '--write-tree', '--no-messages', base, head]).split('\n')[0]
    } catch (error) {
      if (/** @type {any} */ (error).status === 1) return null
      throw error
    }
  }

  // Lookups.

  /** @param {string | number} number */
  function item(number) {
    const found = state.items.find((entry) => entry.number === Number(number))
    if (!found) throw httpError(404, 'Not Found')
    return found
  }

  /** @param {string | number} number */
  function pullItem(number) {
    const found = item(number)
    if (!found.pull) throw httpError(404, 'Not Found')
    return /** @type {FakeItem & { pull: FakePull }} */ (found)
  }

  /** @param {FakeItem & { pull: FakePull }} entry */
  function headShaOf(entry) {
    if (entry.state === 'open' && entry.pull.headRepo === state.repo) {
      const sha = branchSha(entry.pull.head)
      if (sha !== null) entry.pull.headSha = sha
    }
    return entry.pull.headSha
  }

  /** @param {FakeItem} entry */
  function touch(entry) {
    entry.updatedAt = now()
  }

  // The JSON GitHub returns.

  const [owner] = state.repo.split('/')
  /** @param {string} login */
  const user = (login) => ({ login, type: 'User' })
  /** @param {FakeItem} entry */
  const htmlUrl = (entry) =>
    `https://github.com/${state.repo}/${entry.pull ? 'pull' : 'issues'}/${entry.number}`
  /** @param {string} name */
  const labelJson = (name) => {
    const label = findLabel(name) ?? { name, color: 'ededed', description: '' }
    return { name: label.name, color: label.color, description: label.description, default: false }
  }

  /** @param {FakeMilestone} milestone */
  function milestoneJson(milestone) {
    const carriers = state.items.filter((entry) => entry.milestone === milestone.number)
    const count = (/** @type {'open' | 'closed'} */ wanted) =>
      carriers.filter((entry) => entry.state === wanted).length
    return {
      id: milestone.id,
      number: milestone.number,
      title: milestone.title,
      description: milestone.description,
      state: milestone.state,
      open_issues: milestone.open_issues ?? count('open'),
      closed_issues: milestone.closed_issues ?? count('closed'),
      creator: user(milestone.creator),
      html_url: `https://github.com/${state.repo}/milestone/${milestone.number}`,
      created_at: milestone.created_at,
      updated_at: milestone.updated_at,
      closed_at: milestone.closed_at,
      due_on: milestone.due_on,
    }
  }

  /** @param {FakeItem} entry */
  const itemMilestoneJson = (entry) =>
    entry.milestone === null ? null : milestoneJson(findMilestone(entry.milestone))

  /** @param {FakeItem} entry */
  function issueJson(entry) {
    return {
      id: entry.number * 1000,
      number: entry.number,
      title: entry.title,
      body: entry.body,
      state: entry.state,
      state_reason: entry.stateReason,
      labels: entry.labels.map(labelJson),
      assignee: entry.assignees[0] ? user(entry.assignees[0]) : null,
      assignees: entry.assignees.map(user),
      user: user(entry.author),
      milestone: itemMilestoneJson(entry),
      comments: entry.comments.length,
      html_url: htmlUrl(entry),
      created_at: entry.createdAt,
      updated_at: entry.updatedAt,
      closed_at: entry.closedAt,
      ...(entry.pull
        ? {
            pull_request: {
              url: `https://api.github.com/repos/${state.repo}/pulls/${entry.number}`,
              html_url: htmlUrl(entry),
              merged_at: entry.pull.mergedAt,
            },
          }
        : {}),
    }
  }

  /** @param {FakeItem & { pull: FakePull }} entry */
  function pullJson(entry) {
    const { pull } = entry
    return {
      id: entry.number * 1000,
      number: entry.number,
      title: entry.title,
      body: entry.body,
      state: entry.state,
      draft: pull.draft,
      merged: pull.merged,
      merged_at: pull.mergedAt,
      merge_commit_sha: pull.mergeCommitSha,
      head: {
        ref: pull.head,
        sha: headShaOf(entry),
        repo: pull.headRepo === null ? null : { full_name: pull.headRepo },
      },
      base: { ref: pull.base, sha: branchSha(pull.base), repo: { full_name: state.repo } },
      labels: entry.labels.map(labelJson),
      assignees: entry.assignees.map(user),
      user: user(entry.author),
      milestone: itemMilestoneJson(entry),
      html_url: htmlUrl(entry),
      created_at: entry.createdAt,
      updated_at: entry.updatedAt,
      closed_at: entry.closedAt,
    }
  }

  /**
   * @param {FakeItem} entry
   * @param {FakeComment} comment
   */
  function commentJson(entry, comment) {
    return {
      id: comment.id,
      body: comment.body,
      user: user(comment.author),
      html_url: `${htmlUrl(entry)}#issuecomment-${comment.id}`,
      issue_url: `https://api.github.com/repos/${state.repo}/issues/${entry.number}`,
      created_at: comment.createdAt,
      updated_at: comment.updatedAt,
    }
  }

  /**
   * @param {string} sha
   * @param {FakeCheckRun} run
   */
  function checkRunJson(sha, run) {
    return {
      id: run.id,
      name: run.name,
      head_sha: sha,
      status: run.status,
      conclusion: run.conclusion,
      app: ACTIONS_APP,
      html_url: `https://github.com/${state.repo}/runs/${run.id}`,
    }
  }

  /** @param {string} login */
  function permissionsOf(login) {
    const level = state.collaborators[login] ?? (state.visibility === 'public' ? 'read' : null)
    const order = ['read', 'triage', 'write', 'maintain', 'admin']
    const rank = level === null ? -1 : order.indexOf(level)
    return {
      admin: rank >= 4,
      maintain: rank >= 3,
      push: rank >= 2,
      triage: rank >= 1,
      pull: rank >= 0,
    }
  }

  /**
   * One page of a list.
   * @template T
   * @param {T[]} list
   * @param {Record<string, string>} query
   * @returns {T[]}
   */
  function page(list, query) {
    const perPage = Math.min(Number(query.per_page ?? 30), 100)
    const pageNumber = Number(query.page ?? 1)
    return list.slice((pageNumber - 1) * perPage, pageNumber * perPage)
  }

  /**
   * Close the issues a merged pull request names with a closing keyword, as GitHub does for a
   * merge into the default branch.
   * @param {FakeItem} entry
   */
  function closeReferencedIssues(entry) {
    for (const match of entry.body.matchAll(CLOSING_REFERENCE)) {
      const target = state.items.find((other) => other.number === Number(match[1]))
      if (target && !target.pull && target.state === 'open') {
        target.state = 'closed'
        target.stateReason = 'completed'
        target.closedAt = now()
        touch(target)
      }
    }
  }

  /**
   * The pinned merge: a merge commit, only when the head is still `sha`, as
   * `gh pr merge --merge --match-head-commit <SHA>` and `PUT .../pulls/<N>/merge` with `sha` do.
   * @param {FakeItem & { pull: FakePull }} entry
   * @param {{ sha?: string, title?: string }} options
   */
  function merge(entry, { sha, title }) {
    const { pull } = entry
    if (entry.state !== 'open' || pull.merged) {
      throw httpError(405, `Pull request #${entry.number} is not open`)
    }
    if (pull.draft) throw httpError(405, `Pull request #${entry.number} is still a draft`)
    const head = headShaOf(entry)
    if (sha !== undefined && sha !== head) {
      throw httpError(409, 'Head branch was modified. Review and try the merge again.')
    }
    if (pull.base === state.defaultBranch) {
      for (const name of state.requiredChecks) {
        const run = (state.checks[head ?? ''] ?? []).findLast((check) => check.name === name)
        const reason = !run
          ? 'is expected'
          : run.status !== 'completed'
            ? 'is in progress'
            : run.conclusion !== 'success'
              ? 'is failing'
              : null
        if (reason) {
          throw httpError(
            405,
            `Repository rule violations found. Required status check "${name}" ${reason}.`,
          )
        }
      }
    }
    const message = title ?? `Merge pull request #${entry.number} from ${owner}/${pull.head}`
    const base = branchSha(pull.base)
    let mergeSha
    if (state.origin && head && base) {
      const tree = mergeTreeInOrigin(base, head)
      if (tree === null) throw httpError(405, 'Pull Request is not mergeable')
      mergeSha = originGit(['commit-tree', tree, '-p', base, '-p', head, '-m', message]).trim()
      originGit(['update-ref', `refs/heads/${pull.base}`, mergeSha, base])
    } else {
      mergeSha = createHash('sha1').update(`${base}:${head}:${entry.number}`).digest('hex')
      setBranch(pull.base, mergeSha)
    }
    const time = now()
    Object.assign(pull, { merged: true, mergedAt: time, mergeCommitSha: mergeSha, headSha: head })
    Object.assign(entry, { state: 'closed', closedAt: time, updatedAt: time })
    if (pull.base === state.defaultBranch) closeReferencedIssues(entry)
    return { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' }
  }

  /**
   * The files a pull request changes: its own list, or the diff in the linked origin.
   * @param {FakeItem & { pull: FakePull }} entry
   */
  function filesOf(entry) {
    if (entry.pull.files) return entry.pull.files
    const head = headShaOf(entry)
    const base = branchSha(entry.pull.base)
    if (!state.origin || !head || !base) return []
    const out = originGit(['diff', '--name-status', '-M', `${base}...${head}`])
    const statuses = {
      A: 'added',
      D: 'removed',
      M: 'modified',
      R: 'renamed',
      C: 'copied',
      T: 'changed',
    }
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [code, first, second] = line.split('\t')
        const status = statuses[/** @type {keyof typeof statuses} */ (code[0])] ?? 'modified'
        return second === undefined
          ? { path: first, status, previousPath: null }
          : { path: second, status, previousPath: first }
      })
  }

  // Routes.

  /** @type {Array<{ key: string, match: (request: ParsedRequest) => Record<string, string> | null, handler: FakeHandler }>} */
  const routes = []

  /**
   * Register a handler. `request` is `<METHOD> <path>` for `gh api`, with `{owner}/{repo}` and
   * `:name` parts (`:name*` takes the rest of the path), or the first words of another gh command,
   * such as `pr merge`.
   * @param {string} request
   * @param {FakeHandler} handler
   * @returns {() => void} Removes the handler again.
   */
  function on(request, handler) {
    const route = { key: request, match: compileRoute(request), handler }
    routes.push(route)
    return () => {
      const index = routes.indexOf(route)
      if (index !== -1) routes.splice(index, 1)
    }
  }

  const REPO = 'repos/{owner}/{repo}'

  on('GET user', ({ login }) => ({ login, id: 1, type: 'User' }))

  on(`GET ${REPO}`, ({ login }) => ({
    full_name: state.repo,
    name: state.repo.split('/')[1],
    owner: user(owner),
    default_branch: state.defaultBranch,
    visibility: state.visibility,
    private: state.visibility === 'private',
    html_url: `https://github.com/${state.repo}`,
    permissions: permissionsOf(login),
  }))

  // Issues.

  on(`GET ${REPO}/issues`, ({ query }) => {
    const wanted = query.state ?? 'open'
    const labels = (query.labels ?? '').split(',').filter(Boolean)
    const list = [...state.items]
      .reverse()
      .filter((entry) => wanted === 'all' || entry.state === wanted)
      .filter((entry) =>
        labels.every((name) =>
          entry.labels.some((label) => label.toLowerCase() === name.toLowerCase()),
        ),
      )
      .filter((entry) => !query.since || entry.updatedAt >= query.since)
      .filter((entry) => {
        if (query.assignee === undefined) return true
        if (query.assignee === 'none') return entry.assignees.length === 0
        if (query.assignee === '*') return entry.assignees.length > 0
        return entry.assignees.includes(query.assignee)
      })
      .filter((entry) => {
        if (query.milestone === undefined) return true
        if (query.milestone === 'none') return entry.milestone === null
        if (query.milestone === '*') return entry.milestone !== null
        return entry.milestone === Number(query.milestone)
      })
    return page(list, query).map(issueJson)
  })

  on(`POST ${REPO}/issues`, ({ body, login }) => {
    if (!body?.title) throw httpError(422, 'Validation Failed')
    const milestone = milestoneOfBody(body.milestone)
    const entry = addItem(
      {
        title: body.title,
        body: body.body ?? '',
        labels: body.labels ?? [],
        assignees: (body.assignees ?? []).filter(
          (/** @type {string} */ name) => state.collaborators[name],
        ),
        author: login,
        milestone,
      },
      null,
    )
    return issueJson(entry)
  })

  /**
   * The milestone number of a request body, which GitHub takes as a number or its text; null for
   * none, and HTTP 422 for one that the repository does not have.
   * @param {unknown} value
   * @returns {number | null}
   */
  function milestoneOfBody(value) {
    if (value === undefined || value === null) return null
    const number = Number(value)
    if (!state.milestones.some((milestone) => milestone.number === number)) {
      throw httpError(422, 'Validation Failed')
    }
    return number
  }

  on(`GET ${REPO}/issues/:number`, ({ params }) => issueJson(item(params.number)))

  on(`PATCH ${REPO}/issues/:number`, ({ params, body }) => {
    const entry = item(params.number)
    applyIssueChanges(entry, body ?? {})
    return issueJson(entry)
  })

  /**
   * @param {FakeItem} entry
   * @param {Record<string, any>} changes
   */
  function applyIssueChanges(entry, changes) {
    if (changes.milestone !== undefined) entry.milestone = milestoneOfBody(changes.milestone)
    if (changes.title !== undefined) entry.title = changes.title
    if (changes.body !== undefined) entry.body = changes.body ?? ''
    if (changes.labels !== undefined) {
      entry.labels = changes.labels.map(
        (/** @type {any} */ label) => ensureLabel({ name: label.name ?? label }).name,
      )
    }
    if (changes.assignees !== undefined) entry.assignees = [...changes.assignees]
    if (changes.state !== undefined && changes.state !== entry.state) {
      entry.state = changes.state
      entry.closedAt = changes.state === 'closed' ? now() : null
      if (!entry.pull) {
        entry.stateReason =
          changes.state === 'closed' ? (changes.state_reason ?? 'completed') : 'reopened'
      }
    } else if (changes.state_reason !== undefined && !entry.pull) {
      entry.stateReason = changes.state_reason
    }
    touch(entry)
  }

  on(`POST ${REPO}/issues/:number/labels`, ({ params, body }) => {
    const entry = item(params.number)
    for (const name of body?.labels ?? []) {
      const label = ensureLabel({ name })
      if (!entry.labels.some((own) => own.toLowerCase() === label.name.toLowerCase())) {
        entry.labels.push(label.name)
      }
    }
    touch(entry)
    return entry.labels.map(labelJson)
  })

  on(`PUT ${REPO}/issues/:number/labels`, ({ params, body }) => {
    const entry = item(params.number)
    entry.labels = (body?.labels ?? []).map(
      (/** @type {string} */ name) => ensureLabel({ name }).name,
    )
    touch(entry)
    return entry.labels.map(labelJson)
  })

  on(`DELETE ${REPO}/issues/:number/labels/:name`, ({ params }) => {
    const entry = item(params.number)
    const index = entry.labels.findIndex((own) => own.toLowerCase() === params.name.toLowerCase())
    if (index === -1) throw httpError(404, 'Label does not exist')
    entry.labels.splice(index, 1)
    touch(entry)
    return entry.labels.map(labelJson)
  })

  on(`POST ${REPO}/issues/:number/assignees`, ({ params, body }) => {
    const entry = item(params.number)
    for (const login of body?.assignees ?? []) {
      // GitHub leaves out a login that cannot be assigned, without an error.
      if (state.collaborators[login] && !entry.assignees.includes(login))
        entry.assignees.push(login)
    }
    touch(entry)
    return issueJson(entry)
  })

  on(`DELETE ${REPO}/issues/:number/assignees`, ({ params, body }) => {
    const entry = item(params.number)
    entry.assignees = entry.assignees.filter((login) => !(body?.assignees ?? []).includes(login))
    touch(entry)
    return issueJson(entry)
  })

  // Comments.

  on(`GET ${REPO}/issues/:number/comments`, ({ params, query }) => {
    const entry = item(params.number)
    return page(entry.comments, query).map((comment) => commentJson(entry, comment))
  })

  on(`POST ${REPO}/issues/:number/comments`, ({ params, body, login }) => {
    const entry = item(params.number)
    if (typeof body?.body !== 'string') throw httpError(422, 'Validation Failed')
    const time = now()
    /** @type {FakeComment} */
    const comment = {
      id: nextId(),
      body: body.body,
      author: login,
      createdAt: time,
      updatedAt: time,
    }
    entry.comments.push(comment)
    touch(entry)
    return commentJson(entry, comment)
  })

  /** @param {string} id */
  function findComment(id) {
    for (const entry of state.items) {
      const comment = entry.comments.find((own) => own.id === Number(id))
      if (comment) return { entry, comment }
    }
    throw httpError(404, 'Not Found')
  }

  on(`GET ${REPO}/issues/comments/:id`, ({ params }) => {
    const { entry, comment } = findComment(params.id)
    return commentJson(entry, comment)
  })

  on(`PATCH ${REPO}/issues/comments/:id`, ({ params, body }) => {
    const { entry, comment } = findComment(params.id)
    comment.body = body?.body ?? comment.body
    comment.updatedAt = now()
    return commentJson(entry, comment)
  })

  on(`DELETE ${REPO}/issues/comments/:id`, ({ params }) => {
    const { entry, comment } = findComment(params.id)
    entry.comments.splice(entry.comments.indexOf(comment), 1)
  })

  // Labels of the repository.

  on(`GET ${REPO}/labels`, ({ query }) =>
    page(state.labels, query).map((label) => labelJson(label.name)),
  )

  on(`GET ${REPO}/labels/:name`, ({ params }) => {
    const label = findLabel(params.name)
    if (!label) throw httpError(404, 'Not Found')
    return labelJson(label.name)
  })

  on(`POST ${REPO}/labels`, ({ body }) => {
    if (!body?.name) throw httpError(422, 'Validation Failed')
    if (findLabel(body.name)) throw httpError(422, 'Validation Failed: already_exists')
    const label = ensureLabel({
      name: body.name,
      color: body.color ?? 'ededed',
      description: body.description ?? '',
    })
    return labelJson(label.name)
  })

  on(`PATCH ${REPO}/labels/:name`, ({ params, body }) => {
    const label = findLabel(params.name)
    if (!label) throw httpError(404, 'Not Found')
    if (body?.new_name !== undefined && body.new_name !== label.name) {
      if (findLabel(body.new_name)) throw httpError(422, 'Validation Failed: already_exists')
      for (const entry of state.items) {
        entry.labels = entry.labels.map((own) => (own === label.name ? body.new_name : own))
      }
      label.name = body.new_name
    }
    if (body?.color !== undefined) label.color = body.color
    if (body?.description !== undefined) label.description = body.description
    return labelJson(label.name)
  })

  on(`DELETE ${REPO}/labels/:name`, ({ params }) => {
    const label = findLabel(params.name)
    if (!label) throw httpError(404, 'Not Found')
    state.labels.splice(state.labels.indexOf(label), 1)
    for (const entry of state.items) entry.labels = entry.labels.filter((own) => own !== label.name)
  })

  // Pull requests.

  on(`GET ${REPO}/pulls`, ({ query }) => {
    const wanted = query.state ?? 'open'
    const head = query.head?.includes(':') ? query.head.split(':')[1] : query.head
    const list = [...state.items]
      .reverse()
      .filter((entry) => entry.pull)
      .filter((entry) => wanted === 'all' || entry.state === wanted)
      .filter((entry) => !query.base || entry.pull?.base === query.base)
      .filter((entry) => !head || entry.pull?.head === head)
    return page(list, query).map((entry) => pullJson(/** @type {any} */ (entry)))
  })

  on(`POST ${REPO}/pulls`, ({ body, login }) => {
    const { title, head, base = state.defaultBranch } = body ?? {}
    if (!title || !head) throw httpError(422, 'Validation Failed')
    const headSha = branchSha(head)
    if (headSha === null) throw httpError(422, `Validation Failed: head ${head} does not exist`)
    if (branchSha(base) === null)
      throw httpError(422, `Validation Failed: base ${base} does not exist`)
    const open = state.items.find(
      (entry) =>
        entry.pull &&
        entry.state === 'open' &&
        entry.pull.headRepo === state.repo &&
        entry.pull.head === head &&
        entry.pull.base === base,
    )
    if (open) throw httpError(422, `A pull request already exists for ${owner}:${head}.`)
    const entry = addItem(
      { title, body: body.body ?? '', author: login },
      {
        head,
        headRepo: state.repo,
        headSha,
        base,
        draft: Boolean(body.draft),
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        files: null,
      },
    )
    return pullJson(/** @type {any} */ (entry))
  })

  on(`GET ${REPO}/pulls/:number`, ({ params }) => pullJson(pullItem(params.number)))

  on(`PATCH ${REPO}/pulls/:number`, ({ params, body }) => {
    const entry = pullItem(params.number)
    if (entry.pull.merged && body?.state === 'open') throw httpError(422, 'Validation Failed')
    if (body?.base !== undefined) entry.pull.base = body.base
    applyIssueChanges(entry, { title: body?.title, body: body?.body, state: body?.state })
    return pullJson(entry)
  })

  on(`GET ${REPO}/pulls/:number/files`, ({ params, query }) =>
    page(filesOf(pullItem(params.number)), query).map((file) => ({
      filename: file.path,
      status: file.status,
      ...(file.previousPath ? { previous_filename: file.previousPath } : {}),
    })),
  )

  on(`PUT ${REPO}/pulls/:number/merge`, ({ params, body }) => {
    if ((body?.merge_method ?? 'merge') !== 'merge') {
      throw httpError(405, 'the fake GitHub merges only with a merge commit')
    }
    return merge(pullItem(params.number), { sha: body?.sha, title: body?.commit_title })
  })

  on('pr merge', ({ args }) => {
    const number = args[2]
    const options = parseFlags(args.slice(3))
    if (!options.has('--merge')) {
      return rawResult({ code: 1, stderr: 'the fake GitHub merges only with --merge\n' })
    }
    const entry = state.items.find((own) => own.number === Number(number) && own.pull)
    if (!entry) {
      return rawResult({
        code: 1,
        stderr: `GraphQL: Could not resolve to a PullRequest with the number of ${number}. (repository.pullRequest)\n`,
      })
    }
    const sha = options.get('--match-head-commit')
    if (sha !== undefined && !/^[0-9a-f]{40}$/.test(sha)) {
      return rawResult({
        code: 1,
        stderr: `Variable $input of type MergePullRequestInput! was provided invalid value for expectedHeadOid (Could not coerce value "${sha}" to GitObjectID)\n`,
      })
    }
    try {
      merge(/** @type {any} */ (entry), { sha })
    } catch (error) {
      if (!(error instanceof FakeGitHubError)) throw error
      return rawResult({ code: 1, stderr: `GraphQL: ${error.message} (mergePullRequest)\n` })
    }
    return rawResult({ stdout: '' })
  })

  // Branches and git references, of the state or the linked origin.

  on(`GET ${REPO}/branches`, ({ query }) => {
    /** @type {Map<string, string>} */
    const branches = new Map()
    if (state.origin) {
      const refs = originGit([
        'for-each-ref',
        '--format=%(refname:short) %(objectname)',
        'refs/heads',
      ])
      for (const line of refs.split('\n').filter(Boolean)) {
        const [branch, sha] = line.split(' ')
        branches.set(branch, sha)
      }
    }
    for (const [branch, sha] of Object.entries(state.branches)) branches.set(branch, sha)
    const list = [...branches].sort(([a], [b]) => a.localeCompare(b))
    return page(list, query).map(([name, sha]) => ({ name, commit: { sha }, protected: false }))
  })

  on(`GET ${REPO}/git/ref/heads/:branch*`, ({ params }) => {
    const sha = branchSha(params.branch)
    if (sha === null) throw httpError(404, 'Not Found')
    return { ref: `refs/heads/${params.branch}`, object: { sha, type: 'commit' } }
  })

  on(`POST ${REPO}/git/refs`, ({ body }) => {
    const branch = String(body?.ref ?? '').replace(/^refs\/heads\//, '')
    if (!body?.sha || branch === '') throw httpError(422, 'Validation Failed')
    if (branchSha(branch) !== null) throw httpError(422, 'Reference already exists')
    setBranch(branch, body.sha)
    return { ref: `refs/heads/${branch}`, object: { sha: body.sha, type: 'commit' } }
  })

  on(`PATCH ${REPO}/git/refs/heads/:branch*`, ({ params, body }) => {
    const current = branchSha(params.branch)
    if (current === null) throw httpError(422, 'Reference does not exist')
    if (!body?.force && state.origin) {
      try {
        originGit(['merge-base', '--is-ancestor', current, body.sha])
      } catch {
        throw httpError(422, 'Update is not a fast forward')
      }
    }
    setBranch(params.branch, body.sha)
    return { ref: `refs/heads/${params.branch}`, object: { sha: body.sha, type: 'commit' } }
  })

  on(`DELETE ${REPO}/git/refs/heads/:branch*`, ({ params }) => {
    if (branchSha(params.branch) === null) throw httpError(422, 'Reference does not exist')
    setBranch(params.branch, null)
  })

  // Rule sets, in the form docs/verification.md recorded (rows 5 and 6): `GET .../rulesets` lists
  // them without their rules, `POST` creates one, `PUT .../rulesets/<id>` changes the fields it
  // names, `DELETE` removes one, `GET .../rulesets/<id>` returns one with `bypass_actors` and
  // `current_user_can_bypass`, and `GET .../rules/branches/<branch>` lists the rules of the active
  // rule sets that target the branch, each with its `ruleset_id`.

  /** Where GitHub offers no rule sets, it refuses every request for them (E3). */
  function requireRulesets() {
    if (!state.rulesetsOffered) throw httpError(403, RULESETS_NOT_OFFERED)
  }

  /**
   * The fields of a rule set body that the caller may set: GitHub gives the id, the source and
   * the times, and computes whether the caller can bypass it. An empty name or an unknown
   * enforcement is refused.
   * @param {any} body
   * @param {{ create: boolean }} mode
   */
  function rulesetFields(body, { create }) {
    const { id, source_type, source, created_at, updated_at, current_user_can_bypass, ...fields } =
      body ?? {}
    // A new rule set needs both; an update checks only the fields it names.
    const badName =
      (create || 'name' in fields) && (typeof fields.name !== 'string' || fields.name === '')
    const badEnforcement =
      (create || 'enforcement' in fields) &&
      !['active', 'disabled', 'evaluate'].includes(fields.enforcement)
    if (badName || badEnforcement) throw httpError(422, 'Validation Failed')
    return fields
  }

  /** @param {string} id */
  function findRuleset(id) {
    const ruleset = state.rulesets.find((own) => own.id === Number(id))
    if (!ruleset) throw httpError(404, 'Not Found')
    return ruleset
  }

  /**
   * @param {FakeRuleset} ruleset
   * @param {string} login
   */
  function rulesetJson(ruleset, login) {
    const adminBypass = (ruleset.bypass_actors ?? []).some(
      (actor) => actor.actor_type === 'RepositoryRole' && actor.actor_id === ADMIN_ROLE_ID,
    )
    return {
      ...ruleset,
      current_user_can_bypass:
        'current_user_can_bypass' in ruleset
          ? ruleset.current_user_can_bypass
          : adminBypass && state.collaborators[login] === 'admin'
            ? 'always'
            : 'never',
    }
  }

  /**
   * @param {FakeRuleset} ruleset
   * @param {string} branch
   */
  function targetsBranch(ruleset, branch) {
    return (ruleset.conditions?.ref_name?.include ?? []).some(
      (pattern) =>
        pattern === '~ALL' ||
        (pattern === '~DEFAULT_BRANCH' && branch === state.defaultBranch) ||
        pattern === `refs/heads/${branch}`,
    )
  }

  on(`GET ${REPO}/rulesets`, ({ query }) => {
    requireRulesets()
    return page(state.rulesets, query).map((ruleset) => ({
      id: ruleset.id,
      name: ruleset.name,
      target: ruleset.target,
      source_type: ruleset.source_type,
      source: ruleset.source,
      enforcement: ruleset.enforcement,
      created_at: ruleset.created_at,
      updated_at: ruleset.updated_at,
    }))
  })

  on(`POST ${REPO}/rulesets`, ({ body, login }) => {
    requireRulesets()
    const fields = /** @type {FakeRuleset} */ (rulesetFields(body, { create: true }))
    return rulesetJson(addRuleset(fields), login)
  })

  on(`GET ${REPO}/rulesets/:id`, ({ params, login }) => {
    requireRulesets()
    return rulesetJson(findRuleset(params.id), login)
  })

  // An update changes only the fields it names (docs/verification.md, E1: `-f enforcement=...`).
  on(`PUT ${REPO}/rulesets/:id`, ({ params, body, login }) => {
    requireRulesets()
    const ruleset = findRuleset(params.id)
    Object.assign(ruleset, rulesetFields(body, { create: false }), { updated_at: now() })
    return rulesetJson(ruleset, login)
  })

  on(`DELETE ${REPO}/rulesets/:id`, ({ params }) => {
    requireRulesets()
    state.rulesets.splice(state.rulesets.indexOf(findRuleset(params.id)), 1)
  })

  on(`GET ${REPO}/rules/branches/:branch*`, ({ params, query }) => {
    requireRulesets()
    const rules = state.rulesets
      .filter(
        (ruleset) => ruleset.enforcement === 'active' && targetsBranch(ruleset, params.branch),
      )
      .flatMap((ruleset) =>
        ruleset.rules.map((rule) => ({
          type: rule.type,
          ...(rule.parameters ? { parameters: rule.parameters } : {}),
          ruleset_source_type: ruleset.source_type,
          ruleset_source: ruleset.source,
          ruleset_id: ruleset.id,
        })),
      )
    return page(rules, query)
  })

  // Checks.

  on(`GET ${REPO}/commits/:ref/check-runs`, ({ params, query }) => {
    const sha = /^[0-9a-f]{40}$/.test(params.ref) ? params.ref : branchSha(params.ref)
    const runs = (state.checks[sha ?? ''] ?? []).filter(
      (run) => !query.check_name || run.name === query.check_name,
    )
    return {
      total_count: runs.length,
      check_runs: page(runs, query).map((run) => checkRunJson(/** @type {string} */ (sha), run)),
    }
  })

  // Collaborators and invitations.

  on(`GET ${REPO}/collaborators`, ({ query }) =>
    page(Object.entries(state.collaborators), query).map(([login, permission]) => ({
      login,
      role_name: permission,
      permissions: permissionsOf(login),
    })),
  )

  on(`GET ${REPO}/collaborators/:login`, ({ params }) => {
    if (!state.collaborators[params.login]) throw httpError(404, 'Not Found')
  })

  on(`GET ${REPO}/collaborators/:login/permission`, ({ params }) => {
    const level = state.collaborators[params.login]
    const permission =
      level === undefined
        ? 'none'
        : level === 'maintain'
          ? 'write'
          : level === 'triage'
            ? 'read'
            : level
    return { permission, role_name: level ?? 'none', user: user(params.login) }
  })

  on(`PUT ${REPO}/collaborators/:login`, ({ params, body, login }) => {
    if (state.collaborators[params.login]) return undefined
    const existing = state.invitations.find((invitation) => invitation.login === params.login)
    if (existing) return invitationJson(existing)
    const invitation = {
      id: nextId(),
      login: params.login,
      permission: body?.permission ?? 'push',
      inviter: login,
    }
    state.invitations.push(invitation)
    return invitationJson(invitation)
  })

  /** @param {FakeState['invitations'][number]} invitation */
  function invitationJson(invitation) {
    return {
      id: invitation.id,
      invitee: user(invitation.login),
      inviter: user(invitation.inviter),
      permissions: invitation.permission,
      repository: { full_name: state.repo },
    }
  }

  on(`GET ${REPO}/invitations`, ({ query }) => page(state.invitations, query).map(invitationJson))

  // Pinned issues, as `gh issue pin` and `gh issue unpin` (docs/verification.md, row 8).

  on('issue pin', ({ args }) => {
    const entry = state.items.find((own) => own.number === Number(args[2]) && !own.pull)
    if (!entry)
      return rawResult({
        code: 1,
        stderr: `GraphQL: Could not resolve to an issue with the number of ${args[2]}. (repository.issue)\n`,
      })
    if (!entry.pinned && state.items.filter((own) => own.pinned).length >= PIN_LIMIT) {
      return rawResult({
        code: 1,
        stderr: `GraphQL: A repository can have at most ${PIN_LIMIT} pinned issues. (pinIssue)\n`,
      })
    }
    entry.pinned = true
    return rawResult({ stdout: `Pinned issue #${entry.number} (${entry.title})\n` })
  })

  on('issue unpin', ({ args }) => {
    const entry = state.items.find((own) => own.number === Number(args[2]) && !own.pull)
    if (!entry)
      return rawResult({
        code: 1,
        stderr: `GraphQL: Could not resolve to an issue with the number of ${args[2]}. (repository.issue)\n`,
      })
    entry.pinned = false
    return rawResult({ stdout: `Unpinned issue #${entry.number} (${entry.title})\n` })
  })

  // The executor.

  /** @type {FakeCall[]} */
  const calls = []
  /** @type {FakeCall[]} */
  const unhandled = []

  /**
   * An executor that calls as this login.
   * @param {string | (() => string)} who
   * @returns {GhExecutor}
   */
  function executorAs(who) {
    return async (args, call = {}) => {
      const login = typeof who === 'function' ? who() : who
      const parsed = parseRequest(args, call.input, state.repo)
      /** @type {FakeCall} */
      const record = {
        login,
        args: [...args],
        method: parsed.method,
        endpoint: parsed.endpoint,
        body: parsed.body,
        code: 0,
      }
      calls.push(record)
      const result = await answer(parsed, login, call.env ?? {})
      record.code = result.code
      if (result.unhandled) unhandled.push(record)
      return { code: result.code, stdout: result.stdout, stderr: result.stderr }
    }
  }

  /**
   * @param {ParsedRequest} parsed
   * @param {string} login
   * @param {Record<string, string>} env
   */
  async function answer(parsed, login, env) {
    if (parsed.error) return { code: 1, stdout: '', stderr: `${parsed.error}\n`, unhandled: true }
    if (
      parsed.repoScoped &&
      env.GH_REPO &&
      env.GH_REPO.toLowerCase() !== state.repo.toLowerCase()
    ) {
      return errorResult(httpError(404, 'Not Found'))
    }
    if (parsed.otherRepo) return errorResult(httpError(404, 'Not Found'))
    for (let index = routes.length - 1; index >= 0; index -= 1) {
      const route = routes[index]
      const params = route.match(parsed)
      if (params === null) continue
      try {
        const value = await route.handler({ ...parsed.request, login, env, params, state })
        return toResult(value)
      } catch (error) {
        if (error instanceof FakeGitHubError) return errorResult(error)
        throw error
      }
    }
    return {
      code: 1,
      stdout: '',
      stderr: `fake GitHub: no handler for ${parsed.describe}; register one with on()\n`,
      unhandled: true,
    }
  }

  return {
    /** The executor that calls as `state.login`. */
    executor: executorAs(() => state.login),
    /** The repository, its issues, pull requests, labels, branches and checks; change it freely. */
    state,
    on,
    /** An executor that calls as another login, for example `accounts.builder2.login`. */
    as: executorAs,
    /** Every call, in order, with the caller's login and gh's exit code. */
    calls,
    /** The calls that no handler answered. */
    unhandled,
    /**
     * The issue or pull request with this number, or undefined.
     * @param {number} number
     */
    find: (number) => state.items.find((entry) => entry.number === number),
    /**
     * Add a check run for a commit.
     * @param {string} sha
     * @param {Partial<FakeCheckRun> & { name: string }} run
     */
    addCheckRun,
    /**
     * Point a branch at a commit, as a push does.
     * @param {string} branch
     * @param {string} sha
     */
    setBranch: (branch, sha) => setBranch(branch, sha),
    /**
     * Add a rule set, as `POST .../rulesets` does; `id` is given when missing.
     * @param {Partial<FakeRuleset> & { name: string }} body
     */
    addRuleset,
    /**
     * Add a milestone, as `POST .../milestones` does; `number` is given when missing.
     * @param {Partial<FakeMilestone> & { title: string }} body
     */
    addMilestone,
  }
}

/** @typedef {ReturnType<typeof createFakeGitHub>} FakeGitHub */

/**
 * @typedef {object} ParsedRequest
 * @property {Omit<FakeRequest, 'login' | 'env' | 'params' | 'state'>} request
 * @property {string | null} method
 * @property {string | null} endpoint
 * @property {string[]} segments The path of `gh api`, split, or the gh command words.
 * @property {boolean} api
 * @property {boolean} repoScoped
 * @property {boolean} otherRepo The endpoint names another repository than the fake's.
 * @property {any} body
 * @property {string} describe
 * @property {string} [error]
 */

/**
 * @param {string[]} args
 * @param {string | undefined} input
 * @param {string} repo
 * @returns {ParsedRequest}
 */
function parseRequest(args, input, repo) {
  const base = { args: [...args], input, fields: {}, query: {} }
  if (args[0] !== 'api') {
    const words = args.filter((arg) => !arg.startsWith('-'))
    return {
      request: { ...base, method: null, endpoint: null, body: undefined },
      method: null,
      endpoint: null,
      segments: words,
      api: false,
      repoScoped: true,
      otherRepo: false,
      body: undefined,
      describe: `gh ${args.join(' ')}`,
    }
  }
  /** @type {string | undefined} */
  let method
  /** @type {string | undefined} */
  let target
  let fromStdin = false
  /** @type {Record<string, string>} */
  const fields = {}
  /** @type {Record<string, unknown>} */
  const typed = {}
  let error
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--method' || arg === '-X') method = args[(index += 1)]
    else if (arg === '--input') fromStdin = args[(index += 1)] === '-'
    else if (['-f', '--raw-field', '-F', '--field'].includes(arg)) {
      const [key, ...rest] = String(args[(index += 1)]).split('=')
      fields[key] = rest.join('=')
      typed[key] = arg === '-F' || arg === '--field' ? typedField(fields[key]) : fields[key]
    } else if (['-H', '--header', '--hostname', '--cache'].includes(arg)) index += 1
    else if (['--jq', '-q', '--template', '-t', '--paginate', '--slurp'].includes(arg)) {
      error = `fake GitHub: gh api ${arg} is not supported; parse the JSON in the test instead`
    } else if (!arg.startsWith('-') && target === undefined) target = arg
  }
  method = (method ?? (fromStdin || Object.keys(fields).length > 0 ? 'POST' : 'GET')).toUpperCase()
  const [rawPath = '', rawQuery = ''] = String(target ?? '')
    .replace(/^\//, '')
    .split('?')
  const query = Object.fromEntries(new URLSearchParams(rawQuery))
  let segments = rawPath.split('/')
  let otherRepo = false
  if (segments[0] === 'repos' && segments.length >= 3) {
    const named = `${segments[1]}/${segments[2]}`
    if (named.toLowerCase() === repo.toLowerCase() || named === '{owner}/{repo}') {
      segments = ['repos', '{owner}', '{repo}', ...segments.slice(3)]
    } else {
      otherRepo = true
    }
  }
  const endpoint = segments.join('/')
  let body
  if (fromStdin && input !== undefined && input !== '') {
    try {
      body = JSON.parse(input)
    } catch {
      error = 'fake GitHub: the request body on stdin is not JSON'
    }
  } else if (Object.keys(fields).length > 0) {
    body = typed
  }
  return {
    request: { ...base, method, endpoint, query, body, fields },
    method,
    endpoint,
    segments,
    api: true,
    repoScoped: segments[0] === 'repos',
    otherRepo,
    body,
    describe: `gh api --method ${method} ${target ?? ''}`,
    error,
  }
}

/**
 * The value of a `-F` field, typed as gh types it.
 * @param {string} value
 */
function typedField(value) {
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null') return null
  if (/^-?\d+$/.test(value)) return Number(value)
  return value
}

/**
 * @param {string} key `<METHOD> <path>`, or the first words of a gh command.
 * @returns {(parsed: ParsedRequest) => Record<string, string> | null}
 */
function compileRoute(key) {
  const [first, ...rest] = key.trim().split(/\s+/)
  const isApi = /^(GET|POST|PUT|PATCH|DELETE)$/.test(first)
  if (!isApi) {
    const words = [first, ...rest]
    return (parsed) =>
      !parsed.api && words.every((word, index) => parsed.segments[index] === word) ? {} : null
  }
  const pattern = rest.join(' ').replace(/^\//, '').split('/')
  return (parsed) => {
    if (!parsed.api || parsed.method !== first) return null
    /** @type {Record<string, string>} */
    const params = {}
    const path = parsed.segments
    for (let index = 0; index < pattern.length; index += 1) {
      const part = pattern[index]
      if (part.startsWith(':') && part.endsWith('*')) {
        if (index >= path.length) return null
        params[part.slice(1, -1)] = path.slice(index).map(decodeURIComponent).join('/')
        return params
      }
      if (index >= path.length) return null
      if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(path[index])
      else if (part !== path[index]) return null
    }
    return pattern.length === path.length ? params : null
  }
}

/**
 * @param {string[]} args
 * @returns {Map<string, string | undefined>}
 */
function parseFlags(args) {
  /** @type {Map<string, string | undefined>} */
  const flags = new Map()
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg.startsWith('--')) continue
    const [name, value] = arg.split('=')
    if (value !== undefined) flags.set(name, value)
    else if (args[index + 1] !== undefined && !args[index + 1].startsWith('-')) {
      flags.set(name, args[(index += 1)])
    } else flags.set(name, undefined)
  }
  return flags
}

/**
 * @param {unknown} value
 * @returns {{ code: number, stdout: string, stderr: string, unhandled?: boolean }}
 */
function toResult(value) {
  if (value && typeof value === 'object' && RAW in value) {
    const raw = /** @type {{ code: number, stdout: string, stderr: string }} */ (value)
    return { code: raw.code, stdout: raw.stdout, stderr: raw.stderr }
  }
  if (value === undefined || value === null) return { code: 0, stdout: '', stderr: '' }
  if (typeof value === 'string') return { code: 0, stdout: value, stderr: '' }
  return { code: 0, stdout: `${JSON.stringify(value)}\n`, stderr: '' }
}

/**
 * gh's output for an HTTP error: the response on stdout, the message on stderr.
 * @param {FakeGitHubError} error
 */
function errorResult(error) {
  return {
    code: 1,
    stdout: `${JSON.stringify({ message: error.message, status: String(error.status) })}\n`,
    stderr: `gh: ${error.message} (HTTP ${error.status})\n`,
  }
}

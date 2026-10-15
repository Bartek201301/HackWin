// The reset of a fixture repository before a scenario (docs/build/contracts.md section 6.4): delete
// every rule set and branch rule, close every open pull request and issue and unpin it, delete
// every branch but `main`, delete every label, and reset `main` to the recorded commit. Rules go
// first, so that no rule blocks a branch deletion or the reset of `main`. Afterwards the state is
// read back, and a reset that did not hold fails. On a repository where GitHub refuses protection
// (no GitHub Pro), an HTTP 403 on the rule set endpoints is accepted.
//
// A deletion that GitHub answers with 404 counts as done: the rule set, branch or label is gone.
// A gh call that fails without an HTTP status (a network error, a cut response) or with a 5xx is
// made again, up to RESET_ATTEMPTS times in all.
//
// It never assumes an issue or pull request number: it lists what is open.

import { setTimeout as sleep } from 'node:timers/promises'
import { createGitHub, ghFailure } from '../../src/core/github/index.js'
import { RemoteError } from '../../src/core/runtime/errors.js'
import { REFUSED } from './guard.js'

/** @import { GhExecutor, GhResult, GitHub } from '../../src/core/github/index.js' */
/** @import { FixtureRepoInfo } from './fixture-repos.js' */

/** How often the reset makes a gh call that fails without an HTTP status or with a 5xx. */
export const RESET_ATTEMPTS = 4

/** The wait before the second attempt of such a call; it doubles before each further one. */
export const RETRY_DELAY_MS = 1000

const STATE_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    branchProtectionRules(first: 100) { nodes { id pattern } }
    pinnedIssues(first: 10) { nodes { issue { number } } }
  }
}`

const DELETE_RULE = `mutation($id: ID!) {
  deleteBranchProtectionRule(input: { branchProtectionRuleId: $id }) { clientMutationId }
}`

/**
 * What a reset did. A rule set, branch or label that was already gone when the reset deleted it
 * is listed as deleted and named in `accepted`.
 * @typedef {object} ResetReport
 * @property {string} repo
 * @property {Array<{ id: number, name: string }>} deletedRulesets
 * @property {string[]} deletedBranchRules The patterns of the deleted branch rules.
 * @property {number[]} closedPullRequests
 * @property {number[]} closedIssues
 * @property {number[]} unpinnedIssues
 * @property {string[]} deletedBranches
 * @property {string[]} deletedLabels
 * @property {{ before: string | null, after: string }} main
 * @property {string[]} accepted The refusals the reset accepted, such as HTTP 403 on rule sets
 *   or HTTP 404 on deleting a label that is already gone.
 */

/**
 * The state of a fixture repository as GitHub reports it.
 * @typedef {object} FixtureRepoState
 * @property {string} repo
 * @property {string | null} main The commit of `main`, or null without `main`.
 * @property {string[]} branches
 * @property {number[]} openIssues
 * @property {number[]} openPullRequests
 * @property {string[]} labels
 * @property {string[] | null} rulesets Their names; null when GitHub refused to list them.
 * @property {string[]} branchRules The patterns of the branch rules.
 * @property {number[]} pinnedIssues
 * @property {string[]} accepted The refusals accepted while reading, such as HTTP 403 on rule sets.
 */

/**
 * Reset a fixture repository, as its owner.
 * @param {GitHub} lead The Lead's client for the repository.
 * @param {FixtureRepoInfo} info
 * @param {{ log?: (line: string) => void, attempts?: number, retryDelayMs?: number }} [options]
 *   `attempts`: how often a call that fails without an HTTP status or with a 5xx is made;
 *   `retryDelayMs`: the wait before its second attempt, doubled before each further one.
 * @returns {Promise<ResetReport>}
 */
export async function resetFixtureRepo(
  lead,
  info,
  { log = () => {}, attempts = RESET_ATTEMPTS, retryDelayMs = RETRY_DELAY_MS } = {},
) {
  const github = retrying(lead, {
    attempts,
    delayMs: retryDelayMs,
    log: (line) => log(`reset ${info.repo}: ${line}`),
  })
  const [owner, name] = info.repo.split('/')
  /** @type {ResetReport} */
  const report = {
    repo: info.repo,
    deletedRulesets: [],
    deletedBranchRules: [],
    closedPullRequests: [],
    closedIssues: [],
    unpinnedIssues: [],
    deletedBranches: [],
    deletedLabels: [],
    main: { before: null, after: info.resetSha },
    accepted: [],
  }
  /** @param {string} what */
  const accept = (what) => {
    report.accepted.push(what)
    log(`reset ${info.repo}: ${what}, accepted`)
  }

  // Rule sets.
  const rulesets = await listRulesets(github, info)
  if (rulesets === null) {
    report.accepted.push('rule sets: HTTP 403')
    log(`reset ${info.repo}: rule sets answered HTTP 403, accepted (no GitHub Pro)`)
  }
  for (const ruleset of rulesets ?? []) {
    if (ruleset.source_type && ruleset.source_type !== 'Repository') continue
    const gone = await deletion(() =>
      github.api(`repos/{owner}/{repo}/rulesets/${ruleset.id}`, { method: 'DELETE' }),
    )
    if (gone !== null) accept(`rule set ${ruleset.name}: HTTP ${gone}, already gone`)
    report.deletedRulesets.push({ id: ruleset.id, name: ruleset.name })
  }

  // Branch rules (branch protection), on every pattern, and the pinned issues.
  const graph = await graphql(github, STATE_QUERY, { owner, name })
  for (const rule of graph.repository.branchProtectionRules.nodes) {
    await graphql(github, DELETE_RULE, { id: rule.id })
    report.deletedBranchRules.push(rule.pattern)
  }

  // Pull requests, then issues.
  for (const pull of await github.listPullRequests({ state: 'open' })) {
    await github.updatePullRequest(pull.number, { state: 'closed' })
    report.closedPullRequests.push(pull.number)
  }
  for (const issue of await github.listIssues({ state: 'open' })) {
    await github.updateIssue(issue.number, { state: 'closed', stateReason: 'not_planned' })
    report.closedIssues.push(issue.number)
  }
  for (const { issue } of graph.repository.pinnedIssues.nodes) {
    await github.run(['issue', 'unpin', String(issue.number)])
    report.unpinnedIssues.push(issue.number)
  }

  // Branches: main stays alone, so that no run leaves a branch for the next one.
  for (const branch of await github.apiPages('repos/{owner}/{repo}/branches')) {
    if (branch.name === 'main') continue
    const gone = await deletion(
      () =>
        github.api(`repos/{owner}/{repo}/git/refs/heads/${refPath(branch.name)}`, {
          method: 'DELETE',
        }),
      // How the fake GitHub answers the deletion of a branch that does not exist.
      (error) => error.status === 422 && /Reference does not exist/.test(error.message),
    )
    if (gone !== null) accept(`branch ${branch.name}: HTTP ${gone}, already gone`)
    report.deletedBranches.push(branch.name)
  }

  // Labels.
  for (const label of await github.listLabels()) {
    // deleteLabel answers false for GitHub's 404.
    const removed = await github.deleteLabel(label.name)
    if (!removed) accept(`label ${label.name}: HTTP 404, already gone`)
    report.deletedLabels.push(label.name)
  }

  // main.
  report.main.before = await mainSha(github)
  if (report.main.before === null) {
    await github.api('repos/{owner}/{repo}/git/refs', {
      method: 'POST',
      body: { ref: 'refs/heads/main', sha: info.resetSha },
    })
  } else if (report.main.before !== info.resetSha) {
    await github.api('repos/{owner}/{repo}/git/refs/heads/main', {
      method: 'PATCH',
      body: { sha: info.resetSha, force: true },
    })
  }

  // Read the state back.
  const problems = problemsOf(await readFixtureRepoState(github, info), info)
  if (problems.length > 0) {
    throw new Error(`the reset of ${info.repo} did not hold: ${problems.join('; ')}`)
  }
  log(`reset ${info.repo}: ${summarize(report)}`)
  return report
}

/**
 * Read the state of a fixture repository from GitHub, as its owner, without changing it.
 * @param {GitHub} github The Lead's client for the repository.
 * @param {FixtureRepoInfo} info
 * @returns {Promise<FixtureRepoState>}
 */
export async function readFixtureRepoState(github, info) {
  const [owner, name] = info.repo.split('/')
  const rulesets = await listRulesets(github, info)
  const graph = await graphql(github, STATE_QUERY, { owner, name })
  const open = await github.apiPages('repos/{owner}/{repo}/issues', { query: { state: 'open' } })
  return {
    repo: info.repo,
    main: await mainSha(github),
    branches: (await github.apiPages('repos/{owner}/{repo}/branches')).map((branch) => branch.name),
    openIssues: open.filter((item) => !item.pull_request).map((item) => item.number),
    openPullRequests: open.filter((item) => item.pull_request).map((item) => item.number),
    labels: (await github.listLabels()).map((label) => label.name),
    rulesets: rulesets === null ? null : rulesets.map((ruleset) => ruleset.name),
    branchRules: graph.repository.branchProtectionRules.nodes.map(
      (/** @type {any} */ rule) => rule.pattern,
    ),
    pinnedIssues: graph.repository.pinnedIssues.nodes.map(
      (/** @type {any} */ node) => node.issue.number,
    ),
    accepted: rulesets === null ? ['rule sets: HTTP 403'] : [],
  }
}

/**
 * What differs from the state a reset leaves, one text per difference.
 * @param {FixtureRepoState} state
 * @param {FixtureRepoInfo} info
 * @returns {string[]}
 */
export function problemsOf(state, info) {
  const list = (/** @type {Array<string | number>} */ items) => items.join(', ')
  return [
    state.main === info.resetSha ? null : `main is ${state.main}, not ${info.resetSha}`,
    list(state.branches) === 'main' ? null : `branches: ${list(state.branches)}`,
    state.openIssues.length === 0 ? null : `open issues: ${list(state.openIssues)}`,
    state.openPullRequests.length === 0
      ? null
      : `open pull requests: ${list(state.openPullRequests)}`,
    state.labels.length === 0 ? null : `labels: ${list(state.labels)}`,
    (state.rulesets ?? []).length === 0 ? null : `rule sets: ${list(state.rulesets ?? [])}`,
    state.branchRules.length === 0 ? null : `branch rules: ${list(state.branchRules)}`,
    state.pinnedIssues.length === 0 ? null : `pinned issues: ${list(state.pinnedIssues)}`,
  ].filter((problem) => problem !== null)
}

/**
 * One line that describes a reset.
 * @param {ResetReport} report
 * @returns {string}
 */
export function summarize(report) {
  const list = (/** @type {Array<string | number>} */ items) =>
    items.length === 0 ? 'none' : items.join(', ')
  return [
    `rule sets ${list(report.deletedRulesets.map((ruleset) => ruleset.name))}`,
    `branch rules ${list(report.deletedBranchRules)}`,
    `pull requests closed ${list(report.closedPullRequests.map((n) => `#${n}`))}`,
    `issues closed ${list(report.closedIssues.map((n) => `#${n}`))}`,
    `unpinned ${list(report.unpinnedIssues.map((n) => `#${n}`))}`,
    `branches deleted ${list(report.deletedBranches)}`,
    `labels deleted ${report.deletedLabels.length}`,
    `main ${report.main.before === report.main.after ? 'unchanged' : `${report.main.before} -> ${report.main.after}`}`,
    ...(report.accepted.length > 0 ? [`accepted ${report.accepted.join(', ')}`] : []),
  ].join('; ')
}

/**
 * The repository's own rule sets, or null where GitHub refuses them with HTTP 403 and the
 * repository is one where that is expected.
 * @param {GitHub} github
 * @param {FixtureRepoInfo} info
 * @returns {Promise<any[] | null>}
 */
async function listRulesets(github, info) {
  try {
    return await github.apiPages('repos/{owner}/{repo}/rulesets', {
      query: { includes_parents: 'false' },
    })
  } catch (error) {
    if (info.protectionRefused && error instanceof RemoteError && error.status === 403) return null
    throw error
  }
}

/**
 * Run a deletion. GitHub's "not found" (HTTP 404), or an answer that `alsoGone` reads as gone,
 * means that the object is already gone, which counts as done.
 * @param {() => Promise<unknown>} remove
 * @param {(error: RemoteError) => boolean} [alsoGone]
 * @returns {Promise<number | null>} The HTTP status of an object already gone; null when the
 *   deletion removed it.
 */
async function deletion(remove, alsoGone = () => false) {
  try {
    await remove()
    return null
  } catch (error) {
    if (error instanceof RemoteError && (error.status === 404 || alsoGone(error))) {
      return error.status ?? null
    }
    throw error
  }
}

/**
 * The client with an executor that makes a gh call again when it fails without an HTTP status
 * (a network error, a timeout, a cut response) or with a 5xx: up to `attempts` times in all,
 * after a wait of `delayMs` that doubles before each further attempt. A refusal of the guard, a
 * missing gh login and every other HTTP status are not repeated.
 * @param {GitHub} client
 * @param {{ attempts: number, delayMs: number, log: (line: string) => void }} options
 * @returns {GitHub}
 */
function retrying(client, { attempts, delayMs, log }) {
  /** @type {GhExecutor} */
  const executor = async (args, call) => {
    for (let attempt = 1; ; attempt += 1) {
      const result = await client.executor(args, call)
      const failure = result.code === 0 ? null : transientFailure(args, result)
      if (failure === null || attempt >= attempts) return result
      const wait = delayMs * 2 ** (attempt - 1)
      log(`${failure}; attempt ${attempt + 1} of ${attempts} in ${wait} ms`)
      await sleep(wait)
    }
  }
  return createGitHub({ executor, repo: client.repo, cwd: client.cwd })
}

/**
 * The message of a failed gh call that is worth making again, or null.
 * @param {string[]} args
 * @param {GhResult} result
 * @returns {string | null}
 */
function transientFailure(args, result) {
  if (result.stderr.startsWith(REFUSED)) return null
  const error = ghFailure(args, result)
  if (!(error instanceof RemoteError)) return null
  return error.status === undefined || error.status >= 500 ? error.message : null
}

/**
 * The commit of `main`, or null when the branch does not exist.
 * @param {GitHub} github
 * @returns {Promise<string | null>}
 */
async function mainSha(github) {
  try {
    const ref = await github.api('repos/{owner}/{repo}/git/ref/heads/main')
    return ref.object.sha
  } catch (error) {
    if (error instanceof RemoteError && error.status === 404) return null
    throw error
  }
}

/**
 * A branch name as the path of its reference: every part encoded, the slashes kept.
 * @param {string} branch
 */
function refPath(branch) {
  return branch.split('/').map(encodeURIComponent).join('/')
}

/**
 * A GraphQL request through `gh api graphql`; its variables are passed as typed fields.
 * @param {GitHub} github
 * @param {string} query
 * @param {Record<string, string>} variables
 */
async function graphql(github, query, variables) {
  const args = ['api', 'graphql', '-f', `query=${query}`]
  for (const [key, value] of Object.entries(variables)) args.push('-F', `${key}=${value}`)
  const { stdout } = await github.run(args)
  const response = JSON.parse(stdout)
  if (response.errors?.length) {
    throw new RemoteError(
      `GraphQL: ${response.errors.map((/** @type {any} */ e) => e.message).join('; ')}`,
    )
  }
  return response.data
}

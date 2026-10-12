// The reset of a fixture repository before a scenario (docs/build/contracts.md section 6.4): delete
// every rule set and branch rule, close every open pull request and issue and unpin it, delete
// every label, and reset `main` to the recorded commit. Rules go first, so that no rule blocks the
// reset of `main`. Branches other than `main` stay. On a repository where GitHub refuses
// protection (no GitHub Pro), an HTTP 403 on the rule set endpoints is accepted.
//
// It never assumes an issue or pull request number: it lists what is open.

import { RemoteError } from '../../src/core/runtime/errors.js'

/** @import { GitHub } from '../../src/core/github/index.js' */
/** @import { FixtureRepoInfo } from './fixture-repos.js' */

const RULES_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    branchProtectionRules(first: 100) { nodes { id pattern } }
    pinnedIssues(first: 10) { nodes { issue { number } } }
  }
}`

const DELETE_RULE = `mutation($id: ID!) {
  deleteBranchProtectionRule(input: { branchProtectionRuleId: $id }) { clientMutationId }
}`

/**
 * @typedef {object} ResetReport
 * @property {string} repo
 * @property {Array<{ id: number, name: string }>} deletedRulesets
 * @property {string[]} deletedBranchRules The patterns of the deleted branch rules.
 * @property {number[]} closedPullRequests
 * @property {number[]} closedIssues
 * @property {number[]} unpinnedIssues
 * @property {string[]} deletedLabels
 * @property {{ before: string | null, after: string }} main
 * @property {string[]} accepted The refusals the reset accepted, such as HTTP 403 on rule sets.
 */

/**
 * Reset a fixture repository, as its owner.
 * @param {GitHub} github The Lead's client for the repository.
 * @param {FixtureRepoInfo} info
 * @param {{ log?: (line: string) => void }} [options]
 * @returns {Promise<ResetReport>}
 */
export async function resetFixtureRepo(github, info, { log = () => {} } = {}) {
  const [owner, name] = info.repo.split('/')
  /** @type {ResetReport} */
  const report = {
    repo: info.repo,
    deletedRulesets: [],
    deletedBranchRules: [],
    closedPullRequests: [],
    closedIssues: [],
    unpinnedIssues: [],
    deletedLabels: [],
    main: { before: null, after: info.resetSha },
    accepted: [],
  }

  /**
   * An HTTP 403 where GitHub refuses protection on this repository, accepted and reported.
   * @param {unknown} error
   * @param {string} what
   */
  const acceptRefusal = (error, what) => {
    if (info.protectionRefused && error instanceof RemoteError && error.status === 403) {
      report.accepted.push(`${what}: HTTP 403`)
      log(`reset ${info.repo}: ${what} answered HTTP 403, accepted (no GitHub Pro)`)
      return true
    }
    return false
  }

  // Rule sets.
  try {
    const rulesets = await github.apiPages('repos/{owner}/{repo}/rulesets', {
      query: { includes_parents: 'false' },
    })
    for (const ruleset of rulesets) {
      if (ruleset.source_type && ruleset.source_type !== 'Repository') continue
      await github.api(`repos/{owner}/{repo}/rulesets/${ruleset.id}`, { method: 'DELETE' })
      report.deletedRulesets.push({ id: ruleset.id, name: ruleset.name })
    }
  } catch (error) {
    if (!acceptRefusal(error, 'rule sets')) throw error
  }

  // Branch rules (branch protection), on every pattern, and the pinned issues.
  const rules = await graphql(github, RULES_QUERY, { owner, name })
  for (const rule of rules.repository.branchProtectionRules.nodes) {
    await graphql(github, DELETE_RULE, { id: rule.id })
    report.deletedBranchRules.push(rule.pattern)
  }
  const pinned = rules.repository.pinnedIssues.nodes.map(
    (/** @type {any} */ node) => node.issue.number,
  )

  // Pull requests, then issues.
  for (const pull of await github.listPullRequests({ state: 'open' })) {
    await github.updatePullRequest(pull.number, { state: 'closed' })
    report.closedPullRequests.push(pull.number)
  }
  for (const issue of await github.listIssues({ state: 'open' })) {
    await github.updateIssue(issue.number, { state: 'closed', stateReason: 'not_planned' })
    report.closedIssues.push(issue.number)
  }
  for (const number of pinned) {
    await github.run(['issue', 'unpin', String(number)])
    report.unpinnedIssues.push(number)
  }

  // Labels.
  for (const label of await github.listLabels()) {
    await github.deleteLabel(label.name)
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
  const after = await mainSha(github)
  const open = await github.apiPages('repos/{owner}/{repo}/issues', { query: { state: 'open' } })
  const labels = await github.listLabels()
  const problems = [
    after === info.resetSha ? null : `main is ${after}, not ${info.resetSha}`,
    open.length === 0 ? null : `still open: ${open.map((item) => `#${item.number}`).join(', ')}`,
    labels.length === 0 ? null : `labels left: ${labels.map((label) => label.name).join(', ')}`,
  ].filter(Boolean)
  if (problems.length > 0) {
    throw new Error(`the reset of ${info.repo} did not hold: ${problems.join('; ')}`)
  }
  log(`reset ${info.repo}: ${summarize(report)}`)
  return report
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
    `labels deleted ${report.deletedLabels.length}`,
    `main ${report.main.before === report.main.after ? 'unchanged' : `${report.main.before} -> ${report.main.after}`}`,
    ...(report.accepted.length > 0 ? [`accepted ${report.accepted.join(', ')}`] : []),
  ].join('; ')
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

// Rule sets for the tests of src/core/protection: the bodies of the two rule sets that `setup`
// creates (docs/build/contracts.md section 5.4), and the reads of the reader in the fake GitHub,
// in the form docs/verification.md recorded (E1, E5): `GET .../rules/branches/<branch>` lists the
// rules of the active rule sets that target the branch, each with its `ruleset_id`, and
// `GET .../rulesets/<id>` returns one rule set with `bypass_actors` and `current_user_can_bypass`.
//
// The fake GitHub of the test harness answers no rule set request, so tests of other tasks that
// call readProtection against it can import serveRulesets from here.

import {
  ACTIONS_APP_ID,
  ADMIN_ROLE_ID,
  REQUIRED_CHECK,
} from '../../../src/core/protection/index.js'
import { httpError } from '../../harness/index.js'

/** @import { FakeGitHub } from '../../harness/index.js' */

/** GitHub's answer on a private repository of a personal account without GitHub Pro (E3). */
export const NOT_OFFERED_MESSAGE =
  'Upgrade to GitHub Pro or make this repository public to enable this feature.'

/** The bypass actor of the update restriction (docs/verification.md row 6). */
export const ADMIN_BYPASS = Object.freeze({
  actor_id: ADMIN_ROLE_ID,
  actor_type: 'RepositoryRole',
  bypass_mode: 'always',
})

/** The required check pinned to GitHub Actions (docs/verification.md row 5). */
export const PINNED_CHECK = Object.freeze({
  context: REQUIRED_CHECK,
  integration_id: ACTIONS_APP_ID,
})

/** The details readProtection reports for a branch without any rule. */
export const NO_RULES = Object.freeze({
  pullRequestRequired: false,
  requiredChecks: [],
  checkRequired: false,
  checkPinned: false,
  forcePushBlocked: false,
  deletionBlocked: false,
  appliesToAdmins: false,
  updateRestricted: false,
  bypassable: [],
})

/** The details of the rules for everyone as setup creates them, without the update restriction. */
export const FULL_RULES = Object.freeze({
  pullRequestRequired: true,
  requiredChecks: [{ context: REQUIRED_CHECK, integrationId: ACTIONS_APP_ID }],
  checkRequired: true,
  checkPinned: true,
  forcePushBlocked: true,
  deletionBlocked: true,
  appliesToAdmins: true,
  updateRestricted: false,
  bypassable: [],
})

/** A pull request rule with one required approval, which a bypass would lift. */
export const ONE_APPROVAL = Object.freeze({
  type: 'pull_request',
  parameters: {
    required_approving_review_count: 1,
    dismiss_stale_reviews_on_push: false,
    require_code_owner_review: false,
    require_last_push_approval: false,
    required_review_thread_resolution: false,
  },
})

const ON_DEFAULT_BRANCH = { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }

/**
 * The rules for everyone: one rule set without bypass actors.
 * @param {{ name?: string, checks?: Array<{ context: string, integration_id?: number }> }} [options]
 */
export function branchRulesBody({ name = 'hackwin-branch-rules', checks = [PINNED_CHECK] } = {}) {
  return {
    name,
    target: 'branch',
    enforcement: 'active',
    conditions: ON_DEFAULT_BRANCH,
    bypass_actors: [],
    rules: [
      {
        type: 'pull_request',
        parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_review_thread_resolution: false,
        },
      },
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: false,
          required_status_checks: checks,
        },
      },
      { type: 'non_fast_forward' },
      { type: 'deletion' },
    ],
  }
}

/**
 * The update restriction: a rule set of its own with the admin role as its only bypass actor.
 * @param {{ name?: string }} [options]
 */
export function updateRestrictionBody({ name = 'hackwin-update-restriction' } = {}) {
  return {
    name,
    target: 'branch',
    enforcement: 'active',
    conditions: ON_DEFAULT_BRANCH,
    bypass_actors: [ADMIN_BYPASS],
    rules: [{ type: 'update', parameters: { update_allows_fetch_and_merge: false } }],
  }
}

/**
 * Answer the reader's requests in the fake GitHub from a list of rule sets. A rule set may set
 * `current_user_can_bypass` itself, as undefined to leave it out; otherwise it is `always` for an
 * admin of the repository when the admin role is a bypass actor, and `never` for everyone else. A rule set whose
 * `bypass_actors` is undefined is returned without them. With `offered: false` both requests
 * answer as GitHub does on a repository without rule sets.
 * @param {FakeGitHub} fake
 * @param {any[]} [initial] Rule set bodies; `id` is given when missing.
 * @param {{ offered?: boolean }} [options]
 * @returns {{ rulesets: any[], add: (body: any) => any }} The list, which the test may change.
 */
export function serveRulesets(fake, initial = [], { offered = true } = {}) {
  /** @type {any[]} */
  const rulesets = []
  let nextId = 24_000_001
  /** @param {any} body */
  const add = (body) => {
    const ruleset = { id: nextId++, source_type: 'Repository', source: fake.state.repo, ...body }
    rulesets.push(ruleset)
    return ruleset
  }
  for (const body of initial) add(body)

  const refuse = () => {
    throw httpError(403, NOT_OFFERED_MESSAGE)
  }

  fake.on('GET repos/{owner}/{repo}/rules/branches/:branch*', ({ params, query, state }) => {
    if (!offered) refuse()
    const rules = rulesets
      .filter((ruleset) => ruleset.enforcement === 'active')
      .filter((ruleset) => targets(ruleset, params.branch, state.defaultBranch))
      .flatMap((ruleset) =>
        ruleset.rules.map((/** @type {any} */ rule) => ({
          type: rule.type,
          ...(rule.parameters ? { parameters: rule.parameters } : {}),
          ruleset_source_type: 'Repository',
          ruleset_source: state.repo,
          ruleset_id: ruleset.id,
        })),
      )
    const perPage = Number(query.per_page ?? 30)
    const page = Number(query.page ?? 1)
    return rules.slice((page - 1) * perPage, page * perPage)
  })

  fake.on('GET repos/{owner}/{repo}/rulesets/:id', ({ params, login, state }) => {
    if (!offered) refuse()
    const ruleset = rulesets.find((own) => own.id === Number(params.id))
    if (!ruleset) throw httpError(404, 'Not Found')
    const adminBypass = (ruleset.bypass_actors ?? []).some(
      (/** @type {any} */ actor) =>
        actor.actor_type === 'RepositoryRole' && actor.actor_id === ADMIN_ROLE_ID,
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
  })

  return { rulesets, add }
}

/**
 * @param {any} ruleset
 * @param {string} branch
 * @param {string} defaultBranch
 */
function targets(ruleset, branch, defaultBranch) {
  return (ruleset.conditions?.ref_name?.include ?? []).some(
    (/** @type {string} */ pattern) =>
      pattern === '~ALL' ||
      (pattern === '~DEFAULT_BRANCH' && branch === defaultBranch) ||
      pattern === `refs/heads/${branch}`,
  )
}

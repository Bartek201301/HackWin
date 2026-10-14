// Rule sets for the tests of src/core/protection: the bodies of the two rule sets that `setup`
// creates (docs/build/contracts.md section 5.4) and the details the reader reports for them. The
// fake GitHub of the test harness holds the rule sets and answers the reader's requests.

import {
  ACTIONS_APP_ID,
  ADMIN_ROLE_ID,
  REQUIRED_CHECK,
} from '../../../src/core/protection/index.js'

/** @import { FakeGitHub, FakeRuleset } from '../../harness/index.js' */

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
 * Give a fake GitHub these rule sets. The fake GitHub of the test harness answers the rule set
 * requests itself (`rulesets` and `rulesetsOffered` of its state, `addRuleset`); this function
 * stays for the tests that import it, such as the Gate's. A rule set may set
 * `current_user_can_bypass` itself, as undefined to leave it out; a rule set whose
 * `bypass_actors` is undefined is returned without them. With `offered: false` every rule set
 * request answers as GitHub does on a repository without rule sets.
 * @param {FakeGitHub} fake
 * @param {any[]} [initial] Rule set bodies; `id` is given when missing.
 * @param {{ offered?: boolean }} [options]
 * @returns {{ rulesets: FakeRuleset[], add: (body: any) => FakeRuleset }} The fake's own list,
 *   which the test may change.
 */
export function serveRulesets(fake, initial = [], { offered = true } = {}) {
  fake.state.rulesetsOffered = offered
  for (const body of initial) fake.addRuleset(body)
  return { rulesets: fake.state.rulesets, add: fake.addRuleset }
}

// Steps 11 and 12 of `setup` (7.1): the branch rules of the default branch as two repository rule
// sets, read back through src/core/protection (settle.js), and the fallback where GitHub refuses
// them. The
// mechanism and the names are those of docs/build/contracts.md section 5.4, which
// docs/verification.md (rows 5 and 6) confirmed:
//
// - `hackwin-branch-rules`, the rules for everyone (A32): a pull request, the check `hackwin`
//   pinned to the GitHub Actions app, no force push, no deletion, no bypass actor, so the rules
//   bind the owner too; "up to date" stays off.
// - `hackwin-update-restriction` [D2]: the rule `update` with the repository admin role as its
//   only bypass actor, a rule set of its own, so the bypass does not lift the rules above.
//
// A rule set of either name is updated in place, so a rerun creates no second one (CM3). Where
// GitHub refuses the pin, the rules for everyone are applied with an unpinned check, and the
// summary says so (scope change on #13). Where GitHub refuses the update restriction, the rules
// for everyone stay (full); where it refuses rule sets, setup falls back to soft protection.

import { ACTIONS_APP_ID, ADMIN_ROLE_ID, REQUIRED_CHECK } from '../../core/protection/index.js'
import { RemoteError, runIn } from '../../core/runtime/index.js'
import { unsettled } from './settle.js'

/** @import { GitHub } from '../../core/github/index.js' */
/** @import { Protection, ProtectionState } from '../../core/protection/index.js' */
/** @import { Settled } from './settle.js' */

/** The rule set of the rules for everyone (contracts 5.4). */
export const BRANCH_RULES = 'hackwin-branch-rules'

/** The rule set of the update restriction (contracts 5.4). */
export const UPDATE_RESTRICTION = 'hackwin-update-restriction'

/** The HTTP statuses with which GitHub refuses a rule set, as opposed to failing. */
const REFUSALS = Object.freeze([403, 404, 422])

/** GitHub's answer where it offers no rule sets (docs/verification.md E3, contracts 5.4). */
const NOT_OFFERED = /make this repository public to enable this feature/i

/** Both rule sets apply to the default branch, whatever its name. */
const ON_DEFAULT_BRANCH = Object.freeze({
  ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] },
})

/**
 * What setup wrote, or what GitHub refused.
 * @typedef {object} RulesOutcome
 * @property {boolean} offered False where GitHub offers no rule sets for the repository.
 * @property {'created' | 'updated' | null} branchRules What setup did with the rules for
 *   everyone; null when GitHub refused them.
 * @property {'created' | 'updated' | null} updateRestriction The same for the update restriction.
 * @property {string | null} refused Why GitHub refused the rules for everyone.
 * @property {string | null} restrictionRefused Why GitHub refused the update restriction.
 * @property {string | null} pinRefused Why GitHub refused the pinned check; the rules for
 *   everyone then require an unpinned one.
 */

/**
 * The body of the rules for everyone.
 * @param {{ pinned?: boolean }} [options] Pin the check `hackwin` to the GitHub Actions app.
 */
export function branchRulesBody({ pinned = true } = {}) {
  return {
    name: BRANCH_RULES,
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
          required_status_checks: [
            pinned
              ? { context: REQUIRED_CHECK, integration_id: ACTIONS_APP_ID }
              : { context: REQUIRED_CHECK },
          ],
        },
      },
      { type: 'non_fast_forward' },
      { type: 'deletion' },
    ],
  }
}

/** The body of the update restriction. */
export function updateRestrictionBody() {
  return {
    name: UPDATE_RESTRICTION,
    target: 'branch',
    enforcement: 'active',
    conditions: ON_DEFAULT_BRANCH,
    bypass_actors: [
      { actor_id: ADMIN_ROLE_ID, actor_type: 'RepositoryRole', bypass_mode: 'always' },
    ],
    rules: [{ type: 'update', parameters: { update_allows_fetch_and_merge: false } }],
  }
}

/**
 * Step 11: apply both rule sets where GitHub accepts them. The state is read back afterwards,
 * once GitHub's reads have settled (settle.js).
 * @param {GitHub} github The Lead's client.
 * @returns {Promise<RulesOutcome>}
 */
export async function applyBranchRules(github) {
  /** @type {RulesOutcome} */
  const outcome = {
    offered: true,
    branchRules: null,
    updateRestriction: null,
    refused: null,
    restrictionRefused: null,
    pinRefused: null,
  }
  const existing = await ownRulesets(github)
  if (existing === null) {
    outcome.offered = false
  } else {
    await applyRulesForEveryone(github, existing, outcome)
    if (outcome.branchRules !== null) {
      try {
        outcome.updateRestriction = await putRuleset(github, existing, updateRestrictionBody())
      } catch (error) {
        outcome.restrictionRefused = refusalOf(error)
      }
    }
  }
  return outcome
}

/**
 * The rules for everyone, pinned; where GitHub refuses that, unpinned.
 * @param {GitHub} github
 * @param {any[]} existing
 * @param {RulesOutcome} outcome Filled in.
 */
async function applyRulesForEveryone(github, existing, outcome) {
  try {
    outcome.branchRules = await putRuleset(github, existing, branchRulesBody({ pinned: true }))
    return
  } catch (error) {
    const reason = refusalOf(error)
    if (NOT_OFFERED.test(reason)) {
      outcome.offered = false
      return
    }
    outcome.pinRefused = reason
  }
  try {
    outcome.branchRules = await putRuleset(github, existing, branchRulesBody({ pinned: false }))
  } catch (error) {
    outcome.refused = refusalOf(error)
    outcome.pinRefused = null
  }
}

/**
 * The repository's own rule sets, without those an organization applies, or null where GitHub
 * offers no rule sets.
 * @param {GitHub} github
 * @returns {Promise<any[] | null>}
 */
async function ownRulesets(github) {
  try {
    const rulesets = await github.apiPages('repos/{owner}/{repo}/rulesets', {
      query: { includes_parents: 'false' },
    })
    return rulesets.filter((ruleset) => (ruleset.source_type ?? 'Repository') === 'Repository')
  } catch (error) {
    if (error instanceof RemoteError && error.status === 403 && NOT_OFFERED.test(error.message)) {
      return null
    }
    throw error
  }
}

/**
 * Create a rule set, or update the one of the same name.
 * @param {GitHub} github
 * @param {any[]} existing The repository's own rule sets; a created one is added.
 * @param {{ name: string }} body
 * @returns {Promise<'created' | 'updated'>}
 */
async function putRuleset(github, existing, body) {
  const own = existing.find((ruleset) => ruleset.name === body.name)
  if (own) {
    await github.api(`repos/{owner}/{repo}/rulesets/${own.id}`, { method: 'PUT', body })
    return 'updated'
  }
  existing.push(await github.api('repos/{owner}/{repo}/rulesets', { method: 'POST', body }))
  return 'created'
}

/**
 * GitHub's reason for refusing a rule set. Any other failure is thrown again: a network or
 * server failure leaves the step for `setup --resume`.
 * @param {unknown} error
 * @returns {string}
 */
function refusalOf(error) {
  if (error instanceof RemoteError && REFUSALS.includes(error.status ?? 0)) {
    const tail = /** @type {string[]} */ (error.details?.tail ?? [])
    return tail.length > 0 ? tail.join(' ') : error.message
  }
  throw error
}

/**
 * The lines of the summary for the protection state (step 15), with the fallback in use.
 * @param {RulesOutcome} outcome
 * @param {Settled<Protection>} read The state read back from GitHub.
 * @param {object} context
 * @param {string} context.branch
 * @param {string} context.lead
 * @param {string} context.repository `owner/name`.
 * @param {boolean} context.personal The repository belongs to a personal account, whose owner is
 *   its only admin. Otherwise every admin of the repository can bypass the update restriction,
 *   an organization's owners included.
 * @param {string} context.root The main checkout, for the resume command.
 * @returns {string[]}
 */
export function protectionLines(outcome, read, { branch, lead, repository, personal, root }) {
  const { state, rules } = read.value
  const everyone = `changes to ${branch} only through a pull request whose check ${REQUIRED_CHECK} passed, no force push and no deletion, for every account, the owner included`
  const updaters = personal
    ? `only ${lead} can update ${branch}, so GitHub refuses a merge by any other account`
    : `only the admins of ${repository} can update ${branch}, ${lead} and any other admin of the repository, the organization's owners included, so GitHub refuses a merge by any account without admin rights`
  /** @type {Record<ProtectionState, string>} */
  const lines = {
    'full-restricted': `protection: full, with the update restriction: ${everyone}; ${updaters}`,
    full: `protection: full, without the update restriction: ${everyone}; GitHub does not restrict updates of ${branch} to ${personal ? lead : `the admins of ${repository}`}${because(outcome.restrictionRefused)}, so merges by agent sessions are blocked only softly (10.6)`,
    soft: `protection: soft: ${softReason(outcome, repository)}. The pre-push hook blocks pushes to ${branch}, agent sessions have no right to merge, and the Gate serializes merges; a public repository gets full protection`,
  }
  const result = [lines[state]]
  if (rules.checkRequired && !rules.checkPinned) {
    result.push(
      `the required check ${REQUIRED_CHECK} is not pinned to the GitHub Actions app${because(outcome.pinRefused)}: a status that anyone with write access posts by hand can satisfy it. Once GitHub Actions has run in ${repository}, ${runIn('hackwin setup --resume', root)} to pin it`,
    )
  }
  if (!read.settled) result.push(unsettled('protection state', read, root))
  return result
}

/**
 * @param {RulesOutcome} outcome
 * @param {string} repository
 * @returns {string}
 */
function softReason(outcome, repository) {
  if (!outcome.offered) {
    return `GitHub offers no branch rules for ${repository} (a private repository on a free plan has none)`
  }
  if (outcome.refused !== null) return `GitHub refused the branch rules${because(outcome.refused)}`
  return `the branch rules read back from GitHub are incomplete`
}

/**
 * @param {string | null} reason
 * @returns {string}
 */
function because(reason) {
  return reason === null ? '' : ` (GitHub answered: ${reason})`
}

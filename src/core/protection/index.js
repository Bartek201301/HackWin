// The protection state of the default branch (7.1 steps 11 and 12, A32), read from GitHub with
// the Lead's token: for the read back of `setup` and for the Gate's header and status issue
// (7.5 step 7, 9.6). See docs/build/contracts.md, sections 4.11 and 5.4.
//
// The mechanism is the one of docs/verification.md, rows 5 and 6: repository rule sets. The
// reader goes by the rules GitHub reports for the branch (`GET .../rules/branches/<branch>`, each
// rule with its `ruleset_id`) and by the bypass list of each of their rule sets
// (`GET .../rulesets/<id>`), not by the names of the rule sets. Classic branch protection is not
// read: `setup` never creates it, and GitHub offers rule sets on the same repositories.

import { nullWhenNotFound } from '../github/index.js'
import { RemoteError } from '../runtime/errors.js'

/** @import { GitHub } from '../github/index.js' */

/** The protection states of docs/build/contracts.md section 5.4, strongest first. */
export const PROTECTION_STATES = Object.freeze(['full-restricted', 'full', 'soft'])

/** The CI check that the rules for everyone require (7.1 step 11). */
export const REQUIRED_CHECK = 'hackwin'

/** The GitHub Actions app, which the required check is pinned to (docs/verification.md row 5). */
export const ACTIONS_APP_ID = 15368

/** The repository admin role: the bypass actor of the update restriction (verification row 6). */
export const ADMIN_ROLE_ID = 5

// GitHub's answer where it offers no rule sets, as on a private repository of a personal account
// without GitHub Pro: HTTP 403 "Upgrade to GitHub Pro or make this repository public to enable
// this feature." (docs/verification.md, E3 and section 5).
const NOT_OFFERED = /make this repository public to enable this feature/i

/** @typedef {'full-restricted' | 'full' | 'soft'} ProtectionState */

/**
 * @typedef {object} RequiredCheck
 * @property {string} context The name of the check.
 * @property {number | null} integrationId The app the check must come from; null for any.
 */

/**
 * The rules in force on the branch. A rule is in force when an active rule set applies it, with
 * or without bypass actors; `appliesToAdmins` says whether the rules for everyone bind the owner.
 * @typedef {object} ProtectionRules
 * @property {boolean} pullRequestRequired Changes only through a pull request.
 * @property {RequiredCheck[]} requiredChecks Every required status check.
 * @property {boolean} checkRequired The check `hackwin` is required.
 * @property {boolean} checkPinned The check `hackwin` must come from the GitHub Actions app.
 *   Reported only: it does not change the state until the next PRD revision (issue #7).
 * @property {boolean} forcePushBlocked
 * @property {boolean} deletionBlocked
 * @property {boolean} appliesToAdmins Each of the four rules above that is in force is applied by
 *   a rule set without bypass actors, so it binds every account, the owner included. False when
 *   none of them is in force.
 * @property {boolean} updateRestricted The update restriction of D2: a rule `update` whose rule
 *   set has only the repository admin role as bypass actor, and the reading account can bypass it.
 * @property {BypassableRule[]} bypassable Every rule in force that the reading account can bypass,
 *   except the rule `update` of the update restriction; another rule inside the update
 *   restriction's own rule set is listed. Empty when the update restriction is the only rule the
 *   account can skip. The Gate reads this field, not the rule sets (#23).
 */

/**
 * A rule in force that the reading account can bypass: its rule set's `current_user_can_bypass` is
 * not `never`, or GitHub does not return it.
 * @typedef {object} BypassableRule
 * @property {string} type The rule, for example `pull_request`.
 * @property {string} ruleset The name of its rule set.
 */

/**
 * @typedef {object} Protection
 * @property {ProtectionState} state `full-restricted`: the rules for everyone and the update
 *   restriction; `full`: the rules for everyone without it; `soft`: anything less.
 * @property {ProtectionRules} rules
 */

/**
 * Read the protection state of a branch from GitHub. Called with the Lead's client: a rule set
 * whose bypass list GitHub does not return counts as having bypass actors, and one whose
 * `current_user_can_bypass` it does not return counts as one the Lead can bypass.
 * @param {GitHub} github
 * @param {{ branch?: string }} [options] The default branch of the repository when not given.
 * @returns {Promise<Protection>} A RemoteError (exit 3) when GitHub fails.
 */
export async function readProtection(github, { branch } = {}) {
  const name = branch ?? (await github.repository()).defaultBranch
  const listed = await branchRules(github, name)
  if (listed === null) return protectionOf([])

  /** @type {Map<number, any>} */
  const rulesets = new Map()
  const ids = new Set(listed.map((rule) => rule.ruleset_id).filter((id) => id != null))
  for (const id of ids) {
    // A rule set deleted since the first read no longer applies.
    const ruleset = await nullWhenNotFound(() => github.api(`repos/{owner}/{repo}/rulesets/${id}`))
    if (ruleset !== null) rulesets.set(id, ruleset)
  }
  return protectionOf(
    listed
      .filter((rule) => rulesets.has(rule.ruleset_id))
      .map((rule) => ({
        type: String(rule.type),
        parameters: rule.parameters ?? {},
        ruleset: rulesets.get(rule.ruleset_id),
      })),
  )
}

/**
 * The rules GitHub reports for the branch, or null where GitHub offers no rule sets.
 * @param {GitHub} github
 * @param {string} branch
 * @returns {Promise<any[] | null>}
 */
async function branchRules(github, branch) {
  const path = branch.split('/').map(encodeURIComponent).join('/')
  try {
    return await github.apiPages(`repos/{owner}/{repo}/rules/branches/${path}`)
  } catch (error) {
    if (error instanceof RemoteError && error.status === 403 && NOT_OFFERED.test(error.message)) {
      return null
    }
    throw error
  }
}

/**
 * @typedef {object} RuleInForce
 * @property {string} type
 * @property {any} parameters
 * @property {any} ruleset The rule set that applies the rule, as `GET .../rulesets/<id>` returns it.
 */

/**
 * @param {RuleInForce[]} rules
 * @returns {Protection}
 */
function protectionOf(rules) {
  /** @param {string} type */
  const ofType = (type) => rules.filter((rule) => rule.type === type)
  const checkRules = ofType('required_status_checks')

  /** @type {RequiredCheck[]} */
  const requiredChecks = []
  for (const rule of checkRules) {
    for (const check of checksOf(rule)) {
      if (
        !requiredChecks.some(
          (own) => own.context === check.context && own.integrationId === check.integrationId,
        )
      ) {
        requiredChecks.push(check)
      }
    }
  }

  const pullRequest = ofType('pull_request')
  const check = checkRules.filter((rule) =>
    checksOf(rule).some((own) => own.context === REQUIRED_CHECK),
  )
  const forcePush = ofType('non_fast_forward')
  const deletion = ofType('deletion')
  const inForce = [pullRequest, check, forcePush, deletion].filter((group) => group.length > 0)

  /** @type {ProtectionRules} */
  const details = {
    pullRequestRequired: pullRequest.length > 0,
    requiredChecks,
    checkRequired: check.length > 0,
    checkPinned: requiredChecks.some(
      (own) => own.context === REQUIRED_CHECK && own.integrationId === ACTIONS_APP_ID,
    ),
    forcePushBlocked: forcePush.length > 0,
    deletionBlocked: deletion.length > 0,
    appliesToAdmins:
      inForce.length > 0 &&
      inForce.every((group) => group.some((rule) => bindsEveryone(rule.ruleset))),
    updateRestricted: ofType('update').some((rule) => restrictsToAdmins(rule.ruleset)),
    bypassable: rules
      .filter((rule) => rule.ruleset.current_user_can_bypass !== 'never')
      .filter((rule) => !(rule.type === 'update' && restrictsToAdmins(rule.ruleset)))
      .map((rule) => ({ type: rule.type, ruleset: String(rule.ruleset.name ?? rule.ruleset.id) })),
  }
  const full =
    details.pullRequestRequired &&
    details.checkRequired &&
    details.forcePushBlocked &&
    details.deletionBlocked &&
    details.appliesToAdmins
  return {
    state: !full ? 'soft' : details.updateRestricted ? 'full-restricted' : 'full',
    rules: details,
  }
}

/**
 * @param {RuleInForce} rule A `required_status_checks` rule.
 * @returns {RequiredCheck[]}
 */
function checksOf(rule) {
  return (rule.parameters.required_status_checks ?? []).map((/** @type {any} */ check) => ({
    context: String(check.context),
    integrationId: check.integration_id ?? null,
  }))
}

/**
 * True for a rule set without bypass actors (docs/verification.md row 5).
 * @param {any} ruleset
 */
function bindsEveryone(ruleset) {
  return Array.isArray(ruleset.bypass_actors) && ruleset.bypass_actors.length === 0
}

/**
 * True for a rule set whose only bypass actor is the repository admin role, which the reading
 * account can bypass (docs/verification.md row 6).
 * @param {any} ruleset
 */
function restrictsToAdmins(ruleset) {
  const actors = ruleset.bypass_actors
  return (
    Array.isArray(actors) &&
    actors.length > 0 &&
    actors.every(
      (/** @type {any} */ actor) =>
        actor.actor_type === 'RepositoryRole' && actor.actor_id === ADMIN_ROLE_ID,
    ) &&
    typeof ruleset.current_user_can_bypass === 'string' &&
    ruleset.current_user_can_bypass !== 'never'
  )
}

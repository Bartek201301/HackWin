// The caller's identity: the login gh is authenticated with, matched to team.members (5.4, A4).

import { PreconditionError } from '../runtime/errors.js'
import { memberOf } from './ownership.js'

/** @import { Member } from './hackwin.js' */
/** @import { OwnershipConfig } from './ownership.js' */

/**
 * @typedef {object} Identity
 * @property {string} login The gh login, as GitHub spells it.
 * @property {Member} member The member of hackwin.yml with this login.
 * @property {string[]} roles The ownership roles the member holds.
 * @property {boolean} isLead True for the Lead (team.lead).
 */

/** What a login outside the team is told (7.2). */
export const NOT_IN_TEAM_RESOLVE = 'ask the Lead to add you to `hackwin.yml`'

/**
 * Match a gh login to the team. A login outside the team is a PreconditionError (exit 2) with
 * the resolve "ask the Lead to add you to `hackwin.yml`" (7.2).
 * @param {OwnershipConfig} config
 * @param {string} login
 * @returns {Identity}
 */
export function resolveIdentity(config, login) {
  const member = memberOf(config, login)
  if (!member) {
    throw new PreconditionError(
      `the gh login ${login} is not a member of the team in hackwin.yml`,
      { resolve: NOT_IN_TEAM_RESOLVE },
    )
  }
  return {
    login,
    member,
    roles: [...member.roles],
    isLead: member.github.toLowerCase() === config.hackwin.team.lead.toLowerCase(),
  }
}

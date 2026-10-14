// The validation rules of section 6.1, which read hackwin.yml together with owners.yml. Any
// violation makes every command exit 2 and name the key.

import { configError } from './fields.js'
import { rolesOfGlob } from './ownership.js'
import { sharedRole } from './owners.js'

/** @import { HackwinConfig } from './hackwin.js' */
/** @import { Owners } from './owners.js' */

const FILE = 'hackwin.yml'

/** The most members a team may have (A34). */
export const MAX_MEMBERS = 4

/**
 * Check every validation rule of 6.1 against both files. Throws a ConfigError that names the
 * first key that breaks a rule. owners.yml's own rules (6.2) hold once parseOwners returned.
 * @param {HackwinConfig} hackwin
 * @param {Owners} owners
 * @returns {void}
 */
export function validateConfig(hackwin, owners) {
  const { lead, members } = hackwin.team
  const memberKey = (/** @type {number} */ index, /** @type {string} */ key) =>
    `team.members[${index}].${key}`

  if (members.length < 1 || members.length > MAX_MEMBERS) {
    throw configError(
      FILE,
      'team.members',
      `has ${members.length} entries; a team has 1 to ${MAX_MEMBERS} members`,
    )
  }
  const seen = new Map()
  members.forEach((member, index) => {
    const login = member.github.toLowerCase()
    if (seen.has(login)) {
      throw configError(
        FILE,
        memberKey(index, 'github'),
        `(${member.github}) is also team.members[${seen.get(login)}]; each member appears once`,
      )
    }
    seen.set(login, index)
  })
  const leadIndex = members.findIndex(
    (member) => member.github.toLowerCase() === lead.toLowerCase(),
  )
  if (leadIndex === -1) {
    throw configError(FILE, 'team.lead', `(${lead}) must be one of team.members`)
  }

  const roleNames = Object.keys(owners.roles)
  members.forEach((member, index) => {
    for (const role of member.roles) {
      if (!roleNames.includes(role)) {
        throw configError(
          FILE,
          memberKey(index, 'roles'),
          `names the role ${role}, which owners.yml does not define`,
        )
      }
    }
  })
  if (members.length === 1) {
    const missing = roleNames.filter((role) => !members[0].roles.includes(role))
    if (missing.length > 0) {
      throw configError(
        FILE,
        memberKey(0, 'roles'),
        `lacks ${missing.join(', ')}: with one member, that member holds every role`,
      )
    }
  }
  for (const role of roleNames) {
    const holders = members.flatMap((member, index) => (member.roles.includes(role) ? [index] : []))
    if (holders.length === 0) {
      throw configError(
        FILE,
        'team.members',
        `gives the role ${role} of owners.yml to no member; every role has exactly one holder`,
      )
    }
    if (holders.length > 1) {
      throw configError(
        FILE,
        memberKey(holders[1], 'roles'),
        `names the role ${role}, which team.members[${holders[0]}] holds already; every role has exactly one holder`,
      )
    }
  }
  const shared = sharedRole(owners)
  const sharedHolder = members.findIndex((member) => member.roles.includes(shared))
  if (sharedHolder !== leadIndex) {
    throw configError(
      FILE,
      memberKey(sharedHolder, 'roles'),
      `names the shared role ${shared}, which the Lead (${lead}) must hold`,
    )
  }
  if (members[leadIndex].agent !== 'claude') {
    throw configError(
      FILE,
      memberKey(leadIndex, 'agent'),
      `must be claude for the Lead: the Claude Code deny rule is the only block against a merge by the Lead's own sessions [D12]`,
    )
  }

  const config = { hackwin, owners }
  /** @type {Array<[string, string[]]>} */
  const groups = [
    ['paths.contracts', hackwin.paths.contracts],
    ['paths.generated', hackwin.paths.generated],
    ['paths.manifests', hackwin.paths.manifests],
    ['paths.lockfiles', hackwin.paths.lockfiles],
    ['paths.gated.migrations', hackwin.paths.gated.migrations],
    ['paths.gated.production_config', hackwin.paths.gated.production_config],
  ]
  for (const [key, globs] of groups) {
    globs.forEach((glob, index) => {
      const other = rolesOfGlob(config, glob).roles.find((entry) => entry.role !== shared)
      if (other) {
        throw configError(
          FILE,
          `${key}[${index}]`,
          `(${glob}) must resolve to the shared role ${shared}, but ${other.path} belongs to the role ${other.role}`,
        )
      }
    })
  }
  if (hackwin.paths.manifests.length === 0) {
    throw configError(FILE, 'paths.manifests', 'must name at least one dependency manifest')
  }
  if (hackwin.resolver.enabled && hackwin.resolver.model === null) {
    throw configError(FILE, 'resolver.model', 'must be set while resolver.enabled is true')
  }
  if (hackwin.gate.status_issue_seconds >= hackwin.gate.heartbeat_stale_seconds) {
    throw configError(
      FILE,
      'gate.status_issue_seconds',
      `(${hackwin.gate.status_issue_seconds}) must be smaller than gate.heartbeat_stale_seconds (${hackwin.gate.heartbeat_stale_seconds})`,
    )
  }
}

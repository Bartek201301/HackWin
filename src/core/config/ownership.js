// Who owns a path, which roles a member holds, and the scope check of a change (E1, A15, A16).
// Logins are compared without regard to case, as GitHub does.

import { createMatcher, normalizePath, samplePath } from './glob.js'
import { sharedRole } from './owners.js'

/** @import { HackwinConfig, Member } from './hackwin.js' */
/** @import { Owners } from './owners.js' */

/**
 * The parts of a Config that the ownership functions read.
 * @typedef {{ hackwin: HackwinConfig, owners: Owners }} OwnershipConfig
 */

/**
 * @typedef {object} Owner
 * @property {string} role The role whose globs match the path, or the shared role (A16).
 * @property {string | null} holder The login of the member who holds the role.
 * @property {boolean} open True when the path is on the `open` list: everyone may edit it.
 */

/**
 * @typedef {object} ScopeViolation
 * @property {string} path
 * @property {string} role The role that owns the path.
 * @property {string | null} holder The login of the member who holds that role.
 */

/**
 * @typedef {object} ScopeResult
 * @property {ScopeViolation[]} violations Paths that are not open and whose role the login does not hold (E1).
 * @property {string[]} outsideTask Paths inside the login's roles but outside the task's paths: a warning only (A15).
 */

/** @type {WeakMap<Owners, { roles: Array<{ name: string, matches: (path: string) => boolean }>, open: (path: string) => boolean, shared: string }>} */
const matcherCache = new WeakMap()

/**
 * @param {Owners} owners
 */
function matchersOf(owners) {
  let matchers = matcherCache.get(owners)
  if (!matchers) {
    matchers = {
      roles: Object.entries(owners.roles).map(([name, role]) => ({
        name,
        matches: createMatcher(role.paths),
      })),
      open: createMatcher(owners.open),
      shared: sharedRole(owners),
    }
    matcherCache.set(owners, matchers)
  }
  return matchers
}

/**
 * The owner of a path: the role whose globs match it, or the shared role for a path that no
 * role matches (A16), its holder, and whether the path is on the `open` list.
 * @param {OwnershipConfig} config
 * @param {string} path Relative to the repository root.
 * @returns {Owner}
 */
export function ownerOf(config, path) {
  const normalized = normalizePath(path)
  const matchers = matchersOf(config.owners)
  const role =
    matchers.roles.find((candidate) => candidate.matches(normalized))?.name ?? matchers.shared
  return { role, holder: holderOf(config, role), open: matchers.open(normalized) }
}

/**
 * The login of the member who holds a role, or null when no member does.
 * @param {OwnershipConfig} config
 * @param {string} role
 * @returns {string | null}
 */
export function holderOf(config, role) {
  return config.hackwin.team.members.find((member) => member.roles.includes(role))?.github ?? null
}

/**
 * The member with this login, or undefined.
 * @param {OwnershipConfig} config
 * @param {string} login
 * @returns {Member | undefined}
 */
export function memberOf(config, login) {
  const wanted = login.toLowerCase()
  return config.hackwin.team.members.find((member) => member.github.toLowerCase() === wanted)
}

/**
 * The roles a member holds; none for a login outside the team.
 * @param {OwnershipConfig} config
 * @param {string} login
 * @returns {string[]}
 */
export function rolesOf(config, login) {
  return [...(memberOf(config, login)?.roles ?? [])]
}

/**
 * The scope check of a change against the roles that a login holds (E1), used by the hooks, CI,
 * `ship` and the Gate. A path on the `open` list is in everyone's scope. With `taskPaths`, the
 * paths inside the login's roles that no task glob matches are listed as a warning (A15).
 * Pass both paths of a rename.
 * @param {OwnershipConfig} config
 * @param {object} change
 * @param {string} change.login The author of the change.
 * @param {string[]} change.files Paths of the change, relative to the repository root.
 * @param {string[]} [change.taskPaths] The task's allowed paths (globs).
 * @returns {ScopeResult}
 */
export function scopeCheck(config, { login, files, taskPaths }) {
  const roles = new Set(rolesOf(config, login))
  const inTask = taskPaths ? createMatcher(taskPaths) : null
  /** @type {ScopeViolation[]} */
  const violations = []
  /** @type {string[]} */
  const outsideTask = []
  for (const path of new Set(files.map(normalizePath))) {
    const owner = ownerOf(config, path)
    if (roles.has(owner.role)) {
      if (inTask && !inTask(path)) outsideTask.push(path)
    } else if (!owner.open) {
      violations.push({ path, role: owner.role, holder: owner.holder })
    }
  }
  return { violations, outsideTask }
}

/**
 * Where the paths of a glob lie: the roles that own at least one of them, with a sample path
 * for each, and whether every path of the glob is on the `open` list.
 * @param {OwnershipConfig} config
 * @param {string} glob A glob that passes globError.
 * @returns {{ roles: Array<{ role: string, path: string }>, open: boolean }}
 */
export function rolesOfGlob(config, glob) {
  const shared = sharedRole(config.owners)
  /** @type {Array<{ role: string, path: string }>} */
  const roles = []
  /** @type {string[]} */
  const otherGlobs = []
  for (const [name, role] of Object.entries(config.owners.roles)) {
    if (name === shared) continue
    otherGlobs.push(...role.paths)
    const path =
      role.paths.length > 0 ? samplePath({ inside: [glob], alsoInside: role.paths }) : null
    if (path !== null) roles.push({ role: name, path })
  }
  // The shared role owns every path that no other role matches (A16).
  const sharedPath = samplePath({ inside: [glob], outside: otherGlobs })
  if (sharedPath !== null) roles.push({ role: shared, path: sharedPath })
  const open =
    config.owners.open.length > 0 &&
    samplePath({ inside: [glob], outside: config.owners.open }) === null
  return { roles, open }
}

// owners.yml: the schema of section 6.2. A path matches at most one role, so two roles with
// globs that share a path are rejected; a path that matches no role belongs to the shared role
// (A16); the `open` list holds paths that every member may edit.

import { Fields, configError, parseYaml } from './fields.js'
import { globError, samplePath } from './glob.js'

const FILE = 'owners.yml'

/**
 * @typedef {object} Role
 * @property {boolean} shared True for the one role that the Lead holds (3.4).
 * @property {string[]} paths
 */

/**
 * The parsed owners.yml.
 * @typedef {object} Owners
 * @property {1} schema
 * @property {Record<string, Role>} roles
 * @property {string[]} open
 */

/**
 * Parse owners.yml. Throws a ConfigError naming the key for a broken shape, unless exactly one
 * role is shared, and for two roles whose globs share a path.
 * @param {string} text
 * @returns {Owners}
 */
export function parseOwners(text) {
  const root = new Fields(FILE, '', parseYaml(FILE, text), ['schema', 'roles', 'open'])
  const schema = root.integer('schema')
  if (schema !== 1) throw root.error('schema', `must be 1, not ${schema}`)
  // The keys of `roles` are role names, so they are read without Fields' list of known keys.
  const rawRoles = root.value.roles
  if (rawRoles === undefined || rawRoles === null) throw root.error('roles', 'is missing')
  if (typeof rawRoles !== 'object' || Array.isArray(rawRoles)) {
    throw root.error('roles', 'must be a mapping from role names to roles')
  }
  /** @type {Record<string, Role>} */
  const roles = {}
  for (const name of Object.keys(rawRoles)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      throw configError(
        FILE,
        `roles.${name}`,
        'is not a valid role name: use letters, digits, ".", "_" and "-", starting with a letter or digit',
      )
    }
    const role = new Fields(FILE, `roles.${name}`, rawRoles[name], ['shared', 'paths'])
    roles[name] = {
      shared: role.boolean('shared', false),
      paths: role.strings('paths', { check: globError }),
    }
  }
  const shared = Object.keys(roles).filter((name) => roles[name].shared)
  if (shared.length === 0) {
    throw configError(FILE, 'roles', 'must have exactly one role with shared: true, and has none')
  }
  if (shared.length > 1) {
    throw configError(
      FILE,
      `roles.${shared[1]}.shared`,
      `is a second shared role besides ${shared[0]}; exactly one role carries shared: true`,
    )
  }
  const owners = {
    schema: /** @type {1} */ (1),
    roles,
    open: root.strings('open', { check: globError }),
  }
  checkOverlaps(owners)
  return owners
}

/**
 * The name of the shared role.
 * @param {Owners} owners
 * @returns {string}
 */
export function sharedRole(owners) {
  const name = Object.keys(owners.roles).find((role) => owners.roles[role].shared)
  if (name === undefined) throw new Error('owners.yml has no shared role')
  return name
}

/**
 * Two globs of different roles that share a path are a ConfigError on the later glob.
 * @param {Owners} owners
 */
function checkOverlaps(owners) {
  const names = Object.keys(owners.roles)
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      const [a, b] = [names[i], names[j]]
      owners.roles[b].paths.forEach((globB, indexB) => {
        owners.roles[a].paths.forEach((globA, indexA) => {
          const path = samplePath({ inside: [globB], alsoInside: [globA] })
          if (path !== null) {
            throw configError(
              FILE,
              `roles.${b}.paths[${indexB}]`,
              `(${globB}) overlaps roles.${a}.paths[${indexA}] (${globA}): both match ${path}, and a path matches at most one role`,
            )
          }
        })
      })
    }
  }
}

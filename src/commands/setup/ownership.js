// Step 4 of `setup` (7.1): ownership roles and their path globs, and who holds each role. An
// existing owners.yml is the starting proposal (6.5); otherwise setup proposes the HackYeah layout
// from the directory tree: one role per directory of a features directory, everything else
// shared. The Lead confirms or edits the roles and assigns each role to one member; the shared
// role goes to the Lead (3.4).

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { OWNERS_FILE, parseOwners } from '../../core/config/index.js'
import { ConfigError } from '../../core/runtime/index.js'
import { renderOwners } from '../../generate/index.js'
import { listText, wordsOf } from './questions.js'
import { sameLogin } from './team.js'

/** @import { Owners } from '../../core/config/index.js' */
/** @import { Questions } from './questions.js' */
/** @import { MemberAnswer, Team } from './team.js' */

/** The name of the shared role that setup proposes. */
export const SHARED_ROLE = 'shared'

/** The `open` list that setup proposes: only the README is open to everyone (6.2). */
export const OPEN_PATHS = Object.freeze(['README.md'])

/** Directories whose subdirectories are feature roles, in the order setup looks for them. */
export const FEATURE_PARENTS = Object.freeze([
  'src/features',
  'features',
  'src/modules',
  'modules',
  'apps',
  'packages',
])

/** What the questions of step 4 about the roles decide, in the words of the team. */
export const ROLES_INTRO =
  'Roles decide who may edit which folders: each role owns the folders and files listed after it, only the member who holds the role may change them, and every other path belongs to the shared role, which the Lead holds.'

/** How a path of a role is written, for the questions. */
const PATH_FORM = '<folder>/** is a folder and everything in it'

/** The HackYeah layout, shown as an example where the Lead types the roles (7.1 step 4). */
const EXAMPLE = Object.freeze([
  'shared: src/shared/**, src/app/**, docs/**, .github/**',
  'workbench: src/features/workbench/**',
  'detection: src/features/detection/**',
])

/**
 * @typedef {object} Proposal
 * @property {Owners} owners
 * @property {'owners.yml' | 'directory tree'} source
 */

/**
 * @typedef {object} Ownership
 * @property {Owners} owners
 * @property {MemberAnswer[]} members The members with their roles.
 */

/**
 * The starting proposal: the existing owners.yml, or the HackYeah layout of the directory tree.
 * An existing owners.yml that breaks a rule of 6.2, such as overlapping globs, is refused.
 * @param {string} root The checkout.
 * @param {ReadonlySet<string>} directories Every directory with a tracked file, relative.
 * @returns {Promise<Proposal>}
 */
export async function proposeOwners(root, directories) {
  /** @type {string | null} */
  let text = null
  try {
    text = await readFile(join(root, OWNERS_FILE), 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (text !== null) return { owners: parseOwners(text), source: 'owners.yml' }
  return { owners: ownersFromTree(directories), source: 'directory tree' }
}

/**
 * The HackYeah layout of a directory tree: one role per subdirectory of the first features
 * directory of FEATURE_PARENTS, and a shared role with every other directory beside the path to
 * it. A path that no glob names belongs to the shared role anyway (A16).
 * @param {ReadonlySet<string>} directories
 * @returns {Owners}
 */
export function ownersFromTree(directories) {
  const parent = FEATURE_PARENTS.find((dir) => childrenOf(directories, dir).length > 0) ?? null
  /** @type {string[]} */
  const shared = []
  let level = ''
  // Each directory on the way to the features directory is left out, its siblings are shared.
  for (const step of parent === null ? [null] : parent.split('/')) {
    for (const child of childrenOf(directories, level)) {
      if (child !== step) shared.push(`${join2(level, child)}/**`)
    }
    if (step !== null) level = join2(level, step)
  }
  /** @type {Owners['roles']} */
  const roles = { [SHARED_ROLE]: { shared: true, paths: shared } }
  for (const child of parent === null ? [] : childrenOf(directories, parent)) {
    roles[uniqueName(roleName(child), roles)] = { shared: false, paths: [`${parent}/${child}/**`] }
  }
  return { schema: 1, roles, open: [...OPEN_PATHS] }
}

/**
 * Step 4: the roles, their globs and their holders.
 * @param {Questions} questions
 * @param {object} options
 * @param {Team} options.team
 * @param {() => Promise<Proposal>} options.propose The starting proposal, read when needed.
 * @returns {Promise<Ownership>}
 */
export async function askOwnership(questions, { team, propose }) {
  /** @type {Owners} */
  let owners
  if (questions.has('roles')) {
    owners = checkedOwners(
      {
        schema: 1,
        roles: questions.given('roles'),
        open: questions.given('open') ?? [...OPEN_PATHS],
      },
      questions,
    )
  } else {
    const proposal = await propose()
    const open = questions.has('open') ? questions.given('open') : proposal.owners.open
    owners = checkedOwners({ ...proposal.owners, open }, questions)
    if (questions.interactive) owners = await confirmRoles(questions, owners, proposal)
  }

  const shared = sharedRoleOf(owners)
  const proposed = proposeHolders(owners, team)
  /** @type {MemberAnswer[]} */
  let members = team.members.map((member, index) => ({
    ...member,
    roles: member.roles ?? (questions.interactive ? null : proposed[index]),
  }))
  if (members.some((member) => member.roles === null)) {
    members = await askHolders(questions, { owners, team, proposed, members })
  }
  questions.say(
    `ownership: ${Object.keys(owners.roles).length} roles, ${shared} held by the Lead (${team.lead})`,
  )
  return { owners, members }
}

/**
 * True when the checkout's owners.yml says exactly these roles and open paths, so that it stays as
 * it is, comments included.
 * @param {string} root
 * @param {Owners} owners
 * @returns {Promise<boolean>}
 */
export async function ownersUnchanged(root, owners) {
  try {
    const existing = parseOwners(await readFile(join(root, OWNERS_FILE), 'utf8'))
    return JSON.stringify(existing) === JSON.stringify(owners)
  } catch {
    return false
  }
}

/**
 * The roles and globs in the terminal: the proposal is kept, or the Lead types the roles.
 * @param {Questions} questions
 * @param {Owners} owners
 * @param {Proposal} proposal
 * @returns {Promise<Owners>}
 */
async function confirmRoles(questions, owners, proposal) {
  const roles = Object.entries(owners.roles)
  const empty = roles.every(([, role]) => role.paths.length === 0) && roles.length === 1
  questions.say(ROLES_INTRO)
  if (!empty) {
    questions.say(`Ownership roles, from ${proposal.source}; ${PATH_FORM}:`)
    for (const line of rolesText(owners)) questions.say(`  ${line}`)
    questions.say(`  open (every member may edit): ${listText(owners.open)}`)
    if (await questions.keep('Keep these roles?')) return owners
  } else {
    questions.say('No ownership roles yet. An example, the layout of HackYeah 2026:')
    for (const line of EXAMPLE) questions.say(`  ${line}`)
  }
  questions.say(
    `Type one role per line as <role>: <path>, <path>, where ${PATH_FORM}. The first role is the shared role, which the Lead holds. An empty line ends the list.`,
  )
  for (;;) {
    /** @type {Owners['roles']} */
    const typed = {}
    for (;;) {
      const line = await questions.ask(`Role ${Object.keys(typed).length + 1}`, {
        fallback: '',
        check: (answer) =>
          answer === '' || /^[^:]+:/.test(answer) ? null : 'type <role>: <path>, <path>',
      })
      if (line === '') break
      const colon = line.indexOf(':')
      const name = line.slice(0, colon).trim()
      typed[name] = {
        shared: Object.keys(typed).length === 0,
        paths: wordsOf(line.slice(colon + 1)),
      }
    }
    if (Object.keys(typed).length === 0) {
      questions.say('  at least the shared role is needed')
      continue
    }
    try {
      return checkedOwners({ schema: 1, roles: typed, open: owners.open }, null)
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error
      questions.say(`  ${error.message}; type the roles again`)
    }
  }
}

/**
 * Who holds which role, in the terminal: each member confirms or edits the proposed roles.
 * @param {Questions} questions
 * @param {object} options
 * @param {Owners} options.owners
 * @param {Team} options.team
 * @param {string[][]} options.proposed
 * @param {MemberAnswer[]} options.members
 * @returns {Promise<MemberAnswer[]>}
 */
async function askHolders(questions, { owners, team, proposed, members }) {
  if (!questions.interactive) throw new Error('askHolders runs only in a terminal')
  const names = Object.keys(owners.roles)
  const shared = sharedRoleOf(owners)
  // Two holders that the answers file names cannot be fixed by the members asked here.
  for (const role of names) {
    const given = members.filter((member) => member.roles?.includes(role))
    if (given.length > 1) {
      const index = members.indexOf(given[1])
      throw questions.error(
        `team.members[${index}].roles`,
        `names the role ${role}, which ${given[0].github} holds already; every role has exactly one holder`,
      )
    }
  }
  questions.say(
    `Who holds which role: every role has exactly one holder, the member whose tasks may change its folders, and ${shared} goes to the Lead.`,
  )
  for (;;) {
    /** @type {MemberAnswer[]} */
    const result = []
    for (const [index, member] of members.entries()) {
      const isLead = sameLogin(member.github, team.lead)
      const roles =
        member.roles ??
        wordsOf(
          await questions.ask(`Roles of ${member.name} (${member.github}), separated by commas`, {
            fallback: proposed[index].join(', '),
            check: (answer) => {
              const words = wordsOf(answer)
              if (words.length === 0) return 'name at least one role'
              const unknown = words.find((word) => !names.includes(word))
              if (unknown) return `${unknown} is not a role; the roles are ${names.join(', ')}`
              if (isLead && !words.includes(shared))
                return `the Lead holds the shared role ${shared}`
              if (!isLead && words.includes(shared)) return `${shared} is the Lead's role`
              return null
            },
          }),
        )
      result.push({ ...member, roles })
    }
    const problem = holderProblem(names, result)
    if (problem === null) return result
    questions.say(`  ${problem}; assign the roles again`)
    members = members.map((member, index) => ({ ...member, roles: team.members[index].roles }))
  }
}

/**
 * The roles proposed for each member: the Lead holds the shared role and, alone, every role;
 * the feature roles go round the other members, and with two members the Lead also takes one
 * feature role (3.5).
 * @param {Owners} owners
 * @param {Team} team
 * @returns {string[][]}
 */
export function proposeHolders(owners, team) {
  const shared = sharedRoleOf(owners)
  const features = Object.keys(owners.roles).filter((role) => role !== shared)
  const leadIndex = team.members.findIndex((member) => sameLogin(member.github, team.lead))
  /** @type {string[][]} */
  const roles = team.members.map((_, index) => (index === leadIndex ? [shared] : []))
  const builders = team.members.map((_, index) => index).filter((index) => index !== leadIndex)
  if (builders.length === 0) {
    roles[leadIndex].push(...features)
    return roles
  }
  const rest = [...features]
  if (builders.length === 1 && rest.length > 1)
    roles[leadIndex].push(/** @type {string} */ (rest.pop()))
  rest.forEach((role, index) => roles[builders[index % builders.length]].push(role))
  return roles
}

/**
 * Why an assignment breaks a rule of 6.1, or null: every role has exactly one holder.
 * @param {string[]} names
 * @param {MemberAnswer[]} members
 * @returns {string | null}
 */
function holderProblem(names, members) {
  for (const role of names) {
    const holders = members.filter((member) => member.roles?.includes(role))
    if (holders.length === 0) return `nobody holds ${role}`
    if (holders.length > 1) return `${role} has ${holders.length} holders`
  }
  return null
}

/**
 * The owners.yml of these roles, through the rules of 6.2: overlapping globs, globs of an
 * unsupported syntax and anything but exactly one shared role are a ConfigError naming the key.
 * @param {unknown} owners
 * @param {Questions | null} questions Rewords the error for the answers file, when it gave them.
 * @returns {Owners}
 */
function checkedOwners(owners, questions) {
  try {
    return parseOwners(renderOwners(/** @type {Owners} */ (owners)))
  } catch (error) {
    if (!(error instanceof ConfigError) || questions === null || questions.file === null) {
      throw error
    }
    if (!questions.has('roles') && !questions.has('open')) throw error
    throw questions.error(error.key ?? 'roles', error.message.replace(/^owners\.yml: \S+ /, ''))
  }
}

/**
 * The shared role of a valid owners.yml.
 * @param {Owners} owners
 * @returns {string}
 */
export function sharedRoleOf(owners) {
  return /** @type {string} */ (Object.keys(owners.roles).find((role) => owners.roles[role].shared))
}

/**
 * One line per role, the shared role marked.
 * @param {Owners} owners
 * @returns {string[]}
 */
export function rolesText(owners) {
  return Object.entries(owners.roles).map(
    ([name, role]) => `${name}${role.shared ? ' (shared role)' : ''}: ${listText(role.paths)}`,
  )
}

/**
 * The directories directly inside `dir` (relative; empty for the root), sorted.
 * @param {ReadonlySet<string>} directories
 * @param {string} dir
 * @returns {string[]}
 */
function childrenOf(directories, dir) {
  const prefix = dir === '' ? '' : `${dir}/`
  const children = new Set()
  for (const path of directories) {
    if (!path.startsWith(prefix) || path === dir) continue
    children.add(path.slice(prefix.length).split('/')[0])
  }
  return [...children].sort()
}

/**
 * @param {string} dir
 * @param {string} child
 * @returns {string}
 */
function join2(dir, child) {
  return dir === '' ? child : `${dir}/${child}`
}

/**
 * A role name from a directory name: the characters of 6.2's role names, lower case.
 * @param {string} dir
 * @returns {string}
 */
function roleName(dir) {
  const name = dir
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
  return name === '' ? 'role' : name
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} taken
 * @returns {string}
 */
function uniqueName(name, taken) {
  if (!(name in taken)) return name
  let index = 2
  while (`${name}-${index}` in taken) index += 1
  return `${name}-${index}`
}

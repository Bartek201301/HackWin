// Steps 2 and 3 of `setup` (7.1): the team, its Lead, and each member's name, GitHub login,
// agent and number of sessions; then whether each login exists on GitHub and can write to the
// repository. The Lead runs setup, so the Lead's login must be the gh login (A62), and the Lead's
// agent is Claude Code [D12].

import { nullWhenNotFound } from '../../core/github/index.js'
import { PreconditionError } from '../../core/runtime/index.js'

/** @import { GitHub } from '../../core/github/index.js' */
/** @import { Questions } from './questions.js' */

/** The most members a team may have (A34). */
export const MAX_MEMBERS = 4

/** The agents a member may choose; `codex` is a beta [D7]. */
const AGENTS = Object.freeze(['claude', 'codex'])

/** Why the Lead's agent cannot be Codex [D12]. */
export const CODEX_LEAD_REASON =
  "the Lead's agent must be claude: the Claude Code deny rule is the only block against a merge by the Lead's own sessions (10.6), and from Phase 3 on the Resolver needs the claude CLI on the Lead's laptop [D12]"

/** The sessions a member may choose; 3 is advanced and prints a warning. */
const SESSIONS = Object.freeze([1, 2, 3])

/** The number of sessions proposed to every member. */
const DEFAULT_SESSIONS = 2

/**
 * A member as the questions give it. `roles` is null until step 4 assigns the roles, unless the
 * answers file names them.
 * @typedef {object} MemberAnswer
 * @property {string} name
 * @property {string} github
 * @property {string[] | null} roles
 * @property {'claude' | 'codex'} agent
 * @property {1 | 2 | 3} sessions
 */

/**
 * @typedef {object} Team
 * @property {string} lead The Lead's login.
 * @property {MemberAnswer[]} members The Lead first when asked in the terminal; as given in the
 *   answers file otherwise.
 */

/**
 * Step 2: the team, from the answers file or the terminal.
 * @param {Questions} questions
 * @param {object} options
 * @param {string} options.login The gh login that runs setup.
 * @returns {Promise<Team>}
 */
export async function askTeam(questions, { login }) {
  const team = questions.has('team')
    ? teamFromAnswers(questions)
    : await teamFromTerminal(questions, { login })
  for (const member of team.members) {
    if (member.sessions === 3) {
      questions.ctx.out.warn(
        `${member.github} runs 3 agent sessions, an advanced option: 1 or 2 is the default (3.2)`,
      )
    }
  }
  if (!sameLogin(team.lead, login)) throw notTheLead(questions, team.lead, login)
  return team
}

/**
 * @param {Questions} questions
 * @returns {Team}
 */
function teamFromAnswers(questions) {
  const team = questions.given('team')
  if (team === null || typeof team !== 'object' || Array.isArray(team)) {
    throw questions.error('team', 'must be a mapping with lead and members')
  }
  const { lead, members } = /** @type {Record<string, unknown>} */ (team)
  if (!Array.isArray(members)) throw questions.error('team.members', 'must be a list of members')
  if (members.length === 0 || members.length > MAX_MEMBERS) {
    throw questions.error(
      'team.members',
      `has ${members.length} entries; a team has 1 to ${MAX_MEMBERS} members, and setup refuses more (A34)`,
    )
  }
  if (typeof lead !== 'string' || lead.trim() === '') {
    throw questions.error('team.lead', "must be the Lead's GitHub login")
  }
  const parsed = members.map((member, index) => memberFromAnswers(questions, member, index))
  const leadIndex = parsed.findIndex((member) => sameLogin(member.github, lead))
  if (leadIndex === -1) throw questions.error('team.lead', `(${lead}) must be one of team.members`)
  if (parsed[leadIndex].agent !== 'claude') {
    throw questions.error(`team.members[${leadIndex}].agent`, `is codex, but ${CODEX_LEAD_REASON}`)
  }
  return { lead: lead.trim(), members: parsed }
}

/**
 * @param {Questions} questions
 * @param {unknown} value
 * @param {number} index
 * @returns {MemberAnswer}
 */
function memberFromAnswers(questions, value, index) {
  const key = `team.members[${index}]`
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw questions.error(key, 'must be a mapping with name, github, agent and sessions')
  }
  const member = /** @type {Record<string, unknown>} */ (value)
  const github = member.github
  if (typeof github !== 'string' || github.trim() === '') {
    throw questions.error(`${key}.github`, "must be the member's GitHub login")
  }
  const name = member.name ?? github
  if (typeof name !== 'string' || name.trim() === '') {
    throw questions.error(`${key}.name`, 'must be a non-empty text')
  }
  const agent = member.agent ?? 'claude'
  if (typeof agent !== 'string' || !AGENTS.includes(agent)) {
    throw questions.error(`${key}.agent`, `must be ${AGENTS.join(' or ')}`)
  }
  const sessions = member.sessions ?? DEFAULT_SESSIONS
  if (!SESSIONS.includes(/** @type {number} */ (sessions))) {
    throw questions.error(`${key}.sessions`, 'must be 1, 2 or 3')
  }
  const roles = member.roles ?? null
  if (
    roles !== null &&
    (!Array.isArray(roles) || roles.some((role) => typeof role !== 'string' || role === ''))
  ) {
    throw questions.error(`${key}.roles`, 'must be a list of ownership roles')
  }
  return {
    name: name.trim(),
    github: github.trim(),
    roles: /** @type {string[] | null} */ (roles),
    agent: /** @type {'claude' | 'codex'} */ (agent),
    sessions: /** @type {1 | 2 | 3} */ (sessions),
  }
}

/**
 * @param {Questions} questions
 * @param {{ login: string }} options
 * @returns {Promise<Team>}
 */
async function teamFromTerminal(questions, { login }) {
  const count = Number(
    await questions.ask(`How many people are in the team, 1 to ${MAX_MEMBERS}`, {
      check: (answer) => (/^[1-9]\d*$/.test(answer) ? null : 'answer with a number'),
    }),
  )
  if (count > MAX_MEMBERS) {
    throw new PreconditionError(
      `a team has 1 to ${MAX_MEMBERS} members, and setup refuses ${count} (A34)`,
      { resolve: `with at most ${MAX_MEMBERS} members, ${questions.rerun()}` },
    )
  }
  const lead = await questions.ask('GitHub login of the Lead', { fallback: login })
  if (!sameLogin(lead, login)) throw notTheLead(questions, lead, login)

  /** @type {MemberAnswer[]} */
  const members = []
  for (let index = 0; index < count; index += 1) {
    const who = index === 0 ? 'the Lead' : `person ${index + 1}`
    const github =
      index === 0
        ? lead
        : await questions.ask(`GitHub login of ${who}`, {
            check: (answer) => {
              if (answer === '') return 'an answer is needed'
              if (members.some((member) => sameLogin(member.github, answer))) {
                return `${answer} is already in the team`
              }
              return null
            },
          })
    const name = await questions.ask(`Name of ${who}`, { fallback: github })
    const agent = await questions.ask(
      index === 0 ? `Agent of ${who}: claude` : `Agent of ${who}: claude, or codex as a beta`,
      {
        fallback: 'claude',
        check: (answer) => {
          if (!AGENTS.includes(answer)) return `answer ${AGENTS.join(' or ')}`
          if (index === 0 && answer === 'codex')
            return `setup refuses codex here: ${CODEX_LEAD_REASON}`
          return null
        },
      },
    )
    const sessions = Number(
      await questions.ask(`Agent sessions of ${name}: 1 or 2, or 3 as an advanced option`, {
        fallback: String(DEFAULT_SESSIONS),
        check: (answer) => (['1', '2', '3'].includes(answer) ? null : 'answer 1, 2 or 3'),
      }),
    )
    members.push({
      name,
      github,
      roles: null,
      agent: /** @type {'claude' | 'codex'} */ (agent),
      sessions: /** @type {1 | 2 | 3} */ (sessions),
    })
  }
  return { lead, members }
}

/**
 * Step 3: each login exists on GitHub, and whether it can write to the repository. Read only:
 * the invitations come after the bootstrap commit.
 * @param {Questions} questions
 * @param {GitHub} github
 * @param {Team} team
 * @returns {Promise<Array<{ login: string, write: boolean }>>}
 */
export async function checkLogins(questions, github, team) {
  for (const [index, member] of team.members.entries()) {
    const login = member.github
    const user = await nullWhenNotFound(() => github.api(`users/${encodeURIComponent(login)}`))
    if (user === null) {
      throw new PreconditionError(
        `GitHub has no account ${login} (team.members[${index}].github)`,
        { resolve: `correct the login of ${member.name}, then ${questions.rerun()}` },
      )
    }
  }
  const writers = await writersOf(github)
  return team.members.map(({ github: login }) => ({
    login,
    write: writers.has(login.toLowerCase()),
  }))
}

/**
 * The logins, in lower case, that can write to the repository: admin, maintain or write. One
 * list of the collaborators answers it for the whole team. A login whose invitation waits to be
 * accepted is not among them.
 * @param {GitHub} github
 * @returns {Promise<Set<string>>}
 */
export async function writersOf(github) {
  const collaborators = await github.apiPages('repos/{owner}/{repo}/collaborators')
  return new Set(
    collaborators
      .filter((collaborator) => collaborator?.permissions?.push === true)
      .map((collaborator) => String(collaborator.login).toLowerCase()),
  )
}

/**
 * GitHub compares logins without case.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sameLogin(a, b) {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/**
 * @param {Questions} questions
 * @param {string} lead
 * @param {string} login
 * @returns {PreconditionError}
 */
function notTheLead(questions, lead, login) {
  return new PreconditionError(
    `the Lead is ${lead}, but gh is logged in as ${login}: setup must be run by the Lead, because the branch rules, the Gate and the approvals are tied to the Lead's account (A62)`,
    {
      resolve: `log gh in as ${lead} with \`gh auth login\` in any directory, or name ${login} as the Lead; then ${questions.rerun()}`,
    },
  )
}

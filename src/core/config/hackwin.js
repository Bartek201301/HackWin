// hackwin.yml: the schema of section 6.1 with the defaults of section 6.3. Parsing checks the
// shape of every key; validateConfig checks the validation rules of 6.1.

import semver from 'semver'
import { Fields, isIsoTimeWithOffset, parseYaml } from './fields.js'
import { globError } from './glob.js'

const FILE = 'hackwin.yml'

/** The agents a member may use; `codex` is a beta [D7]. */
export const AGENTS = Object.freeze(['claude', 'codex'])

/** The commands of `commands` that must not be empty (6.1). */
export const REQUIRED_COMMANDS = Object.freeze([
  'install',
  'check',
  'test',
  'format',
  'lockfile_regen',
])

/**
 * @typedef {object} Member
 * @property {string} name
 * @property {string} github The member's GitHub login.
 * @property {string[]} roles Ownership roles from owners.yml.
 * @property {'claude' | 'codex'} agent
 * @property {1 | 2 | 3} sessions
 */

/**
 * The parsed hackwin.yml. Keys keep the names of the file.
 * @typedef {object} HackwinConfig
 * @property {1} schema
 * @property {string} cli_version
 * @property {{ default_branch: string, language: string, event: { start: string, end: string } }} project
 * @property {{ lead: string, members: Member[] }} team
 * @property {{ install: string, check: string, test: string, format: string, generate: string | null, lockfile_regen: string, smoke: string | null }} commands
 * @property {{ contracts: string[], generated: string[], manifests: string[], lockfiles: string[], gated: { migrations: string[], production_config: string[] }, ledger: string | null }} paths
 * @property {{ max_files: number }} tasks
 * @property {{ poll_seconds: number, ci_rerun_limit: number, repeated_failure_threshold: number, heartbeat_stale_seconds: number, status_issue_seconds: number, ci_timeout_minutes: number, step_timeout_minutes: number, known_flaky_tests: string[], secret_patterns: string[] }} gate
 * @property {{ enabled: boolean, model: string | null, max_turns: number }} resolver
 */

/**
 * Parse hackwin.yml and apply the defaults of 6.3. Throws a ConfigError that names the key for
 * a key that is missing, unknown or of the wrong type. The validation rules of 6.1 are
 * validateConfig's.
 * @param {string} text
 * @returns {HackwinConfig}
 */
export function parseHackwinConfig(text) {
  const root = new Fields(FILE, '', parseYaml(FILE, text), [
    'schema',
    'cli_version',
    'project',
    'team',
    'commands',
    'paths',
    'tasks',
    'gate',
    'resolver',
  ])
  const schema = root.integer('schema')
  if (schema !== 1) throw root.error('schema', `must be 1, not ${schema}`)
  const cliVersion = root.string('cli_version')
  if (semver.valid(cliVersion) === null) {
    throw root.error('cli_version', `must be a version such as 0.1.0, not "${cliVersion}"`)
  }

  const project = root.mapping('project', ['default_branch', 'language', 'event'])
  const event = project.mapping('event', ['start', 'end'])
  for (const key of ['start', 'end']) {
    if (!isIsoTimeWithOffset(event.string(key))) {
      throw event.error(
        key,
        'must be an ISO 8601 time with an offset, such as 2026-10-17T09:00:00+02:00',
      )
    }
  }

  const team = root.mapping('team', ['lead', 'members'])
  const members = team.list('members').map((value, index) => parseMember(value, index))

  const commands = root.mapping('commands', [...REQUIRED_COMMANDS, 'generate', 'smoke'])
  const paths = root.mapping('paths', [
    'contracts',
    'generated',
    'manifests',
    'lockfiles',
    'gated',
    'ledger',
  ])
  const gated = paths.mapping('gated', ['migrations', 'production_config'], { optional: true })
  const tasks = root.mapping('tasks', ['max_files'], { optional: true })
  const gate = root.mapping(
    'gate',
    [
      'poll_seconds',
      'ci_rerun_limit',
      'repeated_failure_threshold',
      'heartbeat_stale_seconds',
      'status_issue_seconds',
      'ci_timeout_minutes',
      'step_timeout_minutes',
      'known_flaky_tests',
      'secret_patterns',
    ],
    { optional: true },
  )
  const resolver = root.mapping('resolver', ['enabled', 'model', 'max_turns'], { optional: true })

  /** @type {HackwinConfig} */
  const config = {
    schema: 1,
    cli_version: cliVersion,
    project: {
      default_branch: project.string('default_branch'),
      language: project.string('language', { fallback: 'en' }),
      event: { start: event.string('start'), end: event.string('end') },
    },
    team: { lead: team.string('lead'), members },
    commands: {
      install: commands.string('install'),
      check: commands.string('check'),
      test: commands.string('test'),
      format: commands.string('format'),
      generate: commands.optionalString('generate'),
      lockfile_regen: commands.string('lockfile_regen'),
      smoke: commands.optionalString('smoke'),
    },
    paths: {
      contracts: paths.strings('contracts', { check: globError }),
      generated: paths.strings('generated', { check: globError }),
      manifests: paths.strings('manifests', { check: globError }),
      lockfiles: paths.strings('lockfiles', { check: globError }),
      gated: {
        migrations: gated.strings('migrations', { check: globError }),
        production_config: gated.strings('production_config', { check: globError }),
      },
      ledger: paths.optionalString('ledger'),
    },
    tasks: { max_files: tasks.integer('max_files', { fallback: 10, min: 1 }) },
    gate: {
      poll_seconds: gate.integer('poll_seconds', { fallback: 60, min: 1 }),
      ci_rerun_limit: gate.integer('ci_rerun_limit', { fallback: 1, min: 0 }),
      repeated_failure_threshold: gate.integer('repeated_failure_threshold', {
        fallback: 2,
        min: 1,
      }),
      heartbeat_stale_seconds: gate.integer('heartbeat_stale_seconds', { fallback: 300, min: 1 }),
      status_issue_seconds: gate.integer('status_issue_seconds', { fallback: 120, min: 1 }),
      ci_timeout_minutes: gate.integer('ci_timeout_minutes', { fallback: 20, min: 1 }),
      step_timeout_minutes: gate.integer('step_timeout_minutes', { fallback: 20, min: 1 }),
      known_flaky_tests: gate.strings('known_flaky_tests'),
      secret_patterns: gate.strings('secret_patterns', { check: regexError }),
    },
    resolver: {
      // Phase 1 has no Resolver (I11).
      enabled: resolver.boolean('enabled', false),
      model: resolver.optionalString('model'),
      max_turns: resolver.integer('max_turns', { fallback: 30, min: 1 }),
    },
  }

  return config
}

/**
 * @param {unknown} value
 * @param {number} index
 * @returns {Member}
 */
function parseMember(value, index) {
  const member = new Fields(FILE, `team.members[${index}]`, value, [
    'name',
    'github',
    'roles',
    'agent',
    'sessions',
  ])
  const roles = member.strings('roles')
  if (roles.length === 0) throw member.error('roles', 'must name at least one ownership role')
  const agent = member.string('agent')
  if (!AGENTS.includes(agent)) {
    throw member.error('agent', `must be ${AGENTS.join(' or ')}, not "${agent}"`)
  }
  if (!member.has('sessions')) throw member.error('sessions', 'is missing; it must be 1, 2 or 3')
  const sessions = member.value.sessions
  if (sessions !== 1 && sessions !== 2 && sessions !== 3) {
    throw member.error('sessions', `must be 1, 2 or 3, not ${JSON.stringify(sessions)}`)
  }
  return {
    name: member.string('name'),
    github: member.string('github'),
    roles,
    agent: /** @type {'claude' | 'codex'} */ (agent),
    sessions,
  }
}

/**
 * @param {string} pattern
 * @returns {string | null}
 */
function regexError(pattern) {
  try {
    new RegExp(pattern)
    return null
  } catch (error) {
    return `is not a valid regular expression: ${error.message}`
  }
}

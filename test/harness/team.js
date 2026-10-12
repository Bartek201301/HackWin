// Team configurations of the fixtures: a valid hackwin.yml (6.1) and owners.yml (6.2) for a team
// of 1, 3 or 4 members (3.5), on the roles of the Node fixture's owners.yml: `shared`, `counter`,
// `todos` and `greeting`. Invitations are always off.

import { stringify } from 'yaml'
import { VERSION } from '../../src/cli/context.js'
import { BUILDER3_LOGIN, accounts } from './accounts.js'

/** The team sizes the fixtures offer. */
export const TEAM_SIZES = Object.freeze([1, 3, 4])

/** owners.yml of the Node fixture, as an object. */
export function ownersObject() {
  return {
    schema: 1,
    roles: {
      shared: { shared: true, paths: ['src/shared/**', 'docs/**', '.github/**'] },
      counter: { paths: ['src/features/counter/**'] },
      todos: { paths: ['src/features/todos/**'] },
      greeting: { paths: ['src/features/greeting/**'] },
    },
    open: ['README.md'],
  }
}

/**
 * The members of a team of this size. Solo: the Lead holds every role. 3: the Lead holds
 * `shared`, builder1 `counter` and `todos`, builder2 `greeting`. 4: one feature role per builder.
 * @param {number} size
 */
export function teamMembers(size) {
  const member = (name, github, roles) => ({ name, github, roles, agent: 'claude', sessions: 2 })
  switch (size) {
    case 1:
      return [member('Solo', accounts.solo.login, ['shared', 'counter', 'todos', 'greeting'])]
    case 3:
      return [
        member('Lead', accounts.lead.login, ['shared']),
        member('Builder One', accounts.builder1.login, ['counter', 'todos']),
        member('Builder Two', accounts.builder2.login, ['greeting']),
      ]
    case 4:
      return [
        member('Lead', accounts.lead.login, ['shared']),
        member('Builder One', accounts.builder1.login, ['counter']),
        member('Builder Two', accounts.builder2.login, ['todos']),
        member('Builder Three', BUILDER3_LOGIN, ['greeting']),
      ]
    default:
      throw new Error(`a fixture team has ${TEAM_SIZES.join(', ')} members, not ${size}`)
  }
}

/**
 * hackwin.yml of the Node fixture for a team of this size, pinned to the running CLI version.
 * @param {number} size
 */
export function hackwinObject(size) {
  const members = teamMembers(size)
  return {
    schema: 1,
    cli_version: VERSION,
    project: {
      default_branch: 'main',
      language: 'en',
      event: { start: '2026-10-24T09:00:00+02:00', end: '2026-10-25T15:00:00+02:00' },
    },
    team: { lead: members[0].github, members },
    commands: {
      install: 'npm ci',
      check: 'npm run check',
      test: 'npm test --',
      format: 'npm run format --',
      generate: null,
      lockfile_regen: 'npm install --package-lock-only',
      smoke: null,
    },
    paths: {
      contracts: ['src/shared/**'],
      generated: [],
      manifests: ['package.json'],
      lockfiles: ['package-lock.json'],
      gated: { migrations: [], production_config: [] },
      ledger: null,
    },
    tasks: { max_files: 10 },
    gate: {
      poll_seconds: 60,
      ci_rerun_limit: 1,
      repeated_failure_threshold: 2,
      heartbeat_stale_seconds: 300,
      status_issue_seconds: 120,
      ci_timeout_minutes: 20,
      step_timeout_minutes: 20,
      known_flaky_tests: [],
      secret_patterns: [],
    },
    resolver: { enabled: false, model: null, max_turns: 30 },
  }
}

/**
 * @typedef {object} TeamConfig
 * @property {number} size
 * @property {ReturnType<typeof hackwinObject>} hackwin
 * @property {ReturnType<typeof ownersObject>} owners
 * @property {ReturnType<typeof teamMembers>} members
 * @property {Record<string, unknown>} answers The answers of `setup --answers` (CM11) for this
 *   team: the keys of hackwin.yml, `roles` and `open` as in owners.yml, and `invite: false`.
 * @property {Record<string, string>} files `hackwin.yml` and `owners.yml` as YAML text.
 */

/**
 * The team configuration of a fixture.
 * @param {number} size 1, 3 or 4.
 * @returns {TeamConfig}
 */
export function teamConfig(size) {
  const hackwin = hackwinObject(size)
  const owners = ownersObject()
  const { project, team, commands, paths } = hackwin
  return {
    size,
    hackwin,
    owners,
    members: team.members,
    answers: {
      project,
      team,
      commands,
      paths,
      roles: owners.roles,
      open: owners.open,
      invite: false,
    },
    files: { 'hackwin.yml': yaml(hackwin), 'owners.yml': yaml(owners) },
  }
}

/**
 * YAML text of a value.
 * @param {unknown} value
 * @returns {string}
 */
export function yaml(value) {
  return stringify(value)
}

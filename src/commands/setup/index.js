// `hackwin setup` (7.1): the Lead configures a project once, in the main checkout. Steps 1 to 9:
// the preconditions, a few questions (in an interactive terminal or from `--answers <file>`,
// CM11), the logins, the ownership map, the detected stack commands and path groups, the event,
// the visibility, every committed file of 6.4, and the bootstrap commit with its push, the only
// direct push to the default branch in the life of the project. A failure before that push
// leaves GitHub and the checkout as they were. A configured repository exits 2: configuration
// changes go through a pull request by the Lead.

import { parseHackwinConfig, parseOwners, validateConfig } from '../../core/config/index.js'
import { NotBuiltError, PreconditionError, runIn } from '../../core/runtime/index.js'
import { renderHackwinConfig, renderOwners } from '../../generate/index.js'
import { bootstrap } from './bootstrap.js'
import { askOwnership, ownersUnchanged, proposeOwners } from './ownership.js'
import { checkPreconditions } from './preconditions.js'
import { askProject, reportVisibility } from './project.js'
import { openQuestions } from './questions.js'
import { askStack, detectStack } from './stack.js'
import { askTeam, checkLogins } from './team.js'

/** @import { CommandContext, CommandResult } from '../../cli/context.js' */
/** @import { Git } from '../../core/git/index.js' */
/** @import { HackwinConfig } from '../../core/config/index.js' */
/** @import { Questions } from './questions.js' */

/** The module of this command, for the flags that are not built yet. */
const MODULE = 'src/commands/setup/index.js'

/** `tasks` of hackwin.yml with the default of 6.3. */
const TASK_DEFAULTS = Object.freeze({ max_files: 10 })

/** `gate` of hackwin.yml with the defaults of 6.3. */
const GATE_DEFAULTS = Object.freeze({
  poll_seconds: 60,
  ci_rerun_limit: 1,
  repeated_failure_threshold: 2,
  heartbeat_stale_seconds: 300,
  status_issue_seconds: 120,
  ci_timeout_minutes: 20,
  step_timeout_minutes: 20,
  known_flaky_tests: [],
  secret_patterns: [],
})

/** `resolver` of hackwin.yml in Phase 1: no Resolver, no model (I11). */
const RESOLVER_PHASE_1 = Object.freeze({ enabled: false, model: null, max_turns: 30 })

/**
 * @param {CommandContext} ctx
 * @returns {Promise<CommandResult>}
 */
export async function run(ctx) {
  for (const flag of ['resume', 'regenerate']) {
    if (ctx.flags[flag]) {
      throw new NotBuiltError(`setup --${flag}`, MODULE, `setup --${flag} is not built yet`)
    }
  }
  if (ctx.config) throw configured(ctx)

  const questions = await openQuestions(ctx)
  try {
    return await setUp(ctx, questions)
  } finally {
    questions.close()
  }
}

/**
 * Steps 1 to 9.
 * @param {CommandContext} ctx
 * @param {Questions} questions
 * @returns {Promise<CommandResult>}
 */
async function setUp(ctx, questions) {
  const pre = await checkPreconditions(ctx)
  const { repository, branch } = pre

  const team = await askTeam(questions, { login: pre.login })
  const access = await checkLogins(questions, ctx.github, team)
  for (const { login, write } of access) {
    questions.say(
      write
        ? `${login}: write access to ${repository.nameWithOwner}`
        : `${login}: no write access to ${repository.nameWithOwner} yet`,
    )
  }

  const tree = await trackedTree(ctx.git)
  const ownership = await askOwnership(questions, {
    team,
    propose: () => proposeOwners(ctx.repoRoot, tree.directories),
  })
  const stack = await askStack(questions, await detectStack(ctx.repoRoot, tree))
  const project = await askProject(questions, { defaultBranch: branch })
  const visibility = reportVisibility(questions, repository)

  const hackwin = /** @type {HackwinConfig} */ ({
    schema: 1,
    cli_version: ctx.version,
    project,
    team: {
      lead: team.lead,
      members: ownership.members.map(({ name, github, roles, agent, sessions }) => ({
        name,
        github,
        roles,
        agent,
        sessions,
      })),
    },
    commands: stack.commands,
    paths: stack.paths,
    tasks: { ...TASK_DEFAULTS, ...section(questions, 'tasks') },
    gate: { ...GATE_DEFAULTS, ...section(questions, 'gate') },
    resolver: { ...RESOLVER_PHASE_1 },
  })
  const hackwinText = renderHackwinConfig(hackwin)
  const ownersText = renderOwners(ownership.owners)
  const checked = parseHackwinConfig(hackwinText)
  validateConfig(checked, parseOwners(ownersText))

  const result = await bootstrap(ctx, {
    branch,
    head: pre.head,
    version: ctx.version,
    language: project.language,
    hackwin: hackwinText,
    owners: (await ownersUnchanged(ctx.repoRoot, ownership.owners)) ? null : ownersText,
    secretPatterns: checked.gate.secret_patterns,
  })
  for (const notice of result.notices) ctx.out.warn(notice)

  const changes = [`${result.written.length} files written`]
  if (result.removed.length > 0) changes.push(`${result.removed.join(', ')} removed`)
  return {
    lines: [
      `bootstrap commit ${result.commit} pushed to origin/${branch} of ${repository.nameWithOwner}: ${changes.join(', ')}`,
    ],
    data: {
      repository: repository.nameWithOwner,
      defaultBranch: branch,
      visibility,
      lead: team.lead,
      versions: pre.versions,
      access,
      hackwin,
      owners: ownership.owners,
      commit: result.commit,
      written: result.written,
      removed: result.removed,
      kept: result.kept,
      notices: result.notices,
    },
  }
}

/**
 * A mapping of the answers file that overrides defaults of hackwin.yml, such as `gate`.
 * @param {Questions} questions
 * @param {string} key
 * @returns {Record<string, unknown>}
 */
function section(questions, key) {
  const value = questions.given(key)
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw questions.error(key, 'must be a mapping with the keys of hackwin.yml')
  }
  return /** @type {Record<string, unknown>} */ (value)
}

/**
 * Every tracked file of the checkout, and every directory that holds one.
 * @param {Git} git
 * @returns {Promise<{ files: Set<string>, directories: Set<string> }>}
 */
async function trackedTree(git) {
  const output = await git.run(['ls-files', '-z'])
  const files = new Set(output.stdout.split('\0').filter(Boolean))
  const directories = new Set()
  for (const file of files) {
    const parts = file.split('/')
    for (let depth = 1; depth < parts.length; depth += 1) {
      directories.add(parts.slice(0, depth).join('/'))
    }
  }
  return { files, directories }
}

/**
 * A second `setup` on a configured repository (7.1, failure behavior).
 * @param {CommandContext} ctx
 * @returns {PreconditionError}
 */
function configured(ctx) {
  const ref = ctx.config?.ref ?? 'origin/main'
  return new PreconditionError(
    `this repository is configured already: hackwin.yml is on ${ref}. Configuration changes go through a pull request by the Lead`,
    {
      resolve: `the Lead changes hackwin.yml or owners.yml in a task of the shared role and ships it as a pull request; to finish a setup that stopped after its bootstrap push, ${runIn('hackwin setup --resume', ctx.repoRoot)}`,
    },
  )
}

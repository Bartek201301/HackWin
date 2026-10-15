// Steps 10 to 15 of `setup` (7.1), after the bootstrap push: the labels and the invitations, the
// branch rules and their fallback, push protection, the steps of `join` for the Lead's machine,
// and the summary. `setup --resume` runs them again on a configured repository. Each step leaves
// what is already right as it is, so a rerun continues where the last run stopped and never
// creates a second label, rule set, invitation or file (CM3).

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { loadConfig, resolveIdentity } from '../../core/config/index.js'
import { HackwinError, PreconditionError, formatResolve, runIn } from '../../core/runtime/index.js'
import { readLocal } from '../../core/state/index.js'
import { mainCheckout } from '../../core/worktrees/index.js'
import { run as runJoin } from '../join/index.js'
import { inviteMembers } from './invitations.js'
import { createLabels } from './labels.js'
import { enablePushProtection, pushProtectionLine } from './push-protection.js'
import { applyBranchRules, protectionLines } from './rules.js'

/** @import { CommandContext, CommandResult } from '../../cli/context.js' */
/** @import { Config, Identity } from '../../core/config/index.js' */
/** @import { Repository } from '../../core/github/index.js' */

/** @typedef {Pick<Repository, 'nameWithOwner' | 'url'>} RepositoryName */
/** @import { Invitations } from './invitations.js' */
/** @import { Questions } from './questions.js' */

/** The explanation style offered when the Lead has none yet, as `join` offers it. */
const DEFAULT_STYLE = 'concise'

/** The questions of `join` that setup asks for the Lead's machine (CM11, A61). */
const JOIN_QUESTIONS = Object.freeze({
  language: 'Answer language of your agent sessions',
  explanation_style: 'Explanation style, for example concise or step by step',
})

/**
 * @typedef {object} Finish
 * @property {0 | 1} exitCode 1 when a check of `join` failed.
 * @property {string[]} lines The summary of step 15.
 * @property {Record<string, unknown>} data
 */

/**
 * Check the answers of the answers file that steps 10 and 14 use, before setup changes anything:
 * `invite`, and the `language` and `explanation_style` of `join`.
 * @param {Questions} questions
 */
export function checkLaterAnswers(questions) {
  if (questions.has('invite') && typeof questions.given('invite') !== 'boolean') {
    throw questions.error('invite', 'must be true or false')
  }
  for (const key of Object.keys(JOIN_QUESTIONS)) {
    const given = questions.given(key)
    if (given !== undefined && (typeof given !== 'string' || given.trim() === '')) {
      throw questions.error(key, 'must be a text, such as English or concise')
    }
  }
}

/**
 * Steps 10 to 15. An error ends setup with the instruction to run `setup --resume`.
 * @param {CommandContext} ctx
 * @param {Questions} questions
 * @param {object} options
 * @param {RepositoryName} options.repository
 * @param {Config} [options.config] Loaded from origin/main when not given.
 * @returns {Promise<Finish>}
 */
export async function finishSetup(ctx, questions, { repository, config }) {
  try {
    return await finish(ctx, questions, { repository, config })
  } catch (error) {
    throw resumable(error, ctx.repoRoot)
  }
}

/**
 * `setup --resume` (7.1, failure behavior): steps 10 to 15 on a repository whose origin holds the
 * bootstrap commit, run by the Lead in the main checkout.
 * @param {CommandContext} ctx
 * @param {Questions} questions
 * @returns {Promise<CommandResult>}
 */
export async function resumeSetup(ctx, questions) {
  const { config, identity } = ctx
  if (!config || !identity) {
    throw new PreconditionError(
      'there is nothing to resume: origin holds no hackwin.yml on its default branch, so the bootstrap push of setup did not happen',
      { resolve: runIn('hackwin setup', ctx.repoRoot) },
    )
  }
  if (!identity.isLead) {
    throw new PreconditionError(
      `setup --resume is run by the Lead, ${config.hackwin.team.lead}, but gh is logged in as ${identity.login}: the branch rules, the Gate and the approvals are tied to the Lead's account (A62)`,
      {
        resolve: `log gh in as ${config.hackwin.team.lead} with \`gh auth login\` in any directory, then ${runIn('hackwin setup --resume', ctx.repoRoot)}`,
      },
    )
  }
  const main = await mainCheckout(ctx.git)
  if (main !== ctx.repoRoot) {
    throw new PreconditionError('setup runs in the main checkout, not in a worktree', {
      resolve: { command: 'hackwin setup --resume', dir: main },
    })
  }
  checkLaterAnswers(questions)
  const repository = await ctx.github.repository()
  if (!repository.permissions.admin) {
    throw new PreconditionError(
      `${identity.login} has no admin rights on ${repository.nameWithOwner}; setup creates the branch rules, which need them`,
      {
        resolve: `give ${identity.login} admin rights, then ${runIn('hackwin setup --resume', main)}`,
      },
    )
  }
  ctx.out.line(
    `resuming setup of ${repository.nameWithOwner}: origin/${config.hackwin.project.default_branch} holds the bootstrap commit; the steps after it run again`,
  )
  const finished = await finishSetup(ctx, questions, { repository, config })
  return { exitCode: finished.exitCode, lines: finished.lines, data: finished.data }
}

/**
 * @param {CommandContext} ctx
 * @param {Questions} questions
 * @param {{ repository: RepositoryName, config?: Config }} options
 * @returns {Promise<Finish>}
 */
async function finish(ctx, questions, { repository, config: given }) {
  const config = given ?? (await loadConfig(ctx.git))
  const { hackwin, owners } = config
  const branch = hackwin.project.default_branch
  const lead = hackwin.team.lead
  const name = repository.nameWithOwner
  const root = ctx.repoRoot

  // Step 10.
  const labels = await createLabels(ctx.github, Object.keys(owners.roles))
  ctx.out.line(
    `labels: ${labels.created.length} created, ${labels.existing.length} were there already`,
  )
  const invitations = await inviteMembers(questions, ctx.github, {
    members: hackwin.team.members,
    repository: name,
  })
  for (const line of invitationLines(invitations, name)) ctx.out.line(line)

  // Steps 11 and 12.
  const rules = await applyBranchRules(ctx.github, { branch })
  ctx.out.line(`branch rules: the state read back from GitHub is ${rules.protection.state}`)

  // Step 13.
  const pushProtection = await enablePushProtection(ctx.github)
  ctx.out.line(`push protection: the setting read back from GitHub is ${pushProtection.status}`)

  // Step 14.
  ctx.out.line(`join for the Lead's machine, in ${root}:`)
  const identity = resolveIdentity(config, await ctx.github.login())
  const joined = await joinLead(ctx, questions, { config, identity })

  // Step 15.
  const lines = [
    joined.exitCode === 1
      ? `setup of ${name} is complete except for join on this machine`
      : `setup of ${name} is complete`,
    ...protectionLines(rules, { branch, lead, repository: name, root }),
    pushProtectionLine(pushProtection, name),
    ...memberLines({ config, identity, invitations, joined, repository, root }),
    'next:',
    `  ${runIn('hackwin gate', root)}, in a separate terminal that stays open`,
    `  write the first tasks by hand, as issues from the template "HackWin task" (.github/ISSUE_TEMPLATE/hackwin-task.md); docs/hackwin/manual-workflow.md describes the method`,
    `  send .env.local to each member over a private channel; it is never committed`,
  ]
  return {
    exitCode: joined.exitCode === 1 ? 1 : 0,
    lines,
    data: {
      labels,
      invitations,
      protection: {
        state: rules.protection.state,
        rules: rules.protection.rules,
        offered: rules.offered,
        branchRules: rules.branchRules,
        updateRestriction: rules.updateRestriction,
        refused: rules.refused,
        restrictionRefused: rules.restrictionRefused,
        pinRefused: rules.pinRefused,
      },
      pushProtection,
      join: { exitCode: joined.exitCode ?? 0, lines: joined.lines, data: joined.data },
    },
  }
}

/**
 * Step 14: the steps of `join` for the Lead's machine, through the `join` module. Setup asks the
 * questions of `join` itself, from the answers file or in the terminal, and hands the answers to
 * `join` in a file of its own, so that one reader serves the terminal.
 * @param {CommandContext} ctx
 * @param {Questions} questions
 * @param {{ config: Config, identity: Identity }} options
 * @returns {Promise<CommandResult>}
 */
async function joinLead(ctx, questions, { config, identity }) {
  const answers = await joinAnswers(ctx, questions, { config, login: identity.login })
  const scratch = await mkdtemp(join(tmpdir(), 'hackwin-setup-join-'))
  try {
    /** @type {CommandContext['flags']} */
    const flags = {}
    if (answers !== null) {
      flags.answers = join(scratch, 'answers.yml')
      await writeFile(flags.answers, stringify(answers))
    }
    const result = await runJoin({ ...ctx, command: 'join', flags, config, identity })
    return result ?? {}
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/**
 * The answer language and the explanation style for `join`: from the answers file; in a terminal,
 * asked with the Lead's earlier answer or the default; otherwise the earlier answer. Null when an
 * answer is missing outside a terminal: `join` then reports it.
 * @param {CommandContext} ctx
 * @param {Questions} questions
 * @param {{ config: Config, login: string }} options
 * @returns {Promise<{ language: string, explanation_style: string } | null>}
 */
async function joinAnswers(ctx, questions, { config, login }) {
  const local = await readLocal(ctx.gitCommonDir)
  const previous =
    local !== null && local.login.toLowerCase() === login.toLowerCase() ? local : null
  const defaults = { language: config.hackwin.project.language, explanation_style: DEFAULT_STYLE }
  /** @type {Record<string, string | null>} */
  const answers = {}
  for (const key of /** @type {const} */ (['language', 'explanation_style'])) {
    const given = questions.given(key)
    if (typeof given === 'string') {
      answers[key] = given.trim()
    } else if (questions.interactive) {
      answers[key] = await questions.ask(JOIN_QUESTIONS[key], {
        fallback: previous?.[key] ?? defaults[key],
      })
    } else {
      answers[key] = previous?.[key] ?? null
    }
  }
  const { language, explanation_style } = answers
  return language === null || explanation_style === null ? null : { language, explanation_style }
}

/**
 * The lines of step 10 about the invitations.
 * @param {Invitations} invitations
 * @param {string} repository
 * @returns {string[]}
 */
function invitationLines({ invited, waiting, declined, refused }, repository) {
  const lines = []
  if (invited.length > 0) lines.push(`invited to ${repository}: ${invited.join(', ')}`)
  if (waiting.length > 0) {
    lines.push(`invited earlier, not accepted yet: ${waiting.join(', ')}`)
  }
  if (declined.length > 0) lines.push(`not invited, without write access: ${declined.join(', ')}`)
  for (const { login, reason } of refused) {
    lines.push(`GitHub refused the invitation of ${login}: ${reason}`)
  }
  if (lines.length === 0) lines.push(`invitations: every member can write to ${repository}`)
  return lines
}

/**
 * The summary lines of the members: what each one runs, and what must happen first.
 * @param {object} options
 * @param {Config} options.config
 * @param {Identity} options.identity
 * @param {Invitations} options.invitations
 * @param {CommandResult} options.joined
 * @param {RepositoryName} options.repository
 * @param {string} options.root
 * @returns {string[]}
 */
function memberLines({ config, identity, invitations, joined, repository, root }) {
  const lines = ['members:']
  const theirClone = `the main checkout of their clone of ${repository.url}`
  const byHand = `give them write access on GitHub (Settings, Collaborators), or ${runIn('hackwin setup --resume', root)} and answer yes to the invitation`
  for (const member of config.hackwin.team.members) {
    const who = `  ${member.name} (${member.github})`
    const login = member.github.toLowerCase()
    const named = (/** @type {string[]} */ logins) =>
      logins.some((own) => own.toLowerCase() === login)
    if (login === identity.login.toLowerCase()) {
      lines.push(
        joined.exitCode === 1
          ? `${who}: join on this machine is not complete; fix the failed checks above, then ${runIn('hackwin join', root)}`
          : `${who}: joined on this machine`,
      )
    } else if (named(invitations.invited) || named(invitations.waiting)) {
      lines.push(
        `${who}: accept the invitation GitHub sent, then ${runIn('hackwin join', theirClone)}`,
      )
    } else if (
      named(invitations.declined) ||
      invitations.refused.some((entry) => entry.login.toLowerCase() === login)
    ) {
      lines.push(
        `${who}: needs write access to ${repository.nameWithOwner} first: ${byHand}; then ${runIn('hackwin join', theirClone)}`,
      )
    } else {
      lines.push(`${who}: ${runIn('hackwin join', theirClone)}`)
    }
  }
  return lines
}

/**
 * The error that ended a step after the bootstrap push, with the instruction to resume.
 * @param {unknown} error
 * @param {string} root
 * @returns {unknown}
 */
function resumable(error, root) {
  if (!(error instanceof HackwinError)) return error
  const resume = `${runIn('hackwin setup --resume', root)}: origin holds the bootstrap commit, and the steps after it run again`
  error.resolve =
    error.resolve === undefined ? resume : `${formatResolve(error.resolve)}; then ${resume}`
  return error
}

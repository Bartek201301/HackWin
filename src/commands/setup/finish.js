// Steps 10 to 15 of `setup` (7.1), after the bootstrap push: the labels and the invitations, the
// branch rules and their fallback, push protection, the steps of `join` for the Lead's machine,
// and the summary. `setup --resume` runs them again on a configured repository. Each step leaves
// what is already right as it is, so a rerun continues where the last run stopped and never
// creates a second label, rule set, invitation or file (CM3).

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { REPOSITORY_URL } from '../../cli/context.js'
import { installCommand, loadConfig, resolveIdentity } from '../../core/config/index.js'
import {
  HackwinError,
  PreconditionError,
  formatResolve,
  quoteShellArg,
  runIn,
} from '../../core/runtime/index.js'
import { readProtection } from '../../core/protection/index.js'
import { readLocal } from '../../core/state/index.js'
import { mainCheckout } from '../../core/worktrees/index.js'
import { envExampleKeys } from '../join/checks.js'
import { run as runJoin } from '../join/index.js'
import { inviteMembers } from './invitations.js'
import { createLabels } from './labels.js'
import { enablePushProtection, pushProtectionLines, readPushProtection } from './push-protection.js'
import { applyBranchRules, protectionLines } from './rules.js'
import { settledRead } from './settle.js'

/** @import { CommandContext, CommandResult } from '../../cli/context.js' */
/** @import { Config, Identity } from '../../core/config/index.js' */
/** @import { Repository } from '../../core/github/index.js' */

/** @typedef {Pick<Repository, 'nameWithOwner' | 'url'>} RepositoryName */
/** @import { Invitations } from './invitations.js' */
/** @import { Questions } from './questions.js' */

/** The explanation style offered when the Lead has none yet, as `join` offers it. */
const DEFAULT_STYLE = 'concise'

/** What the questions of `join` in step 14 decide, in the words of the team. */
export const JOIN_INTRO =
  'Your agent sessions on this machine: the language they answer you in, and how they explain what they do.'

/** The guide for the team, which the next steps point to. */
const GUIDE = 'docs/hackwin/using-hackwin.md'

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
  await holdsBootstrap(ctx, config.hackwin.project.default_branch)
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
 * The main checkout must hold origin's default branch, the bootstrap commit with it: step 14 runs
 * the checks of `join` there, whose hooks check needs the hook shims of that commit. The runner
 * has fast-forwarded a clean checkout on the default branch already (CM10), as after a setup that
 * put its files back although its push may have landed; a checkout it could not fast-forward is
 * refused here, before anything changes on GitHub.
 * @param {CommandContext} ctx
 * @param {string} branch The default branch.
 */
async function holdsBootstrap(ctx, branch) {
  const origin = await ctx.git.tryRevParse(`refs/remotes/origin/${branch}`)
  const head = await ctx.git.tryRevParse('HEAD')
  if (origin === null || (head !== null && (await ctx.git.isAncestor(origin, head)))) return
  throw new PreconditionError(
    `the main checkout does not hold origin/${branch}, which holds the bootstrap commit of setup, and the runner could not fast-forward it because the checkout has local changes or is not on ${branch}`,
    {
      resolve: `commit or stash the local changes, ${runIn(`git switch ${branch} && git merge --ff-only origin/${branch}`, ctx.repoRoot)}, then ${runIn('hackwin setup --resume', ctx.repoRoot)}`,
    },
  )
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

  // Steps 11 to 13: both writes first, then both read backs, once GitHub's reads have settled.
  const rules = await applyBranchRules(ctx.github)
  const enabling = await enablePushProtection(ctx.github)
  ctx.out.line('branch rules and push protection: reading them back once GitHub has settled')
  const since = ctx.clock.now().getTime()
  /** @type {import('./settle.js').Stop} */
  const stop = {}
  const [protection, pushProtection] = await Promise.all([
    settledRead(ctx.clock, () => readProtection(ctx.github, { branch }), {
      since,
      what: 'the branch rules',
      stop,
    }),
    settledRead(ctx.clock, () => readPushProtection(ctx.github), {
      since,
      what: 'the push protection setting',
      stop,
    }),
  ])
  ctx.out.line(`branch rules: the state read back from GitHub is ${protection.value.state}`)
  ctx.out.line(`push protection: the setting read back from GitHub is ${pushProtection.value}`)

  // A personal account's repository has its owner as its only admin; an organization's has more.
  const owner = (await ctx.github.api('repos/{owner}/{repo}'))?.owner
  const personal = owner?.type === 'User'

  // Step 14.
  ctx.out.line(`join for the Lead's machine, in ${root}:`)
  const identity = resolveIdentity(config, await ctx.github.login())
  const joined = await joinLead(ctx, questions, { config, identity })

  // Step 15. The reminder about .env.local only when there is one to send, by join's step 7.
  const envLocal = (await envExampleKeys(root)).length > 0
  const lines = [
    joined.exitCode === 1
      ? `setup of ${name} is complete except for join on this machine`
      : `setup of ${name} is complete`,
    ...protectionLines(rules, protection, { branch, lead, repository: name, personal, root }),
    ...pushProtectionLines(pushProtection, name, root),
    ...memberLines({ config, identity, invitations, joined, repository, root }),
    'next steps for you, the Lead:',
    `  1. start the Gate in a terminal of its own and leave it open: ${runIn('hackwin gate', root)}`,
    `  2. write the first tasks as issues from the template "HackWin task" (.github/ISSUE_TEMPLATE/hackwin-task.md), or ask your planning session, the Claude Code session in ${root}, to write them from that template`,
    `  3. take a task: ${runIn('hackwin take', root)}; with no number, take picks the next task of your queue`,
    `  4. read ${GUIDE}: how the team works with HackWin`,
    ...(envLocal
      ? ['  5. send .env.local to each member over a private channel; it is never committed']
      : []),
  ]
  return {
    exitCode: joined.exitCode === 1 ? 1 : 0,
    lines,
    data: {
      labels,
      invitations,
      protection: {
        state: protection.value.state,
        rules: protection.value.rules,
        settled: protection.settled,
        reads: protection.reads,
        failures: protection.failures,
        offered: rules.offered,
        branchRules: rules.branchRules,
        updateRestriction: rules.updateRestriction,
        refused: rules.refused,
        restrictionRefused: rules.restrictionRefused,
        pinRefused: rules.pinRefused,
      },
      pushProtection: {
        on: pushProtection.value === 'enabled',
        status: pushProtection.value,
        settled: pushProtection.settled,
        reads: pushProtection.reads,
        failures: pushProtection.failures,
        refused: enabling.refused,
      },
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
  const keys = /** @type {const} */ (['language', 'explanation_style'])
  if (questions.interactive && keys.some((key) => typeof questions.given(key) !== 'string')) {
    questions.say(JOIN_INTRO)
  }
  for (const key of keys) {
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
 * The summary lines of the members: the Lead's own state, and for every other member what must
 * happen first and a message for the Lead to paste into a chat, which says how to start.
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
      continue
    }
    const invited = named(invitations.invited) || named(invitations.waiting)
    if (invited) {
      lines.push(`${who}: GitHub sent them an invitation; send them this message:`)
    } else if (
      named(invitations.declined) ||
      invitations.refused.some((entry) => entry.login.toLowerCase() === login)
    ) {
      lines.push(
        `${who}: needs write access to ${repository.nameWithOwner} first: ${byHand}; then send them this message:`,
      )
    } else {
      lines.push(`${who}: send them this message:`)
    }
    const message = startMessage({
      name: member.name,
      repository,
      version: config.hackwin.cli_version,
      invited,
    })
    lines.push(...message.map((line) => `    ${line}`))
  }
  return lines
}

/**
 * The message that tells a member how to start, ready to paste into a chat: accept the
 * invitation, where GitHub sent one; install the pinned version (CM12); clone the repository;
 * join in the clone. Each command stands alone on its line, so that it can be copied.
 * @param {object} options
 * @param {string} options.name
 * @param {RepositoryName} options.repository
 * @param {string} options.version `cli_version` of hackwin.yml.
 * @param {boolean} options.invited
 * @returns {string[]}
 */
function startMessage({ name, repository, version, invited }) {
  const folder = /** @type {string} */ (repository.nameWithOwner.split('/').pop())
  /** @type {Array<[string, string?]>} */
  const steps = []
  if (invited) {
    steps.push([
      `Accept the invitation to ${repository.nameWithOwner} that GitHub sent you: ${repository.url}/invitations`,
    ])
  }
  steps.push(
    [
      `Install HackWin ${version}, the version of the team:`,
      installCommand(version, REPOSITORY_URL),
    ],
    [
      'Clone the repository, in the folder where you keep your projects:',
      `git clone ${quoteShellArg(repository.url)}`,
    ],
    ['Go into the clone and join the team:', `cd ${quoteShellArg(folder)} && hackwin join`],
  )
  return [
    `${name}, you are in our HackWin team for ${repository.nameWithOwner}. To start:`,
    ...steps.flatMap(([text, command], index) =>
      command === undefined
        ? [`${index + 1}. ${text}`]
        : [`${index + 1}. ${text}`, `   ${command}`],
    ),
  ]
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

// `hackwin take [N]` (7.7): the preconditions, then the five checks on task N, or on the caller's
// queue until a task passes them all; then the steps that hand the task to the member's agent:
// the cleanup of merged worktrees, the warnings, the claim, the worktree, the prompt and the
// start of the agent.

import { runInstall } from '../../core/project/index.js'
import {
  BlockedError,
  NotBuiltError,
  PreconditionError,
  UsageError,
  runIn,
} from '../../core/runtime/index.js'
import { isJoinComplete, readLocal } from '../../core/state/index.js'
import { toTask } from '../../core/tasks/index.js'
import {
  checkHooksPath,
  mainCheckout,
  removeMergedWorktrees,
  repairHooksPath,
  taskWorktrees,
} from '../../core/worktrees/index.js'
import { AGENT_NAMES, launchClaude, printReason, startCommand } from './agent.js'
import { createBoard } from './board.js'
import { CHECK_RULES, checkTask, chooseFromQueue } from './checks.js'
import { claimTask, undoClaim } from './claim.js'
import { writeTaskPrompt } from './prompt.js'
import { linkLocalFiles, openCheckout, planCheckout } from './worktree.js'

/** @import { CommandContext, CommandResult } from '../../cli/context.js' */
/** @import { Config, Identity } from '../../core/config/index.js' */
/** @import { PullRequest } from '../../core/github/index.js' */
/** @import { ProjectRun } from '../../core/project/index.js' */
/** @import { LocalRecord } from '../../core/state/index.js' */
/** @import { Task, TaskBlock } from '../../core/tasks/index.js' */
/** @import { CheckFailure, CheckScope, Skipped } from './checks.js' */
/** @import { Claim } from './claim.js' */
/** @import { WrittenPrompt } from './prompt.js' */
/** @import { LinkedFiles, TaskCheckout } from './worktree.js' */

const USAGE = 'hackwin take [N] [--release]'

/** The labels on a pull request that wait for its author (7.7 step 3, 8.2). */
const WAITING_LABELS = Object.freeze(['needs-owner', 'gate:failed', 'scope-violation'])

/**
 * @typedef {object} Selection
 * @property {Task & { block: TaskBlock }} task
 * @property {Skipped[]} skipped
 */

/**
 * What the run has done so far, for the result and for --json.
 * @typedef {object} Progress
 * @property {Selection['task']} task
 * @property {Skipped[]} skipped
 * @property {boolean} hooksRepaired
 * @property {string[]} removedWorktrees
 * @property {PullRequest[]} waitingPulls
 * @property {Claim} [claim]
 * @property {TaskCheckout} [checkout]
 * @property {{ ref: string, sha: string }} [main]
 * @property {LinkedFiles} [links]
 * @property {ProjectRun | { skipped: true, notice: string }} [install]
 * @property {WrittenPrompt} [prompt]
 */

/**
 * @param {CommandContext} ctx
 * @returns {Promise<CommandResult>}
 */
export async function run(ctx) {
  if (ctx.flags.release) {
    throw new NotBuiltError(
      'take',
      'src/commands/take/index.js',
      '`take --release` is not built yet',
    )
  }
  const number = issueNumber(ctx.args[0])
  const { config, identity } = prepared(ctx)
  const main = await mainCheckout(ctx.git)
  const local = await requireJoin(ctx, identity.login, main)

  // Step 1. The runner fetched origin before this command started (CM9).
  const hooksRepaired = await activateHooks(ctx)

  /** @type {CheckScope} */
  const scope = {
    config,
    identity,
    main,
    board: createBoard(ctx.github, config),
    worktrees: await taskWorktrees(ctx.git),
  }
  const selection =
    number === null ? await takeFromQueue(scope) : await takeNumber(ctx, scope, number)
  if ('result' in selection) return selection.result
  return takeTask(ctx, scope, local, { ...selection, hooksRepaired })
}

/**
 * `take N`: issue N must be an open task (a precondition, exit 2) that passes every check
 * (exit 1 with the first failure otherwise).
 * @param {CommandContext} ctx
 * @param {CheckScope} scope
 * @param {number} number
 * @returns {Promise<Selection>}
 */
async function takeNumber(ctx, scope, number) {
  const resolve = { command: 'hackwin take', dir: scope.main }
  const issue = await ctx.github.getIssue(number)
  if (issue === null) throw new PreconditionError(`#${number} does not exist`, { resolve })
  if (issue.isPullRequest) {
    throw new PreconditionError(`#${number} is a pull request, not a task issue`, { resolve })
  }
  const task = toTask(issue, scope.config)
  if (task === null) {
    throw new PreconditionError(
      `#${number} is not a task issue: its body has no \`# hackwin:task\` block (8.1)`,
      { resolve },
    )
  }
  if (task.state === 'closed') throw new PreconditionError(`#${number} is closed`, { resolve })

  const failure = await checkTask(task, scope)
  if (failure) throw blocked(`#${number} cannot be taken: ${failure.reason}`, failure)
  return { task: withBlock(task), skipped: [] }
}

/**
 * `take` without a number: the first task of the caller's queue that passes every check, with
 * the tasks skipped before it. An empty queue exits 0; a queue in which no task passes exits 1.
 * @param {CheckScope} scope
 * @returns {Promise<Selection | { result: CommandResult }>}
 */
async function takeFromQueue(scope) {
  const { queue, task, skipped, blocked: limit } = await chooseFromQueue(scope)
  if (queue.length === 0) {
    const next = scope.identity.isLead
      ? 'the next wave of tasks is due'
      : 'ask the Lead for the next wave'
    return {
      result: {
        lines: [
          `queue empty: no open task of your roles (${scope.identity.roles.join(', ')}) waits to be taken; ${next}`,
        ],
        data: { task: null, skipped: [], queueEmpty: true },
      },
    }
  }
  if (limit) throw blocked(`no task can be taken: ${limit.reason}`, limit)
  if (task === null) {
    throw new BlockedError(
      `no task of your queue can be taken yet: all ${skipped.length} failed a check; take again once a blocker is gone`,
      {
        rule: 'take checks 1 to 5 (7.7)',
        objects: skipped.map(skippedLine),
        resolve: { command: 'hackwin take', dir: scope.main },
        details: { skipped: skipped.map(skippedData) },
      },
    )
  }
  return { task: withBlock(task), skipped }
}

/**
 * Steps 2 to 7 for a task that passed every check. Each step runs only after the earlier ones
 * succeeded. A worktree that cannot be created undoes the claim (exit 2); a failed install
 * keeps the worktree and the claim (exit 1).
 * @param {CommandContext} ctx
 * @param {CheckScope} scope
 * @param {LocalRecord | null} local
 * @param {Selection & { hooksRepaired: boolean }} selection
 * @returns {Promise<CommandResult>}
 */
async function takeTask(ctx, scope, local, { task, skipped, hooksRepaired }) {
  const { config, identity, main } = scope
  for (const entry of skipped) ctx.out.line(`skipped ${skippedLine(entry)}`)
  ctx.out.line(`selected #${task.number} ${task.title} (role ${task.block.role})`)

  // Step 2.
  const cleanup = await removeMergedWorktrees(ctx.git, ctx.github)
  for (const path of cleanup.removed) ctx.out.line(`removed the worktree of a merged task: ${path}`)

  // Step 3.
  const waitingPulls = await pullsWaitingFor(scope, identity.login)
  for (const pull of waitingPulls) ctx.out.warn(waitingText(pull))

  /** @type {Progress} */
  const progress = {
    task,
    skipped,
    hooksRepaired,
    removedWorktrees: cleanup.removed,
    waitingPulls,
  }

  // Step 4.
  const claim = await claimTask(ctx.github, task, identity.login)
  progress.claim = claim
  const role = claim.roleAdded ? `, labeled ${claim.roleAdded}` : ''
  ctx.out.line(`claimed #${task.number}: in-progress, assigned to ${identity.login}${role}`)

  // Step 5.
  const mainRef = `origin/${config.hackwin.project.default_branch}`
  const mainSha = await ctx.git.revParse(`refs/remotes/${mainRef}`)
  progress.main = { ref: mainRef, sha: mainSha }
  const checkout = await createCheckout(ctx, scope, claim, { task, mainSha })
  progress.checkout = checkout
  ctx.out.line(checkoutLine(checkout, mainRef, mainSha))

  progress.links = await linkLocalFiles(main, checkout.path)
  const links = linksLine(progress.links)
  if (links) ctx.out.line(links)

  const install = await runInstall({ cwd: checkout.path, config })
  progress.install = install
  if ('skipped' in install) {
    ctx.out.line(install.notice)
  } else if (install.ok) {
    ctx.out.line(`install passed in ${checkout.path}: ${install.command}`)
  } else {
    return installFailed(main, progress, install)
  }

  // Step 6.
  const issue = await scope.board.issue(task.number)
  if (issue === null) throw new Error(`#${task.number} disappeared while it was taken`)
  progress.prompt = await writeTaskPrompt(ctx, {
    config,
    identity,
    issue,
    block: task.block,
    local,
    main,
    worktree: checkout.path,
    branch: checkout.branch,
    mainSha,
  })

  // Step 7.
  return startAgent(ctx, identity, progress)
}

/**
 * Step 5: the worktree of the task, created or reused. When it cannot be created, the claim of
 * step 4 is undone and the run exits 2.
 * @param {CommandContext} ctx
 * @param {CheckScope} scope
 * @param {Claim} claim
 * @param {{ task: Task, mainSha: string }} options
 * @returns {Promise<TaskCheckout>}
 */
async function createCheckout(ctx, scope, claim, { task, mainSha }) {
  /** @type {TaskCheckout | null} */
  let checkout = null
  try {
    checkout = await planCheckout(ctx.git, { main: scope.main, task })
    await openCheckout(ctx.git, checkout, mainSha)
    return checkout
  } catch (error) {
    let undone = 'the in-progress label and the assignment were undone'
    try {
      await undoClaim(ctx.github, claim)
    } catch (undoError) {
      undone = `the claim could not be undone (${undoError.message}): remove in-progress and your assignment on #${task.number} by hand`
    }
    const where = checkout ? ` at ${checkout.path}` : ''
    throw new PreconditionError(
      `the worktree of #${task.number} cannot be created${where}: ${error.message}; ${undone}`,
      {
        resolve: { command: `hackwin take ${task.number}`, dir: scope.main },
        details: { path: checkout?.path ?? null, branch: checkout?.branch ?? null },
        cause: error,
      },
    )
  }
}

/**
 * Step 7: start the agent, or print the prompt file and the command that starts it. An agent
 * that cannot be started leaves the worktree and the claim and prints the command (exit 1).
 * @param {CommandContext} ctx
 * @param {Identity} identity
 * @param {Progress} progress
 * @returns {Promise<CommandResult>}
 */
async function startAgent(ctx, identity, progress) {
  const { task } = progress
  const checkout = /** @type {TaskCheckout} */ (progress.checkout)
  const prompt = /** @type {WrittenPrompt} */ (progress.prompt)
  const { agent } = identity.member
  const name = AGENT_NAMES[agent]
  const start = startCommand(agent, { worktree: checkout.path, promptFile: prompt.file })
  const startLine = `start ${name} for #${task.number} in a new terminal: ${runIn(start.command, start.dir)}`
  const reason = printReason({ agent, caller: ctx.caller, json: ctx.json })

  if (reason !== null) {
    return {
      lines: [`prompt: ${prompt.file}`, startLine],
      data: resultData(progress, { agent, mode: 'printed', reason, ...start }),
    }
  }

  ctx.out.line(`prompt: ${prompt.file}`)
  ctx.out.line(`starting ${name} in ${checkout.path}`)
  const launch = await launchClaude({ worktree: checkout.path, prompt: prompt.text, env: ctx.env })
  if (!launch.started) {
    return {
      exitCode: 1,
      lines: [
        `${name} could not be started: ${launch.reason}; the worktree and the claim stay`,
        startLine,
      ],
      data: resultData(progress, { agent, mode: 'failed', reason: launch.reason, ...start }),
    }
  }
  const ended = launch.signal ? `by the signal ${launch.signal}` : `with exit code ${launch.code}`
  return {
    lines: [`the ${name} session of #${task.number} ended ${ended}`],
    data: resultData(progress, {
      agent,
      mode: 'started',
      exitCode: launch.code,
      signal: launch.signal,
      ...start,
    }),
  }
}

/**
 * A failed `commands.install` (7.7, failure behavior): exit 1 with the end of its log. The
 * worktree and the claim stay.
 * @param {string} main
 * @param {Progress} progress
 * @param {ProjectRun} install
 * @returns {CommandResult}
 */
function installFailed(main, progress, install) {
  const checkout = /** @type {TaskCheckout} */ (progress.checkout)
  const how = install.timedOut ? 'timed out' : `exited with code ${install.code}`
  return {
    exitCode: 1,
    lines: [
      `install failed in ${checkout.path}: \`${install.command}\` ${how}`,
      ...install.tail.map((line) => `  ${line}`),
      `the worktree and the claim stay; fix the install, then ${runIn(`hackwin take ${progress.task.number}`, main)} to finish the remaining steps`,
    ],
    data: resultData(progress, null),
  }
}

/**
 * Step 1: the git hooks are active; core.hooksPath is repaired when they are not (E20).
 * @param {CommandContext} ctx
 * @returns {Promise<boolean>} True when it had to be repaired.
 */
async function activateHooks(ctx) {
  const hooks = await checkHooksPath(ctx.git)
  if (hooks.ok) return false
  await repairHooksPath(ctx.git)
  const was = hooks.value === null ? 'was not set' : `was ${hooks.value}`
  ctx.out.warn(`core.hooksPath ${was}, so the git hooks were off; set it to .githooks (E20)`)
  return true
}

/**
 * Step 3: the caller's open pull requests that wait for them.
 * @param {CheckScope} scope
 * @param {string} login
 * @returns {Promise<PullRequest[]>}
 */
async function pullsWaitingFor(scope, login) {
  const wanted = login.toLowerCase()
  return (await scope.board.openPulls()).filter(
    (pull) =>
      pull.author?.toLowerCase() === wanted &&
      pull.labels.some((label) => WAITING_LABELS.includes(label)),
  )
}

/**
 * @param {PullRequest} pull
 * @returns {string}
 */
function waitingText(pull) {
  const labels = pull.labels.filter((label) => WAITING_LABELS.includes(label)).join(', ')
  const where = pull.url ? `; read the Gate's comment on ${pull.url}` : ''
  return `PR #${pull.number} ${pull.title} waits for you: ${labels}${where}`
}

/**
 * @param {TaskCheckout} checkout
 * @param {string} mainRef
 * @param {string} mainSha
 * @returns {string}
 */
function checkoutLine(checkout, mainRef, mainSha) {
  if (checkout.how === 'create') {
    return `worktree: ${checkout.path} on ${checkout.branch}, new from ${mainRef} ${mainSha.slice(0, 12)}`
  }
  const what = checkout.how === 'reuse-worktree' ? 'reused' : 'added for the existing branch'
  return `worktree: ${checkout.path} on ${checkout.branch}, ${what}`
}

/**
 * @param {LinkedFiles} links
 * @returns {string | null}
 */
function linksLine({ linked, missing }) {
  const parts = []
  if (linked.length > 0) parts.push(`linked ${linked.join(' and ')} from the main checkout`)
  if (missing.length > 0)
    parts.push(`not in the main checkout, so not linked: ${missing.join(', ')}`)
  return parts.length > 0 ? parts.join('; ') : null
}

/**
 * The full result for --json.
 * @param {Progress} progress
 * @param {Record<string, unknown> | null} start
 * @returns {Record<string, unknown>}
 */
function resultData(progress, start) {
  const { task, claim, checkout, prompt, install } = progress
  return {
    task: taskData(task),
    skipped: progress.skipped.map(skippedData),
    queueEmpty: false,
    hooksRepaired: progress.hooksRepaired,
    removedWorktrees: progress.removedWorktrees,
    waitingPulls: progress.waitingPulls.map((pull) => ({
      number: pull.number,
      title: pull.title,
      labels: pull.labels.filter((label) => WAITING_LABELS.includes(label)),
      url: pull.url,
    })),
    claim: claim && {
      labels: claim.labels,
      assignees: claim.assignees,
      roleAdded: claim.roleAdded,
    },
    main: progress.main,
    worktree: checkout && { path: checkout.path, branch: checkout.branch, how: checkout.how },
    links: progress.links,
    install: install && ('skipped' in install ? install : installData(install)),
    prompt: prompt && {
      file: prompt.file,
      changes: {
        from: prompt.changes.from,
        to: prompt.changes.to,
        recorded: prompt.recorded,
        files: prompt.changes.files,
      },
    },
    start,
  }
}

/**
 * @param {ProjectRun} install
 */
function installData({ ok, command, code, timedOut, tail, durationMs }) {
  return { ok, command, code, timedOut, tail, durationMs }
}

/**
 * @param {Selection['task']} task
 */
function taskData(task) {
  const { block } = task
  return {
    number: task.number,
    title: task.title,
    role: block.role,
    wave: block.wave,
    paths: block.paths,
    depends_on: block.depends_on,
    acceptance_tests: block.acceptance_tests,
    deadline: block.deadline,
  }
}

/**
 * A task that passed check 2, so its block is valid.
 * @param {Task} task
 * @returns {Selection['task']}
 */
function withBlock(task) {
  return /** @type {Selection['task']} */ (task)
}

/**
 * @param {string} message
 * @param {CheckFailure} failure
 * @returns {BlockedError}
 */
function blocked(message, failure) {
  return new BlockedError(message, {
    rule: CHECK_RULES[failure.check],
    objects: failure.objects,
    resolve: failure.resolve,
    details: { check: failure.check },
  })
}

/** @param {Skipped} entry */
function skippedLine({ task, failure }) {
  return `#${task.number} ${task.title}: ${failure.reason}`
}

/** @param {Skipped} entry */
function skippedData({ task, failure }) {
  return {
    number: task.number,
    title: task.title,
    check: failure.check,
    reason: failure.reason,
    objects: failure.objects,
  }
}

/**
 * The issue number of `take N`, or null without one.
 * @param {string | undefined} arg
 * @returns {number | null}
 */
function issueNumber(arg) {
  if (arg === undefined) return null
  if (!/^[1-9]\d*$/.test(arg)) {
    throw new UsageError(`not an issue number: ${arg}; usage: ${USAGE}`)
  }
  return Number(arg)
}

/**
 * The configuration and identity the runner prepared for every user command (contracts 3.6).
 * @param {CommandContext} ctx
 * @returns {{ config: Config, identity: Identity }}
 */
function prepared(ctx) {
  if (!ctx.config || !ctx.identity) {
    throw new Error('take needs the configuration and identity that the runner prepares')
  }
  return { config: ctx.config, identity: ctx.identity }
}

/**
 * The precondition `join` is complete: the join record of this clone is the caller's. Returns
 * the record, which holds the personal settings of the prompt (A14).
 * @param {CommandContext} ctx
 * @param {string} login
 * @param {string} main
 * @returns {Promise<LocalRecord>}
 */
async function requireJoin(ctx, login, main) {
  const record = await readLocal(ctx.gitCommonDir)
  if (record && isJoinComplete(record, login)) return record
  const message =
    record?.join && record.login
      ? `\`hackwin join\` completed in this clone for ${record.login}, not for ${login}`
      : '`hackwin join` has not completed in this clone'
  throw new PreconditionError(message, { resolve: { command: 'hackwin join', dir: main } })
}

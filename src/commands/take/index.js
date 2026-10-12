// `hackwin take [N]` (7.7): the preconditions, then the five checks on task N, or on the caller's
// queue until a task passes them all. The run ends with the selected task.

import {
  BlockedError,
  NotBuiltError,
  PreconditionError,
  UsageError,
} from '../../core/runtime/index.js'
import { isJoinComplete, readLocal } from '../../core/state/index.js'
import { toTask } from '../../core/tasks/index.js'
import { mainCheckout, taskWorktrees } from '../../core/worktrees/index.js'
import { createBoard } from './board.js'
import { CHECK_RULES, checkTask, chooseFromQueue } from './checks.js'

/** @import { CommandContext, CommandResult } from '../../cli/context.js' */
/** @import { Config, Identity } from '../../core/config/index.js' */
/** @import { Task } from '../../core/tasks/index.js' */
/** @import { CheckFailure, CheckScope, Skipped } from './checks.js' */

const USAGE = 'hackwin take [N] [--release]'

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
  await requireJoin(ctx, identity.login, main)

  /** @type {CheckScope} */
  const scope = {
    config,
    identity,
    main,
    board: createBoard(ctx.github, config),
    worktrees: await taskWorktrees(ctx.git),
  }
  return number === null ? takeFromQueue(scope) : takeNumber(ctx, scope, number)
}

/**
 * `take N`: issue N must be an open task (a precondition, exit 2) that passes every check
 * (exit 1 with the first failure otherwise).
 * @param {CommandContext} ctx
 * @param {CheckScope} scope
 * @param {number} number
 * @returns {Promise<CommandResult>}
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
  return selected(task, [])
}

/**
 * `take` without a number: the first task of the caller's queue that passes every check, with
 * the tasks skipped before it. An empty queue exits 0; a queue in which no task passes exits 1.
 * @param {CheckScope} scope
 * @returns {Promise<CommandResult>}
 */
async function takeFromQueue(scope) {
  const { queue, task, skipped, blocked: limit } = await chooseFromQueue(scope)
  if (queue.length === 0) {
    const next = scope.identity.isLead
      ? 'the next wave of tasks is due'
      : 'ask the Lead for the next wave'
    return {
      lines: [
        `queue empty: no open task of your roles (${scope.identity.roles.join(', ')}) waits to be taken; ${next}`,
      ],
      data: { task: null, skipped: [], queueEmpty: true },
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
  return selected(task, skipped)
}

/**
 * The result for a task that passed every check.
 * @param {Task} task
 * @param {Skipped[]} skipped
 * @returns {CommandResult}
 */
function selected(task, skipped) {
  const block = /** @type {NonNullable<Task['block']>} */ (task.block)
  return {
    lines: [
      ...skipped.map((entry) => `skipped ${skippedLine(entry)}`),
      `selected #${task.number} ${task.title} (role ${block.role})`,
    ],
    data: {
      task: {
        number: task.number,
        title: task.title,
        role: block.role,
        wave: block.wave,
        paths: block.paths,
        depends_on: block.depends_on,
        acceptance_tests: block.acceptance_tests,
        deadline: block.deadline,
      },
      skipped: skipped.map(skippedData),
      queueEmpty: false,
    },
  }
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
 * The precondition `join` is complete: the join record of this clone is the caller's.
 * @param {CommandContext} ctx
 * @param {string} login
 * @param {string} main
 * @returns {Promise<void>}
 */
async function requireJoin(ctx, login, main) {
  const record = await readLocal(ctx.gitCommonDir)
  if (isJoinComplete(record, login)) return
  const message =
    record?.join && record.login
      ? `\`hackwin join\` completed in this clone for ${record.login}, not for ${login}`
      : '`hackwin join` has not completed in this clone'
  throw new PreconditionError(message, { resolve: { command: 'hackwin join', dir: main } })
}

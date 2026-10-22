// `hackwin ship` (7.9): run inside a task worktree once the work is committed. It merges the
// remote branch and the default branch into the branch, never rebasing, runs every local check
// in a fixed order and writes the green check record of the head commit. Then it pushes the
// branch, opens or updates the pull request of the task, reports on the issue, sets the issue
// in-review and ends with the stop line. A step runs only when every earlier step succeeded, so
// nothing goes on after a failed check (F3).
//
// A rerun continues where an earlier `ship` stopped (CM3): the checks do not run again for a
// commit that has its green check record, and the later steps find the pull request and the
// report that the earlier run left.

import { BlockedError, PreconditionError } from '../../core/runtime/errors.js'
import { runIn } from '../../core/runtime/output.js'
import { parseBranch } from '../../core/tasks/index.js'
import { currentTask, mainCheckout, taskWorktrees } from '../../core/worktrees/index.js'
import { recordedChecks, runChecks } from './checks.js'
import { publish } from './publish.js'
import { listOf, plural } from './steps.js'
import { syncBranch } from './sync.js'

/** @import { CommandContext, CommandResult } from '../../cli/context.js' */
/** @import { Resolve } from '../../core/runtime/errors.js' */
/** @import { TaskWorktree } from '../../core/worktrees/index.js' */

/**
 * @param {CommandContext} ctx
 * @returns {Promise<CommandResult>}
 */
export async function run(ctx) {
  const worktree = await requireTaskWorktree(ctx)
  await requireCleanTree(ctx, worktree)
  const synced = await syncBranch(ctx, worktree)
  const checked =
    (await recordedChecks(ctx, worktree, synced)) ?? (await runChecks(ctx, worktree, synced))
  const published = await publish(ctx, worktree, synced, checked)
  const { pull } = published.pull
  return {
    lines: [`pull request: ${pull.url}`, published.stopLine],
    data: {
      issue: synced.task.number,
      branch: worktree.branch,
      worktree: worktree.path,
      head: synced.head,
      main: { ref: synced.mainRef, sha: synced.mainSha },
      merged: { remote: synced.remote, main: synced.main },
      hooksRepaired: synced.hooksRepaired,
      checks: checked.checks,
      checksReused: checked.reused,
      outsideTask: checked.outsideTask,
      record: checked.record,
      pushed: published.pushed,
      pullRequest: {
        number: pull.number,
        url: pull.url,
        action: published.pull.action,
        changes: published.pull.changes,
      },
      report: {
        id: published.report.comment.id,
        url: published.report.comment.url,
        created: published.report.created,
      },
      labels: published.labels,
    },
  }
}

/**
 * The precondition of the place (7.9): a task worktree on a `task/` branch. A `spike/` branch
 * exits 1 (E16); anywhere else exits 2 and names the caller's task worktrees.
 * @param {CommandContext} ctx
 * @returns {Promise<TaskWorktree>}
 */
async function requireTaskWorktree(ctx) {
  const branch = await ctx.git.currentBranch()
  const main = await mainCheckout(ctx.git)
  if (branch !== null && parseBranch(branch).kind === 'spike') {
    throw new BlockedError(`${branch} is a spike branch: spike branches are never merged`, {
      rule: 'E16: spike branches are never merged',
      objects: [branch],
      resolve: { command: 'hackwin take', dir: main },
    })
  }
  const task = await currentTask(ctx.git)
  if (task !== null && task.path !== main) return task

  const worktrees = (await taskWorktrees(ctx.git)).filter((worktree) => worktree.path !== main)
  const here =
    task !== null
      ? `${ctx.repoRoot} is the main checkout`
      : `${ctx.repoRoot} is on ${branch ?? 'a detached HEAD'}`
  const list =
    worktrees.length === 0
      ? 'you have no task worktree'
      : `your task worktrees: ${worktrees.map((worktree) => `#${worktree.issue} ${worktree.path}`).join(', ')}`
  /** @type {Resolve} */
  let resolve
  if (worktrees.length === 1) resolve = { command: 'hackwin ship', dir: worktrees[0].path }
  else if (worktrees.length === 0) resolve = { command: 'hackwin take', dir: main }
  else resolve = 'start it again in the worktree of the task to ship, one of those listed above'
  throw new PreconditionError(`ship runs in a task worktree, and ${here}; ${list}`, {
    resolve,
    details: { worktrees },
  })
}

/**
 * The precondition of a clean working tree (7.9): every change is committed, so the checks and
 * the record are for the head commit. A merge left in progress by an earlier `ship` is named.
 * Through the Claude Code wrapper, which may only run `ship`, the human is told what to ask the
 * session for and to type `/ship` again; anywhere else, how to start `ship` again.
 * @param {CommandContext} ctx
 * @param {TaskWorktree} worktree
 * @returns {Promise<void>}
 */
async function requireCleanTree(ctx, worktree) {
  const status = await ctx.git.run(['status', '--porcelain', '-z'])
  const paths = changedPaths(status.stdout)
  if (paths.length === 0) return
  const merging = (await ctx.git.tryRevParse('MERGE_HEAD')) !== null
  const dir = worktree.path
  const what = merging
    ? `a merge is in progress in ${dir}`
    : `the working tree of ${dir} has changes`
  const again = runIn('hackwin ship', dir)
  /** @type {string} */
  let resolve
  if (ctx.caller === 'claude-code') {
    resolve = merging
      ? 'ask this session to resolve the conflicts and commit the merge, then type `/ship` again'
      : 'ask this session to commit the listed files, then type `/ship` again'
  } else {
    resolve = merging
      ? `resolve the conflicts and commit the merge in ${dir}, then ${again}`
      : `commit these changes or remove them in ${dir}, then ${again}`
  }
  throw new PreconditionError(
    `${what}: ${plural(paths.length, 'path')}, ${listOf(paths)}; ship checks only committed work`,
    { resolve, details: { paths, merging } },
  )
}

/**
 * The paths of `git status --porcelain -z`; a rename or copy also names its source.
 * @param {string} output
 * @returns {string[]}
 */
function changedPaths(output) {
  const fields = output.split('\0')
  /** @type {string[]} */
  const paths = []
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i]
    if (field === '') continue
    paths.push(field.slice(3))
    if (/[RC]/.test(field.slice(0, 2))) i += 1
  }
  return paths
}

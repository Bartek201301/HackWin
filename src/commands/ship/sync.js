// Steps 1 and 2 of `ship` (7.9): fetch, read the task issue, repair core.hooksPath (E20), merge
// the commits of the remote branch that the local branch lacks, then merge the default branch.
// Never a rebase. A conflict leaves the merge in progress, so that the session resolves it in
// its own files (A46), commits and runs `ship` again.

import { PreconditionError } from '../../core/runtime/errors.js'
// src/core/tasks/index.js does not export shown; until it does, it comes from block.js itself, so
// that ship names an author as checkTaskLink does.
import { shown } from '../../core/tasks/block.js'
import { toTask, writtenByTeam } from '../../core/tasks/index.js'
import { checkHooksPath, mainCheckout, repairHooksPath } from '../../core/worktrees/index.js'
import { STEPS, fail, plural, progress } from './steps.js'

/** @import { CommandContext } from '../../cli/context.js' */
/** @import { Config } from '../../core/config/index.js' */
/** @import { Issue } from '../../core/github/index.js' */
/** @import { MergeResult } from '../../core/git/index.js' */
/** @import { Task, TaskBlock } from '../../core/tasks/index.js' */
/** @import { TaskWorktree } from '../../core/worktrees/index.js' */
/** @import { Step } from './steps.js' */

/** The statuses of a task that `ship` accepts (7.9, preconditions). */
const SHIPPABLE = Object.freeze(['in-progress', 'in-review'])

/**
 * @typedef {object} Synced
 * @property {Task & { block: TaskBlock }} task The task of the worktree, with a valid block.
 * @property {string} mainRef `origin/<default branch>`.
 * @property {string} mainSha The commit of `mainRef` that was merged and that the checks diff against.
 * @property {string} head HEAD after both merges: the commit the checks run on.
 * @property {boolean} hooksRepaired True when core.hooksPath had to be set again (E20).
 * @property {MergeResult['status'] | 'absent'} remote What step 1 did with the remote branch:
 *   `absent` when it is not on origin yet.
 * @property {MergeResult['status']} main What step 2 did with the default branch.
 */

/**
 * Steps 1 and 2. A failed fetch or GitHub call exits 3; a task issue that is not shippable exits
 * 2; a conflict exits 1 with the files.
 * @param {CommandContext} ctx
 * @param {TaskWorktree} worktree The current task worktree.
 * @returns {Promise<Synced>}
 */
export async function syncBranch(ctx, worktree) {
  const config = /** @type {Config} */ (ctx.config)
  const { branch } = worktree

  // Step 1.
  await ctx.git.fetch({ remote: 'origin', prune: true })
  const task = await shippableTask(ctx, worktree)
  const hooks = await checkHooksPath(ctx.git)
  if (!hooks.ok) {
    await repairHooksPath(ctx.git)
    const was = hooks.value === null ? 'was not set' : `was ${hooks.value}`
    ctx.out.warn(`core.hooksPath ${was}, so the git hooks were off; set it to .githooks (E20)`)
  }
  const remoteRef = `origin/${branch}`
  /** @type {Synced['remote']} */
  let remote = 'absent'
  if ((await ctx.git.tryRevParse(`refs/remotes/${remoteRef}`)) !== null) {
    remote = await mergeInto(ctx, STEPS.sync, remoteRef, worktree)
  }
  progress(
    ctx,
    STEPS.sync,
    `issue #${task.number} is ${task.status}; ${remoteText(remote, remoteRef)}`,
  )

  // Step 2.
  const mainRef = `origin/${config.hackwin.project.default_branch}`
  const mainSha = await ctx.git.tryRevParse(`refs/remotes/${mainRef}`)
  if (mainSha === null) {
    throw new PreconditionError(`${mainRef} does not exist after the fetch`, {
      resolve: `check that origin has the default branch ${config.hackwin.project.default_branch} of hackwin.yml`,
    })
  }
  const main = await mergeInto(ctx, STEPS.merge, mainSha, worktree, mainRef)
  progress(ctx, STEPS.merge, mainText(main, mainRef))

  return {
    task,
    mainRef,
    mainSha,
    head: await ctx.git.revParse('HEAD'),
    hooksRepaired: !hooks.ok,
    remote,
    main,
  }
}

/**
 * Read the task issue of the worktree and require that it is shippable: an open issue that a
 * member of the team wrote, with a valid task block, `in-progress` or `in-review` (7.9,
 * preconditions, 8.1). Otherwise exit 2.
 * @param {CommandContext} ctx
 * @param {TaskWorktree} worktree
 * @returns {Promise<Task & { block: TaskBlock }>}
 */
async function shippableTask(ctx, worktree) {
  const config = /** @type {Config} */ (ctx.config)
  const number = worktree.issue
  const issue = await ctx.github.getIssue(number)
  const task = issue === null || issue.isPullRequest ? null : toTask(issue, config)
  if (task === null) {
    const outsider = issue !== null && !issue.isPullRequest && !writtenByTeam(issue, config)
    const what = issueProblem(issue, outsider)
    throw new PreconditionError(`#${number}, the issue of ${worktree.branch}, ${what}`, {
      resolve: `ship from the worktree of a task issue; ask the Lead when #${number} should be one`,
      ...(outsider ? { details: { author: issue.author, member: false } } : {}),
    })
  }
  if (task.block === null) {
    throw new PreconditionError(
      `the task block of issue #${number} is invalid: ${task.errors.join('; ')}`,
      { resolve: `ask the Lead to correct the task block of issue #${number}` },
    )
  }
  if (task.state !== 'open' || task.status === 'cut') {
    const what = task.status === 'cut' ? 'cut' : 'closed'
    throw new PreconditionError(`issue #${number} is ${what}, so its branch is not shipped`, {
      resolve: `ask the Lead whether issue #${number} should be open again`,
    })
  }
  if (!SHIPPABLE.includes(task.status)) {
    const label = task.status === 'open' ? 'has no status label' : `is ${task.status}`
    throw new PreconditionError(
      `issue #${number} ${label}, not in-progress or in-review: ship runs on a task you took`,
      { resolve: { command: `hackwin take ${number}`, dir: await mainCheckout(ctx.git) } },
    )
  }
  return /** @type {Task & { block: TaskBlock }} */ (task)
}

/**
 * Why the issue of the worktree is no task. An issue that no member of the team wrote is none
 * (8.1, contracts 4.5); its author is named as checkTaskLink names it: as it is, or quoted with
 * each control character, line break and bidirectional format character escaped.
 * @param {Issue | null} issue
 * @param {boolean} outsider True when no member of the team wrote the issue.
 * @returns {string}
 */
function issueProblem(issue, outsider) {
  if (issue === null) return 'does not exist'
  if (issue.isPullRequest) return 'is a pull request'
  if (outsider) {
    const who = issue.author ? shown(issue.author) : 'an unknown account'
    return `is not a task: it was written by ${who}, who is not a member of the team in hackwin.yml; only an issue that team.lead or one of team.members wrote is a task`
  }
  return 'has no # hackwin:task block'
}

/**
 * Merge a ref into the branch of the worktree. A conflict stops `ship` at this step with the
 * conflicting files, and the merge stays in progress.
 * @param {CommandContext} ctx
 * @param {Step} step
 * @param {string} ref
 * @param {TaskWorktree} worktree
 * @param {string} [name] The name of the ref in messages; `ref` by default.
 * @returns {Promise<MergeResult['status']>}
 */
async function mergeInto(ctx, step, ref, worktree, name = ref) {
  if (await ctx.git.isAncestor(ref, 'HEAD')) return 'up-to-date'
  const result = await ctx.git.merge(ref, {
    message: `Merge ${name} into ${worktree.branch}`,
  })
  if (result.status === 'conflict') {
    fail(
      ctx,
      step,
      `merging ${name} into ${worktree.branch} stopped at conflicts in ${plural(result.conflicts.length, 'file')}; the merge is left in progress: resolve the conflicts and commit the merge in ${worktree.path}`,
      { objects: result.conflicts, resolve: { command: 'hackwin ship', dir: worktree.path } },
    )
  }
  return result.status
}

/**
 * @param {Synced['remote']} status
 * @param {string} ref
 * @returns {string}
 */
function remoteText(status, ref) {
  if (status === 'absent') return `${ref.replace(/^origin\//, '')} is not on origin yet`
  if (status === 'up-to-date') return `${ref} has no commit that the branch lacks`
  if (status === 'fast-forward') return `fast-forwarded to ${ref}`
  return `merged the commits of ${ref} that the branch lacked`
}

/**
 * @param {MergeResult['status']} status
 * @param {string} ref
 * @returns {string}
 */
function mainText(status, ref) {
  if (status === 'up-to-date') return `the branch already contains ${ref}`
  if (status === 'fast-forward') return `fast-forwarded to ${ref}`
  return `merged ${ref}`
}

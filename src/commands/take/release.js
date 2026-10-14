// `take N --release` (7.7, "Resuming and releasing", A12): the caller's task in progress returns
// to `ready` and their session slot is free, so that check 5 no longer counts it. The branch and
// the worktree stay, and the next `take N` reuses them.

import { BlockedError } from '../../core/runtime/index.js'
import { setTaskStatus } from '../../core/tasks/index.js'
import { taskBranches } from './worktree.js'

/** @import { CommandContext, CommandResult } from '../../cli/context.js' */
/** @import { Identity } from '../../core/config/index.js' */
/** @import { Task } from '../../core/tasks/index.js' */
/** @import { TaskWorktree } from '../../core/worktrees/index.js' */

/** The rule of a refused release (CM5). */
export const RELEASE_RULE =
  'take --release: only your own task in progress returns to ready (7.7, A12)'

/**
 * Release a task. The caller stops being its assignee first and the status label follows, so a
 * release that fails between the two leaves the task in progress without an assignee, which a
 * rerun of the release, or a resume by `take N`, finishes. A task that is already ready and not
 * assigned to the caller exits 0 without a change, so a rerun after a finished release changes
 * nothing.
 * @param {CommandContext} ctx
 * @param {object} options
 * @param {Task} options.task An open task.
 * @param {Identity} options.identity
 * @param {string} options.main The main checkout.
 * @param {TaskWorktree[]} options.worktrees The task worktrees of this clone.
 * @param {boolean} options.hooksRepaired True when step 1 set core.hooksPath again (E20).
 * @returns {Promise<CommandResult>}
 */
export async function releaseTask(ctx, { task, identity, main, worktrees, hooksRepaired }) {
  const n = task.number
  const login = identity.login
  const assigned = task.assignees.some((name) => name.toLowerCase() === login.toLowerCase())
  const object = `#${n} ${task.title}`

  if (task.status === 'ready' && !assigned) {
    return {
      lines: [`#${n} is already ready and not assigned to you: nothing to release`],
      data: {
        task: { number: n, title: task.title },
        released: false,
        labels: task.labels,
        hooksRepaired,
      },
    }
  }
  if (task.status !== 'in-progress') {
    throw new BlockedError(`#${n} cannot be released: it is ${task.status}, not in progress`, {
      rule: RELEASE_RULE,
      objects: [`${object}: ${task.status}`],
      resolve: { command: 'hackwin status', dir: main },
    })
  }
  if (!assigned && task.assignees.length > 0) {
    throw new BlockedError(
      `#${n} cannot be released: it is in progress, assigned to ${task.assignees.join(', ')}, not to you`,
      {
        rule: RELEASE_RULE,
        objects: [`${object}: assigned to ${task.assignees.join(', ')}`],
        resolve: `ask ${task.assignees.join(' or ')} to release #${n}`,
      },
    )
  }
  // In progress without an assignee: a claim left half done, which only a holder of the role
  // may release (check 1).
  if (!assigned && !(task.block && identity.roles.includes(task.block.role))) {
    const role = task.block ? `the role ${task.block.role}` : 'its role'
    throw new BlockedError(`#${n} cannot be released: you do not hold ${role}`, {
      rule: RELEASE_RULE,
      objects: [`${object}: in progress without an assignee`],
      resolve: `ask the holder of ${role} or the Lead to release #${n}`,
    })
  }

  if (assigned) await ctx.github.removeAssignees(n, [login])
  const labels = await setTaskStatus(ctx.github, n, 'ready')
  const worktree = worktrees.find((entry) => entry.issue === n && entry.path !== main) ?? null
  const branches = await taskBranches(ctx.git, n)
  const kept = worktree
    ? `the branch ${worktree.branch} and its worktree ${worktree.path} stay for the next take`
    : branches.length > 0
      ? `the branch ${branches.join(', ')} stays for the next take`
      : 'it has no local branch yet'
  const who = assigned ? `${login} is no longer assigned` : 'it had no assignee'
  return {
    lines: [`released #${n} ${task.title}: ready, ${who}; ${kept}`],
    data: {
      task: { number: n, title: task.title },
      released: true,
      labels,
      unassigned: assigned ? login : null,
      worktree,
      branches,
      hooksRepaired,
    },
  }
}

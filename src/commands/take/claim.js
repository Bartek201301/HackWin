// Step 4 of `take` (7.7): claim the task before the slower steps. `in-progress` replaces the
// other status labels, the caller becomes an assignee, and a task written by hand gets its
// `role:` label. When the worktree cannot be created, the claim is undone exactly (failure
// behavior of 7.7): only what this claim changed goes back.

import { roleLabel, setTaskStatus } from '../../core/tasks/index.js'

/** @import { GitHub } from '../../core/github/index.js' */
/** @import { Task, TaskBlock } from '../../core/tasks/index.js' */

/**
 * What a claim changed on the issue, so that it can be undone.
 * @typedef {object} Claim
 * @property {number} issue
 * @property {string} login
 * @property {string[]} labels The labels of the issue after the claim.
 * @property {string[]} assignees The assignees of the issue after the claim.
 * @property {boolean} statusAdded True when `in-progress` was not there before.
 * @property {string[]} statusRemoved The status labels the claim removed, such as `ready`.
 * @property {string | null} roleAdded The `role:` label the claim added, or null.
 * @property {boolean} assigneeAdded True when the caller was not an assignee before.
 */

/**
 * Claim a task for the caller (7.7 step 4). `task` holds the labels and assignees from before.
 * @param {GitHub} github
 * @param {Task} task A task with a valid block.
 * @param {string} login The caller.
 * @returns {Promise<Claim>}
 */
export async function claimTask(github, task, login) {
  const block = /** @type {TaskBlock} */ (task.block)
  const before = task.labels.map((label) => label.toLowerCase())
  let labels = await setTaskStatus(github, task.number, 'in-progress')
  const after = labels.map((label) => label.toLowerCase())
  const statusRemoved = task.labels.filter(
    (label) => label.toLowerCase() !== 'in-progress' && !after.includes(label.toLowerCase()),
  )

  const assigned = task.assignees.some((name) => name.toLowerCase() === login.toLowerCase())
  if (!assigned) await github.addAssignees(task.number, [login])

  const role = roleLabel(block.role)
  const hasRole = after.includes(role.toLowerCase())
  if (!hasRole) labels = await github.addLabels(task.number, [role])

  return {
    issue: task.number,
    login,
    labels,
    assignees: assigned ? [...task.assignees] : [...task.assignees, login],
    statusAdded: !before.includes('in-progress'),
    statusRemoved,
    roleAdded: hasRole ? null : role,
    assigneeAdded: !assigned,
  }
}

/**
 * Undo a claim: the assignee, the `role:` label and the status labels go back to what they were.
 * The earlier status comes back before `in-progress` goes, so the issue keeps a status.
 * @param {GitHub} github
 * @param {Claim} claim
 * @returns {Promise<void>}
 */
export async function undoClaim(github, claim) {
  if (claim.assigneeAdded) await github.removeAssignees(claim.issue, [claim.login])
  if (claim.roleAdded) await github.removeLabel(claim.issue, claim.roleAdded)
  if (claim.statusRemoved.length > 0) await github.addLabels(claim.issue, claim.statusRemoved)
  if (claim.statusAdded) await github.removeLabel(claim.issue, 'in-progress')
}

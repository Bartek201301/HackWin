// Tasks from issues: who may write one, the status from labels, the member's queue (8.1) and
// whether the dependencies allow a task to be taken (8.3, I12).

import { memberOf } from '../config/ownership.js'
import { parseTaskBlock } from './block.js'

/** @import { Issue } from '../github/index.js' */
/** @import { OwnershipConfig } from '../config/ownership.js' */
/** @import { TaskBlock } from './block.js' */

/**
 * @typedef {'ready' | 'blocked' | 'in-progress' | 'in-review' | 'cut' | 'closed' | 'open'} TaskStatus
 *   `open` is an open task without a status label.
 */

/**
 * @typedef {object} Task
 * @property {number} number
 * @property {string} title
 * @property {'open' | 'closed'} state
 * @property {string[]} labels
 * @property {string[]} assignees
 * @property {TaskStatus} status
 * @property {TaskBlock | null} block Null when the block is invalid.
 * @property {boolean} valid
 * @property {string[]} errors Why the block is invalid; empty when it is valid.
 */

/** Status labels in the order in which one wins over another when an issue has several. */
const STATUS_ORDER = /** @type {const} */ (['in-review', 'in-progress', 'ready', 'blocked'])

/** The statuses that keep a task out of every queue (8.1). */
const NOT_QUEUED = Object.freeze(['in-progress', 'in-review', 'cut', 'closed'])

/**
 * Whether an issue counts as a task by its author: only an issue that a member of the team wrote,
 * `team.lead` or one of `team.members`, compared without case (the Lead's review of PR #73). On a
 * public repository any account can open an issue with a valid task block, and `take` hands the
 * body of a task to an agent as its prompt. A reader that calls parseTaskBlock directly calls this
 * first.
 * @param {Pick<Issue, 'author'>} issue
 * @param {OwnershipConfig} config
 * @returns {boolean}
 */
export function writtenByTeam(issue, config) {
  const { author } = issue
  if (!author) return false
  return (
    author.toLowerCase() === config.hackwin.team.lead.toLowerCase() ||
    memberOf(config, author) !== undefined
  )
}

/**
 * The task of a task issue, or null for an issue without a task block and for an issue that no
 * member of the team wrote (writtenByTeam), whose body is not read.
 * @param {Issue} issue
 * @param {OwnershipConfig} config
 * @returns {Task | null}
 */
export function toTask(issue, config) {
  if (!writtenByTeam(issue, config)) return null
  const parsed = parseTaskBlock(issue.body, config)
  if (!parsed.isTask) return null
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    labels: [...issue.labels],
    assignees: [...issue.assignees],
    status: statusOf(issue),
    block: parsed.valid ? parsed.block : null,
    valid: parsed.valid,
    errors: parsed.valid ? [] : parsed.errors,
  }
}

/**
 * The status of an issue from its state and labels: `cut` wins, then a closed state, then
 * `in-review`, `in-progress`, `ready` and `blocked`.
 * @param {{ state: 'open' | 'closed', labels: string[] }} issue
 * @returns {TaskStatus}
 */
export function statusOf(issue) {
  if (issue.labels.includes('cut')) return 'cut'
  if (issue.state === 'closed') return 'closed'
  return STATUS_ORDER.find((label) => issue.labels.includes(label)) ?? 'open'
}

/**
 * A member's queue (8.1): open tasks with a valid block whose role the member holds and that
 * are not in progress, in review or cut; ordered by wave (tasks without a wave last), then
 * deadline, then issue number. Tasks with an invalid block are not in the queue; `status` lists
 * them as invalid.
 * @param {Task[]} tasks
 * @param {string[]} roles The member's roles.
 * @returns {Task[]}
 */
export function queueOf(tasks, roles) {
  return tasks
    .filter(
      (task) =>
        task.block !== null &&
        task.state === 'open' &&
        !NOT_QUEUED.includes(task.status) &&
        roles.includes(task.block.role),
    )
    .sort(compareQueued)
}

/**
 * Whether a task can be taken: every dependency is closed (8.3, I12). The `blocked` and `ready`
 * labels only mirror this. A dependency missing from `issues` counts as open.
 * @param {Task} task
 * @param {Map<number, { state: string }> | Record<number, { state: string }>} issues By number.
 * @returns {{ takeable: boolean, open: number[] }}
 */
export function dependenciesOf(task, issues) {
  if (task.block === null) return { takeable: false, open: [] }
  const lookup = (/** @type {number} */ number) =>
    issues instanceof Map ? issues.get(number) : issues[number]
  const open = task.block.depends_on.filter((number) => lookup(number)?.state !== 'closed')
  return { takeable: open.length === 0, open }
}

/**
 * @param {Task} a
 * @param {Task} b
 */
function compareQueued(a, b) {
  const blockA = /** @type {TaskBlock} */ (a.block)
  const blockB = /** @type {TaskBlock} */ (b.block)
  const waveA = blockA.wave ?? Number.POSITIVE_INFINITY
  const waveB = blockB.wave ?? Number.POSITIVE_INFINITY
  if (waveA !== waveB) return waveA < waveB ? -1 : 1
  const deadlineA = Date.parse(blockA.deadline)
  const deadlineB = Date.parse(blockB.deadline)
  if (deadlineA !== deadlineB) return deadlineA - deadlineB
  return a.number - b.number
}

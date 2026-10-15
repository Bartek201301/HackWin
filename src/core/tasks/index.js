// Tasks: the task block, who may write a task, the prefix of a scope change, the queue,
// dependencies, branch names, the task link of a pull request, the label catalogue, the labels
// that wait for a pull request's author and status transitions. See docs/build/contracts.md
// section 4.5.

export { parseTaskBlock, SCOPE_CHANGE, shown } from './block.js'
export { toTask, writtenByTeam, queueOf, dependenciesOf } from './task.js'
export { slugOf, branchName, parseBranch, parseTaskLink, checkTaskLink } from './branch.js'
export { LABELS, WAITING_LABELS, roleLabel, setTaskStatus } from './labels.js'

/** @typedef {import('./block.js').TaskBlock} TaskBlock */
/** @typedef {import('./block.js').ParsedTaskBlock} ParsedTaskBlock */
/** @typedef {import('./task.js').Task} Task */
/** @typedef {import('./task.js').TaskStatus} TaskStatus */
/** @typedef {import('./branch.js').TaskLink} TaskLink */
/** @typedef {import('./branch.js').TaskLinkReason} TaskLinkReason */
/** @typedef {import('./branch.js').InvalidTaskBlock} InvalidTaskBlock */

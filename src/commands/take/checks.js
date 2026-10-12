// The five checks of `take` (7.7) and the choice of a task from the caller's queue (8.1). A task
// is takeable only when every check passes; a failure names the check, a one-line reason, the
// objects involved and the next action (CM5).

// src/core/config/index.js does not export the glob functions; until it does, they come from
// glob.js itself, so that take reads every glob as owners.yml and the task block do.
import { createMatcher, samplePath } from '../../core/config/glob.js'
import { ownerOf } from '../../core/config/index.js'
import { dependenciesOf, queueOf, slugOf } from '../../core/tasks/index.js'
import { taskWorktreePath } from '../../core/worktrees/index.js'

/** @import { Config, Identity } from '../../core/config/index.js' */
/** @import { Resolve } from '../../core/runtime/index.js' */
/** @import { Task, TaskBlock } from '../../core/tasks/index.js' */
/** @import { TaskWorktree } from '../../core/worktrees/index.js' */
/** @import { Board } from './board.js' */

/** The rule of each check, as a block names it (CM5). */
export const CHECK_RULES = Object.freeze({
  1: 'take check 1: you hold the role of the task in hackwin.yml on main (7.7, 3.4)',
  2: 'take check 2: the task is open with a valid data block, not in progress, in review or cut, and not labeled needs-lead (7.7, 8.1)',
  3: 'take check 3: every dependency is closed (7.7, 8.3)',
  4: "take check 4: no open pull request changes a file inside the task's paths and no task in progress has overlapping paths; the open list is exempt (H3, H6)",
  5: 'take check 5: you run fewer tasks than your sessions value (7.7, E17)',
})

/**
 * @typedef {object} CheckScope
 * @property {Config} config
 * @property {Identity} identity
 * @property {Board} board
 * @property {string} main The main checkout, where `take` and `join` run.
 * @property {TaskWorktree[]} worktrees The task worktrees of this clone.
 */

/**
 * @typedef {object} CheckFailure
 * @property {1 | 2 | 3 | 4 | 5} check
 * @property {string} reason One line, for example "blocked by #3, still open".
 * @property {string[]} objects The issues, pull requests, paths or block errors involved.
 * @property {Resolve} resolve The next action.
 */

/**
 * @typedef {object} Skipped
 * @property {Task} task
 * @property {CheckFailure} failure
 */

/**
 * Run the five checks on a task in their order and return the first failure, or null when the
 * task can be taken. A task with an invalid block fails check 2, since its role is unknown.
 * @param {Task} task
 * @param {CheckScope} scope
 * @returns {Promise<CheckFailure | null>}
 */
export async function checkTask(task, scope) {
  return (
    checkRole(task, scope) ??
    checkState(task, scope) ??
    (await checkDependencies(task, scope)) ??
    (await checkCollisions(task, scope)) ??
    (await checkSessions(scope))
  )
}

/**
 * The first task of the caller's queue that passes every check, and the tasks before it with
 * the reason each was skipped. An empty queue gives no task and no skipped tasks. When the
 * caller already runs as many tasks as their sessions value, check 5 fails for every task, so
 * it is returned once as `blocked` instead of once per task.
 * @param {CheckScope} scope
 * @returns {Promise<{ queue: Task[], task: Task | null, skipped: Skipped[], blocked: CheckFailure | null }>}
 */
export async function chooseFromQueue(scope) {
  const queue = queueOf(await scope.board.tasks(), scope.identity.roles)
  if (queue.length === 0) return { queue, task: null, skipped: [], blocked: null }
  const blocked = await checkSessions(scope)
  if (blocked) return { queue, task: null, skipped: [], blocked }
  /** @type {Skipped[]} */
  const skipped = []
  for (const task of queue) {
    const failure = await checkTask(task, scope)
    if (failure === null) return { queue, task, skipped, blocked: null }
    skipped.push({ task, failure })
  }
  return { queue, task: null, skipped, blocked: null }
}

/**
 * The open tasks that a login runs: in progress and assigned to it (7.7 step 4).
 * @param {Task[]} tasks
 * @param {string} login
 * @returns {Task[]}
 */
export function runningTasks(tasks, login) {
  const wanted = login.toLowerCase()
  return tasks.filter(
    (task) =>
      task.status === 'in-progress' &&
      task.assignees.some((assignee) => assignee.toLowerCase() === wanted),
  )
}

/**
 * Check 1: the caller holds the task's role on main, whoever the assignee is (3.4).
 * @param {Task} task
 * @param {CheckScope} scope
 * @returns {CheckFailure | null}
 */
function checkRole(task, { config, identity, main }) {
  if (task.block === null || identity.roles.includes(task.block.role)) return null
  const { role } = task.block
  const holder = config.hackwin.team.members.find((member) => member.roles.includes(role))
  const held = holder ? `, which ${holder.github} holds on main` : ''
  return {
    check: 1,
    reason: `#${task.number} is a task of the role ${role}${held}; you hold ${identity.roles.join(', ')}`,
    objects: [`#${task.number} ${task.title}: role ${role}`],
    resolve: { command: 'hackwin take', dir: main },
  }
}

/**
 * Check 2: open, a valid block, not in progress, in review or cut, not labeled needs-lead.
 * @param {Task} task
 * @param {CheckScope} scope
 * @returns {CheckFailure | null}
 */
function checkState(task, { main }) {
  const n = task.number
  const object = `#${n} ${task.title}`
  /** @type {Resolve} */
  const takeAnother = { command: 'hackwin take', dir: main }
  if (task.state === 'closed') {
    return { check: 2, reason: `#${n} is closed`, objects: [object], resolve: takeAnother }
  }
  if (!task.valid) {
    return {
      check: 2,
      reason: `the task block of #${n} is invalid: ${task.errors.join('; ')}`,
      objects: task.errors.map((error) => `#${n}: ${error}`),
      resolve: `ask the Lead to correct the task block of #${n} (8.1)`,
    }
  }
  if (task.status === 'cut') {
    return { check: 2, reason: `#${n} is cut`, objects: [object], resolve: takeAnother }
  }
  if (task.status === 'in-progress') {
    const who = task.assignees.length > 0 ? `, assigned to ${task.assignees.join(', ')}` : ''
    return {
      check: 2,
      reason: `#${n} is in progress${who}`,
      objects: [object],
      resolve: takeAnother,
    }
  }
  if (task.status === 'in-review') {
    return { check: 2, reason: `#${n} is in review`, objects: [object], resolve: takeAnother }
  }
  if (task.labels.includes('needs-lead')) {
    return {
      check: 2,
      reason: `#${n} waits for the Lead (needs-lead)`,
      objects: [object],
      resolve: `ask the Lead to release #${n}`,
    }
  }
  return null
}

/**
 * Check 3: every dependency is closed (8.3, I12). A dependency that does not exist counts as open.
 * @param {Task} task
 * @param {CheckScope} scope
 * @returns {Promise<CheckFailure | null>}
 */
async function checkDependencies(task, { board, main }) {
  const block = /** @type {TaskBlock} */ (task.block)
  /** @type {Map<number, { state: string, title: string }>} */
  const found = new Map()
  for (const number of block.depends_on) {
    const issue = await board.issue(number)
    if (issue) found.set(number, issue)
  }
  const { open } = dependenciesOf(task, found)
  if (open.length === 0) return null
  const names = open.map((number) =>
    found.has(number) ? `#${number}` : `#${number} (no such issue)`,
  )
  return {
    check: 3,
    reason: `blocked by ${listText(names)}, still open`,
    objects: open.map((number) => {
      const issue = found.get(number)
      return issue ? `#${number} ${issue.title}: open` : `#${number}: no such issue`
    }),
    resolve: { command: 'hackwin take', dir: main },
  }
}

/**
 * Check 4 (H3, H6): no open pull request changes a file inside the task's paths, and no other
 * task in progress has paths that overlap the task's paths. Paths on the `open` list are exempt.
 * @param {Task} task
 * @param {CheckScope} scope
 * @returns {Promise<CheckFailure | null>}
 */
async function checkCollisions(task, { config, board, main }) {
  const block = /** @type {TaskBlock} */ (task.block)
  const inTask = createMatcher(block.paths)
  /** @type {string[]} */
  const collisions = []

  for (const pull of await board.pulls()) {
    const paths = pull.paths.filter((path) => inTask(path) && !ownerOf(config, path).open)
    if (paths.length === 0) continue
    const more = paths.length > 1 ? `, and ${paths.length - 1} more` : ''
    collisions.push(`PR #${pull.number}: ${paths[0]}${more}`)
  }

  for (const other of await board.tasks()) {
    if (other.number === task.number || other.status !== 'in-progress' || !other.block) continue
    const overlap = overlapOf(block.paths, other.block.paths, config.owners.open)
    if (overlap) {
      collisions.push(`#${other.number}, in progress: ${overlap.ours} overlaps ${overlap.theirs}`)
    }
  }

  if (collisions.length === 0) return null
  return {
    check: 4,
    reason: `path collision with ${collisions[0]}`,
    objects: collisions,
    resolve: { command: 'hackwin take', dir: main },
  }
}

/**
 * Check 5: the caller runs fewer tasks than their `sessions` value (E17).
 * @param {CheckScope} scope
 * @returns {Promise<CheckFailure | null>}
 */
async function checkSessions({ identity, board, main, worktrees }) {
  const running = runningTasks(await board.tasks(), identity.login)
  const { sessions } = identity.member
  if (running.length < sessions) return null
  const first = running[0]
  const worktree =
    worktrees.find((entry) => entry.issue === first.number)?.path ??
    taskWorktreePath(main, first.number, slugOf(first.title))
  const count = `${running.length} ${running.length === 1 ? 'task' : 'tasks'}`
  return {
    check: 5,
    reason: `you already run ${count}: ${running.map((task) => `#${task.number}`).join(', ')}; your sessions value in hackwin.yml is ${sessions}`,
    objects: running.map((task) => `#${task.number} ${task.title}: in progress`),
    resolve: { command: 'hackwin ship', dir: worktree },
  }
}

/**
 * The first pair of globs, one of each list, that share a path outside the `open` list.
 * @param {string[]} ours
 * @param {string[]} theirs
 * @param {string[]} open
 * @returns {{ ours: string, theirs: string } | null}
 */
function overlapOf(ours, theirs, open) {
  for (const a of ours) {
    for (const b of theirs) {
      if (samplePath({ inside: [a], alsoInside: [b], outside: open }) !== null) {
        return { ours: a, theirs: b }
      }
    }
  }
  return null
}

/**
 * "a", "a and b", "a, b and c".
 * @param {string[]} items
 * @returns {string}
 */
function listText(items) {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

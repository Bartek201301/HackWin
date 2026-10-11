// Task worktrees and the git hooks of a clone: where a task's worktree lives (A9), which task the
// current worktree belongs to, the removal of the worktrees of merged tasks (A35), and the check
// and repair of core.hooksPath (E20). See docs/build/contracts.md, section 4.8.

import { basename, dirname, join, resolve } from 'node:path'
import { PreconditionError } from '../runtime/errors.js'

/** @import { Git, Worktree } from '../git/index.js' */
/** @import { GitHub } from '../github/index.js' */

/** The value of core.hooksPath that activates the generated hook shims (7.2 step 5). */
export const HOOKS_PATH = '.githooks'

/**
 * @typedef {object} TaskWorktree
 * @property {number} issue The issue number from the branch name.
 * @property {string} branch `task/<N>-<slug>`
 * @property {string} path Absolute path of the worktree.
 */

/**
 * @typedef {object} RemovedWorktrees
 * @property {string[]} removed The paths of the removed worktrees.
 * @property {Array<{ path: string, reason: string }>} kept The other task worktrees, with the
 *   reason each one stays.
 */

/**
 * The path of the main checkout of the clone.
 * @param {Git} git
 * @returns {Promise<string>}
 */
export async function mainCheckout(git) {
  const [main] = await git.worktreeList()
  return main.path
}

/**
 * The path of a task's worktree: `<repo-parent>/<repo-name>.worktrees/<N>-<slug>` (A9).
 * @param {string} mainCheckout The path of the main checkout.
 * @param {number} issue
 * @param {string} slug
 * @returns {string}
 */
export function taskWorktreePath(mainCheckout, issue, slug) {
  if (!mainCheckout) throw new TypeError('taskWorktreePath needs the main checkout')
  if (!Number.isInteger(issue) || issue < 1) {
    throw new TypeError(`taskWorktreePath needs an issue number, not ${issue}`)
  }
  if (typeof slug !== 'string' || slug === '' || /[/\\]/.test(slug) || slug.startsWith('.')) {
    throw new TypeError(`not a slug: ${slug}`)
  }
  const main = resolve(mainCheckout)
  return join(dirname(main), `${basename(main)}.worktrees`, `${issue}-${slug}`)
}

/**
 * The task of the current worktree: its issue, branch and path when it is on a `task/` branch,
 * otherwise null.
 * @param {Git} git A Git for the current directory.
 * @returns {Promise<TaskWorktree | null>}
 */
export async function currentTask(git) {
  const branch = await git.currentBranch()
  const issue = taskIssueOf(branch)
  if (branch === null || issue === null) return null
  return { issue, branch, path: await git.topLevel() }
}

/**
 * Every worktree of the clone that is on a `task/` branch. A worktree whose directory is gone
 * (prunable) is left out.
 * @param {Git} git
 * @returns {Promise<TaskWorktree[]>}
 */
export async function taskWorktrees(git) {
  return tasksOf(await git.worktreeList()).map(({ issue, branch, path }) => ({
    issue,
    branch,
    path,
  }))
}

/**
 * Remove the worktree of every task whose pull request is merged (A35). The branch stays. A
 * worktree with changes or untracked files, a locked worktree and the worktree `git` runs in are
 * kept, each with its reason, and so is every task worktree whose pull request is not merged.
 * @param {Git} git
 * @param {GitHub} github
 * @returns {Promise<RemovedWorktrees>}
 */
export async function removeMergedWorktrees(git, github) {
  /** @type {RemovedWorktrees} */
  const result = { removed: [], kept: [] }
  const tasks = tasksOf(await git.worktreeList())
  if (tasks.length === 0) return result

  const pulls = await github.listPullRequests({ state: 'closed' })
  const merged = new Set(pulls.filter((pull) => pull.merged).map((pull) => pull.headRef))
  const current = resolve(await git.topLevel())

  for (const task of tasks) {
    if (!merged.has(task.branch)) {
      result.kept.push({ path: task.path, reason: 'its pull request is not merged' })
    } else if (resolve(task.path) === current) {
      result.kept.push({ path: task.path, reason: 'it is the current worktree' })
    } else if (task.locked) {
      result.kept.push({ path: task.path, reason: 'it is locked' })
    } else {
      try {
        await git.worktreeRemove(task.path)
        result.removed.push(task.path)
      } catch (error) {
        const dirty = /modified or untracked/.test(error.message)
        const reason = dirty ? 'it has uncommitted changes or untracked files' : error.message
        result.kept.push({ path: task.path, reason })
      }
    }
  }
  return result
}

/**
 * Whether the git hooks are active: core.hooksPath is `.githooks` (E20).
 * @param {Git} git
 * @returns {Promise<{ ok: boolean, value: string | null }>} `value` is the current setting, or
 *   null when it is not set.
 */
export async function checkHooksPath(git) {
  // A Git with the member hooks switched off would report its own setting.
  const value = await git.with({ hooksOff: false }).configGet('core.hooksPath')
  return { ok: value !== null && isHooksPath(value), value }
}

/**
 * Point core.hooksPath at `.githooks` in the clone's config when it is unset or wrong (E20).
 * Every worktree of the clone shares that config.
 * @param {Git} git
 * @returns {Promise<{ changed: boolean }>}
 */
export async function repairHooksPath(git) {
  if ((await checkHooksPath(git)).ok) return { changed: false }
  await git.with({ hooksOff: false }).configSet('core.hooksPath', HOOKS_PATH)
  const { ok, value } = await checkHooksPath(git)
  if (!ok) {
    throw new PreconditionError(
      `core.hooksPath is still ${value} after hackwin set it to ${HOOKS_PATH} in the clone's config: a setting with higher precedence overrides it`,
      { resolve: { command: 'git config --show-origin --get core.hooksPath', dir: git.cwd } },
    )
  }
  return { changed: true }
}

/**
 * The worktrees on a `task/` branch, without a bare entry and without a worktree whose directory
 * is gone (prunable).
 * @param {Worktree[]} worktrees
 * @returns {Array<TaskWorktree & { locked: boolean }>}
 */
function tasksOf(worktrees) {
  /** @type {Array<TaskWorktree & { locked: boolean }>} */
  const tasks = []
  for (const { bare, prunable, branch, path, locked } of worktrees) {
    if (bare || prunable || branch === null) continue
    const issue = taskIssueOf(branch)
    if (issue !== null) tasks.push({ issue, branch, path, locked })
  }
  return tasks
}

/**
 * The issue number of a `task/<N>-<slug>` branch, or null for any other branch.
 * @param {string | null} branch
 * @returns {number | null}
 */
function taskIssueOf(branch) {
  const match = branch === null ? null : /^task\/([1-9]\d*)(?:-|$)/.exec(branch)
  return match ? Number(match[1]) : null
}

/**
 * True for `.githooks`, also written as `./.githooks` or `.githooks/`.
 * @param {string} value
 * @returns {boolean}
 */
function isHooksPath(value) {
  return value.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '') === HOOKS_PATH
}

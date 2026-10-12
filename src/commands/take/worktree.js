// Step 5 of `take` (7.7): the branch `task/<N>-<slug>` from the fresh default branch and its
// worktree beside the repository (A9), or both reused when an earlier `take` left them, and the
// personal files linked from the main checkout (A13). The links point at the files of the main
// checkout; `take` never opens them.

import { lstat, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { branchName, parseBranch, slugOf } from '../../core/tasks/index.js'
import { taskWorktreePath, taskWorktrees } from '../../core/worktrees/index.js'

/** @import { Git } from '../../core/git/index.js' */
/** @import { Task } from '../../core/tasks/index.js' */

/** The personal files of the main checkout that every task worktree links (A13). */
export const LINKED_FILES = Object.freeze(['.env.local', 'CLAUDE.local.md'])

/**
 * Where a task's work happens, and how step 5 gets there.
 * @typedef {object} TaskCheckout
 * @property {string} path The absolute path of the worktree.
 * @property {string} branch `task/<N>-<slug>`
 * @property {'create' | 'reuse-worktree' | 'reuse-branch'} how `create` makes a new branch from
 *   the default branch and its worktree; `reuse-branch` adds a worktree for a branch an earlier
 *   `take` left; `reuse-worktree` keeps the worktree as it is.
 */

/**
 * @typedef {object} LinkedFiles
 * @property {string[]} linked Linked by this run.
 * @property {string[]} present Already in the worktree, as a link or a file of its own.
 * @property {string[]} missing Not in the main checkout, so nothing to link.
 */

/**
 * Decide where the task's work happens, without changing anything: the worktree of the task
 * when one exists, else a worktree for the task's local branch when one exists, else a new
 * branch and worktree at the path of A9. The main checkout is never reused as a task worktree.
 * @param {Git} git
 * @param {{ main: string, task: Task }} options
 * @returns {Promise<TaskCheckout>}
 */
export async function planCheckout(git, { main, task }) {
  const worktree = (await taskWorktrees(git)).find(
    (entry) => entry.issue === task.number && resolve(entry.path) !== resolve(main),
  )
  if (worktree) return { path: worktree.path, branch: worktree.branch, how: 'reuse-worktree' }

  const wanted = branchName(task.number, task.title)
  const branches = await taskBranches(git, task.number)
  const branch = branches.includes(wanted) ? wanted : branches[0]
  if (branch !== undefined) {
    const slug = branch.slice(`task/${task.number}-`.length) || slugOf(task.title)
    return { path: taskWorktreePath(main, task.number, slug), branch, how: 'reuse-branch' }
  }
  return {
    path: taskWorktreePath(main, task.number, slugOf(task.title)),
    branch: wanted,
    how: 'create',
  }
}

/**
 * Carry out the plan: a new branch starts at `mainSha` without tracking (A9).
 * @param {Git} git
 * @param {TaskCheckout} checkout
 * @param {string} mainSha The fresh commit of the default branch.
 * @returns {Promise<void>}
 */
export async function openCheckout(git, checkout, mainSha) {
  if (checkout.how === 'reuse-worktree') return
  if (checkout.how === 'reuse-branch') {
    await git.worktreeAdd(checkout.path, { branch: checkout.branch })
    return
  }
  await git.worktreeAdd(checkout.path, {
    branch: checkout.branch,
    createBranch: true,
    startPoint: mainSha,
  })
}

/**
 * Link `.env.local` and `CLAUDE.local.md` of the main checkout into the worktree (A13). A file
 * missing in the main checkout is not linked, and an entry the worktree already has stays.
 * @param {string} main The main checkout.
 * @param {string} worktree
 * @returns {Promise<LinkedFiles>}
 */
export async function linkLocalFiles(main, worktree) {
  /** @type {LinkedFiles} */
  const result = { linked: [], present: [], missing: [] }
  if (resolve(main) === resolve(worktree)) return result
  for (const name of LINKED_FILES) {
    const source = join(main, name)
    const target = join(worktree, name)
    if (!(await exists(source))) result.missing.push(name)
    else if (await exists(target)) result.present.push(name)
    else {
      await symlink(source, target)
      result.linked.push(name)
    }
  }
  return result
}

/**
 * The local branches of a task, `task/<N>` with or without a slug, by name.
 * @param {Git} git
 * @param {number} issue
 * @returns {Promise<string[]>}
 */
async function taskBranches(git, issue) {
  const refs = await git.run(['for-each-ref', '--format=%(refname)', 'refs/heads/task/'])
  return refs.stdout
    .split('\n')
    .filter((ref) => ref !== '')
    .map((ref) => ref.replace(/^refs\/heads\//, ''))
    .filter((branch) => {
      const parsed = parseBranch(branch)
      return parsed.kind === 'task' && parsed.issue === issue
    })
    .sort()
}

/**
 * True when the path exists, as a file, a directory or a link. Only the entry is looked at,
 * never its content.
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function exists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false
    throw error
  }
}

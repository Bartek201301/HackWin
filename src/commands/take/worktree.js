// Step 5 of `take` (7.7): the branch `task/<N>-<slug>` from the fresh default branch and its
// worktree beside the repository (A9), or both reused when an earlier `take` left them, and the
// personal files linked from the main checkout (A13). The links point at the files of the main
// checkout; `take` never opens them.
//
// A reused branch is brought up to date before the agent starts (A12): first with the commits of
// its remote branch that it lacks, then with the current default branch. A branch without
// commits of its own, such as one a failed `git worktree add -b` left behind, is fast-forwarded;
// one with commits of its own gets a merge, never a rebase. Where that cannot happen, because the
// worktree has uncommitted changes or the merge conflicts, nothing changes and the update says
// why; `ship` merges both later.

import { lstat, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { GitError } from '../../core/runtime/index.js'
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
 * @property {'create' | 'from-remote' | 'reuse-worktree' | 'reuse-branch'} how `create` makes a
 *   new branch from the default branch and its worktree; `from-remote` makes the branch from its
 *   remote branch, which an earlier `ship` pushed; `reuse-branch` adds a worktree for a branch an
 *   earlier `take` left; `reuse-worktree` keeps the worktree.
 */

/**
 * What bringing the branch up to date did with one ref.
 * @typedef {object} RefUpdate
 * @property {string} ref For example `origin/main` or `origin/task/7-reset`.
 * @property {string | null} sha The commit of the ref; null when it does not exist.
 * @property {'absent' | 'up-to-date' | 'fast-forward' | 'merged' | 'not-merged'} status
 *   `absent` when the ref does not exist; `up-to-date` when the branch already contains it.
 * @property {string | null} reason Why it was not merged.
 * @property {string[]} conflicts The files a merge that was undone conflicted in.
 */

/**
 * @typedef {object} BranchUpdate
 * @property {RefUpdate} remote The branch's own remote branch.
 * @property {RefUpdate} main The default branch.
 */

/**
 * @typedef {object} LinkedFiles
 * @property {string[]} linked Linked by this run.
 * @property {string[]} present Already in the worktree, as a link or a file of its own.
 * @property {string[]} missing Not in the main checkout, so nothing to link.
 */

/**
 * Decide where the task's work happens, without changing anything: the worktree of the task
 * when one exists, else a worktree for the task's local branch when one exists, else a branch
 * from the task's remote branch when one exists, else a new branch from the default branch. The
 * worktree lies at the path of A9. The main checkout is never reused as a task worktree.
 * @param {Git} git
 * @param {{ main: string, task: Task, branch?: string }} options `branch` is the name to prefer
 *   among several branches of the task; `task/<N>-<slug>` of the title by default.
 * @returns {Promise<TaskCheckout>}
 */
export async function planCheckout(git, { main, task, branch: wanted }) {
  const worktree = (await taskWorktrees(git)).find(
    (entry) => entry.issue === task.number && resolve(entry.path) !== resolve(main),
  )
  if (worktree) return { path: worktree.path, branch: worktree.branch, how: 'reuse-worktree' }

  const name = wanted ?? branchName(task.number, task.title)
  /** @param {string} branch */
  const pathOf = (branch) =>
    taskWorktreePath(
      main,
      task.number,
      branch.slice(`task/${task.number}-`.length) || slugOf(task.title),
    )
  const local = pick(await taskBranches(git, task.number), name)
  if (local !== undefined) return { path: pathOf(local), branch: local, how: 'reuse-branch' }
  const remote = pick(await taskBranches(git, task.number, REMOTE_PREFIX), name)
  if (remote !== undefined) return { path: pathOf(remote), branch: remote, how: 'from-remote' }
  return { path: pathOf(name), branch: name, how: 'create' }
}

/**
 * Carry out the plan: a new branch starts at `mainSha`, or at its remote branch, without
 * tracking (A9).
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
    startPoint:
      checkout.how === 'from-remote' ? `refs/${REMOTE_PREFIX}${checkout.branch}` : mainSha,
  })
}

/**
 * Bring the branch of the worktree up to date: first the commits of its remote branch that it
 * lacks, then the default branch. A branch that contains a ref stays as it is; a branch inside
 * the ref is fast-forwarded; any other gets a merge commit. Nothing is merged while the worktree
 * has uncommitted changes or untracked files, and a merge that conflicts is undone; the default
 * branch is not merged while the remote branch is not.
 * @param {Git} git
 * @param {TaskCheckout} checkout
 * @param {{ mainRef: string, mainSha: string }} main
 * @returns {Promise<BranchUpdate>}
 */
export async function updateCheckout(git, checkout, { mainRef, mainSha }) {
  const worktree = git.with({ cwd: checkout.path })
  const changes = (await worktree.isClean())
    ? null
    : 'the worktree has uncommitted changes or untracked files'
  const remoteRef = `origin/${checkout.branch}`
  const remoteSha = await worktree.tryRevParse(`refs/${REMOTE_PREFIX}${checkout.branch}`)
  const remote =
    remoteSha === null
      ? refUpdate(remoteRef, null, 'absent')
      : await mergeRef(worktree, checkout.branch, remoteRef, remoteSha, changes)
  const blocked =
    remote.status === 'not-merged' ? `${remoteRef} could not be merged first` : changes
  const main = await mergeRef(worktree, checkout.branch, mainRef, mainSha, blocked)
  return { remote, main }
}

/**
 * Merge one ref into the branch, unless it is in already or `blocked` names why not.
 * @param {Git} git Git in the worktree.
 * @param {string} branch
 * @param {string} ref
 * @param {string} sha
 * @param {string | null} blocked
 * @returns {Promise<RefUpdate>}
 */
async function mergeRef(git, branch, ref, sha, blocked) {
  if (await git.isAncestor(sha, 'HEAD')) return refUpdate(ref, sha, 'up-to-date')
  if (blocked !== null) return refUpdate(ref, sha, 'not-merged', blocked)
  try {
    const result = await git.merge(sha, { message: `Merge ${ref} into ${branch}` })
    if (result.status !== 'conflict') {
      return refUpdate(ref, sha, result.status === 'fast-forward' ? 'fast-forward' : 'merged')
    }
    await git.mergeAbort()
    const count = result.conflicts.length
    const files = `${count} ${count === 1 ? 'file' : 'files'}`
    return {
      ...refUpdate(ref, sha, 'not-merged', `the merge conflicts in ${files}, so it was undone`),
      conflicts: result.conflicts,
    }
  } catch (error) {
    if (!(error instanceof GitError)) throw error
    if ((await git.tryRevParse('MERGE_HEAD')) !== null) await git.mergeAbort()
    return refUpdate(ref, sha, 'not-merged', error.message)
  }
}

/**
 * @param {string} ref
 * @param {string | null} sha
 * @param {RefUpdate['status']} status
 * @param {string | null} [reason]
 * @returns {RefUpdate}
 */
function refUpdate(ref, sha, status, reason = null) {
  return { ref, sha, status, reason, conflicts: [] }
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

/** Where the branches of `origin` are, below `refs/`. */
const REMOTE_PREFIX = 'remotes/origin/'

/**
 * The branches of a task, `task/<N>` with or without a slug, by name: the local branches, or
 * with `prefix` the remote branches of `origin`.
 * @param {Git} git
 * @param {number} issue
 * @param {string} [prefix] Below `refs/`.
 * @returns {Promise<string[]>}
 */
export async function taskBranches(git, issue, prefix = 'heads/') {
  const refs = await git.run(['for-each-ref', '--format=%(refname)', `refs/${prefix}task/`])
  return refs.stdout
    .split('\n')
    .filter((ref) => ref !== '')
    .map((ref) => ref.slice(`refs/${prefix}`.length))
    .filter((branch) => {
      const parsed = parseBranch(branch)
      return parsed.kind === 'task' && parsed.issue === issue
    })
    .sort()
}

/**
 * The wanted branch when it is among the branches, else the first of them.
 * @param {string[]} branches
 * @param {string} wanted
 * @returns {string | undefined}
 */
function pick(branches, wanted) {
  return branches.includes(wanted) ? wanted : branches[0]
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

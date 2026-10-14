// CM10: a command that runs in the main checkout first fast-forwards it to origin/main when it is
// on the default branch without local changes; otherwise the runner warns that it is behind
// (A52). A task worktree is never touched.

/** @import { Git } from '../git/index.js' */

/**
 * @typedef {'fast-forwarded' | 'up-to-date' | 'behind' | 'not-main-checkout'} FastForwardStatus
 */

/**
 * Fast-forward the main checkout to `origin/<defaultBranch>`, which the caller has fetched.
 * Untracked files do not block it; git itself refuses a fast-forward that would overwrite one.
 * @param {Git} git Runs in the checkout or worktree the command started in.
 * @param {{ defaultBranch: string }} options
 * @returns {Promise<{ status: FastForwardStatus }>} `behind` when the checkout has local
 *   changes, is on another branch or has commits of its own: nothing changes.
 */
export async function fastForwardMainCheckout(git, { defaultBranch }) {
  const [main] = await git.worktreeList()
  if (!main || main.bare || main.path !== (await git.topLevel())) {
    return { status: 'not-main-checkout' }
  }
  const target = await git.tryRevParse(`origin/${defaultBranch}`)
  const head = await git.tryRevParse('HEAD')
  if (target === null || (head !== null && (await git.isAncestor(target, head)))) {
    return { status: 'up-to-date' }
  }
  if (head === null || (await git.currentBranch()) !== defaultBranch) return { status: 'behind' }
  const changes = await git.run(['status', '--porcelain', '--untracked-files=no'])
  if (changes.stdout.trim() !== '') return { status: 'behind' }
  const result = await git.merge(target, { ffOnly: true })
  if (result.status === 'fast-forward') return { status: 'fast-forwarded' }
  if (result.status === 'up-to-date') return { status: 'up-to-date' }
  return { status: 'behind' }
}

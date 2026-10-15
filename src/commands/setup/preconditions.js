// Step 1 of `setup` (7.1): the versions of git, gh and Node, and the preconditions: a clone with a
// GitHub remote, gh logged in with admin rights on the repository, the main checkout, a clean
// working tree on the default branch, and nothing on it that origin lacks. The runner has already
// made sure that origin's default branch holds no hackwin.yml (contracts 3.6).

import { PreconditionError, runIn } from '../../core/runtime/index.js'
import { mainCheckout } from '../../core/worktrees/index.js'
import { checkNode } from '../join/checks.js'

/** @import { CommandContext } from '../../cli/context.js' */

/**
 * What step 1 found.
 * @typedef {object} Preconditions
 * @property {string} login The gh login, the Lead's.
 * @property {{ nameWithOwner: string, defaultBranch: string, visibility: string, url: string }} repository
 * @property {string} branch The default branch, checked out.
 * @property {string | null} head The commit of the branch before setup, or null on an empty
 *   repository.
 * @property {{ git: string, gh: string, node: string }} versions
 */

/**
 * @param {CommandContext} ctx
 * @returns {Promise<Preconditions>}
 */
export async function checkPreconditions(ctx) {
  const git = ctx.git
  const root = ctx.repoRoot
  const versions = await checkVersions(ctx)

  if ((await git.remoteUrl('origin')) === null) {
    throw new PreconditionError('this clone has no remote origin', {
      resolve: 'run hackwin setup in a clone of the team repository on GitHub',
    })
  }
  const login = await ctx.github.login()
  const repository = await ctx.github.repository()
  const name = repository.nameWithOwner
  if (!repository.permissions.admin) {
    throw new PreconditionError(
      `${login} has no admin rights on ${name}; setup creates the branch rules, which need them`,
      {
        resolve: `log gh in as an admin of ${name}, the Lead, then ${runIn('hackwin setup', root)}`,
      },
    )
  }
  const main = await mainCheckout(git)
  if (main !== root) {
    throw new PreconditionError('setup runs in the main checkout, not in a worktree', {
      resolve: { command: 'hackwin setup', dir: main },
    })
  }
  const branch = repository.defaultBranch
  if ((await git.currentBranch()) !== branch) {
    throw new PreconditionError(`setup runs on the default branch ${branch}`, {
      resolve: { command: `git switch ${branch}`, dir: root },
    })
  }
  if (!(await git.isClean())) {
    throw new PreconditionError('the working tree has changes or untracked files', {
      resolve: `commit, stash or remove them, then ${runIn('hackwin setup', root)}`,
    })
  }
  const head = await upToDate(ctx, branch)
  ctx.out.line(
    `checked: git ${versions.git}, gh ${versions.gh}, Node ${versions.node}; ${login} is an admin of ${name}`,
  )
  return { login, repository, branch, head, versions }
}

/**
 * The versions of git, gh and Node: git 2.38 or later for `merge-tree --write-tree`, Node 22 or
 * later (plan section 9, decision 11), and any gh that answers.
 * @param {CommandContext} ctx
 * @returns {Promise<{ git: string, gh: string, node: string }>}
 */
async function checkVersions(ctx) {
  const { major, minor, patch } = await ctx.git.version()
  await ctx.git.requireMergeTree()
  const node = checkNode(process.versions.node)
  if (node.result === 'failed') {
    throw new PreconditionError(node.detail, { resolve: node.fixes?.[0] })
  }
  const gh = await ctx.github.run(['version'])
  const ghVersion = /(\d+\.\d+\.\d+)/.exec(gh.stdout)?.[1] ?? gh.stdout.trim().split('\n')[0]
  return { git: `${major}.${minor}.${patch}`, gh: ghVersion, node: process.versions.node }
}

/**
 * The commit of the default branch, after bringing it up to origin's: a branch behind origin is
 * fast-forwarded (CM10); a branch with commits that origin lacks is refused, because setup pushes
 * only its own commit.
 * @param {CommandContext} ctx
 * @param {string} branch
 * @returns {Promise<string | null>} Null on an empty repository.
 */
async function upToDate(ctx, branch) {
  const git = ctx.git
  const head = await git.tryRevParse('HEAD')
  const remote = await git.tryRevParse(`refs/remotes/origin/${branch}`)
  if (head === remote) return head
  if (head !== null && (remote === null || !(await git.isAncestor(head, remote)))) {
    throw new PreconditionError(
      `${branch} has commits that origin/${branch} lacks; setup pushes only its own commit`,
      {
        resolve: `push those commits or remove them from ${branch}, then ${runIn('hackwin setup', ctx.repoRoot)}`,
      },
    )
  }
  await git.merge(`refs/remotes/origin/${branch}`, { ffOnly: true })
  ctx.out.line(`fast-forwarded ${branch} to origin/${branch}`)
  return remote
}

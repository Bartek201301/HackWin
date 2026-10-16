// Step 1 of `setup` (7.1): the versions of git, gh and Node, and the preconditions: a clone with a
// GitHub remote, gh logged in with admin rights on the repository and, where git pushes with gh's
// token, with the `workflow` scope, the main checkout, a clean working tree on the default branch,
// and nothing on it that origin lacks. The runner has already made sure that origin's default
// branch holds no hackwin.yml (contracts 3.6).

import { PreconditionError, RemoteError, runIn } from '../../core/runtime/index.js'
import { mainCheckout } from '../../core/worktrees/index.js'
import { WORKFLOW_PATH } from '../../generate/index.js'
import { checkNode } from '../join/checks.js'

/** @import { CommandContext } from '../../cli/context.js' */
/** @import { Git } from '../../core/git/index.js' */
/** @import { GitHub } from '../../core/github/index.js' */

/** The OAuth scope without which GitHub refuses a push that creates or changes a workflow file. */
const WORKFLOW_SCOPE = 'workflow'

/** gh as git's credential helper, as `gh auth setup-git` configures it. */
const GH_CREDENTIAL_HELPER = /\bgh\S*\s+auth\s+git-credential\b/

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
  await checkWorkflowScope(ctx)
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

/**
 * The bootstrap commit of step 9 creates the CI workflow, and GitHub refuses a push that creates a
 * workflow file from an OAuth token without the `workflow` scope. Where git pushes to origin with
 * gh's token (an HTTPS remote whose credential helper is gh), setup reads the token's scopes from
 * the `X-OAuth-Scopes` header of `gh api -i user`, as docs/verification.md read them, and stops
 * here, before any question or change. Where git pushes with another credential, such as SSH, or
 * GitHub returns no scopes, as for a fine-grained token, the check is skipped, and step 9 names
 * the scope if GitHub refuses the push.
 * @param {CommandContext} ctx
 */
async function checkWorkflowScope(ctx) {
  if (!(await pushesWithGh(ctx.git))) return
  const scopes = await tokenScopes(ctx.github)
  if (scopes === null || scopes.includes(WORKFLOW_SCOPE)) return
  throw new PreconditionError(
    `gh is logged in without the ${WORKFLOW_SCOPE} scope (its scopes: ${scopes.join(', ')}), and git pushes with its token: GitHub refuses a push that creates a workflow file without that scope, and the bootstrap commit creates ${WORKFLOW_PATH}`,
    {
      resolve: `${runIn(`gh auth refresh -s ${WORKFLOW_SCOPE}`, 'any directory')}, then ${runIn('hackwin setup', ctx.repoRoot)}`,
    },
  )
}

/**
 * True when git pushes to origin over HTTPS with gh as its credential helper, so with gh's token.
 * The URL is the one git really pushes to: `pushurl`, `insteadOf` and `pushInsteadOf` applied.
 * @param {Git} git
 * @returns {Promise<boolean>}
 */
async function pushesWithGh(git) {
  const pushUrl = await git.run(['remote', 'get-url', '--push', 'origin'], { allowFailure: true })
  const url = pushUrl.code === 0 ? pushUrl.stdout.trim() : ''
  if (!/^https:\/\//i.test(url)) return false
  const helper = await git.run(['config', '--get-urlmatch', 'credential.helper', url], {
    allowFailure: true,
  })
  return helper.code === 0 && GH_CREDENTIAL_HELPER.test(helper.stdout)
}

/**
 * The OAuth scopes of gh's token, or null where they are unknown: GitHub sends no scopes, an
 * empty list of them, which a token that is no OAuth token may send, or the call fails. A classic
 * token without any scope could not push the bootstrap commit anyway.
 * @param {GitHub} github
 * @returns {Promise<string[] | null>}
 */
async function tokenScopes(github) {
  try {
    const { stdout } = await github.run(['api', '-i', 'user'])
    const header = /^x-oauth-scopes:[ \t]*(.*?)\r?$/im.exec(stdout)
    const scopes = (header?.[1] ?? '')
      .split(',')
      .map((scope) => scope.trim())
      .filter(Boolean)
    return scopes.length === 0 ? null : scopes
  } catch (error) {
    if (error instanceof RemoteError) return null
    throw error
  }
}

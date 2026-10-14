// `hackwin internal hook pre-push` (10.3): a push to the default branch is blocked (E2, E18),
// deleting it included; a push that rewrites the history of a remote branch is blocked (E12);
// the pushed head commit of a `task/` branch needs its green check record (E4), which `ship`
// writes after every check passed. Tags and refs outside refs/heads/ are left alone; `spike/`
// and other branches need no check record; deleting a remote branch other than the default
// branch is allowed.
//
// git passes the remote name and URL as arguments and one line per ref on stdin:
// `<local ref> <local sha> <remote ref> <remote sha>`, with a SHA of zeros for a ref that does
// not exist on that side.

import { BlockedError, UsageError } from '../../core/runtime/errors.js'
import { quoteShellArg } from '../../core/runtime/exec.js'
import { isGreen, readCheckRecord } from '../../core/state/index.js'
import { parseBranch } from '../../core/tasks/index.js'
import { mainCheckout } from '../../core/worktrees/index.js'
import { loadHookConfig } from './config.js'
import { announceSelfTest } from './self-test.js'

/** @import { CommandContext, CommandResult } from '../../cli/context.js' */
/** @import { Git, Worktree } from '../../core/git/index.js' */

/**
 * One ref of a push, as git describes it to the hook.
 * @typedef {object} RefUpdate
 * @property {string} localRef `(delete)` when the push deletes the remote ref.
 * @property {string} localSha Zeros when the push deletes the remote ref.
 * @property {string} remoteRef
 * @property {string} remoteSha Zeros when the remote ref does not exist yet.
 */

const BRANCH_PREFIX = 'refs/heads/'

/**
 * @param {CommandContext} ctx
 * @returns {Promise<CommandResult | void>}
 */
export async function run(ctx) {
  announceSelfTest(ctx)
  const [remote = 'origin'] = ctx.args
  const updates = parsePushLines(await ctx.readStdin()).filter((update) =>
    update.remoteRef.startsWith(BRANCH_PREFIX),
  )
  if (updates.length === 0) return
  const config = await loadHookConfig(ctx)
  const defaultBranch = config.hackwin.project.default_branch
  const worktrees = await ctx.git.worktreeList()
  /** @param {RefUpdate} update */
  const dirOf = (update) => worktreeOf(worktrees, update.localRef) ?? ctx.repoRoot

  const toDefault = updates.filter((update) => branchOf(update.remoteRef) === defaultBranch)
  if (toDefault.length > 0) {
    const [first] = toDefault
    throw new BlockedError(
      `a push to ${defaultBranch} is blocked: ${defaultBranch} changes only through the Gate's merges of pull requests`,
      {
        rule: `E2: no direct push to ${defaultBranch}`,
        objects: toDefault.map((update) =>
          isZero(update.localSha)
            ? `${remote}: delete ${update.remoteRef}`
            : `${remote}: ${update.remoteRef} to ${update.localSha}`,
        ),
        resolve:
          parseBranch(first.localRef).kind === 'task'
            ? { command: 'hackwin ship', dir: dirOf(first) }
            : { command: 'hackwin take', dir: await mainCheckout(ctx.git) },
      },
    )
  }

  const changes = updates.filter(
    (update) => !isZero(update.localSha) && update.localSha !== update.remoteSha,
  )

  /** @type {RefUpdate[]} */
  const rewrites = []
  for (const update of changes) {
    if (!isZero(update.remoteSha) && (await rewritesHistory(ctx.git, update))) {
      rewrites.push(update)
    }
  }
  if (rewrites.length > 0) {
    const [first] = rewrites
    throw new BlockedError(
      `this push would replace commits on ${remote} that the pushed commit does not contain; merge the remote branch instead of rewriting it`,
      {
        rule: 'E12: main is merged in, never rebased or force pushed',
        objects: rewrites.map(
          (update) =>
            `${branchOf(update.remoteRef)}: ${update.remoteSha} on ${remote} is not in the history of ${update.localSha}`,
        ),
        resolve: {
          command: `git pull --no-rebase ${quoteShellArg(remote)} ${quoteShellArg(branchOf(first.remoteRef))}`,
          dir: dirOf(first),
        },
      },
    )
  }

  /** @type {RefUpdate[]} */
  const unchecked = []
  for (const update of changes) {
    if (parseBranch(branchOf(update.remoteRef)).kind !== 'task') continue
    const record = await readCheckRecord(ctx.gitCommonDir, update.localSha)
    if (!isGreen(record, update.localSha)) unchecked.push(update)
  }
  if (unchecked.length > 0) {
    throw new BlockedError(
      'the pushed commit of a task branch has no green check record; hackwin ship runs the checks, records them and pushes',
      {
        rule: 'E4: no push without green checks on the pushed commit',
        objects: unchecked.map(
          (update) => `${branchOf(update.remoteRef)} at ${update.localSha}: no green check record`,
        ),
        resolve: { command: 'hackwin ship', dir: dirOf(unchecked[0]) },
      },
    )
  }
}

/**
 * The ref lines that git writes on the stdin of the pre-push hook.
 * @param {string} text
 * @returns {RefUpdate[]}
 */
export function parsePushLines(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const fields = line.split(/\s+/)
      if (fields.length !== 4) {
        throw new UsageError(
          `pre-push expects lines of <local ref> <local sha> <remote ref> <remote sha> on stdin, not: ${line}`,
        )
      }
      const [localRef, localSha, remoteRef, remoteSha] = fields
      return { localRef, localSha, remoteRef, remoteSha }
    })
}

/**
 * True when the remote commit is not in the history of the pushed one. A remote commit that
 * this clone does not have cannot be in that history.
 * @param {Git} git
 * @param {RefUpdate} update
 * @returns {Promise<boolean>}
 */
async function rewritesHistory(git, update) {
  if ((await git.tryRevParse(update.remoteSha)) === null) return true
  return !(await git.isAncestor(update.remoteSha, update.localSha))
}

/**
 * The worktree that has the local branch of a push checked out, or null.
 * @param {Worktree[]} worktrees
 * @param {string} localRef
 * @returns {string | null}
 */
function worktreeOf(worktrees, localRef) {
  if (!localRef.startsWith(BRANCH_PREFIX)) return null
  const branch = branchOf(localRef)
  return worktrees.find((worktree) => worktree.branch === branch)?.path ?? null
}

/**
 * @param {string} ref
 * @returns {string}
 */
function branchOf(ref) {
  return ref.startsWith(BRANCH_PREFIX) ? ref.slice(BRANCH_PREFIX.length) : ref
}

/**
 * @param {string} sha
 * @returns {boolean}
 */
function isZero(sha) {
  return /^0+$/.test(sha)
}

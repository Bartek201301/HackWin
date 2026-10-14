// `hackwin internal hook pre-tool-use` (10.4): before a tool call of a Claude Code session, the
// hook refuses
//
// - an edit of a file outside the session's role scope: the roles that the member running the
//   session holds in hackwin.yml on main, the same check as at commit (E1, A15), never the role
//   of a task. Files on `spike/` branches are exempt, as at commit (10.3);
// - `gh pr merge` and a merge through `gh api`, in every session, the Lead's included: for the
//   Lead's own sessions this and the deny rule are the only block against a merge outside the
//   queue (E3, D2, 10.6);
// - any push to the default branch (E2, E18).
//
// It refuses with the decision `deny` (event.js). It stays offline: the configuration comes from
// the local origin/main, and only a call that needs it loads it, which applies CM12 as the git
// hooks do (config.js). A merge is refused without it.

import { resolve } from 'node:path'
import { BlockedError } from '../../core/runtime/errors.js'
import { scopeCheck } from '../../core/config/index.js'
import { parseBranch } from '../../core/tasks/index.js'
import { mainCheckout } from '../../core/worktrees/index.js'
import { hookIdentity, loadHookConfig } from './config.js'
import { denyToolCall, editedFile, eventDir, readHookEvent } from './event.js'
import { isIgnored, locateFile } from './files.js'
import { commandsOf, destinationOf, isMerge, pushOf } from './shell.js'

/** @import { CommandContext, CommandResult } from '../../cli/context.js' */
/** @import { Push } from './shell.js' */

/**
 * @param {CommandContext} ctx
 * @returns {Promise<CommandResult | void>}
 */
export async function run(ctx) {
  const event = await readHookEvent(ctx, 'PreToolUse')
  const dir = eventDir(ctx, event)
  if (event.tool_name === 'Bash') {
    const command = event.tool_input?.command
    return typeof command === 'string' ? checkCommand(ctx, command, dir) : undefined
  }
  const file = editedFile(event)
  return file === null ? undefined : checkEdit(ctx, resolve(dir, file))
}

/**
 * Refuse an edit of a file of this repository outside the member's roles (E1).
 * @param {CommandContext} ctx
 * @param {string} file An absolute path.
 * @returns {Promise<CommandResult | void>}
 */
async function checkEdit(ctx, file) {
  const located = await locateFile(ctx.git, file)
  if (located === null || (await isIgnored(ctx.git, located))) return
  const branch = located.worktree.branch
  if (branch !== null && parseBranch(branch).kind === 'spike') return

  const config = await loadHookConfig(ctx)
  const identity = await hookIdentity(ctx, config)
  const { violations } = scopeCheck(config, { login: identity.login, files: [located.path] })
  if (violations.length === 0) return
  const ask = identity.isLead
    ? 'write a task for the role that owns it'
    : 'stop and ask the Lead, who writes a task for it'
  return denyToolCall(
    new BlockedError(
      `this edit changes a file outside the roles of ${identity.login} (${identity.roles.join(', ') || 'none'})`,
      {
        rule: "E1: edits stay inside the author's ownership scope",
        objects: violations.map(
          ({ path, role, holder }) => `${path}: role ${role}, held by ${holder ?? 'nobody'}`,
        ),
        resolve: `leave the file unchanged; when the change is needed, ${ask}`,
      },
    ),
  )
}

/**
 * Refuse a command line that merges a pull request (E3) or pushes to the default branch (E2).
 * @param {CommandContext} ctx
 * @param {string} line
 * @param {string} dir The directory the command line starts in.
 * @returns {Promise<CommandResult | void>}
 */
async function checkCommand(ctx, line, dir) {
  /** @type {Array<{ push: Push, words: string[], dir: string }>} */
  const pushes = []
  let at = dir
  for (const words of commandsOf(line)) {
    if (isMerge(words)) {
      const main = await mainCheckout(ctx.git)
      return denyToolCall(
        new BlockedError(
          'merging a pull request from an agent session is blocked: only the Gate merges, one pull request at a time, after testing it with the newest main',
          {
            rule: 'E3: no agent session merges; only the Gate does',
            objects: [words.join(' ')],
            resolve: `leave the merge to the Gate, which the Lead runs with \`hackwin gate\` in ${main}; stop and report the pull request number and the full head SHA`,
          },
        ),
      )
    }
    if (words[0] === 'cd' && words[1] !== undefined && words[1] !== '-') {
      at = resolve(at, words[1].replace(/^~(?=$|\/)/, ctx.env.HOME ?? '~'))
      continue
    }
    const push = pushOf(words)
    if (push !== null) {
      pushes.push({ push, words, dir: push.dirs.reduce((d, c) => resolve(d, c), at) })
    }
  }
  if (pushes.length === 0) return

  const config = await loadHookConfig(ctx)
  const defaultBranch = config.hackwin.project.default_branch
  for (const { push, words, dir: pushDir } of pushes) {
    const current = await currentBranchAt(ctx, pushDir)
    const targets = push.refspecs
      .map(destinationOf)
      .map((branch) => (branch === 'HEAD' || branch === '@' ? current : branch))
    // Without a refspec git pushes the current branch.
    const toDefault =
      push.all ||
      (targets.length === 0 ? current === defaultBranch : targets.includes(defaultBranch))
    if (!toDefault) continue
    const task = current !== null && parseBranch(current).kind === 'task'
    return denyToolCall(
      new BlockedError(
        `a push to ${defaultBranch} is blocked: ${defaultBranch} changes only through the Gate's merges of pull requests`,
        {
          rule: `E2: no direct push to ${defaultBranch}`,
          objects: [`${words.join(' ')} in ${pushDir}`],
          resolve: task
            ? { command: 'hackwin ship', dir: await topLevelAt(ctx, pushDir) }
            : { command: 'hackwin take', dir: await mainCheckout(ctx.git) },
        },
      ),
    )
  }
}

/**
 * The branch checked out in a directory, or null when it is detached or not in a checkout.
 * @param {CommandContext} ctx
 * @param {string} dir
 * @returns {Promise<string | null>}
 */
async function currentBranchAt(ctx, dir) {
  try {
    return await ctx.git.with({ cwd: dir }).currentBranch()
  } catch {
    return null
  }
}

/**
 * @param {CommandContext} ctx
 * @param {string} dir A directory inside a checkout.
 * @returns {Promise<string>}
 */
async function topLevelAt(ctx, dir) {
  try {
    return await ctx.git.with({ cwd: dir }).topLevel()
  } catch {
    return dir
  }
}

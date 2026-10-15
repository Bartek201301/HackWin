// `hackwin internal hook pre-tool-use` (10.4): before a tool call of a Claude Code session, the
// hook refuses
//
// - an edit of a file outside the session's role scope: the roles that the member running the
//   session holds in hackwin.yml on main, the same check as at commit (E1, A15), never the role
//   of a task. Files on `spike/` branches are exempt, as at commit (10.3);
// - `gh pr merge` and a merge through `gh api`, in every session, the Lead's included: for the
//   Lead's own sessions this and the deny rule are the only block against a merge outside the
//   queue (E3, D2, 10.6);
// - any push to the default branch (E2, E18), also a `git push` without a refspec whose upstream,
//   `push.default` or `remote.<name>.push` leads to it, and a `gh api` call that updates it
//   without a pull request.
//
// It reads commands as shell.js describes, which names what it does not see. It refuses with the
// decision `deny` (event.js). It stays offline: the configuration comes from the local
// origin/main, and only a call that needs it loads it, which applies CM12 as the git hooks do
// (config.js). A merge is refused without it.

import { resolve } from 'node:path'
import { BlockedError } from '../../core/runtime/errors.js'
import { scopeCheck } from '../../core/config/index.js'
import { parseBranch } from '../../core/tasks/index.js'
import { mainCheckout } from '../../core/worktrees/index.js'
import { hookIdentity, loadHookConfig } from './config.js'
import { denyToolCall, editedFile, eventDir, readHookEvent } from './event.js'
import { isIgnored, locateFile } from './files.js'
import { branchUpdateOf, commandsOf, destinationOf, isMerge, pushOf } from './shell.js'

/** @import { CommandContext, CommandResult } from '../../cli/context.js' */
/** @import { BranchUpdate, Push } from './shell.js' */

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
 * Refuse a command line that merges a pull request (E3) or changes the default branch without
 * one: a push to it, or a `gh api` call that updates it (E2).
 * @param {CommandContext} ctx
 * @param {string} line
 * @param {string} dir The directory the command line starts in.
 * @returns {Promise<CommandResult | void>}
 */
async function checkCommand(ctx, line, dir) {
  /** @type {Array<{ push: Push, words: string[], dir: string }>} */
  const pushes = []
  /** @type {Array<{ update: BranchUpdate, words: string[], dir: string }>} */
  const updates = []
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
    const update = branchUpdateOf(words)
    if (update !== null) {
      updates.push({ update, words, dir: at })
      continue
    }
    const push = pushOf(words)
    if (push !== null) {
      pushes.push({ push, words, dir: push.dirs.reduce((d, c) => resolve(d, c), at) })
    }
  }
  if (pushes.length === 0 && updates.length === 0) return

  const config = await loadHookConfig(ctx)
  const defaultBranch = config.hackwin.project.default_branch
  /** @type {Array<{ object: string, dir: string }>} */
  const changes = []
  for (const { update, words, dir: updateDir } of updates) {
    if (update.branch !== null && update.branch !== defaultBranch) continue
    const what =
      update.branch === null
        ? `${update.via} can update any branch, ${defaultBranch} included`
        : `${update.via} updates ${defaultBranch}`
    changes.push({ object: `${words.join(' ')}: ${what}`, dir: updateDir })
  }
  for (const { push, words, dir: pushDir } of pushes) {
    if ((await pushTargets(ctx, push, pushDir, defaultBranch)).includes(defaultBranch)) {
      changes.push({ object: `${words.join(' ')} in ${pushDir}`, dir: pushDir })
    }
  }
  if (changes.length === 0) return
  const first = changes[0].dir
  const current = await currentBranchAt(ctx, first)
  return denyToolCall(
    new BlockedError(
      `a change of ${defaultBranch} without a pull request is blocked: ${defaultBranch} changes only through the Gate's merges of pull requests`,
      {
        rule: `E2: no direct push to ${defaultBranch}`,
        objects: changes.map(({ object }) => object),
        resolve:
          current !== null && parseBranch(current).kind === 'task'
            ? { command: 'hackwin ship', dir: await topLevelAt(ctx, first) }
            : { command: 'hackwin take', dir: await mainCheckout(ctx.git) },
      },
    ),
  )
}

/**
 * The branches of the remote that a push updates. Without a refspec git decides from its
 * configuration (git-push(1)): the push refspecs of the remote, else `push.default` with the
 * current branch and its upstream. Settings of `git -c` win. The upstream counts also where
 * `simple` would refuse a push to it, which then fails anyway.
 * @param {CommandContext} ctx
 * @param {Push} push
 * @param {string} dir
 * @param {string} defaultBranch
 * @returns {Promise<string[]>}
 */
async function pushTargets(ctx, push, dir, defaultBranch) {
  if (push.all) return [defaultBranch]
  const current = await currentBranchAt(ctx, dir)
  if (push.refspecs.length > 0) {
    return push.refspecs
      .map(destinationOf)
      .flatMap((branch) => (branch === 'HEAD' || branch === '@' ? (current ?? []) : [branch]))
  }
  /** @param {string} key */
  const setting = async (key) =>
    push.config.get(key.toLowerCase()) ?? (await configAt(ctx, dir, key))[0] ?? null
  const remote =
    push.remote ??
    (current === null ? null : await setting(`branch.${current}.pushRemote`)) ??
    (await setting('remote.pushDefault')) ??
    (current === null ? null : await setting(`branch.${current}.remote`)) ??
    'origin'
  const pushSpecs = push.config.has(`remote.${remote}.push`.toLowerCase())
    ? [/** @type {string} */ (push.config.get(`remote.${remote}.push`.toLowerCase()))]
    : await configAt(ctx, dir, `remote.${remote}.push`)
  if (pushSpecs.length > 0) {
    return pushSpecs.map(destinationOf).flatMap((branch) => {
      if (branch === 'HEAD' || branch === '@') return current ?? []
      if (!branch.includes('*')) return [branch]
      const glob = new RegExp(`^${branch.split('*').map(escapeRegExp).join('.*')}$`)
      return glob.test(defaultBranch) ? [defaultBranch] : []
    })
  }
  const mode = (await setting('push.default')) ?? 'simple'
  if (mode === 'nothing') return []
  if (mode === 'matching') return [defaultBranch]
  const upstream = current === null ? null : await setting(`branch.${current}.merge`)
  return [current, upstream?.replace(/^refs\/heads\//, '')].filter((branch) => branch != null)
}

/**
 * Every value of a git setting as the checkout of a directory sees it; empty when it is unset or
 * the directory is not in a checkout.
 * @param {CommandContext} ctx
 * @param {string} dir
 * @param {string} key
 * @returns {Promise<string[]>}
 */
async function configAt(ctx, dir, key) {
  try {
    const result = await ctx.git
      .with({ cwd: dir })
      .run(['config', '--get-all', key], { allowFailure: true })
    return result.code === 0 ? result.stdout.split('\n').filter((value) => value !== '') : []
  } catch {
    return []
  }
}

/**
 * @param {string} text
 * @returns {string}
 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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

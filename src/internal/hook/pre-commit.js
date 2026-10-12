// `hackwin internal hook pre-commit` (10.3): on the default branch every commit is blocked (E18).
// On a `task/` branch the staged changes must stay inside the roles that the committing member
// holds in hackwin.yml on main (E1), and on `task/` and `spike/` branches they may add no env
// file and no secret (E6). Any other branch and a detached HEAD are not member work: the hook
// leaves them alone.

import { BlockedError } from '../../core/runtime/errors.js'
import { quoteShellArg } from '../../core/runtime/exec.js'
import { scopeCheck } from '../../core/config/index.js'
import { scanDiff, formatFinding } from '../../core/secrets/index.js'
import { parseBranch } from '../../core/tasks/index.js'
import { mainCheckout } from '../../core/worktrees/index.js'
import { hookIdentity, loadHookConfig } from './config.js'
import { announceSelfTest } from './self-test.js'

/** @import { CommandContext, CommandResult } from '../../cli/context.js' */
/** @import { DiffRange, Git } from '../../core/git/index.js' */

/**
 * @param {CommandContext} ctx
 * @returns {Promise<CommandResult | void>}
 */
export async function run(ctx) {
  announceSelfTest(ctx)
  const config = await loadHookConfig(ctx)
  const defaultBranch = config.hackwin.project.default_branch
  const branch = await ctx.git.currentBranch()
  if (branch === defaultBranch) {
    throw new BlockedError(
      `commits on ${defaultBranch} are blocked: every change reaches ${defaultBranch} through a task branch, its pull request and the Gate`,
      {
        rule: `E18: no fix is committed directly on ${defaultBranch}`,
        objects: [`branch ${defaultBranch} in ${ctx.repoRoot}`],
        resolve: { command: 'hackwin take', dir: await mainCheckout(ctx.git) },
      },
    )
  }
  const kind = branch === null ? 'other' : parseBranch(branch).kind
  if (kind === 'other') return

  const range = await stagedRange(ctx.git)
  if (kind === 'task') {
    const identity = await hookIdentity(ctx, config)
    const files = (await ctx.git.changedFiles(range)).flatMap((file) =>
      file.oldPath === null ? [file.path] : [file.oldPath, file.path],
    )
    const { violations } = scopeCheck(config, { login: identity.login, files })
    if (violations.length > 0) {
      throw new BlockedError(
        `this commit changes files outside the roles of ${identity.login} (${identity.roles.join(', ') || 'none'}); unstage them and ask the holder of each role for the change`,
        {
          rule: "E1: edits stay inside the author's ownership scope",
          objects: violations.map(
            ({ path, role, holder }) => `${path}: role ${role}, held by ${holder ?? 'nobody'}`,
          ),
          resolve: unstage(
            violations.map(({ path }) => path),
            ctx.repoRoot,
          ),
        },
      )
    }
  }

  const findings = await scanDiff(ctx.git, range, {
    extraPatterns: config.hackwin.gate.secret_patterns,
  })
  if (findings.length > 0) {
    throw new BlockedError(
      'this commit adds an env file or a line that matches a secret pattern; remove the secret from the files, keep env files out of git, and stage the files again',
      {
        rule: 'E6: no env file other than .env.example and no secret is committed',
        objects: findings.map(formatFinding),
        resolve: unstage(
          findings.map(({ path }) => path),
          ctx.repoRoot,
        ),
      },
    )
  }
}

/**
 * The staged changes of the commit. While a merge is in progress they are compared with the
 * merged commit, so that the files that arrive with it never count as the member's own (10.2).
 * @param {Git} git
 * @returns {Promise<DiffRange>}
 */
async function stagedRange(git) {
  const merging = await git.tryRevParse('MERGE_HEAD')
  return merging === null ? { staged: true } : { base: merging, staged: true }
}

/**
 * @param {string[]} paths
 * @param {string} dir
 * @returns {{ command: string, dir: string }}
 */
function unstage(paths, dir) {
  const quoted = [...new Set(paths)].map(quoteShellArg).join(' ')
  return { command: `git restore --staged -- ${quoted}`, dir }
}

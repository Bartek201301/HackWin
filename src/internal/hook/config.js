// What every hook loads for itself (contracts section 3.6): the configuration from the local
// origin/main without a fetch, because a hook must stay offline (10.4), and the member from the
// login that `join` recorded (5.1, A4).
//
// CM12 in a hook: the running version is compared with `cli_version` on the local origin/main,
// the last state this clone fetched. An older CLI, or one of another phase, exits 2 with the
// install command of the pinned version, which blocks the commit or the push, as every command
// does; a newer bug fix release of the same phase prints the one-line warning and continues.

import { enforceVersion } from '../../cli/main.js'
import { ConfigError, PreconditionError } from '../../core/runtime/errors.js'
import { loadConfig, resolveIdentity } from '../../core/config/index.js'
import { HACKWIN_FILE, pinnedVersionOf } from '../../core/config/load.js'
import { readLocal } from '../../core/state/index.js'
import { mainCheckout } from '../../core/worktrees/index.js'

/** @import { CommandContext } from '../../cli/context.js' */
/** @import { Config, Identity } from '../../core/config/index.js' */
/** @import { Git } from '../../core/git/index.js' */

/**
 * hackwin.yml and owners.yml from the local origin/main, validated, after the version check.
 * When the configuration is invalid, the version is checked first from the raw file, so that a
 * CLI of another phase names the version to install instead of the keys it does not know.
 * @param {CommandContext} ctx
 * @returns {Promise<Config>}
 */
export async function loadHookConfig(ctx) {
  const ref = await mainRef(ctx.git)
  /** @type {Config} */
  let config
  try {
    config = await loadConfig(ctx.git, { ref, fetch: false })
  } catch (error) {
    if (error instanceof ConfigError) {
      const text = await ctx.git.showFile(ref, HACKWIN_FILE).catch(() => null)
      const pinned = text === null ? null : pinnedVersionOf(text)
      if (pinned !== null) enforceVersion({ running: ctx.version, pinned, out: null })
    }
    throw error
  }
  enforceVersion({ running: ctx.version, pinned: config.hackwin.cli_version, out: ctx.out })
  return config
}

/**
 * The member who commits or pushes: the login that `join` recorded in local.yml, matched to the
 * team on origin/main. A clone without that record is a PreconditionError that names `join`; a
 * login outside the team is one that tells the member to ask the Lead.
 * @param {CommandContext} ctx
 * @param {Config} config
 * @returns {Promise<Identity>}
 */
export async function hookIdentity(ctx, config) {
  const record = await readLocal(ctx.gitCommonDir)
  if (record === null) {
    throw new PreconditionError(
      'join has not run on this machine: the git hooks identify the member by the login that join records',
      { resolve: { command: 'hackwin join', dir: await mainCheckout(ctx.git) } },
    )
  }
  return resolveIdentity(config, record.login)
}

/**
 * The remote-tracking ref of the default branch: what origin/HEAD points to, or origin/main.
 * The same lookup as the runner's, which does not export it.
 * @param {Git} git
 * @returns {Promise<string>}
 */
async function mainRef(git) {
  const result = await git.run(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], {
    allowFailure: true,
  })
  const ref = result.stdout.trim()
  return result.code === 0 && ref.startsWith('origin/') ? ref : 'origin/main'
}

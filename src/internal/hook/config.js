// What every hook loads for itself (contracts section 3.6): the configuration from the local
// origin/main without a fetch, because a hook must stay offline (10.4), and the member from the
// login that `join` recorded (5.1, A4).
//
// CM12 in a hook: the running version is compared with `cli_version` on the local origin/main,
// the last state this clone fetched. An older CLI, or one of another phase, exits 2 with the
// install command of the pinned version, which blocks the commit or the push, as every command
// does; a newer bug fix release of the same phase prints the one-line warning and continues.
// The runner's loader, loadCheckedConfig of src/core/config, does all of this without its fetch.

import { REPOSITORY_URL } from '../../cli/context.js'
import { PreconditionError } from '../../core/runtime/errors.js'
import { loadCheckedConfig, resolveIdentity } from '../../core/config/index.js'
import { readLocal } from '../../core/state/index.js'
import { mainCheckout } from '../../core/worktrees/index.js'

/** @import { CommandContext } from '../../cli/context.js' */
/** @import { Config, Identity } from '../../core/config/index.js' */

/**
 * hackwin.yml and owners.yml from the local origin/main, validated, after the version check.
 * When the configuration is invalid, the version is checked first from the raw file, so that a
 * CLI of another phase names the version to install instead of the keys it does not know.
 * @param {CommandContext} ctx
 * @returns {Promise<Config>}
 */
export function loadHookConfig(ctx) {
  return loadCheckedConfig(ctx.git, {
    fetch: false,
    running: ctx.version,
    repositoryUrl: REPOSITORY_URL,
    out: ctx.out,
  })
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

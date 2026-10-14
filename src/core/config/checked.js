// The configuration as the runner and the hooks load it: from the remote-tracking ref of the
// default branch, after the version check of CM12. The runner fetches first (CM9); a hook reads
// the local ref without a fetch, because it must stay offline (10.4).

import { ConfigError, PreconditionError } from '../runtime/errors.js'
import { HACKWIN_FILE, loadConfig, pinnedVersionOf } from './load.js'
import { checkVersion, installCommand, phaseOf } from './version.js'

/** @import { Git } from '../git/index.js' */
/** @import { Output } from '../runtime/output.js' */
/** @import { Config } from './load.js' */
/** @import { VersionStatus } from './version.js' */

/**
 * The remote-tracking ref of the default branch: what `origin/HEAD` points to, or `origin/main`.
 * @param {Git} git
 * @returns {Promise<string>}
 */
export async function mainRef(git) {
  const result = await git.run(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], {
    allowFailure: true,
  })
  const ref = result.stdout.trim()
  return result.code === 0 && ref.startsWith('origin/') ? ref : 'origin/main'
}

/**
 * The version check as every command applies it (CM12): an older CLI, or one of another phase,
 * is a PreconditionError (exit 2) that prints the install command of the pinned version; a
 * newer release of the same phase prints a one-line warning and continues (20.6).
 * @param {object} versions
 * @param {string} versions.running
 * @param {string} versions.pinned `cli_version` of hackwin.yml on origin/main.
 * @param {string} versions.repositoryUrl `repository.url` of package.json.
 * @param {Output | null} versions.out Receives the warning; null prints none.
 * @returns {VersionStatus}
 */
export function enforceVersion({ running, pinned, repositoryUrl, out }) {
  const { status } = checkVersion({ running, pinned })
  if (status === 'older' || status === 'other-phase') {
    const message =
      status === 'older'
        ? `hackwin ${running} is older than ${pinned}, the version pinned in hackwin.yml on origin/main`
        : `hackwin ${running} is a release of phase ${phaseOf(running)}, but this project is on phase ${phaseOf(pinned)}: hackwin.yml on origin/main pins ${pinned}`
    throw new PreconditionError(message, {
      resolve: { command: installCommand(pinned, repositoryUrl), dir: 'any directory' },
    })
  }
  if (status === 'newer-patch') {
    out?.warn(
      `hackwin ${running} is newer than ${pinned}, the version pinned in hackwin.yml; continuing`,
    )
  }
  return status
}

/**
 * Load the configuration and check the version. When the configuration is invalid, the version
 * is checked first from the raw file, so that a CLI of another phase says which version to
 * install instead of failing on keys it does not know.
 * @param {Git} git
 * @param {object} options
 * @param {string} [options.ref] The ref to read; `mainRef(git)` by default.
 * @param {boolean} [options.fetch] Fetch origin first (CM9); true by default, false in a hook.
 * @param {string} options.running The version of the running CLI.
 * @param {string} options.repositoryUrl `repository.url` of package.json, for the install command.
 * @param {Output | null} options.out Receives the warning of a newer release; null prints none.
 * @returns {Promise<Config>} The errors of loadConfig, and the PreconditionError of
 *   enforceVersion.
 */
export async function loadCheckedConfig(git, { ref, fetch = true, running, repositoryUrl, out }) {
  const source = ref ?? (await mainRef(git))
  /** @type {Config} */
  let config
  try {
    config = await loadConfig(git, { ref: source, fetch })
  } catch (error) {
    if (error instanceof ConfigError) {
      const text = await git.showFile(source, HACKWIN_FILE).catch(() => null)
      const pinned = text === null ? null : pinnedVersionOf(text)
      if (pinned !== null) enforceVersion({ running, pinned, repositoryUrl, out: null })
    }
    throw error
  }
  enforceVersion({ running, pinned: config.hackwin.cli_version, repositoryUrl, out })
  return config
}

// Loading the configuration. Commands, hooks, CI and the Gate read hackwin.yml and owners.yml
// from origin/main after a fetch, never from the branch under test (CM9, A17). A branch's own
// copy is read only to validate it: in CI for a pull request that changes one of the two files
// (10.2 step 1), and by `setup --regenerate`.

import { parse as parseYamlText } from 'yaml'
import semver from 'semver'
import { PreconditionError } from '../runtime/errors.js'
import { configError } from './fields.js'
import { parseHackwinConfig } from './hackwin.js'
import { parseOwners } from './owners.js'
import { validateConfig } from './validate.js'
import { phaseOf } from './version.js'

/** @import { Git } from '../git/index.js' */
/** @import { HackwinConfig } from './hackwin.js' */
/** @import { Owners } from './owners.js' */

/** The files of the configuration, at the repository root (A6). */
export const HACKWIN_FILE = 'hackwin.yml'
export const OWNERS_FILE = 'owners.yml'

/**
 * @typedef {object} Config
 * @property {HackwinConfig} hackwin
 * @property {Owners} owners
 * @property {string} ref The ref both files were read from, for example `origin/main`.
 * @property {string} sha The full commit SHA of that ref.
 */

/**
 * Fetch origin and read, parse and validate hackwin.yml and owners.yml from `ref` (CM9, A17).
 * @param {Git} git
 * @param {{ ref?: string, fetch?: boolean }} [options]
 * @returns {Promise<Config>} RemoteError when the fetch fails; PreconditionError when hackwin.yml
 *   is missing on the ref; ConfigError naming the key for every broken rule.
 */
export async function loadConfig(git, { ref = 'origin/main', fetch = true } = {}) {
  if (fetch) {
    if ((await git.remoteUrl('origin')) === null) {
      throw new PreconditionError('this clone has no remote origin', {
        resolve: 'run hackwin in a clone of the team repository',
      })
    }
    await git.fetch({ remote: 'origin' })
  }
  const sha = await git.tryRevParse(ref)
  const hackwinText = sha === null ? null : await git.showFile(sha, HACKWIN_FILE)
  if (sha === null || hackwinText === null) {
    throw new PreconditionError(`not configured: ${HACKWIN_FILE} is missing on ${ref}`, {
      resolve: { command: 'hackwin setup', dir: await mainCheckoutPath(git) },
    })
  }
  return readConfig(git, { ref, sha, hackwinText })
}

/**
 * Read, parse and validate a branch's own copy of the configuration, as CI does for a pull
 * request that changes hackwin.yml or owners.yml (10.2 step 1) and `setup --regenerate` before it
 * commits. Does not fetch. A `cli_version` of another phase than on `base` is a ConfigError on
 * `cli_version` [D10]; without hackwin.yml on `base` that comparison is skipped.
 * @param {Git} git
 * @param {{ ref?: string, base?: string }} [options] `ref` is HEAD by default, `base` origin/main.
 * @returns {Promise<Config>}
 */
export async function loadProposedConfig(git, { ref = 'HEAD', base = 'origin/main' } = {}) {
  const sha = await git.revParse(ref)
  const hackwinText = await git.showFile(sha, HACKWIN_FILE)
  if (hackwinText === null) {
    throw configError(
      HACKWIN_FILE,
      undefined,
      `is missing on ${ref}; a configured project keeps it`,
    )
  }
  const config = await readConfig(git, { ref, sha, hackwinText })
  const baseSha = await git.tryRevParse(base)
  const baseText = baseSha === null ? null : await git.showFile(baseSha, HACKWIN_FILE)
  const basePinned = baseText === null ? null : pinnedVersionOf(baseText)
  if (basePinned !== null && phaseOf(basePinned) !== phaseOf(config.hackwin.cli_version)) {
    throw configError(
      HACKWIN_FILE,
      'cli_version',
      `(${config.hackwin.cli_version}) is of phase ${phaseOf(config.hackwin.cli_version)}, but ${base} pins ${basePinned} of phase ${phaseOf(basePinned)}; a project stays on the phase it started with [D10]`,
    )
  }
  return config
}

/**
 * `cli_version` of a hackwin.yml text read leniently, or null when it has no valid one. Lets the
 * runner say "install the pinned version" before it complains about keys that this CLI does not
 * know, which a project of another phase may have.
 * @param {string} text
 * @returns {string | null}
 */
export function pinnedVersionOf(text) {
  try {
    const value = parseYamlText(text)?.cli_version
    return typeof value === 'string' && semver.valid(value) !== null ? value : null
  } catch {
    return null
  }
}

/**
 * @param {Git} git
 * @param {{ ref: string, sha: string, hackwinText: string }} source
 * @returns {Promise<Config>}
 */
async function readConfig(git, { ref, sha, hackwinText }) {
  const hackwin = parseHackwinConfig(hackwinText)
  const ownersText = await git.showFile(sha, OWNERS_FILE)
  if (ownersText === null) {
    throw configError(OWNERS_FILE, undefined, `is missing on ${ref}; hackwin.yml needs it`)
  }
  const owners = parseOwners(ownersText)
  validateConfig(hackwin, owners)
  return { hackwin, owners, ref, sha }
}

/**
 * The main checkout of the clone, where `setup` runs; the current directory in a bare clone.
 * @param {Git} git
 * @returns {Promise<string>}
 */
async function mainCheckoutPath(git) {
  const [main] = await git.worktreeList()
  return main && !main.bare ? main.path : git.cwd
}

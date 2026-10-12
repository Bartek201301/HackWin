// The CLI version rule (CM12, A60): the major and minor numbers name the phase; older and newer
// follow semver precedence, pre-release identifiers included (docs/build/contracts.md 6.2).

import semver from 'semver'
import { parseGitHubRemote } from '../github/index.js'

/** The npm package and the prefix of its pre-release assets (contracts 6.3). */
const PACKAGE_NAME = 'hackwin'

/**
 * @typedef {'same' | 'newer-patch' | 'older' | 'other-phase'} VersionStatus
 */

/**
 * Compare the running CLI with the version pinned in hackwin.yml.
 * - `other-phase`: the major or minor number differs;
 * - `older`: same phase, lower precedence, for example 0.1.0-pre.2 against 0.1.1-pre.2;
 * - `newer-patch`: same phase, higher precedence, a bug fix release not merged yet (20.6);
 * - `same`: equal precedence.
 * @param {{ running: string, pinned: string }} versions
 * @returns {{ status: VersionStatus }}
 */
export function checkVersion({ running, pinned }) {
  const ours = parseVersion(running, 'running')
  const theirs = parseVersion(pinned, 'pinned')
  if (ours.major !== theirs.major || ours.minor !== theirs.minor) return { status: 'other-phase' }
  const order = semver.compare(ours, theirs)
  if (order < 0) return { status: 'older' }
  return { status: order > 0 ? 'newer-patch' : 'same' }
}

/**
 * The phase of a version: its major and minor numbers, for example `0.1`.
 * @param {string} version
 * @returns {string}
 */
export function phaseOf(version) {
  const parsed = parseVersion(version, 'version')
  return `${parsed.major}.${parsed.minor}`
}

/**
 * The command that installs a version (contracts 6.3): `npm install -g hackwin@<version>`, or
 * for a pre-release the URL of its `.tgz` on the GitHub pre-release of the repository.
 * @param {string} version
 * @param {string} repositoryUrl `repository.url` of package.json, for example
 *   `git+https://github.com/Bartek201301/HackWin.git`.
 * @returns {string}
 */
export function installCommand(version, repositoryUrl) {
  const parsed = parseVersion(version, 'version')
  if (parsed.prerelease.length === 0) return `npm install -g ${PACKAGE_NAME}@${parsed.version}`
  const repo = parseGitHubRemote(repositoryUrl.replace(/^git\+/, ''))
  if (repo === null) {
    throw new TypeError(`cannot build a release URL from the repository URL ${repositoryUrl}`)
  }
  const base = repo.split('/').length === 3 ? `https://${repo}` : `https://github.com/${repo}`
  return `npm install -g ${base}/releases/download/v${parsed.version}/${PACKAGE_NAME}-${parsed.version}.tgz`
}

/**
 * @param {string} version
 * @param {string} what
 * @returns {semver.SemVer}
 */
function parseVersion(version, what) {
  const parsed = semver.parse(version)
  if (parsed === null) throw new TypeError(`the ${what} version "${version}" is not a version`)
  return parsed
}

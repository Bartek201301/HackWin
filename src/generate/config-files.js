// hackwin.yml (6.1) and owners.yml (6.2) as `setup` writes them. Both belong to the Lead from the
// bootstrap commit on and change only through a pull request, so they carry no generated-file
// header, only a comment that says where they come from. `setup --regenerate` changes only the
// value of `cli_version` in the Lead's hackwin.yml and keeps every other character (20.6).

import { isMap, isScalar, parseDocument, stringify } from 'yaml'
import { HACKWIN_FILE, OWNERS_FILE, pinnedVersionOf } from '../core/config/index.js'
import { ConfigError } from '../core/runtime/errors.js'

/** @import { HackwinConfig, Owners } from '../core/config/index.js' */

/** The width at which YAML strings are folded: never, so a command stays on one line. */
const YAML_OPTIONS = Object.freeze({ lineWidth: 0 })

/**
 * The text of hackwin.yml.
 * @param {HackwinConfig} hackwin
 * @returns {string}
 */
export function renderHackwinConfig(hackwin) {
  return [
    '# The HackWin configuration of this project (hackwin.yml).',
    '# Written by `hackwin setup`. The Lead changes it only through a pull request; hooks, CI and',
    '# the Gate always read it from the default branch on GitHub.',
    '',
    stringify(hackwin, YAML_OPTIONS),
  ].join('\n')
}

/**
 * The text of owners.yml.
 * @param {Owners} owners
 * @returns {string}
 */
export function renderOwners(owners) {
  return [
    '# Ownership map: path globs to ownership roles (owners.yml).',
    '#',
    '# - A path matches at most one role. Globs must not overlap.',
    '# - A path that matches no role and no open entry belongs to the shared role, so every file',
    '#   always has exactly one owner.',
    '# - The role flagged shared: true is held by the Lead. Who holds which role is written in',
    '#   hackwin.yml.',
    '# - Paths under open may be edited by every member.',
    '',
    stringify(owners, YAML_OPTIONS),
  ].join('\n')
}

/**
 * The text of hackwin.yml with `cli_version` set to a version: only the value changes, in the
 * quotes it had, so the Lead's comments, order and layout stay as they are.
 * @param {string} text The text of hackwin.yml.
 * @param {string} version
 * @returns {string}
 */
export function withCliVersion(text, version) {
  const doc = parseDocument(text)
  const pair =
    doc.errors.length === 0 && isMap(doc.contents)
      ? doc.contents.items.find((item) => isScalar(item.key) && item.key.value === 'cli_version')
      : undefined
  const node = pair?.value
  if (!isScalar(node) || !node.range || typeof node.value !== 'string') {
    throw versionError('must be a version written as one value')
  }
  const quoted =
    node.type === 'QUOTE_DOUBLE'
      ? JSON.stringify(version)
      : node.type === 'QUOTE_SINGLE'
        ? `'${version}'`
        : node.type === 'PLAIN'
          ? version
          : null
  const changed =
    quoted === null ? null : text.slice(0, node.range[0]) + quoted + text.slice(node.range[1])
  if (changed === null || pinnedVersionOf(changed) !== version) {
    throw versionError('must be a version written on one line')
  }
  return changed
}

/**
 * @param {string} reason
 * @returns {ConfigError}
 */
function versionError(reason) {
  return new ConfigError(`${HACKWIN_FILE}: cli_version ${reason}`, {
    key: 'cli_version',
    details: { file: HACKWIN_FILE },
  })
}

/** The paths of the two files, relative to the repository root. */
export const CONFIG_FILES = Object.freeze([HACKWIN_FILE, OWNERS_FILE])

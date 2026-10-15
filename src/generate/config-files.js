// hackwin.yml (6.1) and owners.yml (6.2) as `setup` writes them. Both belong to the Lead from the
// bootstrap commit on and change only through a pull request, so they carry no generated-file
// header, only a comment that says where they come from.

import { stringify } from 'yaml'
import { HACKWIN_FILE, OWNERS_FILE } from '../core/config/index.js'

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

/** The paths of the two files, relative to the repository root. */
export const CONFIG_FILES = Object.freeze([HACKWIN_FILE, OWNERS_FILE])

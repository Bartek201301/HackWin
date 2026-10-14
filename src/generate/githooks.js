// The git hook shims (6.4, 10.3): `.githooks/pre-commit` and `.githooks/pre-push`, each a single
// call to `hackwin internal hook <name>`, where all logic lives. `join` points core.hooksPath at
// `.githooks` (7.2 step 5), so every clone and worktree runs them with any agent or editor.

import { HOOKS_PATH } from '../core/worktrees/index.js'
import { generatedBy } from './header.js'

/** @import { GeneratedFileSpec, GenerateInput } from './manifest.js' */

/** The git hooks that HackWin installs. */
export const GIT_HOOKS = Object.freeze(/** @type {const} */ (['pre-commit', 'pre-push']))

/** @typedef {typeof GIT_HOOKS[number]} GitHook */

/**
 * The path of a shim, relative to the repository root.
 * @param {GitHook} hook
 * @returns {string}
 */
export function shimPath(hook) {
  return `${HOOKS_PATH}/${hook}`
}

/**
 * The shim of a git hook. `exec` hands the hook's stdin to the CLI; only `pre-push` gets
 * arguments from git, the remote name and its URL.
 * @param {GitHook} hook
 * @param {GenerateInput} input
 * @returns {string}
 */
export function renderShim(hook, { version }) {
  const args = hook === 'pre-push' ? ' "$@"' : ''
  return [
    '#!/bin/sh',
    `# ${generatedBy(version)}`,
    `exec hackwin internal hook ${hook}${args}`,
    '',
  ].join('\n')
}

/** The entries of the shims in the generated file manifest. */
export const SHIM_FILES = Object.freeze(
  GIT_HOOKS.map(
    (hook) =>
      /** @type {GeneratedFileSpec} */ ({
        path: shimPath(hook),
        mode: 0o755,
        render: (input) => renderShim(hook, input),
      }),
  ),
)

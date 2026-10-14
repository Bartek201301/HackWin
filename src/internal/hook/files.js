// Where a file that a Claude Code tool changes lies: in which checkout of this clone (the main
// checkout or a worktree), at which path relative to its top level, and whether git ignores it.
// The hooks check and format only files that can reach a commit of this repository; a file
// outside every checkout, inside `.git`, or ignored by git is left alone.

import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** @import { Git, Worktree } from '../../core/git/index.js' */

/**
 * @typedef {object} LocatedFile
 * @property {Worktree} worktree The checkout that holds the file.
 * @property {string} root Its top-level directory, with symbolic links resolved.
 * @property {string} path The file's path relative to `root`, with `/` as separator.
 */

/**
 * The checkout of this clone that holds a file. Symbolic links are resolved on both sides, also
 * for a file that does not exist yet. A nested checkout wins over the one around it.
 * @param {Git} git Git in any checkout of the clone.
 * @param {string} file An absolute path.
 * @returns {Promise<LocatedFile | null>} Null outside every checkout and inside `.git`.
 */
export async function locateFile(git, file) {
  const target = await realPathOf(file)
  /** @type {LocatedFile | null} */
  let found = null
  for (const worktree of await git.worktreeList()) {
    if (worktree.bare || worktree.prunable) continue
    const root = await realPathOf(worktree.path)
    const inside = relative(root, target)
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) continue
    if (found === null || root.length > found.root.length) {
      found = { worktree, root, path: inside.split(sep).join('/') }
    }
  }
  if (found === null || found.path === '.git' || found.path.startsWith('.git/')) return null
  return found
}

/**
 * True when git ignores the file in its checkout. A tracked file is never ignored.
 * @param {Git} git
 * @param {LocatedFile} file
 * @returns {Promise<boolean>}
 */
export async function isIgnored(git, { root, path }) {
  const result = await git
    .with({ cwd: root })
    .run(['check-ignore', '--quiet', '--', path], { allowFailure: true })
  return result.code === 0
}

/**
 * The path with every symbolic link resolved. For a path that does not exist, the links of its
 * longest existing parent are resolved and the rest is kept.
 * @param {string} path
 * @returns {Promise<string>}
 */
async function realPathOf(path) {
  /** @type {string[]} */
  const missing = []
  let current = resolve(path)
  for (;;) {
    try {
      return join(await realpath(current), ...missing)
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
    }
    const parent = dirname(current)
    if (parent === current) return resolve(path)
    missing.unshift(basename(current))
    current = parent
  }
}

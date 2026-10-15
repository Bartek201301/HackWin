// Symbolic links among the committed files of 6.4. HackWin never writes through a symlink it did
// not create: writing the file would change the link's target, another file or one outside the
// repository. A team's `CLAUDE.md` that links to `AGENTS.md` is common; it already gives Claude
// Code the rules of `AGENTS.md`, so it stays as it is.

import { lstat, readlink, realpath } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { PreconditionError } from '../core/runtime/errors.js'

/**
 * A symlink on the way to a path: the path itself or one of its directories.
 * @typedef {object} Link
 * @property {string} path The symlink, relative to the repository root.
 * @property {string} target What the symlink points to, as it is written.
 * @property {string | null} resolved The file it resolves to, relative to the repository root,
 *   or null when it resolves outside the repository or to nothing.
 */

/**
 * The first symlink on the way to a path: one of its directories from the root down, or the path
 * itself. Null when there is none.
 * @param {string} root The top-level directory of the checkout.
 * @param {string} path Relative to the root.
 * @returns {Promise<Link | null>}
 */
export async function linkOn(root, path) {
  const parts = path.split('/')
  for (let depth = 1; depth <= parts.length; depth += 1) {
    const part = parts.slice(0, depth).join('/')
    /** @type {import('node:fs').Stats} */
    let stats
    try {
      stats = await lstat(join(root, part))
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
      throw error
    }
    if (stats.isSymbolicLink()) {
      return {
        path: part,
        target: await readlink(join(root, part)),
        resolved: await resolvedIn(root, part),
      }
    }
  }
  return null
}

/**
 * The error for a path that would be written through a symlink.
 * @param {string} path
 * @param {Link} link
 * @returns {PreconditionError}
 */
export function linkError(path, link) {
  const through = link.path === path ? `${path} is` : `${path} lies under ${link.path}, which is`
  return new PreconditionError(
    `hackwin writes ${path}, but ${through} a symbolic link to ${link.target}; hackwin never writes through a link it did not create`,
    {
      resolve: `replace ${link.path} with a regular ${link.path === path ? 'file' : 'directory'} holding the same content, or remove it, and commit the change before you run hackwin again`,
    },
  )
}

/**
 * Refuse to write a path that has a symlink on its way, before anything is written.
 * @param {string} root
 * @param {readonly string[]} paths The paths that would be written, relative to the root.
 * @returns {Promise<void>}
 */
export async function refuseLinks(root, paths) {
  for (const path of paths) {
    const link = await linkOn(root, path)
    if (link !== null) throw linkError(path, link)
  }
}

/**
 * The file a symlink resolves to, relative to the repository root, or null.
 * @param {string} root
 * @param {string} path
 * @returns {Promise<string | null>}
 */
async function resolvedIn(root, path) {
  try {
    const realRoot = await realpath(root)
    const target = await realpath(join(root, path))
    const inside = relative(realRoot, target)
    if (inside === '' || inside.startsWith('..') || inside.startsWith(sep)) return null
    return inside.split(sep).join('/')
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ELOOP') return null
    throw error
  }
}

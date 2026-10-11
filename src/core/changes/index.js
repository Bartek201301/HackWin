// What changed on main since a recorded commit, the member's own scope first (E5, I6), for the
// prompt of `take` (7.7 step 6) and the SessionStart summary (10.4). See
// docs/build/contracts.md, section 4.10.

import picomatch from 'picomatch'

/** @import { Git } from '../git/index.js' */

/**
 * @typedef {object} ChangeOnMain
 * @property {string} path The path after the change.
 * @property {string} status One letter of `git diff --name-status`: A, C, D, M, R, T.
 * @property {string | null} oldPath The path before a rename or copy.
 * @property {boolean} own True when the path, or its path before a rename, lies in the member's
 *   own scope.
 */

/**
 * @typedef {object} ChangesOnMain
 * @property {string | null} from The full SHA of the recorded commit; null when none was
 *   recorded, or when the recorded commit is not in this clone.
 * @property {string} to The full SHA of `to`, the commit to record next.
 * @property {ChangeOnMain[]} files The member's own scope first, each group by path.
 */

/**
 * The files changed on main between a recorded commit and `to`. Without a recorded commit the
 * list is empty and `from` stays null: the first `take` in a clone says that no commit was
 * recorded.
 * @param {Git} git
 * @param {object} [options]
 * @param {string | null} [options.from] The main commit recorded for the worktree, or null.
 * @param {string} [options.to] `origin/main` by default.
 * @param {string[]} [options.ownPaths] The path globs of the member's roles.
 * @returns {Promise<ChangesOnMain>}
 */
export async function changesOnMain(git, { from = null, to = 'origin/main', ownPaths = [] } = {}) {
  const toSha = await git.revParse(to)
  const fromSha = from === null ? null : await git.tryRevParse(from)
  if (fromSha === null) return { from: null, to: toSha, files: [] }

  const isOwn = ownPaths.length === 0 ? () => false : picomatch(ownPaths, { dot: true })
  const files = (await git.changedFiles({ base: fromSha, head: toSha })).map((file) => ({
    path: file.path,
    status: file.status,
    oldPath: file.oldPath,
    own: isOwn(file.path) || (file.oldPath !== null && isOwn(file.oldPath)),
  }))
  return {
    from: fromSha,
    to: toSha,
    files: [...files.filter((file) => file.own), ...files.filter((file) => !file.own)],
  }
}

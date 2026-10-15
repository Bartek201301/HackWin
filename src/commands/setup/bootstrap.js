// Steps 8 and 9 of `setup` (7.1): every committed file of 6.4, written into the main checkout as
// 6.5 says, then the bootstrap commit on the default branch and its push, the only direct push to
// that branch in the life of the project (GO7, CM8). Git runs with the member hooks switched off,
// as the Gate runs it (10.3): the hooks of 1.4a refuse every commit on the default branch and every
// push to it. A failure before the push succeeds changes nothing on GitHub, and setup removes its
// own commit and files, so the working tree is as it was.

import { readFileSync } from 'node:fs'
import { chmod, mkdir, readFile, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { HACKWIN_FILE, OWNERS_FILE } from '../../core/config/index.js'
import {
  MANIFEST,
  PROJECT_FILES,
  SETTINGS_PATH,
  planProjectFiles,
  writeClaudeSettings,
  writeGeneratedFiles,
} from '../../generate/index.js'

/** @import { CommandContext } from '../../cli/context.js' */
/** @import { Git } from '../../core/git/index.js' */
/** @import { ProjectFileChange } from '../../generate/index.js' */

/**
 * What the bootstrap commit holds.
 * @typedef {object} BootstrapInput
 * @property {string} branch The default branch.
 * @property {string | null} head The branch's commit before setup; null on an empty repository.
 * @property {string} version The CLI version, named by the generated files.
 * @property {string} language `project.language`.
 * @property {string} hackwin The text of hackwin.yml.
 * @property {string | null} owners The text of owners.yml, or null to keep the existing file.
 */

/**
 * @typedef {object} Bootstrap
 * @property {string} commit The full SHA of the bootstrap commit.
 * @property {string[]} written The files setup created or changed.
 * @property {string[]} removed The files setup removed.
 * @property {string[]} kept The files of 6.4 that existed and stay as they were.
 * @property {string[]} notices
 */

/** Every path that steps 8 and 9 may write or remove, relative to the repository root. */
export const BOOTSTRAP_PATHS = Object.freeze([
  HACKWIN_FILE,
  OWNERS_FILE,
  ...MANIFEST.map((file) => file.path),
  SETTINGS_PATH,
  ...PROJECT_FILES.map((file) => file.path),
])

/**
 * Write the files, commit them and push the commit. On any failure before the push succeeded,
 * undo every change in the checkout and rethrow.
 * @param {CommandContext} ctx
 * @param {BootstrapInput} input
 * @returns {Promise<Bootstrap>}
 */
export async function bootstrap(ctx, input) {
  const root = ctx.repoRoot
  const git = ctx.git.with({ hooksOff: true })
  const plan = planProjectFiles((path) => readTextSync(join(root, path)), {
    defaultBranch: input.branch,
    language: input.language,
  })
  const journal = await Journal.remember(root, BOOTSTRAP_PATHS)
  /** @type {string | null} */
  let commit = null
  try {
    await writeFiles(root, input, plan)
    await git.run(['add', '--all', '--force', '--', ...(await journal.touchedPaths())])
    await git.run(['commit', '--quiet', '-m', commitMessage(input)])
    commit = await git.revParse('HEAD')
    await git.push({ refspecs: [`${commit}:refs/heads/${input.branch}`] })
  } catch (error) {
    if (commit !== null && (await landed(git, input.branch, commit))) {
      ctx.out.warn(`git reported a failed push, but origin/${input.branch} holds ${commit}`)
    } else {
      try {
        await rollback(git, journal, input.head)
      } catch (undoError) {
        ctx.out.warn(
          `setup could not undo its changes in ${root}: ${undoError.message}; check \`git status\` there`,
        )
      }
      throw error
    }
  }
  const changed = await changedFiles(git, input.head, commit)
  const removed = changed.filter((file) => file.status === 'D').map((file) => file.path)
  return {
    commit,
    written: changed.filter((file) => file.status !== 'D').map((file) => file.path),
    removed,
    kept: BOOTSTRAP_PATHS.filter(
      (path) => journal.existed(path) && !changed.some((file) => file.path === path),
    ),
    notices: plan.flatMap((change) => (change.notice ? [change.notice] : [])),
  }
}

/**
 * Step 8: hackwin.yml and owners.yml, the generated files, the Claude Code settings (6.5: only
 * HackWin's keys and list entries) and the files of the template.
 * @param {string} root
 * @param {BootstrapInput} input
 * @param {ProjectFileChange[]} plan
 */
async function writeFiles(root, input, plan) {
  await writeText(root, HACKWIN_FILE, input.hackwin)
  if (input.owners !== null) await writeText(root, OWNERS_FILE, input.owners)
  await writeGeneratedFiles(root, { version: input.version })
  await writeClaudeSettings(root, { defaultBranch: input.branch })
  for (const change of plan) {
    if (change.action === 'write') await writeText(root, change.path, change.content ?? '')
    else if (change.action === 'remove') await rm(join(root, change.path), { force: true })
  }
}

/**
 * @param {BootstrapInput} input
 * @returns {string}
 */
function commitMessage({ version, branch }) {
  return [
    `Bootstrap HackWin ${version}`,
    '',
    'Written by `hackwin setup`: hackwin.yml, owners.yml, the generated files and HackWin',
    `blocks in the team's files. The only direct push to ${branch} in the life of the project.`,
  ].join('\n')
}

/**
 * Whether origin's branch points at the commit, although the push reported a failure.
 * @param {Git} git
 * @param {string} branch
 * @param {string} commit
 * @returns {Promise<boolean>}
 */
async function landed(git, branch, commit) {
  const result = await git.run(['ls-remote', 'origin', `refs/heads/${branch}`], {
    allowFailure: true,
  })
  return result.code === 0 && result.stdout.split(/\s+/)[0] === commit
}

/**
 * The files the bootstrap commit changed.
 * @param {Git} git
 * @param {string | null} head The commit before; null for a root commit.
 * @param {string} commit
 * @returns {Promise<Array<{ status: string, path: string }>>}
 */
async function changedFiles(git, head, commit) {
  const args =
    head === null
      ? [
          'diff-tree',
          '--root',
          '--no-commit-id',
          '-r',
          '--no-renames',
          '--name-status',
          '-z',
          commit,
        ]
      : ['diff', '--no-renames', '--name-status', '-z', head, commit]
  const fields = (await git.run(args)).stdout.split('\0').filter(Boolean)
  /** @type {Array<{ status: string, path: string }>} */
  const files = []
  for (let index = 0; index + 1 < fields.length; index += 2) {
    files.push({ status: fields[index], path: fields[index + 1] })
  }
  return files
}

/**
 * Undo the bootstrap: the branch and the index back to the commit before setup, then every file
 * back to its content before setup.
 * @param {Git} git
 * @param {Journal} journal
 * @param {string | null} head
 */
async function rollback(git, journal, head) {
  if (head === null) {
    await git.run(['update-ref', '-d', 'HEAD'], { allowFailure: true })
    await git.run(['read-tree', '--empty'])
  } else {
    await git.run(['reset', '--quiet', head])
  }
  await journal.restore()
}

/**
 * The content and mode of a set of files before setup touched them, and the directories that
 * did not exist yet, so that every change can be undone.
 */
class Journal {
  /**
   * @param {string} root
   * @param {Map<string, { content: Buffer | null, mode: number }>} files
   * @param {string[]} missingDirs Relative, deepest first.
   */
  constructor(root, files, missingDirs) {
    this.root = root
    this.files = files
    this.missingDirs = missingDirs
  }

  /**
   * @param {string} root
   * @param {readonly string[]} paths
   * @returns {Promise<Journal>}
   */
  static async remember(root, paths) {
    /** @type {Map<string, { content: Buffer | null, mode: number }>} */
    const files = new Map()
    /** @type {Set<string>} */
    const missingDirs = new Set()
    for (const path of paths) {
      const file = join(root, path)
      try {
        files.set(path, { content: await readFile(file), mode: (await stat(file)).mode & 0o777 })
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        files.set(path, { content: null, mode: 0o644 })
      }
      for (let dir = dirname(path); dir !== '.'; dir = dirname(dir)) {
        if (!(await exists(join(root, dir)))) missingDirs.add(dir)
      }
    }
    const deepestFirst = [...missingDirs].sort((a, b) => b.split('/').length - a.split('/').length)
    return new Journal(root, files, deepestFirst)
  }

  /**
   * @param {string} path
   * @returns {boolean} True when the file existed before setup.
   */
  existed(path) {
    return this.files.get(path)?.content != null
  }

  /**
   * The paths that exist now or existed before, for `git add --all`, which stages a removal too.
   * @returns {Promise<string[]>}
   */
  async touchedPaths() {
    const paths = []
    for (const path of this.files.keys()) {
      if (this.existed(path) || (await exists(join(this.root, path)))) paths.push(path)
    }
    return paths
  }

  /** Put every file back as it was and remove the directories setup created. */
  async restore() {
    for (const [path, { content, mode }] of this.files) {
      const file = join(this.root, path)
      if (content === null) {
        await rm(file, { force: true })
        continue
      }
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, content)
      await chmod(file, mode)
    }
    for (const dir of this.missingDirs) {
      try {
        await rmdir(join(this.root, dir))
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error
      }
    }
  }
}

/**
 * @param {string} root
 * @param {string} path
 * @param {string} content
 */
async function writeText(root, path, content) {
  const file = join(root, path)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content)
}

/**
 * @param {string} file
 * @returns {string | null}
 */
function readTextSync(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

/**
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function exists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

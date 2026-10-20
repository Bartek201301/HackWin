// `hackwin setup --regenerate` (7.1, failure behavior): step 3 of the procedure of 20.6, in which
// the Lead installs a bug fix release of the same phase during a project. In the worktree of a
// task of the shared role it rewrites, with the running version, the generated files of the
// manifest, HackWin's own blocks in the kept files that exist, HackWin's keys and list entries of
// `.claude/settings.json` (6.5), and `cli_version` of hackwin.yml, and commits exactly these
// files on the task branch, so that the Lead ships it next.
//
// - It reads the configuration from the branch's own copy (A17). A CLI of another phase than
//   `cli_version` exits 2 [D10]: the runner refuses one of another phase than origin/main
//   (CM12), and loadProposedConfig a branch whose `cli_version` is of another phase than
//   origin/main, so the running CLI and the branch's `cli_version` are of one phase.
// - On the default branch, or anywhere else but a task worktree, it exits 2 and names the
//   procedure of 20.6.
// - It starts only on a clean working tree, so that its commit holds nothing but its own changes;
//   a failure after it began writing puts every file back as the branch has it.

import { readFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  HACKWIN_FILE,
  OWNERS_FILE,
  loadProposedConfig,
  parseHackwinConfig,
  parseOwners,
  validateConfig,
} from '../../core/config/index.js'
import { PreconditionError, runIn } from '../../core/runtime/index.js'
import { toTask } from '../../core/tasks/index.js'
import { currentTask, mainCheckout } from '../../core/worktrees/index.js'
import {
  MANIFEST,
  PROJECT_FILES,
  SETTINGS_PATH,
  linkOn,
  mergeClaudeSettings,
  planBlockFiles,
  refuseLinks,
  withCliVersion,
  writeClaudeSettings,
  writeGeneratedFiles,
} from '../../generate/index.js'

/** @import { CommandContext, CommandResult } from '../../cli/context.js' */
/** @import { Config, Identity } from '../../core/config/index.js' */
/** @import { Git } from '../../core/git/index.js' */
/** @import { TaskWorktree } from '../../core/worktrees/index.js' */
/** @import { Link, ProjectFileChange } from '../../generate/index.js' */

/** The procedure of 20.6, which a message names when `--regenerate` runs in the wrong place. */
const PROCEDURE =
  'a bug fix release of the same phase is installed in five steps (20.6): the Lead installs it; restarts the Gate (`quit`, then `hackwin gate`); writes a task of the shared role for the release, takes it, runs `hackwin setup --regenerate` in its worktree and ships it; CI and the Gate merge the pull request; then every member installs the release and runs `hackwin join` again'

/**
 * @param {CommandContext} ctx
 * @returns {Promise<CommandResult>}
 */
export async function regenerate(ctx) {
  const { config, identity } = ctx
  if (!config || !identity) {
    throw new PreconditionError(
      `setup --regenerate runs on a configured repository, and ${HACKWIN_FILE} is not on origin's default branch`,
      { resolve: runIn('hackwin setup', await mainCheckout(ctx.git)) },
    )
  }
  const worktree = await requirePlace(ctx, config)
  await requireSharedTask(ctx, { config, identity, worktree })
  await requireCleanTree(ctx.git, worktree)

  const proposed = await loadProposedConfig(ctx.git, { ref: 'HEAD', base: config.ref })
  const previous = proposed.hackwin.cli_version

  const root = ctx.repoRoot
  const read = (/** @type {string} */ path) => readTextSync(join(root, path))
  const defaultBranch = proposed.hackwin.project.default_branch
  const input = { defaultBranch, language: proposed.hackwin.project.language }
  const hackwin = withCliVersion(/** @type {string} */ (read(HACKWIN_FILE)), ctx.version)
  validateConfig(
    parseHackwinConfig(hackwin),
    parseOwners(/** @type {string} */ (read(OWNERS_FILE))),
  )
  /** @type {Map<string, Link | null>} */
  const links = new Map()
  for (const { path } of PROJECT_FILES) links.set(path, await linkOn(root, path))
  const blocks = planBlockFiles(read, input, (path) => links.get(path) ?? null)
  const settings = read(SETTINGS_PATH)
  const settingsChange = mergeClaudeSettings(settings, { defaultBranch }) !== settings
  const pinChange = hackwin !== read(HACKWIN_FILE)
  await refuseLinks(root, [
    ...MANIFEST.map((file) => file.path),
    ...(pinChange ? [HACKWIN_FILE] : []),
    ...(settingsChange ? [SETTINGS_PATH] : []),
  ])

  /** @type {string[]} */
  let changed = []
  try {
    await writeGeneratedFiles(root, { version: ctx.version })
    await writeClaudeSettings(root, { defaultBranch })
    await writeBlocks(root, blocks)
    if (pinChange) await writeText(root, HACKWIN_FILE, hackwin)
    changed = await changedPaths(ctx.git)
    if (changed.length === 0) {
      return {
        lines: [
          `${worktree.path} already holds the files of hackwin ${ctx.version}: nothing to regenerate or commit`,
        ],
        data: { version: ctx.version, previous, commit: null, changed: [] },
      }
    }
    await ctx.git.run(['add', '--', ...changed])
    await ctx.git.run(['commit', '--quiet', '-F', '-', '--', ...changed], {
      input: `${commitMessage(previous, ctx.version)}\n`,
    })
  } catch (error) {
    await undo(ctx, worktree, changed)
    throw error
  }
  const commit = await ctx.git.revParse('HEAD')
  return {
    lines: [
      `regenerated with hackwin ${ctx.version}: ${changed.length} ${changed.length === 1 ? 'file' : 'files'} committed as ${commit} on ${worktree.branch}, cli_version ${previous} -> ${ctx.version}`,
      `next: ${runIn('hackwin ship', worktree.path)}`,
    ],
    data: { version: ctx.version, previous, commit, changed },
  }
}

/**
 * The place (7.1): the worktree of a task, not the main checkout and not the default branch.
 * Anywhere else exits 2 and names the procedure of 20.6.
 * @param {CommandContext} ctx
 * @param {Config} config
 * @returns {Promise<TaskWorktree>}
 */
async function requirePlace(ctx, config) {
  const main = await mainCheckout(ctx.git)
  const task = await currentTask(ctx.git)
  if (task !== null && task.path !== main) return task
  const branch = await ctx.git.currentBranch()
  const defaultBranch = config.hackwin.project.default_branch
  const here =
    branch === defaultBranch
      ? `${ctx.repoRoot} is on the default branch ${defaultBranch}`
      : task !== null
        ? `${ctx.repoRoot} is the main checkout`
        : `${ctx.repoRoot} is on ${branch === null ? 'a detached HEAD' : `the branch ${branch}`}, not in a task worktree`
  throw new PreconditionError(
    `setup --regenerate runs only in the worktree of a task of the shared role, and ${here}; ${PROCEDURE}`,
    {
      resolve: `write a task of the shared role for the bug fix release; then ${runIn('hackwin take <N>', main)} with its number, and run \`hackwin setup --regenerate\` in the task worktree that take names`,
    },
  )
}

/**
 * The task of the worktree is a task of the shared role, and the caller holds that role: the
 * files it rewrites are the shared role's, and the Lead ships them.
 * @param {CommandContext} ctx
 * @param {{ config: Config, identity: Identity, worktree: TaskWorktree }} place
 */
async function requireSharedTask(ctx, { config, identity, worktree }) {
  const shared = Object.entries(config.owners.roles).find(([, role]) => role.shared)?.[0]
  const issue = await ctx.github.getIssue(worktree.issue)
  const task = issue === null || issue.isPullRequest ? null : toTask(issue, config)
  const main = await mainCheckout(ctx.git)
  const resolve = `run \`hackwin setup --regenerate\` in the worktree of a task of the shared role ${shared}; ${PROCEDURE}`
  if (task === null || task.block === null) {
    const why =
      task === null
        ? `issue #${worktree.issue} is not a task that a member of the team wrote`
        : `the task block of #${worktree.issue} is invalid: ${task.errors.join('; ')}`
    throw new PreconditionError(
      `setup --regenerate needs the task of ${worktree.branch}, and ${why}`,
      { resolve },
    )
  }
  if (task.block.role !== shared) {
    throw new PreconditionError(
      `setup --regenerate runs in a task of the shared role ${shared}, and #${worktree.issue} is a task of the role ${task.block.role}`,
      { resolve },
    )
  }
  if (!identity.roles.includes(/** @type {string} */ (shared))) {
    throw new PreconditionError(
      `setup --regenerate rewrites files of the shared role ${shared}, which ${identity.login} does not hold`,
      {
        resolve: `the holder of ${shared}, the Lead, runs it in ${worktree.path}; to stop working on #${worktree.issue}, ${runIn(`hackwin take ${worktree.issue} --release`, main)}`,
      },
    )
  }
}

/**
 * A clean working tree, so that the commit holds only what `--regenerate` wrote.
 * @param {Git} git
 * @param {TaskWorktree} worktree
 */
async function requireCleanTree(git, worktree) {
  const paths = await changedPaths(git)
  if (paths.length === 0) return
  const shown = paths.slice(0, 5).join(', ') + (paths.length > 5 ? ', ...' : '')
  throw new PreconditionError(
    `setup --regenerate commits only its own changes, and the working tree of ${worktree.path} has ${paths.length === 1 ? 'a change' : `${paths.length} changes`}: ${shown}`,
    {
      resolve: `commit these changes or remove them in ${worktree.path}, then ${runIn('hackwin setup --regenerate', worktree.path)}`,
      details: { paths },
    },
  )
}

/**
 * @param {string} root
 * @param {ProjectFileChange[]} blocks
 */
async function writeBlocks(root, blocks) {
  for (const change of blocks) {
    if (change.action === 'write') await writeText(root, change.path, change.content ?? '')
  }
}

/**
 * The paths that differ from HEAD in the working tree or the index, untracked files included.
 * @param {Git} git
 * @returns {Promise<string[]>}
 */
async function changedPaths(git) {
  const status = await git.run(['status', '--porcelain', '-z', '--untracked-files=all'])
  const fields = status.stdout.split('\0')
  /** @type {string[]} */
  const paths = []
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i]
    if (field === '') continue
    paths.push(field.slice(3))
    if (/[RC]/.test(field.slice(0, 2))) i += 1
  }
  return paths
}

/**
 * Put the files back as HEAD has them: a tracked file from HEAD, a new file removed. It never
 * throws: a failure, also of finding the changed files, is a warning, so that the error that
 * stopped `--regenerate` is the one the runner prints.
 * @param {Pick<CommandContext, 'git' | 'out'>} ctx
 * @param {Pick<TaskWorktree, 'path'>} worktree
 * @param {string[]} known The changed files, when known; otherwise read from `git status`.
 * @returns {Promise<void>}
 */
export async function undo(ctx, worktree, known) {
  try {
    const paths = known.length > 0 ? known : await changedPaths(ctx.git)
    if (paths.length === 0) return
    await ctx.git.run(['reset', '--quiet', '--', ...paths])
    const listed = await ctx.git.run(['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', ...paths])
    const tracked = new Set(listed.stdout.split('\0').filter(Boolean))
    if (tracked.size > 0) await ctx.git.run(['checkout', '--quiet', 'HEAD', '--', ...tracked])
    for (const path of paths) {
      if (!tracked.has(path)) await rm(join(worktree.path, path), { force: true })
    }
    ctx.out.warn(`setup --regenerate stopped and put back the files it wrote in ${worktree.path}`)
  } catch (error) {
    ctx.out.warn(
      `setup --regenerate could not put back its files in ${worktree.path}: ${error.message}; check \`git status\` there`,
    )
  }
}

/**
 * @param {string} previous
 * @param {string} version
 * @returns {string}
 */
function commitMessage(previous, version) {
  return [
    `Regenerate the HackWin files with hackwin ${version}`,
    '',
    'Written by `hackwin setup --regenerate` (20.6): the generated files, HackWin blocks in',
    `the team's files and .claude/settings.json, and cli_version ${previous} -> ${version}.`,
  ].join('\n')
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

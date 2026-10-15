// Steps 8 and 9 of `setup` (7.1): every committed file of 6.4, written into the main checkout as
// 6.5 says, then the bootstrap commit on the default branch and its push, the only direct push to
// that branch in the life of the project (GO7, CM8).
//
// - The commit holds exactly the files that setup writes or removes. It is built in an index of
//   its own from the branch's commit, so nothing else that is staged in the checkout enters it,
//   and a file the project ignores is refused before anything is written.
// - Git runs with the member hooks switched off, as the Gate runs it (10.3): the hooks of 1.4a
//   refuse every commit on the default branch and every push to it. So setup scans the commit for
//   secrets itself (E6) before it pushes; push protection does not exist yet at this point.
// - The push sends the commit alone, and the local branch moves only once origin holds it.
// - A failure or an interrupt (Ctrl+C) before the push succeeds puts every file back as it was and
//   changes nothing on GitHub; one after it lets setup finish the local branch first.

import { readFileSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { HACKWIN_FILE, OWNERS_FILE } from '../../core/config/index.js'
import {
  BlockedError,
  GitError,
  PreconditionError,
  RemoteError,
  runIn,
} from '../../core/runtime/index.js'
import { formatFinding, scanDiff } from '../../core/secrets/index.js'
import {
  MANIFEST,
  PROJECT_FILES,
  SETTINGS_PATH,
  TEMPLATE_CHECK_WORKFLOW_PATH,
  linkOn,
  mergeClaudeSettings,
  planProjectFiles,
  refuseLinks,
  writeClaudeSettings,
  writeGeneratedFiles,
} from '../../generate/index.js'

/** @import { CommandContext } from '../../cli/context.js' */
/** @import { Git } from '../../core/git/index.js' */
/** @import { Output } from '../../core/runtime/index.js' */
/** @import { Link, ProjectFileChange } from '../../generate/index.js' */

/**
 * What the bootstrap commit holds.
 * @typedef {object} BootstrapInput
 * @property {string} branch The default branch.
 * @property {string | null} head The branch's commit before setup; null on an empty repository.
 * @property {string} version The CLI version, named by the generated files.
 * @property {string} language `project.language`.
 * @property {string} hackwin The text of hackwin.yml.
 * @property {string | null} owners The text of owners.yml, or null to keep the existing file.
 * @property {string[]} secretPatterns `gate.secret_patterns`, added to the built-in patterns.
 */

/**
 * @typedef {object} Bootstrap
 * @property {string} commit The full SHA of the bootstrap commit.
 * @property {string[]} written The files setup created or changed.
 * @property {string[]} removed The files setup removed.
 * @property {string[]} kept The files of 6.4 that existed and stay as they were.
 * @property {string[]} notices
 */

/**
 * What the steps need besides the context; tests replace the signals.
 * @typedef {object} BootstrapOptions
 * @property {Pick<NodeJS.Process, 'on' | 'off'>} [signals] Where SIGINT and SIGTERM arrive.
 */

/** Every path that steps 8 and 9 may write or remove, relative to the repository root. */
export const BOOTSTRAP_PATHS = Object.freeze([
  HACKWIN_FILE,
  OWNERS_FILE,
  ...MANIFEST.map((file) => file.path),
  SETTINGS_PATH,
  ...PROJECT_FILES.map((file) => file.path),
])

/** The signals that an interrupt sends: Ctrl+C, and a terminal or system that stops setup. */
const INTERRUPTS = Object.freeze(['SIGINT', 'SIGTERM', 'SIGHUP'])

/**
 * Write the files, commit them and push the commit. Before the push succeeds, any failure or
 * interrupt undoes every change in the checkout and ends setup with an error.
 * @param {CommandContext} ctx
 * @param {BootstrapInput} input
 * @param {BootstrapOptions} [options]
 * @returns {Promise<Bootstrap>}
 */
export async function bootstrap(ctx, input, { signals = process } = {}) {
  const root = ctx.repoRoot
  const git = ctx.git.with({ hooksOff: true })
  const plan = await planFiles(root, git, input)
  await refuseIgnored(ctx, git, COMMITTED_PATHS)

  const journal = await Journal.remember(root, BOOTSTRAP_PATHS)
  const interrupt = watchInterrupts(signals)
  const scratch = await mkdtemp(join(tmpdir(), 'hackwin-setup-'))
  try {
    /** @type {string | null} */
    let commit = null
    try {
      await writeFiles(root, input, plan)
      interrupt.check()
      commit = await makeCommit(ctx, git, input, join(scratch, 'index'), journal)
      interrupt.check()
      await push(git, input.branch, commit)
    } catch (error) {
      if (commit === null || !(await landed(git, input.branch, commit))) {
        await undo(ctx.out, journal, root)
        throw interrupt.happened() ? interrupted(root) : error
      }
      ctx.out.warn(`the push reported a failure, but origin/${input.branch} holds ${commit}`)
    }
    const changed = await changedFiles(git, input.head, commit)
    await moveBranch(ctx, git, input, commit, changed)
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
  } finally {
    interrupt.stop()
    await rm(scratch, { recursive: true, force: true })
  }
}

/**
 * The plan of the team's files, and a refusal, before anything is written, of every file that
 * would be written through a symlink. A `CLAUDE.md` that links to `AGENTS.md` stays.
 * @param {string} root
 * @param {Git} git
 * @param {BootstrapInput} input
 * @returns {Promise<ProjectFileChange[]>}
 */
async function planFiles(root, git, input) {
  /** @type {Map<string, Link | null>} */
  const links = new Map()
  for (const { path } of PROJECT_FILES) links.set(path, await linkOn(root, path))
  const planned = planProjectFiles(
    (path) => readTextSync(join(root, path)),
    { defaultBranch: input.branch, language: input.language },
    (path) => links.get(path) ?? null,
  )
  // Only a tracked check.yml is the template's; an untracked one is not setup's to remove.
  const tracked = await git.run(['ls-files', '--', TEMPLATE_CHECK_WORKFLOW_PATH])
  const plan = planned.map((change) =>
    change.action === 'remove' && tracked.stdout.trim() === ''
      ? { path: change.path, action: /** @type {const} */ ('keep') }
      : change,
  )
  const settings = readTextSync(join(root, SETTINGS_PATH))
  const settingsChange = mergeClaudeSettings(settings, { defaultBranch: input.branch }) !== settings
  await refuseLinks(root, [
    HACKWIN_FILE,
    ...(input.owners === null ? [] : [OWNERS_FILE]),
    ...MANIFEST.map((file) => file.path),
    ...(settingsChange ? [SETTINGS_PATH] : []),
  ])
  return plan
}

/**
 * The files of 6.4 that a configured project holds: every path of BOOTSTRAP_PATHS but the
 * template's CI workflow, which setup never writes, only keeps or removes.
 */
const COMMITTED_PATHS = Object.freeze(
  BOOTSTRAP_PATHS.filter((path) => path !== TEMPLATE_CHECK_WORKFLOW_PATH),
)

/**
 * Refuse, before anything is written, a file of 6.4 that the project ignores and that is not
 * tracked yet: setup commits no ignored file, which may hold a secret.
 * @param {CommandContext} ctx
 * @param {Git} git
 * @param {readonly string[]} paths
 */
async function refuseIgnored(ctx, git, paths) {
  const args = ['check-ignore', '--verbose', '--', ...paths]
  const result = await git.run(args, { allowFailure: true })
  // Exit 1: no path is ignored. A tracked file is never reported: ignore rules do not apply to it.
  if (result.code !== 0 && result.code !== 1) {
    throw new GitError(`git check-ignore failed`, { args, code: result.code, tail: result.tail })
  }
  const ignored = result.stdout
    .split('\n')
    .map((line) => /^(.+?):(\d+):(.+)\t(.+)$/.exec(line))
    .filter((match) => match !== null && !match[3].startsWith('!'))
    .map((match) => {
      const [, source, line, pattern, path] = /** @type {RegExpExecArray} */ (match)
      return { path, rule: `${source}:${line}: ${pattern}` }
    })
  if (ignored.length === 0) return
  throw new PreconditionError(
    `the project ignores files that setup commits: ${ignored.map(({ path, rule }) => `${path} (${rule})`).join(', ')}`,
    {
      resolve: `change the ignore rules so that git no longer ignores these files (a file under an ignored directory needs the directory's rule changed), check that they hold no secret, commit the change, and ${runIn('hackwin setup', ctx.repoRoot)}`,
    },
  )
}

/**
 * Step 8: hackwin.yml and owners.yml, the generated files, the Claude Code settings (6.5: only
 * HackWin's keys and list entries) and the team's files.
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
 * The bootstrap commit, built in an index of its own from the branch's commit and setup's files,
 * and scanned for secrets in the lines it adds. The branch does not move yet.
 * @param {CommandContext} ctx
 * @param {Git} git
 * @param {BootstrapInput} input
 * @param {string} indexFile
 * @param {Journal} journal
 * @returns {Promise<string>} The commit's full SHA.
 */
async function makeCommit(ctx, git, input, indexFile, journal) {
  const own = git.with({ env: { ...ctx.env, GIT_INDEX_FILE: indexFile } })
  if (input.head !== null) await own.run(['read-tree', input.head])
  await own.run(['add', '--all', '--', ...(await journal.changedPaths())])
  const tree = (await own.run(['write-tree'])).stdout.trim()
  const base =
    input.head ??
    (await git.run(['hash-object', '-t', 'tree', '--stdin'], { input: '' })).stdout.trim()
  const findings = await scanDiff(
    git,
    { base, head: tree },
    { extraPatterns: input.secretPatterns },
  )
  if (findings.length > 0) {
    throw new BlockedError(
      `setup would commit ${findings.length === 1 ? 'a secret' : `${findings.length} secrets`}; it stopped before the commit and put every file back`,
      {
        rule: 'E6 secrets: no secret in an added line',
        objects: findings.map(formatFinding),
        resolve: `remove each secret from the file or the answer it comes from (a secret belongs in .env.local, which is never committed), then ${runIn('hackwin setup', ctx.repoRoot)}`,
      },
    )
  }
  const parents = input.head === null ? [] : ['-p', input.head]
  const commit = await git.run(['commit-tree', tree, ...parents, '-F', '-'], {
    input: `${commitMessage(input)}\n`,
  })
  return commit.stdout.trim()
}

/**
 * Step 9: push the bootstrap commit alone to the default branch, without tags.
 * @param {Git} git
 * @param {string} branch
 * @param {string} commit
 */
async function push(git, branch, commit) {
  const refspec = `${commit}:refs/heads/${branch}`
  const result = await git.run(['push', '--quiet', '--no-follow-tags', 'origin', refspec], {
    allowFailure: true,
  })
  if (result.code !== 0) {
    throw new RemoteError(`git push origin ${refspec} failed`, { tail: result.tail })
  }
}

/**
 * Once origin holds the commit: the local branch moves to it, and the index takes setup's files
 * from it, so the checkout is clean; anything else that is staged stays staged.
 * @param {CommandContext} ctx
 * @param {Git} git
 * @param {BootstrapInput} input
 * @param {string} commit
 * @param {Array<{ path: string }>} changed
 */
async function moveBranch(ctx, git, input, commit, changed) {
  const ref = `refs/heads/${input.branch}`
  const moved = await git.run(['update-ref', ref, commit, input.head ?? ''], {
    allowFailure: true,
  })
  if (moved.code !== 0) {
    ctx.out.warn(
      `origin/${input.branch} holds the bootstrap commit ${commit}, but the local ${input.branch} changed meanwhile and was left as it is; to bring it up to date, ${runIn(`git merge origin/${input.branch}`, ctx.repoRoot)}`,
    )
    return
  }
  await git.run(['reset', '--quiet', '--', ...changed.map((file) => file.path)])
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
 * The files the bootstrap commit changed, without rename detection.
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
 * Put the files back. A failure to do so is reported, not thrown, so that the error that stopped
 * setup is the one the runner prints.
 * @param {Output} out
 * @param {Journal} journal
 * @param {string} root
 */
async function undo(out, journal, root) {
  try {
    await journal.restore()
  } catch (error) {
    out.warn(
      `setup could not put back its files in ${root}: ${error.message}; check \`git status\` there`,
    )
  }
}

/**
 * @param {string} root
 * @returns {PreconditionError}
 */
function interrupted(root) {
  return new PreconditionError(
    'setup was interrupted before its push: it put every file back, and nothing changed on GitHub',
    { resolve: { command: 'hackwin setup', dir: root } },
  )
}

/**
 * Hold SIGINT, SIGTERM and SIGHUP while setup changes the checkout, so that an interrupt ends in a
 * state the next run explains: setup notes it and stops at the next safe point.
 * @param {Pick<NodeJS.Process, 'on' | 'off'>} signals
 */
function watchInterrupts(signals) {
  let happened = false
  const note = () => {
    happened = true
  }
  for (const signal of INTERRUPTS) signals.on(signal, note)
  return {
    happened: () => happened,
    /** Throws when an interrupt came in. */
    check() {
      if (happened) throw new Error('interrupted')
    },
    stop() {
      for (const signal of INTERRUPTS) signals.off(signal, note)
    },
  }
}

/**
 * The state of a set of files before setup touched them, and the directories that did not exist
 * yet, so that every change can be undone. A symlink is remembered as one and never written.
 */
class Journal {
  /**
   * @param {string} root
   * @param {Map<string, { kind: 'missing' | 'file' | 'link', content: Buffer | null, mode: number }>} files
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
    /** @type {Map<string, { kind: 'missing' | 'file' | 'link', content: Buffer | null, mode: number }>} */
    const files = new Map()
    /** @type {Set<string>} */
    const missingDirs = new Set()
    for (const path of paths) {
      const file = join(root, path)
      const stats = await lstatOrNull(file)
      if (stats === null) files.set(path, { kind: 'missing', content: null, mode: 0 })
      else if (stats.isSymbolicLink()) files.set(path, { kind: 'link', content: null, mode: 0 })
      else
        files.set(path, { kind: 'file', content: await readFile(file), mode: stats.mode & 0o777 })
      for (let dir = dirname(path); dir !== '.'; dir = dirname(dir)) {
        if ((await lstatOrNull(join(root, dir))) === null) missingDirs.add(dir)
      }
    }
    const deepestFirst = [...missingDirs].sort((a, b) => b.split('/').length - a.split('/').length)
    return new Journal(root, files, deepestFirst)
  }

  /**
   * @param {string} path
   * @returns {boolean} True when something existed at the path before setup.
   */
  existed(path) {
    return this.files.get(path)?.kind !== 'missing'
  }

  /**
   * The paths whose file setup created, changed or removed, for `git add --all`, which stages a
   * removal too. A symlink is never among them: setup does not write through one.
   * @returns {Promise<string[]>}
   */
  async changedPaths() {
    const paths = []
    for (const [path, before] of this.files) {
      if (before.kind === 'link') continue
      if (!(await sameAsBefore(join(this.root, path), before))) paths.push(path)
    }
    return paths
  }

  /** Put every changed file back as it was and remove the directories setup created. */
  async restore() {
    for (const [path, { kind, content, mode }] of this.files) {
      if (kind === 'link') continue
      const file = join(this.root, path)
      if (kind === 'missing') {
        await rm(file, { force: true })
        continue
      }
      if (await sameAsBefore(file, { kind, content, mode })) continue
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, /** @type {Buffer} */ (content))
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
 * True when a file is as the journal remembered it: missing, or a regular file with the same
 * content and mode.
 * @param {string} file
 * @param {{ kind: 'missing' | 'file' | 'link', content: Buffer | null, mode: number }} before
 * @returns {Promise<boolean>}
 */
async function sameAsBefore(file, before) {
  const current = await lstatOrNull(file)
  if (before.kind === 'missing') return current === null
  return (
    current !== null &&
    current.isFile() &&
    (current.mode & 0o777) === before.mode &&
    (await readFile(file)).equals(/** @type {Buffer} */ (before.content))
  )
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
 * @param {string} file
 * @returns {Promise<import('node:fs').Stats | null>}
 */
async function lstatOrNull(file) {
  try {
    return await lstat(file)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
    throw error
  }
}

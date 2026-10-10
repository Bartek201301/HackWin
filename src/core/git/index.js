// All repository access goes through git (CM7), and through this module. A lane that needs a git
// call without a helper here uses Git#run.

import { resolve as resolvePath } from 'node:path'
import { GitError, PreconditionError, RemoteError } from '../runtime/errors.js'
import { exec } from '../runtime/exec.js'

/** @import { ExecResult } from '../runtime/exec.js' */

/** The first git version with `merge-tree --write-tree`. */
export const MERGE_TREE_MIN_VERSION = Object.freeze({ major: 2, minor: 38, patch: 0 })

/** Where hooks are looked up when member hooks are switched off: no hook exists there. */
const NO_HOOKS_PATH = '/dev/null'

/**
 * @typedef {object} GitOptions
 * @property {string} cwd The directory git runs in: a checkout, a worktree or a bare repository.
 * @property {Record<string, string | undefined>} [env] The whole environment; process.env by default.
 * @property {boolean} [hooksOff] Run every command with the member hooks switched off (10.3, for the Gate).
 * @property {number} [timeoutMs] Timeout of each git command; none by default.
 */

/**
 * @typedef {object} GitRunOptions
 * @property {string} [input] Text on stdin.
 * @property {boolean} [allowFailure] Resolve with the result instead of throwing on a non-zero exit.
 * @property {number} [timeoutMs] Overrides the instance timeout for this command.
 */

/**
 * @typedef {object} GitVersion
 * @property {number} major
 * @property {number} minor
 * @property {number} patch
 * @property {string} text The full output of `git --version`.
 */

/**
 * @typedef {object} MergeTreeResult
 * @property {boolean} clean True when the merge has no conflict.
 * @property {string} tree The tree of the merge result; with conflicts it holds conflict markers.
 * @property {string[]} conflicts The paths with conflicts, each once.
 */

/**
 * @typedef {object} MergeResult
 * @property {'up-to-date' | 'fast-forward' | 'merged' | 'conflict' | 'not-possible'} status
 *   `conflict` leaves the merge in progress, for the caller to resolve or abort; `not-possible`
 *   is a refused fast-forward with ffOnly.
 * @property {string[]} conflicts The paths with conflicts; empty unless status is `conflict`.
 * @property {string} head The commit HEAD points to afterwards.
 * @property {string} message Git's output, for a refused fast-forward.
 */

/**
 * @typedef {object} Worktree
 * @property {string} path Absolute path.
 * @property {string | null} head The commit checked out; null in a bare repository.
 * @property {string | null} branch The branch name without refs/heads/; null when detached or bare.
 * @property {boolean} bare
 * @property {boolean} detached
 * @property {boolean} locked
 * @property {boolean} prunable
 */

/**
 * @typedef {object} ChangedFile
 * @property {string} status One letter of `git diff --name-status`: A, C, D, M, R, T, U.
 * @property {string} path The path after the change.
 * @property {string | null} oldPath The path before a rename or copy.
 */

/**
 * @typedef {object} AddedLine
 * @property {string} path
 * @property {number} line Line number in the new version of the file.
 * @property {string} text The line without the leading `+`.
 */

/**
 * Which changes a diff covers. Without base and head: the working tree against the index, or with
 * `staged` the index against HEAD.
 * @typedef {object} DiffRange
 * @property {string} [base]
 * @property {string} [head] Defaults to the working tree, or with `staged` to the index.
 * @property {boolean} [staged] Compare the index with `base` or HEAD (the staged changes of a commit).
 * @property {boolean} [threeDot] Only the changes on `head` since its merge base with `base`.
 */

export class Git {
  /** @param {GitOptions} options */
  constructor(options) {
    if (!options?.cwd) throw new TypeError('Git needs a cwd')
    /** @type {Readonly<GitOptions>} */
    this.options = Object.freeze({ ...options })
    /** @type {Promise<GitVersion> | undefined} */
    this.versionPromise = undefined
  }

  /** @returns {string} */
  get cwd() {
    return this.options.cwd
  }

  /**
   * A copy with other options, for example `git.with({ cwd: worktree })` or `{ hooksOff: true }`.
   * @param {Partial<GitOptions>} overrides
   * @returns {Git}
   */
  with(overrides) {
    return new Git({ ...this.options, ...overrides })
  }

  /**
   * Run git with these arguments. Throws GitError on a non-zero exit unless allowFailure is set.
   * @param {string[]} args
   * @param {GitRunOptions} [options]
   * @returns {Promise<ExecResult>}
   */
  async run(args, { input, allowFailure = false, timeoutMs } = {}) {
    const fullArgs = ['-c', 'core.quotePath=false']
    if (this.options.hooksOff) fullArgs.push('-c', `core.hooksPath=${NO_HOOKS_PATH}`)
    fullArgs.push(...args)
    const result = await exec('git', fullArgs, {
      cwd: this.options.cwd,
      env: {
        ...(this.options.env ?? process.env),
        GIT_TERMINAL_PROMPT: '0',
        LC_ALL: 'C',
      },
      input,
      timeoutMs: timeoutMs ?? this.options.timeoutMs,
    })
    if (result.code !== 0 && !allowFailure) {
      throw new GitError(`git ${args.join(' ')} failed${describeFailure(result)}`, {
        args,
        code: result.code,
        tail: result.tail,
      })
    }
    return result
  }

  /**
   * The output of a git command without its trailing newline.
   * @param {string[]} args
   * @returns {Promise<string>}
   */
  async output(args) {
    return (await this.run(args)).stdout.replace(/\n$/, '')
  }

  /** @returns {Promise<GitVersion>} */
  version() {
    this.versionPromise ??= this.output(['--version']).then(parseGitVersion)
    return this.versionPromise
  }

  /**
   * Throws a PreconditionError when git is older than 2.38, which lacks `merge-tree --write-tree`.
   * @returns {Promise<void>}
   */
  async requireMergeTree() {
    const version = await this.version()
    if (!supportsMergeTree(version)) {
      throw new PreconditionError(
        `git ${version.major}.${version.minor}.${version.patch} is too old: hackwin needs git 2.38 or later for merge-tree --write-tree`,
        { resolve: 'install git 2.38 or later' },
      )
    }
  }

  /**
   * The top-level directory of the current checkout or worktree. Throws a PreconditionError
   * outside a git repository.
   * @returns {Promise<string>}
   */
  async topLevel() {
    const result = await this.run(['rev-parse', '--show-toplevel'], { allowFailure: true })
    if (result.code !== 0) {
      throw new PreconditionError(`${this.cwd} is not inside a git checkout`, {
        resolve: 'run hackwin inside a clone of the team repository',
      })
    }
    return result.stdout.trim()
  }

  /**
   * The git common directory, shared by every worktree of a clone, as an absolute path.
   * @returns {Promise<string>}
   */
  async commonDir() {
    const dir = await this.output(['rev-parse', '--path-format=absolute', '--git-common-dir'])
    return resolvePath(this.cwd, dir)
  }

  /**
   * The full SHA of a revision. Throws GitError when it does not exist.
   * @param {string} rev
   * @returns {Promise<string>}
   */
  async revParse(rev) {
    return this.output(['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`])
  }

  /**
   * The full SHA of a revision, or null when it does not exist.
   * @param {string} rev
   * @returns {Promise<string | null>}
   */
  async tryRevParse(rev) {
    const result = await this.run(
      ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`],
      { allowFailure: true },
    )
    return result.code === 0 ? result.stdout.trim() : null
  }

  /**
   * The content of a file at a ref, or null when the file does not exist there. Throws GitError
   * when the ref does not exist.
   * @param {string} ref
   * @param {string} path Path from the repository root.
   * @returns {Promise<string | null>}
   */
  async showFile(ref, path) {
    const result = await this.run(['cat-file', 'blob', `${ref}:${path}`], { allowFailure: true })
    if (result.code === 0) return result.stdout
    await this.revParse(ref)
    return null
  }

  /**
   * Fetch from a remote. Throws RemoteError when the fetch fails (exit 3).
   * @param {object} [options]
   * @param {string} [options.remote]
   * @param {string[]} [options.refspecs] Default: the remote's configured refspecs.
   * @param {boolean} [options.prune]
   * @returns {Promise<void>}
   */
  async fetch({ remote = 'origin', refspecs = [], prune = false } = {}) {
    const args = ['fetch', '--quiet', ...(prune ? ['--prune'] : []), remote, ...refspecs]
    const result = await this.run(args, { allowFailure: true })
    if (result.code !== 0) {
      throw new RemoteError(`git fetch ${remote} failed${describeFailure(result)}`, {
        tail: result.tail,
      })
    }
  }

  /**
   * Push to a remote. Never forces. Throws RemoteError when the push fails (exit 3), also when a
   * hook or the remote refuses it; the tail holds git's reason.
   * @param {object} options
   * @param {string[]} options.refspecs
   * @param {string} [options.remote]
   * @param {boolean} [options.setUpstream]
   * @returns {Promise<void>}
   */
  async push({ refspecs, remote = 'origin', setUpstream = false }) {
    const args = [
      'push',
      '--quiet',
      ...(setUpstream ? ['--set-upstream'] : []),
      remote,
      ...refspecs,
    ]
    const result = await this.run(args, { allowFailure: true })
    if (result.code !== 0) {
      throw new RemoteError(
        `git push ${remote} ${refspecs.join(' ')} failed${describeFailure(result)}`,
        {
          tail: result.tail,
        },
      )
    }
  }

  /**
   * The URL of a remote, or null when the remote does not exist.
   * @param {string} [remote]
   * @returns {Promise<string | null>}
   */
  async remoteUrl(remote = 'origin') {
    const result = await this.run(['remote', 'get-url', remote], { allowFailure: true })
    return result.code === 0 ? result.stdout.trim() : null
  }

  /**
   * The current branch without refs/heads/, or null when HEAD is detached.
   * @returns {Promise<string | null>}
   */
  async currentBranch() {
    const result = await this.run(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      allowFailure: true,
    })
    return result.code === 0 ? result.stdout.trim() : null
  }

  /**
   * True when the working tree and the index have no change and no untracked file.
   * @returns {Promise<boolean>}
   */
  async isClean() {
    return (await this.output(['status', '--porcelain'])) === ''
  }

  /**
   * True when `ancestor` is an ancestor of `descendant` (or the same commit).
   * @param {string} ancestor
   * @param {string} descendant
   * @returns {Promise<boolean>}
   */
  async isAncestor(ancestor, descendant) {
    const result = await this.run(['merge-base', '--is-ancestor', ancestor, descendant], {
      allowFailure: true,
    })
    if (result.code === 0) return true
    if (result.code === 1) return false
    throw new GitError(`git merge-base --is-ancestor failed${describeFailure(result)}`, {
      args: ['merge-base', '--is-ancestor', ancestor, descendant],
      code: result.code,
      tail: result.tail,
    })
  }

  /**
   * The merge base of two commits, or null when they share no history.
   * @param {string} a
   * @param {string} b
   * @returns {Promise<string | null>}
   */
  async mergeBase(a, b) {
    const result = await this.run(['merge-base', a, b], { allowFailure: true })
    return result.code === 0 ? result.stdout.trim() : null
  }

  /**
   * The files a diff changes.
   * @param {DiffRange} [range]
   * @returns {Promise<ChangedFile[]>}
   */
  async changedFiles(range = {}) {
    const output = await this.output(['diff', '--name-status', '-z', ...diffArgs(range)])
    return parseNameStatus(output)
  }

  /**
   * The lines a diff adds, with their line numbers in the new file. Binary files have none.
   * @param {DiffRange} [range]
   * @returns {Promise<AddedLine[]>}
   */
  async addedLines(range = {}) {
    const output = await this.output([
      'diff',
      '--unified=0',
      '--no-color',
      '--no-ext-diff',
      ...diffArgs(range),
    ])
    return parseAddedLines(output)
  }

  /**
   * Merge two commits without touching any checkout, with `git merge-tree --write-tree`.
   * Needs git 2.38 or later (PreconditionError otherwise).
   * @param {string} ours
   * @param {string} theirs
   * @returns {Promise<MergeTreeResult>}
   */
  async mergeTree(ours, theirs) {
    await this.requireMergeTree()
    const args = ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', ours, theirs]
    const result = await this.run(args, { allowFailure: true })
    const [tree, ...rest] = result.stdout.split('\0')
    // Exit 1 means conflicts only when a tree was written; a bad ref also exits 1.
    if ((result.code !== 0 && result.code !== 1) || !/^[0-9a-f]{40,64}$/.test(tree)) {
      throw new GitError(`git merge-tree ${ours} ${theirs} failed${describeFailure(result)}`, {
        args,
        code: result.code,
        tail: result.tail,
      })
    }
    const conflicts = [...new Set(rest.filter((path) => path !== ''))]
    return { clean: result.code === 0, tree, conflicts }
  }

  /**
   * Merge a ref into the current branch. Never rebases. On a conflict the merge stays in
   * progress and the conflicting paths are returned; call mergeAbort to undo it.
   * @param {string} ref
   * @param {object} [options]
   * @param {boolean} [options.ffOnly] Only fast-forward; anything else returns `not-possible`.
   * @param {boolean} [options.noFastForward] Always create a merge commit.
   * @param {string} [options.message] The message of the merge commit.
   * @returns {Promise<MergeResult>}
   */
  async merge(ref, { ffOnly = false, noFastForward = false, message } = {}) {
    const before = await this.revParse('HEAD')
    const args = ['merge', '--no-edit']
    if (ffOnly) args.push('--ff-only')
    if (noFastForward) args.push('--no-ff')
    if (message !== undefined) args.push('-m', message)
    args.push('--end-of-options', ref)
    const result = await this.run(args, { allowFailure: true })
    if (result.code !== 0) {
      const conflicts = await this.conflictedFiles()
      if (conflicts.length > 0) {
        return {
          status: 'conflict',
          conflicts,
          head: before,
          message: result.stdout + result.stderr,
        }
      }
      if (ffOnly) {
        return {
          status: 'not-possible',
          conflicts: [],
          head: before,
          message: result.stderr.trim(),
        }
      }
      throw new GitError(`git merge ${ref} failed${describeFailure(result)}`, {
        args,
        code: result.code,
        tail: result.tail,
      })
    }
    const head = await this.revParse('HEAD')
    /** @type {MergeResult['status']} */
    let status = 'merged'
    if (head === before) status = 'up-to-date'
    else if (head === (await this.revParse(ref))) status = 'fast-forward'
    return { status, conflicts: [], head, message: '' }
  }

  /** Abort a merge in progress. */
  async mergeAbort() {
    await this.run(['merge', '--abort'])
  }

  /**
   * The paths with unresolved conflicts in the index.
   * @returns {Promise<string[]>}
   */
  async conflictedFiles() {
    const output = await this.output(['diff', '--name-only', '--diff-filter=U', '-z'])
    return output.split('\0').filter((path) => path !== '')
  }

  /**
   * Add a worktree. With createBranch, the branch is created at startPoint without tracking
   * (so it never pushes to the branch it started from); without it, branch must exist. With
   * detach, the worktree checks out startPoint without a branch (the Gate's scratch worktrees).
   * @param {string} path
   * @param {object} options
   * @param {string} [options.branch]
   * @param {boolean} [options.createBranch]
   * @param {string} [options.startPoint]
   * @param {boolean} [options.detach]
   * @returns {Promise<void>}
   */
  async worktreeAdd(path, { branch, createBranch = false, startPoint, detach = false }) {
    const args = ['worktree', 'add', '--quiet']
    if (detach) {
      if (!startPoint) throw new TypeError('worktreeAdd with detach needs a startPoint')
      args.push('--detach', path, startPoint)
    } else if (createBranch) {
      if (!branch || !startPoint) {
        throw new TypeError('worktreeAdd with createBranch needs a branch and a startPoint')
      }
      args.push('--no-track', '-b', branch, path, startPoint)
    } else {
      if (!branch) throw new TypeError('worktreeAdd needs a branch')
      args.push(path, branch)
    }
    await this.run(args)
  }

  /**
   * Every worktree of this clone, the main checkout first.
   * @returns {Promise<Worktree[]>}
   */
  async worktreeList() {
    return parseWorktreeList(await this.output(['worktree', 'list', '--porcelain', '-z']))
  }

  /**
   * Remove a worktree. Without force git refuses a worktree with changes (GitError).
   * @param {string} path
   * @param {object} [options]
   * @param {boolean} [options.force]
   * @returns {Promise<void>}
   */
  async worktreeRemove(path, { force = false } = {}) {
    await this.run(['worktree', 'remove', ...(force ? ['--force'] : []), path])
  }

  /**
   * A config value, or null when it is not set.
   * @param {string} key
   * @returns {Promise<string | null>}
   */
  async configGet(key) {
    const result = await this.run(['config', '--get', key], { allowFailure: true })
    return result.code === 0 ? result.stdout.replace(/\n$/, '') : null
  }

  /**
   * Set a config value in the repository's own config.
   * @param {string} key
   * @param {string} value
   * @returns {Promise<void>}
   */
  async configSet(key, value) {
    await this.run(['config', '--local', key, value])
  }
}

/**
 * @param {GitOptions} options
 * @returns {Git}
 */
export function createGit(options) {
  return new Git(options)
}

/**
 * @param {string} text The output of `git --version`, for example "git version 2.39.3 (Apple Git-146)".
 * @returns {GitVersion}
 */
export function parseGitVersion(text) {
  const match = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(text)
  if (!match) throw new PreconditionError(`cannot read the git version from "${text.trim()}"`)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? 0),
    text: text.trim(),
  }
}

/**
 * @param {{ major: number, minor: number }} version
 * @returns {boolean}
 */
export function supportsMergeTree(version) {
  const min = MERGE_TREE_MIN_VERSION
  return version.major > min.major || (version.major === min.major && version.minor >= min.minor)
}

/**
 * @param {string} output The output of `git worktree list --porcelain -z`.
 * @returns {Worktree[]}
 */
export function parseWorktreeList(output) {
  /** @type {Worktree[]} */
  const worktrees = []
  /** @type {Worktree | null} */
  let current = null
  for (const field of output.split('\0')) {
    if (field === '') {
      if (current) worktrees.push(current)
      current = null
      continue
    }
    const space = field.indexOf(' ')
    const name = space === -1 ? field : field.slice(0, space)
    const value = space === -1 ? '' : field.slice(space + 1)
    if (name === 'worktree') {
      current = {
        path: value,
        head: null,
        branch: null,
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
      }
    } else if (current) {
      if (name === 'HEAD') current.head = value
      else if (name === 'branch') current.branch = value.replace(/^refs\/heads\//, '')
      else if (name === 'bare') current.bare = true
      else if (name === 'detached') current.detached = true
      else if (name === 'locked') current.locked = true
      else if (name === 'prunable') current.prunable = true
    }
  }
  if (current) worktrees.push(current)
  return worktrees
}

/**
 * @param {DiffRange} range
 * @returns {string[]}
 */
function diffArgs({ base, head, staged = false, threeDot = false }) {
  const args = []
  if (staged) args.push('--cached')
  if (threeDot) {
    if (base === undefined) throw new TypeError('a three-dot diff needs a base')
    args.push(`${base}...${head ?? 'HEAD'}`)
  } else {
    if (base !== undefined) args.push(base)
    if (head !== undefined) args.push(head)
  }
  args.push('--')
  return args
}

/**
 * @param {string} output The output of `git diff --name-status -z`.
 * @returns {ChangedFile[]}
 */
function parseNameStatus(output) {
  const fields = output.split('\0')
  /** @type {ChangedFile[]} */
  const files = []
  for (let i = 0; i < fields.length; i += 1) {
    const code = fields[i]
    if (code === '') continue
    const status = code[0]
    if (status === 'R' || status === 'C') {
      files.push({ status, oldPath: fields[i + 1], path: fields[i + 2] })
      i += 2
    } else {
      files.push({ status, oldPath: null, path: fields[i + 1] })
      i += 1
    }
  }
  return files
}

/**
 * @param {string} output The output of `git diff --unified=0`.
 * @returns {AddedLine[]}
 */
function parseAddedLines(output) {
  /** @type {AddedLine[]} */
  const lines = []
  /** @type {string | null} */
  let path = null
  let inHeader = false
  let next = 0
  for (const line of output.split('\n')) {
    if (line.startsWith('diff --git ')) {
      inHeader = true
      path = null
    } else if (inHeader && line.startsWith('+++ ')) {
      const name = line.slice(4).replace(/\t$/, '')
      path = name === '/dev/null' ? null : name.replace(/^b\//, '')
    } else if (line.startsWith('@@ ')) {
      inHeader = false
      const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      next = match ? Number(match[1]) : 0
    } else if (!inHeader && path !== null && line.startsWith('+')) {
      lines.push({ path, line: next, text: line.slice(1) })
      next += 1
    }
  }
  return lines
}

/**
 * @param {ExecResult} result
 * @returns {string}
 */
function describeFailure(result) {
  if (result.timedOut) return ': timed out'
  const last = result.tail.filter((line) => line.trim() !== '').at(-1)
  return last ? `: ${last.trim()}` : ` with exit code ${result.code}`
}

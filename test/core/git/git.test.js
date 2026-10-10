import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { chmodSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createGit,
  parseGitVersion,
  parseWorktreeList,
  supportsMergeTree,
} from '../../../src/core/git/index.js'
import { GitError, PreconditionError, RemoteError } from '../../../src/core/runtime/errors.js'
import { createRepoWithOrigin } from './temp-repo.js'

/** @type {ReturnType<typeof createRepoWithOrigin>} */
let repo
/** @type {import('../../../src/core/git/index.js').Git} */
let git

beforeEach(() => {
  repo = createRepoWithOrigin()
  git = createGit({ cwd: repo.clone, env: repo.env })
})

afterEach(() => repo.cleanup())

/**
 * Commit files on the current branch of a checkout.
 * @param {string} cwd
 * @param {Record<string, string>} files
 * @param {string} message
 */
function commit(cwd, files, message) {
  for (const [path, text] of Object.entries(files)) repo.write(join(cwd, path), text)
  repo.git(cwd, 'add', '.')
  repo.git(cwd, 'commit', '--quiet', '-m', message)
  return repo.git(cwd, 'rev-parse', 'HEAD').trim()
}

describe('1.3a/git: git helpers on a temporary repository', () => {
  test('topLevel, commonDir, revParse and currentBranch describe the checkout', async () => {
    expect(await git.topLevel()).toBe(repo.clone)
    expect(await git.commonDir()).toBe(join(repo.clone, '.git'))
    const head = repo.git(repo.clone, 'rev-parse', 'HEAD').trim()
    expect(await git.revParse('HEAD')).toBe(head)
    expect(await git.revParse('main')).toMatch(/^[0-9a-f]{40}$/)
    expect(await git.tryRevParse('no-such-branch')).toBeNull()
    await expect(git.revParse('no-such-branch')).rejects.toBeInstanceOf(GitError)
    expect(await git.currentBranch()).toBe('main')
    expect(await git.remoteUrl()).toBe(repo.origin)
    expect(await git.remoteUrl('upstream')).toBeNull()
  })

  test('topLevel outside a repository is a precondition error', async () => {
    const outside = createGit({ cwd: repo.dir, env: repo.env })
    await expect(outside.topLevel()).rejects.toBeInstanceOf(PreconditionError)
  })

  test('fetch updates origin/main, and a failed fetch is a remote error (exit 3)', async () => {
    const other = join(repo.dir, 'other')
    repo.git(repo.dir, 'clone', '--quiet', repo.origin, other)
    const pushed = commit(other, { 'a.txt': 'a\n' }, 'from elsewhere')
    repo.git(other, 'push', '--quiet', 'origin', 'main')

    expect(await git.revParse('origin/main')).not.toBe(pushed)
    await git.fetch()
    expect(await git.revParse('origin/main')).toBe(pushed)

    const broken = createGit({ cwd: repo.clone, env: repo.env })
    await broken.run(['remote', 'set-url', 'origin', join(repo.dir, 'missing.git')])
    const error = await broken.fetch().catch((e) => e)
    expect(error).toBeInstanceOf(RemoteError)
    expect(error.exitCode).toBe(3)
  })

  test('push sends a branch to the remote', async () => {
    repo.git(repo.clone, 'checkout', '--quiet', '-b', 'task/1-push')
    const head = commit(repo.clone, { 'p.txt': 'p\n' }, 'push me')
    await git.push({ refspecs: ['task/1-push'], setUpstream: true })
    expect(repo.git(repo.origin, 'rev-parse', 'task/1-push').trim()).toBe(head)
  })

  test('showFile reads a file at a ref, null for a missing file, and throws for a missing ref', async () => {
    expect(await git.showFile('HEAD', 'README.md')).toBe('readme\n')
    expect(await git.showFile('origin/main', 'README.md')).toBe('readme\n')
    expect(await git.showFile('HEAD', 'missing.txt')).toBeNull()
    await expect(git.showFile('no-such-ref', 'README.md')).rejects.toBeInstanceOf(GitError)
  })

  test('isClean, changedFiles and addedLines see the changes', async () => {
    expect(await git.isClean()).toBe(true)
    repo.git(repo.clone, 'checkout', '--quiet', '-b', 'task/2-diff')
    commit(repo.clone, { 'src/a.js': 'one\ntwo\n', 'file with space.txt': 'x\n++ plus\n' }, 'add')
    repo.write(join(repo.clone, 'src/a.js'), 'one\nTWO\nthree\n')
    expect(await git.isClean()).toBe(false)

    const committed = await git.changedFiles({ base: 'origin/main', head: 'HEAD', threeDot: true })
    expect(committed.map((file) => file.path).sort()).toEqual(['file with space.txt', 'src/a.js'])
    expect(committed.every((file) => file.status === 'A')).toBe(true)

    const added = await git.addedLines({ base: 'origin/main', head: 'HEAD', threeDot: true })
    expect(added).toContainEqual({ path: 'file with space.txt', line: 2, text: '++ plus' })
    expect(added).toContainEqual({ path: 'src/a.js', line: 1, text: 'one' })

    // Unstaged changes, then the same changes staged.
    expect(await git.addedLines()).toEqual([
      { path: 'src/a.js', line: 2, text: 'TWO' },
      { path: 'src/a.js', line: 3, text: 'three' },
    ])
    repo.git(repo.clone, 'add', 'src/a.js')
    expect(await git.addedLines({ staged: true })).toHaveLength(2)
    expect(await git.changedFiles({ staged: true })).toEqual([
      { status: 'M', path: 'src/a.js', oldPath: null },
    ])
  })

  test('the three-dot diff leaves out what arrived on main', async () => {
    repo.git(repo.clone, 'checkout', '--quiet', '-b', 'task/3-own')
    commit(repo.clone, { 'mine.txt': 'mine\n' }, 'mine')
    repo.git(repo.clone, 'checkout', '--quiet', 'main')
    commit(repo.clone, { 'theirs.txt': 'theirs\n' }, 'theirs')
    const own = await git.changedFiles({ base: 'main', head: 'task/3-own', threeDot: true })
    expect(own.map((file) => file.path)).toEqual(['mine.txt'])
    const both = await git.changedFiles({ base: 'main', head: 'task/3-own' })
    expect(both.map((file) => file.path).sort()).toEqual(['mine.txt', 'theirs.txt'])
  })

  test('merge-tree reports a clean merge and a conflicting merge', async () => {
    const base = repo.git(repo.clone, 'rev-parse', 'HEAD').trim()
    commit(repo.clone, { 'shared.txt': 'a\nb\nc\n' }, 'shared')
    repo.git(repo.clone, 'branch', 'one')
    repo.git(repo.clone, 'branch', 'two')
    repo.git(repo.clone, 'branch', 'three')
    repo.git(repo.clone, 'checkout', '--quiet', 'one')
    commit(repo.clone, { 'shared.txt': 'a\nONE\nc\n', 'only-one.txt': '1\n' }, 'one')
    repo.git(repo.clone, 'checkout', '--quiet', 'two')
    commit(repo.clone, { 'shared.txt': 'a\nTWO\nc\n' }, 'two')
    repo.git(repo.clone, 'checkout', '--quiet', 'three')
    commit(repo.clone, { 'other.txt': '3\n' }, 'three')
    const headBefore = await git.revParse('HEAD')

    const clean = await git.mergeTree('one', 'three')
    expect(clean.clean).toBe(true)
    expect(clean.conflicts).toEqual([])
    expect(clean.tree).toMatch(/^[0-9a-f]{40}$/)

    const conflicting = await git.mergeTree('one', 'two')
    expect(conflicting.clean).toBe(false)
    expect(conflicting.conflicts).toEqual(['shared.txt'])

    // Nothing in the checkout changed.
    expect(await git.revParse('HEAD')).toBe(headBefore)
    expect(await git.isClean()).toBe(true)
    await expect(git.mergeTree('one', 'no-such-ref')).rejects.toBeInstanceOf(GitError)
    expect(base).not.toBe(headBefore)
  })

  test('merge fast-forwards, merges, stops on a conflict and refuses a fast-forward that is not possible', async () => {
    commit(repo.clone, { 'shared.txt': 'a\nb\nc\n' }, 'shared')
    repo.git(repo.clone, 'branch', 'ahead')
    repo.git(repo.clone, 'branch', 'conflict')
    repo.git(repo.clone, 'branch', 'side')
    repo.git(repo.clone, 'checkout', '--quiet', 'ahead')
    const ahead = commit(repo.clone, { 'ahead.txt': 'x\n' }, 'ahead')
    repo.git(repo.clone, 'checkout', '--quiet', 'side')
    commit(repo.clone, { 'side.txt': 'y\n' }, 'side')
    repo.git(repo.clone, 'checkout', '--quiet', 'conflict')
    commit(repo.clone, { 'shared.txt': 'a\nCONFLICT\nc\n' }, 'conflict')
    repo.git(repo.clone, 'checkout', '--quiet', 'main')

    expect(await git.merge('ahead', { ffOnly: true })).toMatchObject({
      status: 'fast-forward',
      head: ahead,
    })
    expect((await git.merge('ahead')).status).toBe('up-to-date')
    expect((await git.merge('side', { ffOnly: true })).status).toBe('not-possible')
    const merged = await git.merge('side')
    expect(merged.status).toBe('merged')
    expect(
      repo.git(repo.clone, 'rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' '),
    ).toHaveLength(3)

    repo.git(repo.clone, 'checkout', '--quiet', 'conflict')
    repo.git(repo.clone, 'checkout', '--quiet', '-b', 'task/4-merge')
    repo.git(repo.clone, 'checkout', '--quiet', 'main')
    commit(repo.clone, { 'shared.txt': 'a\nMAIN\nc\n' }, 'main side')
    repo.git(repo.clone, 'checkout', '--quiet', 'task/4-merge')
    const conflict = await git.merge('main')
    expect(conflict.status).toBe('conflict')
    expect(conflict.conflicts).toEqual(['shared.txt'])
    expect(await git.conflictedFiles()).toEqual(['shared.txt'])
    await git.mergeAbort()
    expect(await git.isClean()).toBe(true)
  })

  test('worktree add, list and remove; every worktree shares the common dir', async () => {
    const path = join(repo.dir, 'clone.worktrees', '7-feature')
    await git.worktreeAdd(path, {
      branch: 'task/7-feature',
      createBranch: true,
      startPoint: 'origin/main',
    })
    expect(existsSync(join(path, 'README.md'))).toBe(true)
    // No tracking: the branch never pushes to the branch it started from.
    expect(await git.configGet('branch.task/7-feature.merge')).toBeNull()

    const scratch = join(repo.dir, 'scratch')
    await git.worktreeAdd(scratch, { detach: true, startPoint: 'HEAD' })

    const list = await git.worktreeList()
    expect(list.map((worktree) => worktree.path)).toEqual([repo.clone, path, scratch])
    expect(list[0]).toMatchObject({ branch: 'main', bare: false, detached: false })
    expect(list[1]).toMatchObject({ branch: 'task/7-feature', detached: false })
    expect(list[2]).toMatchObject({ branch: null, detached: true })

    const inWorktree = git.with({ cwd: path })
    expect(await inWorktree.commonDir()).toBe(await git.commonDir())
    expect(await inWorktree.topLevel()).toBe(path)
    expect(await inWorktree.currentBranch()).toBe('task/7-feature')

    repo.write(join(path, 'dirty.txt'), 'dirty\n')
    await expect(git.worktreeRemove(path)).rejects.toBeInstanceOf(GitError)
    await git.worktreeRemove(path, { force: true })
    await git.worktreeRemove(scratch)
    expect((await git.worktreeList()).map((worktree) => worktree.path)).toEqual([repo.clone])
    // An existing branch can be checked out in a new worktree again.
    await git.worktreeAdd(path, { branch: 'task/7-feature' })
    expect(await git.with({ cwd: path }).currentBranch()).toBe('task/7-feature')
  })

  test('hooksOff runs git with the member hooks switched off', async () => {
    const hook = join(repo.clone, '.git', 'hooks', 'pre-commit')
    repo.write(hook, '#!/bin/sh\necho "hook ran" >&2\nexit 1\n')
    chmodSync(hook, 0o755)
    repo.write(join(repo.clone, 'h.txt'), 'h\n')
    await git.run(['add', 'h.txt'])

    const withHooks = await git.run(['commit', '--quiet', '-m', 'with hooks'], {
      allowFailure: true,
    })
    expect(withHooks.code).not.toBe(0)
    expect(withHooks.stderr).toContain('hook ran')

    await git.with({ hooksOff: true }).run(['commit', '--quiet', '-m', 'without hooks'])
    expect(repo.git(repo.clone, 'log', '-1', '--format=%s').trim()).toBe('without hooks')
  })

  test('configGet and configSet use the repository config', async () => {
    expect(await git.configGet('core.hooksPath')).toBeNull()
    await git.configSet('core.hooksPath', '.githooks')
    expect(await git.configGet('core.hooksPath')).toBe('.githooks')
    expect(readFileSync(join(repo.clone, '.git', 'config'), 'utf8')).toContain(
      'hooksPath = .githooks',
    )
  })
})

describe('1.3a/git: the git 2.38 check of merge-tree', () => {
  test('parseGitVersion reads plain and vendor version strings', () => {
    expect(parseGitVersion('git version 2.53.0\n')).toMatchObject({ major: 2, minor: 53, patch: 0 })
    expect(parseGitVersion('git version 2.39.3 (Apple Git-146)')).toMatchObject({
      major: 2,
      minor: 39,
      patch: 3,
    })
    expect(() => parseGitVersion('not git')).toThrow(PreconditionError)
  })

  test('supportsMergeTree needs 2.38 or later', () => {
    expect(supportsMergeTree({ major: 2, minor: 37 })).toBe(false)
    expect(supportsMergeTree({ major: 2, minor: 38 })).toBe(true)
    expect(supportsMergeTree({ major: 3, minor: 0 })).toBe(true)
    expect(supportsMergeTree({ major: 1, minor: 99 })).toBe(false)
  })

  test('requireMergeTree is a precondition error on an older git', async () => {
    const old = createGit({ cwd: repo.clone, env: repo.env })
    old.versionPromise = Promise.resolve(parseGitVersion('git version 2.37.1'))
    await expect(old.requireMergeTree()).rejects.toThrow(/2\.38 or later/)
    await expect(old.mergeTree('HEAD', 'HEAD')).rejects.toBeInstanceOf(PreconditionError)
    await expect(git.requireMergeTree()).resolves.toBeUndefined()
  })

  test('parseWorktreeList reads bare, locked and prunable entries', () => {
    const output = [
      'worktree /r/bare.git',
      'bare',
      '',
      'worktree /r/wt',
      'HEAD 0123456789012345678901234567890123456789',
      'detached',
      'locked reason',
      'prunable gitdir file points to non-existent location',
      '',
      '',
    ].join('\0')
    expect(parseWorktreeList(output)).toEqual([
      {
        path: '/r/bare.git',
        head: null,
        branch: null,
        bare: true,
        detached: false,
        locked: false,
        prunable: false,
      },
      {
        path: '/r/wt',
        head: '0123456789012345678901234567890123456789',
        branch: null,
        bare: false,
        detached: true,
        locked: true,
        prunable: true,
      },
    ])
  })
})

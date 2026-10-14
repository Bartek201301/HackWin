import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createGit } from '../../../src/core/git/index.js'
import { createGitHub } from '../../../src/core/github/index.js'
import {
  HOOKS_PATH,
  checkHooksPath,
  currentTask,
  mainCheckout,
  removeMergedWorktrees,
  repairHooksPath,
  taskWorktreePath,
  taskWorktrees,
} from '../../../src/core/worktrees/index.js'
import { createRepoWithOrigin } from '../git/temp-repo.js'

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
 * Add the worktree of a task at its path of A9, on a new branch from main.
 * @param {number} issue
 * @param {string} slug
 */
function addTask(issue, slug) {
  const path = taskWorktreePath(repo.clone, issue, slug)
  repo.git(repo.clone, 'worktree', 'add', '--quiet', '-b', `task/${issue}-${slug}`, path, 'main')
  return path
}

/**
 * A GitHub whose closed pull requests are these, answered through the executor seam.
 * @param {Array<{ number: number, branch: string, merged: boolean }>} closed
 */
function githubWithClosedPulls(closed) {
  /** @type {string[][]} */
  const calls = []
  /** @type {import('../../../src/core/github/index.js').GhExecutor} */
  const executor = async (args) => {
    calls.push(args)
    const [, , method, endpoint] = args
    const url = new URL(endpoint, 'https://api.invalid/')
    if (method !== 'GET' || url.pathname !== '/repos/%7Bowner%7D/%7Brepo%7D/pulls') {
      return { code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }
    }
    const pulls = closed.map((pull) => ({
      number: pull.number,
      state: 'closed',
      merged_at: pull.merged ? '2026-10-12T10:00:00Z' : null,
      head: { ref: pull.branch, sha: 'f'.repeat(40), repo: { full_name: 'o/r' } },
      base: { ref: 'main' },
    }))
    const state = url.searchParams.get('state')
    return { code: 0, stdout: JSON.stringify(state === 'closed' ? pulls : []), stderr: '' }
  }
  return { github: createGitHub({ executor, repo: 'o/r' }), calls }
}

describe('1.3c/worktrees: task worktrees of a clone', () => {
  test('the worktree path is <repo-parent>/<repo-name>.worktrees/<N>-<slug> (A9)', async () => {
    expect(taskWorktreePath('/work/app', 12, 'login-form')).toBe(
      '/work/app.worktrees/12-login-form',
    )
    expect(taskWorktreePath('/work/app/', 3, 'x')).toBe('/work/app.worktrees/3-x')
    expect(() => taskWorktreePath('/work/app', 0, 'x')).toThrow(TypeError)
    expect(() => taskWorktreePath('/work/app', 1, '../x')).toThrow(TypeError)
  })

  test('the main checkout, the task of the current worktree and every task worktree are found', async () => {
    const twelve = addTask(12, 'login-form')
    const thirteen = addTask(13, 'api')
    repo.git(repo.clone, 'worktree', 'add', '--quiet', '-b', 'spike/try', join(repo.dir, 'spike'))

    const inTask = createGit({ cwd: twelve, env: repo.env })
    expect(await mainCheckout(inTask)).toBe(repo.clone)
    expect(await mainCheckout(git)).toBe(repo.clone)

    expect(await currentTask(inTask)).toEqual({
      issue: 12,
      branch: 'task/12-login-form',
      path: twelve,
    })
    expect(await currentTask(git)).toBeNull()
    expect(await currentTask(createGit({ cwd: join(repo.dir, 'spike'), env: repo.env }))).toBeNull()

    expect(await taskWorktrees(inTask)).toEqual([
      { issue: 12, branch: 'task/12-login-form', path: twelve },
      { issue: 13, branch: 'task/13-api', path: thirteen },
    ])
  })

  test('the worktrees of merged tasks are removed and the others kept, each saying whether its task is merged (A35)', async () => {
    const merged = addTask(12, 'login-form')
    const open = addTask(13, 'api')
    const closedUnmerged = addTask(14, 'dropped')
    const mergedDirty = addTask(15, 'dirty')
    writeFileSync(join(mergedDirty, 'notes.txt'), 'not committed\n')

    const { github, calls } = githubWithClosedPulls([
      { number: 40, branch: 'task/12-login-form', merged: true },
      { number: 41, branch: 'task/14-dropped', merged: false },
      { number: 42, branch: 'task/15-dirty', merged: true },
    ])
    const result = await removeMergedWorktrees(git, github)

    expect(result.removed).toEqual([merged])
    expect(result.kept).toEqual([
      { path: open, reason: 'its pull request is not merged', merged: false },
      { path: closedUnmerged, reason: 'its pull request is not merged', merged: false },
      { path: mergedDirty, reason: 'it has uncommitted changes or untracked files', merged: true },
    ])
    expect(existsSync(merged)).toBe(false)
    expect(existsSync(open)).toBe(true)
    expect(existsSync(mergedDirty)).toBe(true)
    // The branch of the removed worktree stays.
    expect(repo.git(repo.clone, 'branch', '--list', 'task/12-login-form')).toMatch(/task\/12/)
    expect((await taskWorktrees(git)).map((task) => task.issue)).toEqual([13, 14, 15])
    expect(calls).toHaveLength(1)
  })

  test('the current worktree is kept even when its task is merged', async () => {
    const merged = addTask(12, 'login-form')
    const { github } = githubWithClosedPulls([
      { number: 40, branch: 'task/12-login-form', merged: true },
    ])
    const result = await removeMergedWorktrees(createGit({ cwd: merged, env: repo.env }), github)
    expect(result).toEqual({
      removed: [],
      kept: [{ path: merged, reason: 'it is the current worktree', merged: true }],
    })
  })

  test('a locked worktree of a merged task is kept with merged: true', async () => {
    const merged = addTask(12, 'login-form')
    repo.git(repo.clone, 'worktree', 'lock', merged)
    const { github } = githubWithClosedPulls([
      { number: 40, branch: 'task/12-login-form', merged: true },
    ])
    expect(await removeMergedWorktrees(git, github)).toEqual({
      removed: [],
      kept: [{ path: merged, reason: 'it is locked', merged: true }],
    })
  })

  test('without task worktrees GitHub is not asked', async () => {
    const { github, calls } = githubWithClosedPulls([])
    expect(await removeMergedWorktrees(git, github)).toEqual({ removed: [], kept: [] })
    expect(calls).toEqual([])
  })
})

describe('1.3c/hooks-path: core.hooksPath is checked and repaired (E20)', () => {
  test('an unset core.hooksPath is detected and set to .githooks for every worktree', async () => {
    const worktree = addTask(12, 'login-form')
    const inTask = createGit({ cwd: worktree, env: repo.env })

    expect(await checkHooksPath(inTask)).toEqual({ ok: false, value: null })
    expect(await repairHooksPath(inTask)).toEqual({ changed: true })
    expect(await checkHooksPath(inTask)).toEqual({ ok: true, value: HOOKS_PATH })
    expect(await checkHooksPath(git)).toEqual({ ok: true, value: '.githooks' })
    expect(repo.git(repo.clone, 'config', '--local', '--get', 'core.hooksPath').trim()).toBe(
      '.githooks',
    )
    expect(await repairHooksPath(inTask)).toEqual({ changed: false })
  })

  test('a wrong core.hooksPath is detected and set again', async () => {
    repo.git(repo.clone, 'config', 'core.hooksPath', '.git/hooks')
    expect(await checkHooksPath(git)).toEqual({ ok: false, value: '.git/hooks' })
    expect(await repairHooksPath(git)).toEqual({ changed: true })
    expect(await checkHooksPath(git)).toEqual({ ok: true, value: '.githooks' })
  })

  test('the same directory written another way counts as set', async () => {
    repo.git(repo.clone, 'config', 'core.hooksPath', './.githooks/')
    expect(await checkHooksPath(git)).toEqual({ ok: true, value: './.githooks/' })
    expect(await repairHooksPath(git)).toEqual({ changed: false })
  })

  test('a Git with the member hooks switched off still sees the clone setting', async () => {
    repo.git(repo.clone, 'config', 'core.hooksPath', '.githooks')
    expect(await checkHooksPath(git.with({ hooksOff: true }))).toEqual({
      ok: true,
      value: '.githooks',
    })
  })
})

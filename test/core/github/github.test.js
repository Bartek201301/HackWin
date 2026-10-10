import { afterEach, describe, expect, test } from 'vitest'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createGhExecutor,
  createGitHub,
  parseGitHubRemote,
} from '../../../src/core/github/index.js'
import { PreconditionError, RemoteError } from '../../../src/core/runtime/errors.js'
import { createScratch } from '../git/temp-repo.js'

/**
 * A fake executor: answers `gh api --method <METHOD> <endpoint>` from a route table and records
 * every call.
 * @param {Record<string, (call: { method: string, endpoint: string, body: any }) => { code?: number, stdout?: unknown, stderr?: string }>} routes
 *   Keyed by `<METHOD> <endpoint>`.
 */
function fakeExecutor(routes) {
  /** @type {Array<{ args: string[], input?: string, env?: Record<string, string> }>} */
  const calls = []
  /** @type {import('../../../src/core/github/index.js').GhExecutor} */
  const executor = async (args, call = {}) => {
    calls.push({ args, input: call.input, env: call.env })
    const [command, , method, endpoint] = args
    if (command !== 'api') return { code: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` }
    const route = routes[`${method} ${endpoint}`]
    if (!route) return { code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }
    const answer = route({
      method,
      endpoint,
      body: call.input ? JSON.parse(call.input) : undefined,
    })
    const stdout = answer.stdout === undefined ? '' : JSON.stringify(answer.stdout)
    return { code: answer.code ?? 0, stdout, stderr: answer.stderr ?? '' }
  }
  return { executor, calls }
}

const rawIssue = {
  number: 3,
  title: 'Foundation',
  body: 'task body',
  state: 'open',
  state_reason: null,
  labels: [{ name: 'role:integrator' }, { name: 'in-progress' }],
  assignees: [{ login: 'lead' }],
  user: { login: 'lead' },
  html_url: 'https://github.com/o/r/issues/3',
  created_at: '2026-10-10T10:00:00Z',
  updated_at: '2026-10-10T11:00:00Z',
  closed_at: null,
}

/** @type {Array<() => void>} */
const cleanups = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

describe('1.3a/github: the executor seam and typed helpers', () => {
  test('the executor seam can be replaced, and every call carries GH_REPO', async () => {
    const { executor, calls } = fakeExecutor({ 'GET user': () => ({ stdout: { login: 'lead' } }) })
    const github = createGitHub({ executor, repo: 'o/r' })
    expect(await github.login()).toBe('lead')
    expect(await github.login()).toBe('lead')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      args: ['api', '--method', 'GET', 'user'],
      input: undefined,
      env: { GH_REPO: 'o/r' },
    })
  })

  test('issues are read and normalized; a missing issue is null', async () => {
    const { executor } = fakeExecutor({
      'GET repos/{owner}/{repo}/issues/3': () => ({ stdout: rawIssue }),
    })
    const github = createGitHub({ executor, repo: 'o/r' })
    expect(await github.getIssue(3)).toEqual({
      number: 3,
      title: 'Foundation',
      body: 'task body',
      state: 'open',
      stateReason: null,
      labels: ['role:integrator', 'in-progress'],
      assignees: ['lead'],
      author: 'lead',
      url: 'https://github.com/o/r/issues/3',
      createdAt: '2026-10-10T10:00:00Z',
      updatedAt: '2026-10-10T11:00:00Z',
      closedAt: null,
      isPullRequest: false,
    })
    expect(await github.getIssue(4)).toBeNull()
  })

  test('lists are paginated and pull requests are left out of the issue list', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ ...rawIssue, number: i + 1 }))
    const page2 = [
      { ...rawIssue, number: 101 },
      { ...rawIssue, number: 102, pull_request: { url: 'x' } },
    ]
    const { executor, calls } = fakeExecutor({
      'GET repos/{owner}/{repo}/issues?state=open&labels=ready%2Crole%3Alane-b&per_page=100&page=1':
        () => ({ stdout: page1 }),
      'GET repos/{owner}/{repo}/issues?state=open&labels=ready%2Crole%3Alane-b&per_page=100&page=2':
        () => ({ stdout: page2 }),
    })
    const github = createGitHub({ executor, repo: 'o/r' })
    const issues = await github.listIssues({ labels: ['ready', 'role:lane-b'] })
    expect(issues.map((issue) => issue.number)).toEqual([
      ...page1.map((issue) => issue.number),
      101,
    ])
    expect(calls).toHaveLength(2)
  })

  test('writes send a JSON body on stdin', async () => {
    const { executor, calls } = fakeExecutor({
      'POST repos/{owner}/{repo}/issues/3/comments': ({ body }) => ({
        stdout: {
          id: 9,
          body: body.body,
          user: { login: 'lead' },
          html_url: 'u',
          created_at: 't',
          updated_at: 't',
        },
      }),
      'POST repos/{owner}/{repo}/issues/3/labels': ({ body }) => ({
        stdout: body.labels.map((name) => ({ name })),
      }),
      'PATCH repos/{owner}/{repo}/issues/3': ({ body }) => ({ stdout: { ...rawIssue, ...body } }),
    })
    const github = createGitHub({ executor, repo: 'o/r' })
    const comment = await github.createComment(3, 'PR #12 opened')
    expect(comment).toMatchObject({ id: 9, body: 'PR #12 opened', author: 'lead' })
    expect(calls[0].args).toEqual([
      'api',
      '--method',
      'POST',
      'repos/{owner}/{repo}/issues/3/comments',
      '--input',
      '-',
    ])
    expect(JSON.parse(/** @type {string} */ (calls[0].input))).toEqual({ body: 'PR #12 opened' })
    expect(await github.addLabels(3, ['in-review'])).toEqual(['in-review'])
    expect((await github.updateIssue(3, { state: 'closed' })).state).toBe('closed')
    expect(JSON.parse(/** @type {string} */ (calls[2].input))).toEqual({ state: 'closed' })
  })

  test('removing a label the issue lacks is not an error', async () => {
    const { executor, calls } = fakeExecutor({})
    const github = createGitHub({ executor, repo: 'o/r' })
    await expect(github.removeLabel(3, 'gate:failed')).resolves.toBeUndefined()
    expect(calls[0].args[3]).toBe('repos/{owner}/{repo}/issues/3/labels/gate%3Afailed')
    expect(await github.deleteLabel('ready')).toBe(false)
  })

  test('pull requests are normalized and opened, never as drafts', async () => {
    const rawPull = {
      number: 12,
      title: 'Foundation',
      body: 'Closes #3',
      state: 'open',
      draft: false,
      merged_at: null,
      merge_commit_sha: null,
      head: { ref: 'task/3-foundation', sha: 'a'.repeat(40), repo: { full_name: 'o/r' } },
      base: { ref: 'main' },
      labels: [{ name: 'gate:queued' }],
      user: { login: 'builder' },
      html_url: 'https://github.com/o/r/pull/12',
      created_at: 't1',
      updated_at: 't2',
      closed_at: null,
    }
    const { executor, calls } = fakeExecutor({
      'GET repos/{owner}/{repo}/pulls?state=open&per_page=100&page=1': () => ({
        stdout: [
          rawPull,
          { ...rawPull, number: 13, head: { ...rawPull.head, ref: 'task/4-other' } },
        ],
      }),
      'POST repos/{owner}/{repo}/pulls': ({ body }) => ({ stdout: { ...rawPull, ...body } }),
    })
    const github = createGitHub({ executor, repo: 'o/r' })
    const pulls = await github.listPullRequests({ head: 'task/3-foundation' })
    expect(pulls).toHaveLength(1)
    expect(pulls[0]).toMatchObject({
      number: 12,
      headRef: 'task/3-foundation',
      headSha: 'a'.repeat(40),
      baseRef: 'main',
      merged: false,
      labels: ['gate:queued'],
      author: 'builder',
    })
    await github.createPullRequest({
      title: 't',
      head: 'task/3-foundation',
      base: 'main',
      body: 'Closes #3',
    })
    expect(JSON.parse(/** @type {string} */ (calls[1].input)).draft).toBe(false)
  })
})

describe('1.3a/github: a failing gh call becomes exit 3', () => {
  test('a network failure is a remote error with exit 3', async () => {
    const github = createGitHub({
      executor: async () => ({
        code: 1,
        stdout: '',
        stderr:
          'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com\n',
      }),
    })
    const error = await github.login().catch((e) => e)
    expect(error).toBeInstanceOf(RemoteError)
    expect(error.exitCode).toBe(3)
    expect(error.message).toContain('error connecting to api.github.com')
  })

  test('a GitHub error keeps its HTTP status', async () => {
    const github = createGitHub({
      executor: async () => ({
        code: 1,
        stdout: '{"message":"Server Error"}',
        stderr: 'gh: Server Error (HTTP 500)',
      }),
    })
    const error = await github.getIssue(3).catch((e) => e)
    expect(error).toBeInstanceOf(RemoteError)
    expect(error.status).toBe(500)
    expect(error.exitCode).toBe(3)
  })

  test('gh without a login is a precondition error (exit 2) that names the fix', async () => {
    const github = createGitHub({
      executor: async () => ({
        code: 4,
        stdout: '',
        stderr: 'To get started with GitHub CLI, please run:  gh auth login',
      }),
    })
    const error = await github.login().catch((e) => e)
    expect(error).toBeInstanceOf(PreconditionError)
    expect(error.exitCode).toBe(2)
    expect(error.resolve).toEqual({ command: 'gh auth login', dir: 'any directory' })
  })

  test('the real executor runs the gh on PATH without prompts and passes stdin', async () => {
    const scratch = createScratch()
    cleanups.push(scratch.cleanup)
    const fakeGh = join(scratch.dir, 'gh')
    writeFileSync(
      fakeGh,
      '#!/bin/sh\necho "args=$*"\necho "repo=$GH_REPO prompt=$GH_PROMPT_DISABLED"\ncat\n[ "$1" = fail ] && { echo "gh: Bad Gateway (HTTP 502)" >&2; exit 1; }\nexit 0\n',
    )
    chmodSync(fakeGh, 0o755)
    const executor = createGhExecutor({
      env: { ...scratch.env, PATH: `${scratch.dir}:${process.env.PATH}` },
    })
    const ok = await executor(['api', 'user'], { input: 'body', env: { GH_REPO: 'o/r' } })
    expect(ok).toEqual({ code: 0, stdout: 'args=api user\nrepo=o/r prompt=1\nbody', stderr: '' })

    const github = createGitHub({ executor, repo: 'o/r' })
    const error = await github.run(['fail']).catch((e) => e)
    expect(error).toBeInstanceOf(RemoteError)
    expect(error.status).toBe(502)
  })
})

describe('1.3a/github: the repository of a remote', () => {
  test('parseGitHubRemote reads GitHub URLs and ignores local paths', () => {
    expect(parseGitHubRemote('https://github.com/Bartek201301/HackWin')).toBe(
      'Bartek201301/HackWin',
    )
    expect(parseGitHubRemote('https://github.com/o/r.git')).toBe('o/r')
    expect(parseGitHubRemote('git@github.com:o/r.git')).toBe('o/r')
    expect(parseGitHubRemote('ssh://git@github.com/o/r.git')).toBe('o/r')
    expect(parseGitHubRemote('https://user@github.com/o/r.git/')).toBe('o/r')
    expect(parseGitHubRemote('https://ghe.example.com/o/r.git')).toBe('ghe.example.com/o/r')
    expect(parseGitHubRemote('/tmp/origin.git')).toBeNull()
    expect(parseGitHubRemote(null)).toBeNull()
  })
})

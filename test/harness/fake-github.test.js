import { describe, expect, test } from 'vitest'
import { createGitHub } from '../../src/core/github/index.js'
import { RemoteError } from '../../src/core/runtime/errors.js'
import { createFakeClock } from '../../src/core/runtime/clock.js'
import { LABELS, setTaskStatus } from '../../src/core/tasks/index.js'
import { removeMergedWorktrees } from '../../src/core/worktrees/index.js'
import {
  RULESETS_NOT_OFFERED,
  accounts,
  createFakeGitHub,
  createFixture,
  httpError,
  rawResult,
} from './index.js'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

/** @param {ReturnType<typeof createFakeGitHub>} fake */
const clientOf = (fake, login = accounts.lead.login) =>
  createGitHub({ executor: fake.as(login), repo: fake.state.repo })

describe('1.3d/fake-github: the fake GitHub behind the executor seam', () => {
  test('issues behave through the real helpers, and numbers need not start at 1', async () => {
    const fake = createFakeGitHub({
      nextNumber: 40,
      clock: createFakeClock('2026-10-12T10:00:00Z'),
    })
    const github = createGitHub({ executor: fake.executor, repo: fake.state.repo })

    expect(await github.login()).toBe(accounts.lead.login)
    expect(await github.repository()).toMatchObject({
      nameWithOwner: fake.state.repo,
      defaultBranch: 'main',
      permissions: { admin: true, push: true },
    })

    const created = await github.createIssue({
      title: 'Add the counter reset',
      body: 'body',
      labels: ['role:counter', 'ready'],
      assignees: [accounts.builder1.login, 'stranger'],
    })
    expect(created).toMatchObject({
      number: 40,
      title: 'Add the counter reset',
      state: 'open',
      labels: ['role:counter', 'ready'],
      assignees: [accounts.builder1.login],
      author: accounts.lead.login,
      isPullRequest: false,
      createdAt: '2026-10-12T10:00:00Z',
    })
    const second = await github.createIssue({ title: 'Second' })
    expect(second.number).toBe(41)

    expect(await github.getIssue(40)).toEqual(created)
    expect(await github.getIssue(999)).toBeNull()
    expect((await github.listIssues()).map((issue) => issue.number)).toEqual([41, 40])
    expect((await github.listIssues({ labels: ['ready'] })).map((issue) => issue.number)).toEqual([
      40,
    ])
    expect((await github.listIssues({ assignee: 'none' })).map((issue) => issue.number)).toEqual([
      41,
    ])

    const closed = await github.updateIssue(41, { state: 'closed', stateReason: 'not_planned' })
    expect(closed).toMatchObject({ state: 'closed', stateReason: 'not_planned' })
    expect((await github.listIssues()).map((issue) => issue.number)).toEqual([40])
    expect((await github.listIssues({ state: 'all' })).map((issue) => issue.number)).toEqual([
      41, 40,
    ])

    await github.addAssignees(40, [accounts.lead.login])
    await github.removeAssignees(40, [accounts.builder1.login])
    expect((await github.getIssue(40))?.assignees).toEqual([accounts.lead.login])
  })

  test('labels behave through the real helpers, and the task status is a label edit', async () => {
    const fake = createFakeGitHub({ issues: [{ number: 7, title: 'Task' }] })
    const github = clientOf(fake)

    for (const label of LABELS) await github.createLabel(label)
    expect(await github.listLabels()).toEqual(LABELS)
    await expect(
      github.createLabel({ name: 'in-review', color: '000000', description: '' }),
    ).rejects.toMatchObject({ status: 422 })

    expect(await github.addLabels(7, ['ready'])).toEqual(['ready'])
    expect(await setTaskStatus(github, 7, 'in-progress')).toEqual(['in-progress'])
    expect((await github.getIssue(7))?.labels).toEqual(['in-progress'])
    expect(await github.addLabels(7, ['brand-new'])).toEqual(['in-progress', 'brand-new'])
    expect((await github.listLabels()).some((label) => label.name === 'brand-new')).toBe(true)
    await github.removeLabel(7, 'not-there')
    await github.removeLabel(7, 'brand-new')
    expect((await github.getIssue(7))?.labels).toEqual(['in-progress'])

    expect(
      await github.updateLabel('in-progress', { newName: 'working', color: '123456' }),
    ).toEqual({
      name: 'working',
      color: '123456',
      description: 'A session works on it',
    })
    expect((await github.getIssue(7))?.labels).toEqual(['working'])
    expect(await github.deleteLabel('working')).toBe(true)
    expect(await github.deleteLabel('working')).toBe(false)
    expect((await github.getIssue(7))?.labels).toEqual([])
  })

  test('comments behave through the real helpers, oldest first and over several pages', async () => {
    const fake = createFakeGitHub({ issues: [{ number: 3, title: 'Status' }] })
    const github = clientOf(fake)
    const first = await github.createComment(3, 'first')
    const builder = clientOf(fake, accounts.builder2.login)
    await builder.createComment(3, 'from builder2')
    expect((await github.listComments(3)).map((comment) => [comment.body, comment.author])).toEqual(
      [
        ['first', accounts.lead.login],
        ['from builder2', accounts.builder2.login],
      ],
    )
    const edited = await github.updateComment(first.id, 'edited')
    expect(edited).toMatchObject({ id: first.id, body: 'edited', author: accounts.lead.login })

    for (let index = 0; index < 150; index += 1) await github.createComment(3, `c${index}`)
    const all = await github.listComments(3)
    expect(all).toHaveLength(152)
    expect(all.at(-1)?.body).toBe('c149')
    await expect(github.updateComment(99_999, 'x')).rejects.toBeInstanceOf(RemoteError)
  })

  test('pull requests behave through the real helpers: head SHA, draft, state, body, labels and files', async () => {
    const fake = createFakeGitHub({
      branches: { main: SHA_A, 'task/12-counter': SHA_B },
      issues: [{ number: 12, title: 'Counter', body: 'task' }],
      pulls: [
        {
          number: 9,
          title: 'Draft',
          head: 'task/9-draft',
          headSha: SHA_A,
          draft: true,
          files: [{ path: 'a.txt', status: 'modified', previousPath: null }],
        },
      ],
    })
    const github = clientOf(fake, accounts.builder1.login)

    const pull = await github.createPullRequest({
      title: 'Counter',
      head: 'task/12-counter',
      base: 'main',
      body: 'Closes #12',
    })
    expect(pull).toMatchObject({
      number: 13,
      state: 'open',
      draft: false,
      merged: false,
      headRef: 'task/12-counter',
      headSha: SHA_B,
      baseRef: 'main',
      body: 'Closes #12',
      author: accounts.builder1.login,
      headRepo: fake.state.repo,
    })
    await expect(
      github.createPullRequest({ title: 'Again', head: 'task/12-counter', base: 'main', body: '' }),
    ).rejects.toMatchObject({ status: 422 })
    await expect(
      github.createPullRequest({ title: 'Nothing', head: 'task/99-none', base: 'main', body: '' }),
    ).rejects.toMatchObject({ status: 422 })

    expect(await github.getPullRequest(9)).toMatchObject({ draft: true, headSha: SHA_A })
    expect(await github.getPullRequest(12)).toBeNull()
    expect((await github.listPullRequests()).map((own) => own.number)).toEqual([13, 9])
    expect(
      (await github.listPullRequests({ head: 'task/12-counter' })).map((own) => own.number),
    ).toEqual([13])
    expect(await github.listPullRequestFiles(9)).toEqual([
      { path: 'a.txt', status: 'modified', previousPath: null },
    ])

    // The issue side of a pull request carries its labels and comments.
    await github.addLabels(13, ['gate:queued'])
    await github.createComment(13, 'queued')
    expect((await github.getPullRequest(13))?.labels).toEqual(['gate:queued'])
    expect((await github.listIssues()).map((issue) => issue.number)).toEqual([12])
    expect((await github.listComments(13)).map((comment) => comment.body)).toEqual(['queued'])

    // A new push moves the head SHA of an open pull request.
    fake.setBranch('task/12-counter', 'c'.repeat(40))
    expect((await github.getPullRequest(13))?.headSha).toBe('c'.repeat(40))

    const closed = await github.updatePullRequest(13, {
      state: 'closed',
      body: 'Closes #12\nchanged',
    })
    expect(closed).toMatchObject({ state: 'closed', merged: false, body: 'Closes #12\nchanged' })
    expect((await github.listPullRequests({ state: 'closed' })).map((own) => own.number)).toEqual([
      13,
    ])
  })

  test('a merge pinned to a SHA: refused for another head, then a merge commit that closes the task', async () => {
    const fake = createFakeGitHub({
      branches: { main: SHA_A, 'task/4-x': SHA_B },
      issues: [{ number: 4, title: 'X' }],
      pulls: [{ number: 5, title: 'X', head: 'task/4-x', body: 'Closes #4' }],
    })
    const github = clientOf(fake)
    const wrong = github.run(['pr', 'merge', '5', '--merge', '--match-head-commit', SHA_A])
    await expect(wrong).rejects.toThrow(/Head branch was modified/)
    await expect(
      github.run(['pr', 'merge', '5', '--merge', '--match-head-commit', 'bbbbbbb']),
    ).rejects.toThrow(/Could not coerce value "bbbbbbb" to GitObjectID/)
    expect((await github.getPullRequest(5))?.merged).toBe(false)

    await github.run(['pr', 'merge', '5', '--merge', '--match-head-commit', SHA_B])
    const merged = await github.getPullRequest(5)
    expect(merged).toMatchObject({ state: 'closed', merged: true, headSha: SHA_B })
    expect(merged?.mergeCommitSha).toMatch(/^[0-9a-f]{40}$/)
    expect(fake.state.branches.main).toBe(merged?.mergeCommitSha)
    expect(await github.getIssue(4)).toMatchObject({ state: 'closed', stateReason: 'completed' })
    await expect(
      github.run(['pr', 'merge', '5', '--merge', '--match-head-commit', SHA_B]),
    ).rejects.toThrow(/is not open/)
  })

  test('checks: check runs per commit, and a required check gates the merge', async () => {
    const fake = createFakeGitHub({
      branches: { main: SHA_A, 'task/4-x': SHA_B },
      pulls: [{ number: 5, title: 'X', head: 'task/4-x' }],
      requiredChecks: ['hackwin'],
    })
    const github = clientOf(fake)
    const merge = () => github.run(['pr', 'merge', '5', '--merge', '--match-head-commit', SHA_B])
    await expect(merge()).rejects.toThrow(/Required status check "hackwin" is expected/)
    fake.addCheckRun(SHA_B, { name: 'hackwin', status: 'in_progress' })
    await expect(merge()).rejects.toThrow(/is in progress/)
    fake.addCheckRun(SHA_B, { name: 'hackwin', conclusion: 'failure' })
    await expect(merge()).rejects.toThrow(/is failing/)

    const runs = await github.api(`repos/{owner}/{repo}/commits/${SHA_B}/check-runs`)
    expect(runs.total_count).toBe(2)
    expect(runs.check_runs[0]).toMatchObject({
      name: 'hackwin',
      head_sha: SHA_B,
      app: { id: 15368 },
    })

    fake.addCheckRun(SHA_B, { name: 'hackwin', conclusion: 'success' })
    await merge()
    expect((await github.getPullRequest(5))?.merged).toBe(true)
  })

  test('with a linked origin: real merge commits, files from the diff, and merged worktrees removed', async () => {
    const fixture = await createFixture({ team: 3 })
    const fake = createFakeGitHub({ origin: fixture.origin })
    const github = clientOf(fake, accounts.builder1.login)
    const start = await fixture.git.revParse('origin/main')
    const one = await fixture.worktree({
      issue: 1,
      title: 'One',
      files: { 'one.txt': '1\n' },
      push: true,
    })
    const two = await fixture.worktree({
      issue: 2,
      title: 'Two',
      files: { 'two.txt': '2\n' },
      push: true,
    })
    const first = await github.createPullRequest({
      title: 'One',
      head: one.branch,
      base: 'main',
      body: 'Closes #1',
    })
    const second = await github.createPullRequest({
      title: 'Two',
      head: two.branch,
      base: 'main',
      body: 'Closes #2',
    })
    expect(await github.listPullRequestFiles(second.number)).toEqual([
      { path: 'two.txt', status: 'added', previousPath: null },
    ])

    const lead = clientOf(fake)
    await lead.run([
      'pr',
      'merge',
      String(first.number),
      '--merge',
      '--match-head-commit',
      first.headSha,
    ])
    await lead.run([
      'pr',
      'merge',
      String(second.number),
      '--merge',
      '--match-head-commit',
      second.headSha,
    ])
    const mergedFirst = await lead.getPullRequest(first.number)
    const mergedSecond = await lead.getPullRequest(second.number)
    await fixture.git.fetch()
    expect(await fixture.git.revParse('origin/main')).toBe(mergedSecond?.mergeCommitSha)
    expect(await fixture.git.revParse('origin/main^1')).toBe(mergedFirst?.mergeCommitSha)
    expect(await fixture.git.revParse('origin/main^2')).toBe(second.headSha)

    // A pull request that conflicts with main is not mergeable.
    const three = await fixture.worktree({
      issue: 3,
      title: 'Three',
      base: start,
      files: { 'one.txt': 'other\n' },
      push: true,
    })
    const third = await github.createPullRequest({
      title: 'Three',
      head: three.branch,
      base: 'main',
      body: '',
    })
    await expect(
      lead.run([
        'pr',
        'merge',
        String(third.number),
        '--merge',
        '--match-head-commit',
        third.headSha,
      ]),
    ).rejects.toThrow(/not mergeable/)
    await fixture.git.fetch()
    expect(await fixture.git.revParse('origin/main')).toBe(mergedSecond?.mergeCommitSha)

    const removal = await removeMergedWorktrees(fixture.git, lead)
    expect(removal.removed.sort()).toEqual([one.path, two.path].sort())
    expect(removal.kept).toEqual([
      { path: three.path, reason: 'its pull request is not merged', merged: false },
    ])
    fixture.cleanup()
  })

  test('collaborators, invitations and pinned issues', async () => {
    const fake = createFakeGitHub({
      collaborators: { [accounts.lead.login]: 'admin' },
      issues: [1, 2, 3, 4].map((number) => ({ number, title: `Issue ${number}` })),
    })
    const github = clientOf(fake)
    await github.api(`repos/{owner}/{repo}/collaborators/${accounts.lead.login}`)
    await expect(
      github.api(`repos/{owner}/{repo}/collaborators/${accounts.builder1.login}`),
    ).rejects.toMatchObject({ status: 404 })
    await github.api(`repos/{owner}/{repo}/collaborators/${accounts.builder1.login}`, {
      method: 'PUT',
      body: { permission: 'push' },
    })
    await github.api(`repos/{owner}/{repo}/collaborators/${accounts.builder1.login}`, {
      method: 'PUT',
      body: { permission: 'push' },
    })
    expect(fake.state.invitations.map((invitation) => invitation.login)).toEqual([
      accounts.builder1.login,
    ])
    expect((await clientOf(fake, accounts.builder1.login).repository()).permissions.push).toBe(
      false,
    )

    for (const number of [1, 2, 3]) await github.run(['issue', 'pin', String(number)])
    await expect(github.run(['issue', 'pin', '4'])).rejects.toThrow(/at most 3 pinned issues/)
    await github.run(['issue', 'unpin', '1'])
    await github.run(['issue', 'pin', '4'])
    expect(fake.state.items.filter((item) => item.pinned).map((item) => item.number)).toEqual([
      2, 3, 4,
    ])
  })

  test('milestones: an issue carries its milestone as GitHub returns it on an issue, or null', async () => {
    const fake = createFakeGitHub({
      clock: createFakeClock('2026-10-12T10:00:00Z'),
      milestones: [
        { number: 1, title: 'Wave 1', due_on: '2026-10-25T10:00:00Z' },
        { number: 2, title: 'Wave 2', state: 'closed', open_issues: 11, closed_issues: 2 },
      ],
      issues: [
        { number: 10, title: 'First task', milestone: 1 },
        { number: 11, title: 'Done task', state: 'closed', milestone: 1 },
        { number: 12, title: 'Without a wave' },
        { number: 14, title: 'Old task', milestone: 2 },
      ],
      pulls: [
        { number: 13, title: 'First task', head: 'task/10-first', headSha: SHA_A, milestone: 1 },
      ],
    })
    const github = clientOf(fake)
    /** @param {string} path */
    const get = (path) => github.api(`repos/{owner}/{repo}/${path}`)

    // The open and closed counts take the pull request too, as GitHub's do.
    const wave1 = {
      id: fake.state.milestones[0].id,
      number: 1,
      title: 'Wave 1',
      description: null,
      state: 'open',
      open_issues: 2,
      closed_issues: 1,
      creator: { login: accounts.lead.login, type: 'User' },
      html_url: 'https://github.com/hackwin-test/app/milestone/1',
      created_at: '2026-10-12T10:00:00Z',
      updated_at: '2026-10-12T10:00:00Z',
      closed_at: null,
      due_on: '2026-10-25T10:00:00Z',
    }
    expect((await get('issues/10')).milestone).toEqual(wave1)
    expect((await get('issues/12')).milestone).toBeNull()
    expect((await get('pulls/13')).milestone).toEqual(wave1)
    // Counts a milestone gives are returned as given.
    expect((await get('issues/14')).milestone).toMatchObject({
      number: 2,
      state: 'closed',
      open_issues: 11,
      closed_issues: 2,
      closed_at: '2026-10-12T10:00:00Z',
    })

    const list = await github.api('repos/{owner}/{repo}/issues', { query: { state: 'all' } })
    expect(
      list.map((/** @type {any} */ issue) => [issue.number, issue.milestone?.number ?? null]),
    ).toEqual([
      [14, 2],
      [13, 1],
      [12, null],
      [11, 1],
      [10, 1],
    ])
    expect(list.find((/** @type {any} */ issue) => issue.number === 10).milestone).toEqual(wave1)
    expect(list.find((/** @type {any} */ issue) => issue.number === 12)).toHaveProperty(
      'milestone',
      null,
    )
    /** @param {string} milestone */
    const numbersOf = async (milestone) =>
      (await github.api('repos/{owner}/{repo}/issues', { query: { state: 'all', milestone } })).map(
        (/** @type {any} */ issue) => issue.number,
      )
    expect(await numbersOf('1')).toEqual([13, 11, 10])
    expect(await numbersOf('none')).toEqual([12])
    expect(await numbersOf('*')).toEqual([14, 13, 11, 10])

    // An issue created or edited with a milestone; one the repository lacks is refused.
    const created = await github.api('repos/{owner}/{repo}/issues', {
      method: 'POST',
      body: { title: 'Second task', milestone: 1 },
    })
    expect(created.milestone).toMatchObject({ number: 1, open_issues: 3 })
    expect((await get(`issues/${created.number}`)).milestone).toMatchObject({ number: 1 })
    expect((await github.createIssue({ title: 'Plain' })).number).toBe(16)
    expect((await get('issues/16')).milestone).toBeNull()
    await expect(
      github.api('repos/{owner}/{repo}/issues', {
        method: 'POST',
        body: { title: 'Lost', milestone: 9 },
      }),
    ).rejects.toMatchObject({ status: 422 })
    const moved = await github.api('repos/{owner}/{repo}/issues/12', {
      method: 'PATCH',
      body: { milestone: 1 },
    })
    expect(moved.milestone).toMatchObject({ number: 1, open_issues: 4 })
    const cleared = await github.api('repos/{owner}/{repo}/issues/12', {
      method: 'PATCH',
      body: { milestone: null },
    })
    expect(cleared.milestone).toBeNull()
    await expect(
      github.api('repos/{owner}/{repo}/issues/12', { method: 'PATCH', body: { milestone: 9 } }),
    ).rejects.toMatchObject({ status: 422 })

    // A test adds one later and sets it on an issue directly.
    const wave3 = fake.addMilestone({ title: 'Wave 3', description: 'Polish' })
    expect(wave3).toMatchObject({ number: 3, state: 'open', description: 'Polish' })
    const issue12 = /** @type {NonNullable<ReturnType<typeof fake.find>>} */ (fake.find(12))
    issue12.milestone = wave3.number
    expect((await get('issues/12')).milestone).toMatchObject({
      number: 3,
      title: 'Wave 3',
      description: 'Polish',
      open_issues: 1,
      closed_issues: 0,
    })
    expect(() =>
      createFakeGitHub({ issues: [{ number: 1, title: 'Task', milestone: 1 }] }),
    ).toThrow(/no milestone 1/)
  })

  test('a lane registers handlers for its own calls, and an unknown call fails by name', async () => {
    const fake = createFakeGitHub()
    const github = clientOf(fake)
    await expect(github.api('repos/{owner}/{repo}/environments')).rejects.toThrow(
      /no handler for gh api --method GET repos\/\{owner\}\/\{repo\}\/environments/,
    )
    expect(fake.unhandled).toHaveLength(1)

    const remove = fake.on('GET repos/{owner}/{repo}/environments', ({ query }) => [
      { id: 1, name: 'production', page: query.page },
    ])
    fake.on('POST repos/{owner}/{repo}/autolinks', ({ body }) => {
      if (!body.key_prefix) throw httpError(422, 'Validation Failed')
      return { id: 2, ...body }
    })
    fake.on('run rerun', ({ args }) => rawResult({ stdout: `rerun ${args[2]}\n` }))
    fake.on('GET repos/{owner}/{repo}/issues/:number', ({ params }) => ({
      number: Number(params.number),
      title: 'overridden',
      state: 'open',
      labels: [],
      assignees: [],
    }))

    expect(await github.apiPages('repos/{owner}/{repo}/environments')).toEqual([
      { id: 1, name: 'production', page: '1' },
    ])
    expect(
      await github.api('repos/{owner}/{repo}/autolinks', {
        method: 'POST',
        body: { key_prefix: 'T-' },
      }),
    ).toEqual({ id: 2, key_prefix: 'T-' })
    await expect(
      github.api('repos/{owner}/{repo}/autolinks', { method: 'POST', body: {} }),
    ).rejects.toMatchObject({ status: 422 })
    expect((await github.run(['run', 'rerun', '77', '--failed'])).stdout).toBe('rerun 77\n')
    expect((await github.getIssue(5))?.title).toBe('overridden')

    remove()
    await expect(github.api('repos/{owner}/{repo}/environments')).rejects.toThrow(/no handler/)
    await expect(
      github.run(['api', 'repos/{owner}/{repo}/issues', '--jq', '.[0]']),
    ).rejects.toThrow(/--jq is not supported/)
    expect(fake.calls.every((call) => call.login === accounts.lead.login)).toBe(true)
  })

  test('rule sets: listed without their rules, created, read with the bypass of the caller, updated and deleted', async () => {
    const fake = createFakeGitHub({
      clock: createFakeClock('2026-10-15T10:00:00Z'),
      rulesets: [{ name: 'old', enforcement: 'disabled' }],
    })
    const lead = clientOf(fake)
    const builder = clientOf(fake, accounts.builder1.login)
    const body = {
      name: 'hackwin-update-restriction',
      target: 'branch',
      enforcement: 'active',
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
      bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }],
      rules: [{ type: 'update', parameters: { update_allows_fetch_and_merge: false } }],
    }

    const created = await lead.api('repos/{owner}/{repo}/rulesets', { method: 'POST', body })
    expect(created).toEqual({
      ...body,
      id: 2,
      source_type: 'Repository',
      source: fake.state.repo,
      created_at: '2026-10-15T10:00:00Z',
      updated_at: '2026-10-15T10:00:00Z',
      current_user_can_bypass: 'always',
    })
    expect(await lead.api('repos/{owner}/{repo}/rulesets/2')).toEqual(created)
    // The admin role is the bypass actor, so a builder with write access cannot bypass it.
    expect(await builder.api('repos/{owner}/{repo}/rulesets/2')).toMatchObject({
      current_user_can_bypass: 'never',
    })

    expect(
      await lead.apiPages('repos/{owner}/{repo}/rulesets', {
        query: { includes_parents: 'false' },
      }),
    ).toEqual([
      {
        id: 1,
        name: 'old',
        target: 'branch',
        source_type: 'Repository',
        source: fake.state.repo,
        enforcement: 'disabled',
        created_at: '2026-10-15T10:00:00Z',
        updated_at: '2026-10-15T10:00:00Z',
      },
      expect.objectContaining({ id: 2, name: 'hackwin-update-restriction', enforcement: 'active' }),
    ])
    expect((await lead.apiPages('repos/{owner}/{repo}/rulesets'))[1]).not.toHaveProperty('rules')

    // Only the active rule sets that target the branch give its rules.
    expect(await lead.apiPages('repos/{owner}/{repo}/rules/branches/main')).toEqual([
      {
        type: 'update',
        parameters: { update_allows_fetch_and_merge: false },
        ruleset_source_type: 'Repository',
        ruleset_source: fake.state.repo,
        ruleset_id: 2,
      },
    ])
    expect(await lead.apiPages('repos/{owner}/{repo}/rules/branches/task/1-x')).toEqual([])

    for (const invalid of [
      { ...body, name: '' },
      { ...body, enforcement: 'on' },
    ]) {
      await expect(
        lead.api('repos/{owner}/{repo}/rulesets', { method: 'POST', body: invalid }),
      ).rejects.toMatchObject({ status: 422 })
    }

    // An update changes only the fields it names, as `-f enforcement=disabled` does (E1).
    const disabled = await lead.api('repos/{owner}/{repo}/rulesets/2', {
      method: 'PUT',
      body: { enforcement: 'disabled' },
    })
    expect(disabled).toEqual({ ...created, enforcement: 'disabled' })
    expect(await lead.apiPages('repos/{owner}/{repo}/rules/branches/main')).toEqual([])
    await expect(
      lead.api('repos/{owner}/{repo}/rulesets/2', { method: 'PUT', body: { enforcement: 'on' } }),
    ).rejects.toMatchObject({ status: 422 })
    await expect(
      lead.api('repos/{owner}/{repo}/rulesets/9', { method: 'PUT', body: { name: 'x' } }),
    ).rejects.toMatchObject({ status: 404 })

    expect(await lead.api('repos/{owner}/{repo}/rulesets/2', { method: 'DELETE' })).toBeNull()
    await expect(lead.api('repos/{owner}/{repo}/rulesets/2')).rejects.toMatchObject({
      status: 404,
    })
    await expect(
      lead.api('repos/{owner}/{repo}/rulesets/2', { method: 'DELETE' }),
    ).rejects.toMatchObject({ status: 404 })
    expect(fake.state.rulesets.map((ruleset) => ruleset.name)).toEqual(['old'])
    expect(fake.addRuleset({ name: 'later' }).id).toBe(3)
    expect(fake.unhandled).toEqual([])
  })

  test('rule sets where GitHub offers none: every request answers HTTP 403', async () => {
    const fake = createFakeGitHub({ visibility: 'private', rulesetsOffered: false })
    const lead = clientOf(fake)
    for (const call of [
      () => lead.api('repos/{owner}/{repo}/rulesets'),
      () => lead.api('repos/{owner}/{repo}/rulesets', { method: 'POST', body: { name: 'x' } }),
      () => lead.api('repos/{owner}/{repo}/rulesets/1'),
      () => lead.api('repos/{owner}/{repo}/rulesets/1', { method: 'PUT', body: { name: 'x' } }),
      () => lead.api('repos/{owner}/{repo}/rulesets/1', { method: 'DELETE' }),
      () => lead.api('repos/{owner}/{repo}/rules/branches/main'),
    ]) {
      const error = await call().catch((caught) => caught)
      expect(error).toBeInstanceOf(RemoteError)
      expect(error).toMatchObject({ status: 403 })
      expect(error.message).toContain(RULESETS_NOT_OFFERED)
    }
  })

  test('a pull request from a fork reports its head repository; a deleted fork reports none', async () => {
    const fake = createFakeGitHub({
      branches: { main: SHA_A, 'task/12-counter': SHA_B },
      issues: [{ number: 12, title: 'Counter' }],
      pulls: [
        {
          number: 20,
          title: 'From a fork',
          head: 'task/12-counter',
          headRepo: 'someone/fork',
          headSha: 'c'.repeat(40),
          author: accounts.builder2.login,
          files: [],
        },
        { number: 21, title: 'From a deleted fork', head: 'patch-1', headRepo: null },
      ],
    })
    const github = clientOf(fake, accounts.builder1.login)
    expect(await github.getPullRequest(20)).toMatchObject({
      headRef: 'task/12-counter',
      headRepo: 'someone/fork',
      // The fork's head does not follow the branch of the same name in this repository.
      headSha: 'c'.repeat(40),
    })
    expect(await github.getPullRequest(21)).toMatchObject({ headRepo: null, headSha: null })
    const raw = await github.api('repos/{owner}/{repo}/pulls/21')
    expect(raw.head.repo).toBeNull()

    // The repository's own pull request for the same branch name is no duplicate of the fork's.
    const own = await github.createPullRequest({
      title: 'Counter',
      head: 'task/12-counter',
      base: 'main',
      body: 'Closes #12',
    })
    expect(own).toMatchObject({ number: 22, headRepo: fake.state.repo, headSha: SHA_B })
    fake.find(22).pull.headRepo = 'someone/fork'
    expect((await github.getPullRequest(22))?.headRepo).toBe('someone/fork')
  })

  test('another repository answers 404, and builder2 acts only here', async () => {
    const fake = createFakeGitHub({ issues: [{ number: 1, title: 'One' }] })
    const other = createGitHub({ executor: fake.executor, repo: 'someone/else' })
    expect(await other.getIssue(1)).toBeNull()
    await expect(
      createGitHub({ executor: fake.executor }).api('repos/someone/else/issues/1'),
    ).rejects.toMatchObject({ status: 404 })

    const builder2 = clientOf(fake, accounts.builder2.login)
    expect(await builder2.login()).toBe(accounts.builder2.login)
    expect((await builder2.createComment(1, 'done')).author).toBe(accounts.builder2.login)
    expect(fake.calls.at(-1)).toMatchObject({
      login: accounts.builder2.login,
      method: 'POST',
      code: 0,
    })
  })
})

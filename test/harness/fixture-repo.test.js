// Offline tests of the fixture repository driver: the repository list, the accounts, the lock,
// the guard, the reset and withFixtureRepo, all against the fake GitHub. The same driver runs on
// real GitHub in fixture-repo.fixture.test.js.

import { afterEach, describe, expect, test } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGitHub } from '../../src/core/github/index.js'
import { NAME_ONLY_LOGINS, REDACTED, TOKEN_VARIABLE, accounts, redact } from './accounts.js'
import { createFakeGitHub, httpError, rawResult } from './fake-github.js'
import { FIXTURE_REPOS, RESET_SHA, SANDBOX, fixtureRepo } from './fixture-repos.js'
import { inspectFixtureRepo, withFixtureRepo } from './fixture-repo.js'
import { BUILD_REPO, guardExecutor, refusalOf } from './guard.js'
import { acquireLock } from './lock.js'
import { RESET_ATTEMPTS, resetFixtureRepo } from './reset.js'
import { TEAM_SIZES, teamMembers } from './team.js'

/** @type {string[]} */
const scratch = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hackwin-driver-')))
  scratch.push(dir)
  return dir
}

/**
 * A fake fixture repository: dirty, with a rule set, branch rules and pinned issues, the rule
 * sets held by the fake GitHub and the rest answered by handlers the way GitHub answers them.
 * @param {string} name
 * @param {{ rulesetsRefused?: boolean, collaborators?: Record<string, string> }} [options]
 */
function fakeFixtureRepo(name, { rulesetsRefused = false, collaborators } = {}) {
  const info = fixtureRepo(name)
  const fake = createFakeGitHub({
    repo: info.repo,
    login: accounts.lead.login,
    collaborators: collaborators ?? {
      [accounts.lead.login]: 'admin',
      [accounts.builder1.login]: 'write',
    },
    visibility: info.visibility,
    nextNumber: 40,
    branches: { main: 'c'.repeat(40), 'task/41-x': 'd'.repeat(40), 'spike/left': 'e'.repeat(40) },
    labels: ['bug', 'documentation'],
    issues: [
      { number: 41, title: 'Open task', labels: ['ready'], pinned: true },
      { number: 42, title: 'Done', state: 'closed' },
    ],
    pulls: [{ number: 43, title: 'Open pull request', head: 'task/41-x', body: 'Closes #41' }],
    rulesets: [{ id: 7, name: 'hackwin-branch-rules' }],
    rulesetsOffered: !rulesetsRefused,
  })
  let rules = [{ id: 'BPR_1', pattern: 'main' }]
  fake.on('POST graphql', ({ fields, body }) => {
    if (fields.query.includes('deleteBranchProtectionRule')) {
      rules = rules.filter((rule) => rule.id !== body.id)
      return { data: { deleteBranchProtectionRule: { clientMutationId: null } } }
    }
    expect(body).toMatchObject({ owner: 'Bartek201301', name: info.name })
    const pinned = fake.state.items.filter((item) => item.pinned)
    return {
      data: {
        repository: {
          branchProtectionRules: { nodes: rules },
          pinnedIssues: { nodes: pinned.map((item) => ({ issue: { number: item.number } })) },
        },
      },
    }
  })
  return { fake, info, rulesets: () => fake.state.rulesets, rules: () => rules }
}

describe('1.3d/driver: the fixture repositories and accounts', () => {
  test('the four names and the reset commit equal section 6.4 of docs/build/contracts.md', () => {
    const contracts = readFileSync(
      new URL('../../docs/build/contracts.md', import.meta.url),
      'utf8',
    )
    const section = contracts.slice(contracts.indexOf('### 6.4'))
    expect(FIXTURE_REPOS.map((repo) => repo.repo)).toEqual([
      'Bartek201301/hackwin-fixture-a',
      'Bartek201301/hackwin-fixture-b',
      'Bartek201301/hackwin-fixture-c',
      'Bartek201301/hackwin-fixture-private',
    ])
    for (const repo of FIXTURE_REPOS) {
      expect(section).toContain(
        `\`${repo.repo}\` | ${repo.visibility === 'public' ? 'Public' : 'Private'}`,
      )
    }
    expect(section).toContain(RESET_SHA)
    expect(FIXTURE_REPOS.filter((repo) => repo.protectionRefused).map((repo) => repo.name)).toEqual(
      ['hackwin-fixture-private'],
    )
  })

  test('only a fixture repository is accepted, and never hackwin-sandbox', async () => {
    expect(fixtureRepo('Bartek201301/hackwin-fixture-c').name).toBe('hackwin-fixture-c')
    expect(() => fixtureRepo(SANDBOX)).toThrow(/never touch/)
    expect(() => fixtureRepo('Bartek201301/hackwin-sandbox')).toThrow(/never touch/)
    expect(() => fixtureRepo('HackWin')).toThrow(/not a fixture repository/)
    await expect(withFixtureRepo(SANDBOX, async () => {})).rejects.toThrow(/never touch/)
  })

  test('the accounts: builder2 is a name only, and solo is the Lead', () => {
    expect(accounts.lead.login).toBe('Bartek201301')
    expect(accounts.solo.login).toBe(accounts.lead.login)
    expect(accounts.builder1).toMatchObject({ login: 'test-bot-builder', live: true })
    expect(accounts.builder2).toMatchObject({ login: 'maljul', live: false })
  })

  test('the token is out of the environment of every test, and redact() removes it from text', () => {
    expect(process.env[TOKEN_VARIABLE]).toBeUndefined()
    expect(redact('Authorization: token ghp_secretvalue end', 'ghp_secretvalue')).toBe(
      `Authorization: token ${REDACTED} end`,
    )
    expect(redact('nothing to hide', null)).toBe('nothing to hide')
  })
})

describe('1.3d/driver: the lock per repository', () => {
  test('a second session waits while the first holds the lock, and takes it once released', async () => {
    const dir = tempDir()
    // Another live process holds the lock: the parent of this test process.
    mkdirSync(join(dir, 'hackwin-fixture-a.lock'))
    const holder = {
      pid: process.ppid,
      host: hostname(),
      cwd: '/elsewhere',
      since: '2026-10-12T10:00:00Z',
    }
    writeFileSync(join(dir, 'hackwin-fixture-a.lock', 'holder.json'), JSON.stringify(holder))

    /** @type {unknown[]} */
    const waits = []
    await expect(
      acquireLock('hackwin-fixture-a', {
        dir,
        timeoutMs: 300,
        pollMs: 50,
        onWait: (who) => waits.push(who),
      }),
    ).rejects.toThrow(new RegExp(`still locked .* by process ${process.ppid} .* /elsewhere`))
    expect(waits).toEqual([holder])

    setTimeout(() => rmSync(join(dir, 'hackwin-fixture-a.lock'), { recursive: true }), 150)
    const release = await acquireLock('hackwin-fixture-a', { dir, timeoutMs: 5000, pollMs: 25 })
    const own = JSON.parse(readFileSync(join(dir, 'hackwin-fixture-a.lock', 'holder.json'), 'utf8'))
    expect(own.pid).toBe(process.pid)
    await expect(acquireLock('hackwin-fixture-a', { dir, timeoutMs: 100 })).rejects.toThrow(
      /do not nest/,
    )
    // Another repository has its own lock.
    const releaseB = await acquireLock('hackwin-fixture-b', { dir, timeoutMs: 100 })
    release()
    releaseB()
    expect(existsSync(join(dir, 'hackwin-fixture-a.lock'))).toBe(false)
    release()
  })

  test('a lock whose holder process is gone is taken over', async () => {
    const dir = tempDir()
    const gone = spawnSync(process.execPath, ['-e', '0']).pid
    mkdirSync(join(dir, 'hackwin-fixture-c.lock'))
    writeFileSync(
      join(dir, 'hackwin-fixture-c.lock', 'holder.json'),
      JSON.stringify({ pid: gone, host: hostname(), cwd: '/gone', since: '2026-10-12T10:00:00Z' }),
    )
    const release = await acquireLock('hackwin-fixture-c', { dir, timeoutMs: 1000 })
    release()
  })

  test('a lock left by a dead process of this machine under another host name is taken over', async () => {
    // #94: on macOS the host name changes with the network, and a lock of the old name stayed
    // held, so every scenario on that repository waited its full timeout.
    const dir = tempDir()
    const gone = spawnSync(process.execPath, ['-e', '0']).pid
    mkdirSync(join(dir, 'hackwin-fixture-private.lock'))
    writeFileSync(
      join(dir, 'hackwin-fixture-private.lock', 'holder.json'),
      JSON.stringify({
        pid: gone,
        host: `${hostname()}-before-the-network-changed`,
        cwd: '/gone',
        since: '2026-10-16T18:59:17.891Z',
      }),
    )
    const release = await acquireLock('hackwin-fixture-private', { dir, timeoutMs: 1000 })
    release()
  })

  test('a lock whose process id now belongs to a process that started later is taken over', async () => {
    const dir = tempDir()
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore',
    })
    try {
      const hourAgo = new Date(Date.now() - 3_600_000).toISOString()
      mkdirSync(join(dir, 'hackwin-fixture-a.lock'))
      writeFileSync(
        join(dir, 'hackwin-fixture-a.lock', 'holder.json'),
        JSON.stringify({
          pid: child.pid,
          host: hostname(),
          cwd: '/an-hour-ago',
          since: hourAgo,
          started: hourAgo,
        }),
      )
      const release = await acquireLock('hackwin-fixture-a', { dir, timeoutMs: 1000 })
      release()
    } finally {
      child.kill()
    }
  })

  test('a lock whose live process started when its holder file says is kept', async () => {
    const dir = tempDir()
    const before = new Date().toISOString()
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore',
    })
    try {
      mkdirSync(join(dir, 'hackwin-fixture-b.lock'))
      writeFileSync(
        join(dir, 'hackwin-fixture-b.lock', 'holder.json'),
        JSON.stringify({
          pid: child.pid,
          host: `${hostname()}-another-name`,
          cwd: '/live',
          since: new Date().toISOString(),
          started: before,
        }),
      )
      await expect(
        acquireLock('hackwin-fixture-b', { dir, timeoutMs: 300, pollMs: 50 }),
      ).rejects.toThrow(new RegExp(`still locked .* by process ${child.pid} `))
    } finally {
      child.kill()
    }
  })
})

describe('1.3d/driver: the guard in front of real GitHub', () => {
  const repo = 'Bartek201301/hackwin-fixture-a'
  const env = { GH_REPO: repo }

  test('refuses hackwin-sandbox, other repositories, deletions, the delete_repo scope and gh auth', () => {
    expect(
      refusalOf(['api', '--method', 'GET', 'repos/Bartek201301/hackwin-sandbox'], {}, repo),
    ).toMatch(/never touch/)
    expect(
      refusalOf(
        ['api', '--method', 'GET', 'repos/{owner}/{repo}'],
        { env: { GH_REPO: 'Bartek201301/hackwin-sandbox' } },
        repo,
      ),
    ).toMatch(/never touch/)
    expect(
      refusalOf(
        ['api', '--method', 'GET', 'repos/{owner}/{repo}'],
        { env: { GH_REPO: 'Bartek201301/HackWin' } },
        repo,
      ),
    ).toMatch(/calls only/)
    expect(
      refusalOf(
        ['api', '--method', 'GET', 'repos/Bartek201301/hackwin-fixture-b/labels'],
        { env },
        repo,
      ),
    ).toMatch(/calls only/)
    expect(refusalOf(['api', '--method', 'DELETE', 'repos/{owner}/{repo}'], { env }, repo)).toMatch(
      /ever deleted/,
    )
    expect(refusalOf(['repo', 'delete', repo, '--yes'], { env }, repo)).toMatch(/ever deleted/)
    expect(refusalOf(['auth', 'refresh', '-s', 'delete_repo'], {}, repo)).toMatch(/delete_repo/)
    expect(refusalOf(['auth', 'token'], {}, repo)).toMatch(/gh auth/)
  })

  test('every login of a fixture team that no test may act as is a name-only login', () => {
    expect(NAME_ONLY_LOGINS).toEqual(['maljul', 'hackwin-test-builder3'])
    const live = [accounts.lead.login, accounts.builder1.login]
    const named = new Set(
      TEAM_SIZES.flatMap((size) => teamMembers(size).map((member) => member.github)),
    )
    expect([...named].filter((login) => !live.includes(login)).sort()).toEqual(
      [...NAME_ONLY_LOGINS].sort(),
    )
  })

  test.each(NAME_ONLY_LOGINS)('refuses to invite, assign or mention %s', (login) => {
    const refused = new RegExp(`${login}\\b.*never invited, assigned or mentioned on real GitHub`)
    const calls = [
      [['api', '--method', 'PUT', `repos/{owner}/{repo}/collaborators/${login}`], {}],
      [['api', '--method', 'PUT', `repos/{owner}/{repo}/collaborators/${login.toUpperCase()}`], {}],
      [
        ['api', '--method', 'POST', 'repos/{owner}/{repo}/issues', '--input', '-'],
        { input: JSON.stringify({ title: 't', assignees: [login] }) },
      ],
      [
        [
          'api',
          '--method',
          'POST',
          'repos/{owner}/{repo}/pulls/4/requested_reviewers',
          '--input',
          '-',
        ],
        { input: JSON.stringify({ reviewers: [login] }) },
      ],
      [
        ['api', '--method', 'POST', 'repos/{owner}/{repo}/issues/3/comments', '--input', '-'],
        { input: JSON.stringify({ body: `thanks @${login}.` }) },
      ],
      [['issue', 'edit', '3', '--add-assignee', `someone,${login}`], {}],
      [['issue', 'create', '--title', 't', '-a', `@${login}`], {}],
      [['pr', 'edit', '4', '--add-reviewer', login], {}],
      [['issue', 'comment', '3', '--body', `@${login} please look`], {}],
    ]
    for (const [args, call] of calls) {
      expect(refusalOf(/** @type {string[]} */ (args), { env, ...call }, repo)).toMatch(refused)
    }
    // A team configuration may name the login: only an invitation, assignment or mention is
    // refused, and a longer login that starts with it is another account.
    expect(
      refusalOf(
        ['api', '--method', 'POST', 'repos/{owner}/{repo}/issues', '--input', '-'],
        { env, input: JSON.stringify({ title: 't', body: `members: ${login}` }) },
        repo,
      ),
    ).toBeNull()
    expect(
      refusalOf(
        ['api', '--method', 'POST', 'repos/{owner}/{repo}/issues/3/comments', '--input', '-'],
        { env, input: JSON.stringify({ body: `thanks @${login}-other` }) },
        repo,
      ),
    ).toBeNull()
  })

  test('allows the calls of a scenario that name no such login', () => {
    expect(
      refusalOf(
        ['api', '--method', 'GET', 'repos/{owner}/{repo}/labels?per_page=100&page=1'],
        { env },
        repo,
      ),
    ).toBeNull()
    expect(
      refusalOf(
        ['api', '--method', 'POST', 'repos/{owner}/{repo}/issues/3/assignees', '--input', '-'],
        { env, input: JSON.stringify({ assignees: [accounts.builder1.login] }) },
        repo,
      ),
    ).toBeNull()
    expect(
      refusalOf(['api', 'graphql', '-f', 'query=query { viewer { login } }'], {}, repo),
    ).toBeNull()
  })

  test('a refused call never reaches the executor, and every call is recorded', async () => {
    /** @type {string[][]} */
    const reached = []
    /** @type {import('./guard.js').GuardedCall[]} */
    const calls = []
    const executor = guardExecutor(
      async (args) => {
        reached.push(args)
        return { code: 0, stdout: '{"login":"x"}', stderr: '' }
      },
      { repo, account: 'lead', calls },
    )
    const github = createGitHub({ executor, repo })
    await github.api('repos/{owner}/{repo}')
    await expect(github.api(`repos/Bartek201301/${SANDBOX}`)).rejects.toThrow(
      /refused by the test harness/,
    )
    expect(reached).toEqual([['api', '--method', 'GET', 'repos/{owner}/{repo}']])
    expect(calls.map((call) => [call.args[3], call.refused === null, call.code])).toEqual([
      ['repos/{owner}/{repo}', true, 0],
      [`repos/Bartek201301/${SANDBOX}`, false, 1],
    ])
  })
})

describe('1.3d/driver: the guard lets a call through only for the fixture repository', () => {
  const repo = 'Bartek201301/hackwin-fixture-a'
  const env = { GH_REPO: repo }
  const issue = JSON.stringify({ title: 'Counter reset', body: 'x' })

  test('the call of the incident of 20 October 2026: {owner}/{repo} without GH_REPO is refused', () => {
    // A scenario of #28 made its client without a repository, so gh filled {owner}/{repo} from
    // the git remote of its worktree, Bartek201301/HackWin, and created issues #102 to #105 there.
    expect(
      refusalOf(
        ['api', '--method', 'POST', 'repos/{owner}/{repo}/issues', '--input', '-'],
        { input: issue },
        repo,
      ),
    ).toMatch(/names no repository and GH_REPO is not set/)
    expect(
      refusalOf(
        ['api', '--method', 'POST', 'repos/{owner}/{repo}/issues', '--input', '-'],
        { env, input: issue },
        repo,
      ),
    ).toBeNull()
  })

  test('the same client as in the incident never reaches gh', async () => {
    /** @type {string[][]} */
    const reached = []
    /** @type {import('./guard.js').GuardedCall[]} */
    const calls = []
    const executor = guardExecutor(
      async (args) => {
        reached.push(args)
        return { code: 0, stdout: '{"number":102}', stderr: '' }
      },
      { repo, account: 'lead', calls },
    )
    const github = createGitHub({ executor })
    await expect(github.createIssue({ title: 'Counter reset', body: 'x' })).rejects.toThrow(
      /refused by the test harness: this call names no repository/,
    )
    expect(reached).toEqual([])
    expect(calls).toHaveLength(1)
  })

  test('a subcommand that names no repository is refused without GH_REPO', () => {
    expect(refusalOf(['issue', 'create', '--title', 'Counter reset'], {}, repo)).toMatch(
      /names no repository/,
    )
    expect(refusalOf(['label', 'list'], {}, repo)).toMatch(/names no repository/)
    expect(refusalOf(['repo', 'view'], {}, repo)).toMatch(/names no repository/)
    expect(refusalOf(['issue', 'create', '--title', 'Counter reset'], { env }, repo)).toBeNull()
  })

  test('every way to name the build repository is refused', () => {
    const build = /calls only .*not Bartek201301\/HackWin: the build repository is never reached/
    expect(BUILD_REPO).toBe('Bartek201301/HackWin')
    expect(
      refusalOf(['api', 'repos/{owner}/{repo}/issues'], { env: { GH_REPO: BUILD_REPO } }, repo),
    ).toMatch(build)
    expect(refusalOf(['issue', 'create', '-R', BUILD_REPO, '--title', 't'], { env }, repo)).toMatch(
      build,
    )
    expect(refusalOf(['issue', 'create', `--repo=${BUILD_REPO}`], { env }, repo)).toMatch(build)
    expect(refusalOf(['pr', 'list', '--repo', 'bartek201301/hackwin'], {}, repo)).toMatch(build)
    expect(refusalOf(['repo', 'view', BUILD_REPO], {}, repo)).toMatch(build)
    expect(
      refusalOf(
        ['api', '--method', 'POST', `https://api.github.com/repos/${BUILD_REPO}/issues`],
        { env },
        repo,
      ),
    ).toMatch(build)
    expect(
      refusalOf(
        [
          'api',
          'graphql',
          '-f',
          'query=query($owner: String!, $name: String!) { x }',
          '-F',
          'owner=Bartek201301',
          '-F',
          'name=HackWin',
        ],
        { env },
        repo,
      ),
    ).toMatch(build)
    expect(
      refusalOf(
        [
          'api',
          'graphql',
          '-f',
          'query=query { repository(owner: "Bartek201301", name: "HackWin") { id } }',
        ],
        { env },
        repo,
      ),
    ).toMatch(build)
  })

  test('the same forms pass when they name the fixture repository', () => {
    expect(refusalOf(['issue', 'create', '-R', repo, '--title', 't'], {}, repo)).toBeNull()
    expect(refusalOf(['pr', 'list', `--repo=${repo}`], {}, repo)).toBeNull()
    expect(refusalOf(['repo', 'view', repo], {}, repo)).toBeNull()
    expect(
      refusalOf(['api', `https://api.github.com/repos/${repo}/labels`], { env }, repo),
    ).toBeNull()
    expect(
      refusalOf(
        [
          'api',
          'graphql',
          '-f',
          'query=query($owner: String!, $name: String!) { x }',
          '-F',
          'owner=Bartek201301',
          '-F',
          'name=hackwin-fixture-a',
        ],
        {},
        repo,
      ),
    ).toBeNull()
  })

  test('reads that act on no repository pass; a write outside repos/ does not', () => {
    expect(refusalOf(['api', 'user'], {}, repo)).toBeNull()
    expect(refusalOf(['api', '--method', 'GET', 'users/test-bot-builder'], {}, repo)).toBeNull()
    expect(
      refusalOf(['api', 'graphql', '-f', 'query=query { viewer { login } }'], {}, repo),
    ).toBeNull()
    expect(refusalOf(['version'], {}, repo)).toBeNull()
    expect(refusalOf(['api', 'user/repos', '-f', 'name=new'], {}, repo)).toMatch(
      /writes only to its fixture repository/,
    )
    expect(refusalOf(['api', '--method', 'POST', 'user/repos'], {}, repo)).toMatch(/writes only/)
  })

  test('the residual forms of the review of PR #108 are refused (#94)', () => {
    const mutation = 'query=mutation { unpinIssue(input: {issueId: "I_1"}) { clientMutationId } }'
    expect(refusalOf(['api', 'graphql', '-f', mutation], {}, repo)).toMatch(/names no repository/)
    expect(refusalOf(['api', 'graphql', '-f', mutation], { env }, repo)).toBeNull()
    const build = /not Bartek201301\/HackWin: the build repository/
    expect(
      refusalOf(
        [
          'api',
          'graphql',
          '-f',
          'query=query($o: String!, $r: String!) { repository(owner: $o, name: $r) { id } }',
          '-F',
          'repoOwner=Bartek201301',
          '-F',
          'repoName=HackWin',
        ],
        { env },
        repo,
      ),
    ).toMatch(build)
    expect(
      refusalOf(
        ['api', 'graphql', '-f', 'query=query($r: String!) { x }', '-F', 'r=Bartek201301/HackWin'],
        { env },
        repo,
      ),
    ).toMatch(build)
    // The check named hackwin, or a fixture name that starts with the build repository's, is no
    // build repository.
    expect(
      refusalOf(
        [
          'api',
          'graphql',
          '-f',
          'query=query { x }',
          '-F',
          'owner=Bartek201301',
          '-F',
          'name=hackwin-fixture-a',
          '-F',
          'context=hackwin',
        ],
        { env },
        repo,
      ),
    ).toBeNull()
    expect(
      refusalOf(
        ['api', 'graphql', '-f', 'query=query { x }', '-F', 'r=Bartek201301/hackwin-fixture-a'],
        { env },
        repo,
      ),
    ).toBeNull()
    expect(refusalOf(['api', '-XPOST', 'user/repos'], {}, repo)).toMatch(/writes only/)
    expect(refusalOf(['api', '--method=POST', 'user/repos'], {}, repo)).toMatch(/writes only/)
    expect(refusalOf(['api', '--method=GET', 'user'], {}, repo)).toBeNull()
    expect(refusalOf(['repo', 'create', 'new-repo'], { env }, repo)).toMatch(/created or forked/)
    expect(refusalOf(['repo', 'fork', repo], { env }, repo)).toMatch(/created or forked/)
    expect(refusalOf(['gist', 'create', 'notes.txt'], { env }, repo)).toMatch(/gists/)
  })

  test('a guard for a repository that is no fixture repository lets nothing through', () => {
    expect(refusalOf(['api', 'user'], {}, BUILD_REPO)).toMatch(/not a fixture repository/)
    expect(
      refusalOf(['api', 'repos/{owner}/{repo}'], { env: { GH_REPO: BUILD_REPO } }, BUILD_REPO),
    ).toMatch(/not a fixture repository/)
  })
})

describe('1.3d/driver: the reset of a fixture repository', () => {
  test('closes pull requests and issues, unpins, deletes branches, labels and rules, and resets main', async () => {
    const { fake, info, rulesets, rules } = fakeFixtureRepo('hackwin-fixture-b')
    const github = createGitHub({ executor: fake.executor, repo: info.repo })
    /** @type {string[]} */
    const lines = []
    const report = await resetFixtureRepo(github, info, { log: (line) => lines.push(line) })
    expect(report).toEqual({
      repo: info.repo,
      deletedRulesets: [{ id: 7, name: 'hackwin-branch-rules' }],
      deletedBranchRules: ['main'],
      closedPullRequests: [43],
      closedIssues: [41],
      unpinnedIssues: [41],
      deletedBranches: ['spike/left', 'task/41-x'],
      deletedLabels: ['bug', 'documentation', 'ready'],
      main: { before: 'c'.repeat(40), after: RESET_SHA },
      accepted: [],
    })
    expect(rulesets()).toEqual([])
    expect(rules()).toEqual([])
    expect(fake.state.branches.main).toBe(RESET_SHA)
    expect(fake.state.items.map((item) => [item.number, item.state, item.pinned])).toEqual([
      [41, 'closed', false],
      [42, 'closed', false],
      [43, 'closed', false],
    ])
    expect(fake.find(41)?.stateReason).toBe('not_planned')
    expect(fake.state.labels).toEqual([])
    // main is the only branch left.
    expect(fake.state.branches).toEqual({ main: RESET_SHA })
    expect(lines.at(-1)).toMatch(
      /pull requests closed #43; issues closed #41; unpinned #41; branches deleted spike\/left, task\/41-x/,
    )

    // A second reset finds nothing to do.
    const again = await resetFixtureRepo(github, info)
    expect(again).toMatchObject({
      closedIssues: [],
      deletedBranches: [],
      deletedLabels: [],
      main: { before: RESET_SHA },
    })
  })

  test('a reset that does not hold fails and names what is left', async () => {
    const { fake, info } = fakeFixtureRepo('hackwin-fixture-c')
    // GitHub keeps the branch: the deletion answers, but nothing changes.
    fake.on('DELETE repos/{owner}/{repo}/git/refs/heads/:branch*', () => undefined)
    await expect(
      resetFixtureRepo(createGitHub({ executor: fake.executor, repo: info.repo }), info),
    ).rejects.toThrow(/did not hold: branches: main, spike\/left, task\/41-x/)
  })

  test('inspectFixtureRepo reads the state under the lock without changing it', async () => {
    const stateDir = tempDir()
    const { fake } = fakeFixtureRepo('hackwin-fixture-b')
    const executors = { lead: fake.as(accounts.lead.login) }
    const dirty = await inspectFixtureRepo('hackwin-fixture-b', { stateDir, executors })
    expect(dirty.state).toEqual({
      repo: 'Bartek201301/hackwin-fixture-b',
      main: 'c'.repeat(40),
      branches: ['main', 'spike/left', 'task/41-x'],
      openIssues: [41],
      openPullRequests: [43],
      labels: ['bug', 'documentation', 'ready'],
      rulesets: ['hackwin-branch-rules'],
      branchRules: ['main'],
      pinnedIssues: [41],
      accepted: [],
    })
    expect(dirty.problems).toHaveLength(8)
    expect(dirty.calls.every((call) => call.refused === null)).toBe(true)
    expect(
      fake.calls.filter((call) => call.method !== 'GET' && call.endpoint !== 'graphql'),
    ).toEqual([])
    expect(
      fake.calls.filter((call) => call.endpoint === 'graphql').map((call) => call.body.query),
    ).toEqual([expect.not.stringContaining('mutation')])
    expect(existsSync(join(stateDir, 'locks', 'hackwin-fixture-b.lock'))).toBe(false)
  })

  test('on hackwin-fixture-private an HTTP 403 on rule sets is accepted; on a public one it fails', async () => {
    const privateRepo = fakeFixtureRepo('hackwin-fixture-private', { rulesetsRefused: true })
    const report = await resetFixtureRepo(
      createGitHub({ executor: privateRepo.fake.executor, repo: privateRepo.info.repo }),
      privateRepo.info,
    )
    expect(report.accepted).toEqual(['rule sets: HTTP 403'])
    expect(report.deletedRulesets).toEqual([])
    expect(privateRepo.fake.state.branches.main).toBe(RESET_SHA)

    const publicRepo = fakeFixtureRepo('hackwin-fixture-c', { rulesetsRefused: true })
    await expect(
      resetFixtureRepo(
        createGitHub({ executor: publicRepo.fake.executor, repo: publicRepo.info.repo }),
        publicRepo.info,
      ),
    ).rejects.toMatchObject({ status: 403 })
  })

  test('a missing main is created at the reset commit', async () => {
    const { fake, info } = fakeFixtureRepo('hackwin-fixture-a')
    delete fake.state.branches.main
    fake.state.items = []
    await resetFixtureRepo(createGitHub({ executor: fake.executor, repo: info.repo }), info)
    expect(fake.state.branches.main).toBe(RESET_SHA)
  })
})

describe('1.3d/reset: deletions already done, calls made again, and the logs of failed runs', () => {
  /** The calls of the fake with this method and endpoint. */
  const callsOf = (
    /** @type {ReturnType<typeof createFakeGitHub>} */ fake,
    /** @type {string} */ method,
    /** @type {string} */ endpoint,
  ) => fake.calls.filter((call) => call.method === method && call.endpoint === endpoint)

  test('a 404 on deleting a rule set, a branch or a label counts as done', async () => {
    const { fake, info } = fakeFixtureRepo('hackwin-fixture-b')
    // Each object is gone by the time the reset deletes it, as after an earlier attempt whose
    // answer was lost: GitHub answers 404.
    fake.on('DELETE repos/{owner}/{repo}/rulesets/:id', ({ params }) => {
      const index = fake.state.rulesets.findIndex((ruleset) => ruleset.id === Number(params.id))
      fake.state.rulesets.splice(index, 1)
      throw httpError(404, 'Not Found')
    })
    fake.on('DELETE repos/{owner}/{repo}/git/refs/heads/:branch*', ({ params }) => {
      delete fake.state.branches[params.branch]
      // The fake's own answer for a branch that does not exist is 422; both count as gone.
      if (params.branch === 'spike/left') throw httpError(404, 'Not Found')
      throw httpError(422, 'Reference does not exist')
    })
    fake.on('DELETE repos/{owner}/{repo}/labels/:name', ({ params }) => {
      const index = fake.state.labels.findIndex((label) => label.name === params.name)
      fake.state.labels.splice(index, 1)
      throw httpError(404, 'Not Found')
    })
    /** @type {string[]} */
    const lines = []
    const github = createGitHub({ executor: fake.executor, repo: info.repo })
    const report = await resetFixtureRepo(github, info, { log: (line) => lines.push(line) })
    expect(report).toMatchObject({
      deletedRulesets: [{ id: 7, name: 'hackwin-branch-rules' }],
      deletedBranches: ['spike/left', 'task/41-x'],
      deletedLabels: ['bug', 'documentation', 'ready'],
      accepted: [
        'rule set hackwin-branch-rules: HTTP 404, already gone',
        'branch spike/left: HTTP 404, already gone',
        'branch task/41-x: HTTP 422, already gone',
        'label bug: HTTP 404, already gone',
        'label documentation: HTTP 404, already gone',
        'label ready: HTTP 404, already gone',
      ],
    })
    expect(fake.state.rulesets).toEqual([])
    expect(fake.state.branches).toEqual({ main: RESET_SHA })
    expect(fake.state.labels).toEqual([])
    expect(lines).toContain(
      'reset Bartek201301/hackwin-fixture-b: branch spike/left: HTTP 404, already gone, accepted',
    )
    // Each deletion was made once: a 404 is not made again.
    expect(callsOf(fake, 'DELETE', 'repos/{owner}/{repo}/rulesets/7')).toHaveLength(1)

    // Another refusal of a deletion still fails the reset, with GitHub's message.
    const refused = fakeFixtureRepo('hackwin-fixture-b')
    refused.fake.on('DELETE repos/{owner}/{repo}/git/refs/heads/:branch*', () => {
      throw httpError(422, 'Cannot delete this protected branch')
    })
    await expect(
      resetFixtureRepo(
        createGitHub({ executor: refused.fake.executor, repo: refused.info.repo }),
        refused.info,
      ),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringMatching(/Cannot delete this protected branch/),
    })
  })

  test('a call that fails without an HTTP status, or with a 5xx, is made again and the reset then holds', async () => {
    const { fake, info } = fakeFixtureRepo('hackwin-fixture-b')
    // The deletion takes effect, but its answer is cut: no HTTP status. The second attempt finds
    // the rule set gone (404).
    const offDelete = fake.on('DELETE repos/{owner}/{repo}/rulesets/:id', ({ params }) => {
      offDelete()
      const index = fake.state.rulesets.findIndex((ruleset) => ruleset.id === Number(params.id))
      fake.state.rulesets.splice(index, 1)
      return rawResult({ code: 1, stderr: 'unexpected end of JSON input\n' })
    })
    // The network fails once on the list of labels.
    const offLabels = fake.on('GET repos/{owner}/{repo}/labels', () => {
      offLabels()
      return rawResult({ code: 1, stderr: 'net/http: TLS handshake timeout\n' })
    })
    // GitHub answers 502 and then 503 on the reset of main, before the third attempt passes.
    const failures = [httpError(502, 'Bad Gateway'), httpError(503, 'Service Unavailable')]
    const offMain = fake.on('PATCH repos/{owner}/{repo}/git/refs/heads/:branch*', () => {
      const failure = failures.shift()
      if (failures.length === 0) offMain()
      throw failure
    })
    /** @type {string[]} */
    const lines = []
    const report = await resetFixtureRepo(
      createGitHub({ executor: fake.executor, repo: info.repo }),
      info,
      { log: (line) => lines.push(line), retryDelayMs: 0 },
    )
    expect(report).toMatchObject({
      deletedRulesets: [{ id: 7, name: 'hackwin-branch-rules' }],
      deletedLabels: ['bug', 'documentation', 'ready'],
      main: { before: 'c'.repeat(40), after: RESET_SHA },
      accepted: ['rule set hackwin-branch-rules: HTTP 404, already gone'],
    })
    expect(fake.state.rulesets).toEqual([])
    expect(fake.state.labels).toEqual([])
    expect(fake.state.branches).toEqual({ main: RESET_SHA })
    expect(callsOf(fake, 'DELETE', 'repos/{owner}/{repo}/rulesets/7')).toHaveLength(2)
    expect(callsOf(fake, 'PATCH', 'repos/{owner}/{repo}/git/refs/heads/main')).toHaveLength(3)
    const retries = lines.filter((line) => line.includes('; attempt '))
    expect(retries).toEqual([
      `reset ${info.repo}: GitHub call failed: gh api --method DELETE repos/{owner}/{repo}/rulesets/7: unexpected end of JSON input; attempt 2 of ${RESET_ATTEMPTS} in 0 ms`,
      `reset ${info.repo}: GitHub call failed: gh api --method GET repos/{owner}/{repo}/labels?per_page=100&page=1: net/http: TLS handshake timeout; attempt 2 of ${RESET_ATTEMPTS} in 0 ms`,
      `reset ${info.repo}: GitHub call failed: gh api --method PATCH repos/{owner}/{repo}/git/refs/heads/main: gh: Bad Gateway (HTTP 502); attempt 2 of ${RESET_ATTEMPTS} in 0 ms`,
      `reset ${info.repo}: GitHub call failed: gh api --method PATCH repos/{owner}/{repo}/git/refs/heads/main: gh: Service Unavailable (HTTP 503); attempt 3 of ${RESET_ATTEMPTS} in 0 ms`,
    ])
  })

  test('a call is made at most RESET_ATTEMPTS times, waiting longer each time; other failures are not made again', async () => {
    const { fake, info } = fakeFixtureRepo('hackwin-fixture-c')
    fake.on('DELETE repos/{owner}/{repo}/labels/:name', () => {
      throw httpError(503, 'Service Unavailable')
    })
    /** @type {string[]} */
    const lines = []
    await expect(
      resetFixtureRepo(createGitHub({ executor: fake.executor, repo: info.repo }), info, {
        log: (line) => lines.push(line),
        retryDelayMs: 1,
      }),
    ).rejects.toMatchObject({ status: 503 })
    expect(RESET_ATTEMPTS).toBeGreaterThanOrEqual(3)
    expect(callsOf(fake, 'DELETE', 'repos/{owner}/{repo}/labels/bug')).toHaveLength(RESET_ATTEMPTS)
    expect(lines.map((line) => /in (\d+) ms$/.exec(line)?.[1]).filter(Boolean)).toEqual(
      Array.from({ length: RESET_ATTEMPTS - 1 }, (_, index) => String(2 ** index)),
    )

    // A 4xx other than a 404 on a deletion fails at once.
    const conflict = fakeFixtureRepo('hackwin-fixture-c')
    conflict.fake.on('PATCH repos/{owner}/{repo}/git/refs/heads/:branch*', () => {
      throw httpError(422, 'Object does not exist')
    })
    await expect(
      resetFixtureRepo(
        createGitHub({ executor: conflict.fake.executor, repo: conflict.info.repo }),
        conflict.info,
        { retryDelayMs: 0 },
      ),
    ).rejects.toMatchObject({ status: 422 })
    expect(
      callsOf(conflict.fake, 'PATCH', 'repos/{owner}/{repo}/git/refs/heads/main'),
    ).toHaveLength(1)

    // A refusal of the guard has no HTTP status, and it is not made again either.
    const other = fakeFixtureRepo('hackwin-fixture-c')
    /** @type {import('./guard.js').GuardedCall[]} */
    const calls = []
    const guarded = guardExecutor(other.fake.executor, {
      repo: 'Bartek201301/hackwin-fixture-a',
      account: 'lead',
      calls,
    })
    await expect(
      resetFixtureRepo(createGitHub({ executor: guarded, repo: other.info.repo }), other.info, {
        retryDelayMs: 0,
      }),
    ).rejects.toThrow(/refused by the test harness: this scenario calls only/)
    expect(calls).toHaveLength(1)
    expect(other.fake.calls).toEqual([])
  })

  test("after a failed run, the next run keeps that run's log and full error", async () => {
    const stateDir = tempDir()
    const logs = join(stateDir, 'logs')
    const { fake } = fakeFixtureRepo('hackwin-fixture-b')
    const executors = {
      lead: fake.as(accounts.lead.login),
      builder1: fake.as(accounts.builder1.login),
    }
    // A gh call of the scenario fails with two lines of output; the message names only the first.
    fake.on('GET repos/{owner}/{repo}/environments', () =>
      rawResult({ code: 1, stderr: 'unexpected EOF\nsecond line of gh\n' }),
    )
    await expect(
      withFixtureRepo(
        'hackwin-fixture-b',
        async (repo) => {
          await repo.github('lead').api('repos/{owner}/{repo}/environments')
        },
        { stateDir, executors },
      ),
    ).rejects.toThrow(/unexpected EOF/)
    const failed = readFileSync(join(logs, 'hackwin-fixture-b.log'), 'utf8')
    expect(failed).toMatch(
      /lead gh api --method GET repos\/\{owner\}\/\{repo\}\/environments -> exit 1: unexpected EOF \| second line of gh/,
    )
    // The full error: its class and message, the stack, the status and gh's output.
    expect(failed).toMatch(
      /run on hackwin-fixture-b failed: RemoteError: GitHub call failed: gh api --method GET repos\/\{owner\}\/\{repo\}\/environments: unexpected EOF\n\s+at /,
    )
    expect(failed).toMatch(
      /details: \{ status: null, tail: \[ 'unexpected EOF', 'second line of gh' \] \}/,
    )
    expect(failed).not.toMatch(/scenario on hackwin-fixture-b passed/)
    const started = failed.slice(0, failed.indexOf(' ')).replaceAll(':', '-')

    // The next run keeps it, and names where.
    await withFixtureRepo('hackwin-fixture-b', async () => {}, { stateDir, executors })
    const keptName = `hackwin-fixture-b.failed-${started}.log`
    expect(readdirSync(logs).sort()).toEqual([keptName, 'hackwin-fixture-b.log'])
    expect(readFileSync(join(logs, keptName), 'utf8')).toBe(failed)
    const next = readFileSync(join(logs, 'hackwin-fixture-b.log'), 'utf8')
    expect(next).toContain(
      `the log of the previous run on hackwin-fixture-b, which did not pass, is kept in ${join(logs, keptName)}`,
    )
    expect(next).toMatch(/scenario on hackwin-fixture-b passed/)

    // The log of a passed run is replaced by the next run, as before.
    await withFixtureRepo('hackwin-fixture-b', async () => {}, { stateDir, executors })
    expect(readdirSync(logs).sort()).toEqual([keptName, 'hackwin-fixture-b.log'])
    expect(readFileSync(join(logs, 'hackwin-fixture-b.log'), 'utf8')).not.toContain('is kept in')

    // A run that ended without a word, killed for example, is kept as well.
    const interrupted = '2026-10-15T08:00:00.000Z lock of hackwin-fixture-b taken by process 1\n'
    writeFileSync(join(logs, 'hackwin-fixture-b.log'), interrupted)
    await withFixtureRepo('hackwin-fixture-b', async () => {}, { stateDir, executors })
    expect(
      readFileSync(join(logs, 'hackwin-fixture-b.failed-2026-10-15T08-00-00.000Z.log'), 'utf8'),
    ).toBe(interrupted)
    expect(readdirSync(logs)).toHaveLength(3)
  })
})

describe('1.3d/driver: withFixtureRepo against the fake GitHub', () => {
  test('runs the scenario under the lock after the reset, as the Lead and as builder1', async () => {
    const stateDir = tempDir()
    const { fake, info } = fakeFixtureRepo('hackwin-fixture-b')
    const lock = join(stateDir, 'locks', 'hackwin-fixture-b.lock')
    const executors = {
      lead: fake.as(accounts.lead.login),
      builder1: fake.as(accounts.builder1.login),
    }

    const result = await withFixtureRepo(
      'hackwin-fixture-b',
      async (repo) => {
        expect(existsSync(lock)).toBe(true)
        expect(repo.repo).toBe(info.repo)
        expect(repo.logins).toEqual({
          lead: accounts.lead.login,
          builder1: accounts.builder1.login,
          builder2: accounts.builder2.login,
          solo: accounts.lead.login,
        })
        expect(repo.report.closedIssues).toEqual([41])
        await repo.github('lead').createLabel({ name: 'ready', color: '0e8a16', description: '' })
        expect((await repo.github('builder1').listLabels()).map((label) => label.name)).toEqual([
          'ready',
        ])
        expect(await repo.github('solo').login()).toBe(accounts.lead.login)
        expect(() => repo.github('builder2')).toThrow(/only against the fake GitHub/)
        await expect(repo.github('lead').api(`repos/Bartek201301/${SANDBOX}`)).rejects.toThrow(
          /refused/,
        )
        for (const login of NAME_ONLY_LOGINS) {
          await expect(
            repo.github('lead').api(`repos/{owner}/{repo}/collaborators/${login}`, {
              method: 'PUT',
              body: { permission: 'push' },
            }),
          ).rejects.toThrow(/refused by the test harness: .*never invited/)
        }
        return 'done'
      },
      { stateDir, executors },
    )
    expect(result).toBe('done')
    expect(existsSync(lock)).toBe(false)
    expect(fake.calls.some((call) => call.args.join(' ').includes(SANDBOX))).toBe(false)
    // The refused invitations never reached GitHub.
    expect(fake.state.invitations).toEqual([])
    const log = readFileSync(join(stateDir, 'logs', 'hackwin-fixture-b.log'), 'utf8')
    expect(log).toMatch(
      /accounts: lead Bartek201301 \(admin\), builder1 test-bot-builder \(write\)/,
    )
    expect(log).toMatch(/refused: hackwin-sandbox is for the human's live tests/)
    expect(log).toMatch(/scenario on hackwin-fixture-b passed/)
  })

  test('a scenario that acts only as the Lead checks only the Lead and cannot act as builder1', async () => {
    const stateDir = tempDir()
    // builder1 has no access here and no executor: a scenario of the Lead does not need it.
    const { fake } = fakeFixtureRepo('hackwin-fixture-c', {
      collaborators: { [accounts.lead.login]: 'admin' },
    })
    const result = await withFixtureRepo(
      'hackwin-fixture-c',
      async (repo) => {
        expect(repo.logins).toEqual({
          lead: accounts.lead.login,
          builder1: accounts.builder1.login,
          builder2: accounts.builder2.login,
          solo: accounts.lead.login,
        })
        expect(repo.report.closedIssues).toEqual([41])
        expect(await repo.github('solo').login()).toBe(accounts.lead.login)
        for (const use of [
          () => repo.github('builder1'),
          () => repo.executor('builder1'),
          () => repo.env('builder1'),
        ]) {
          expect(use).toThrow(/acts only as the Lead: name builder1 in the accounts option/)
        }
        await expect(repo.clone('builder1')).rejects.toThrow(/acts only as the Lead/)
        expect(() => repo.github('builder2')).toThrow(/only against the fake GitHub/)
        return 'done'
      },
      { stateDir, executors: { lead: fake.as(accounts.lead.login) }, accounts: ['lead'] },
    )
    expect(result).toBe('done')
    expect(fake.calls.every((call) => call.login === accounts.lead.login)).toBe(true)
    const log = readFileSync(join(stateDir, 'logs', 'hackwin-fixture-c.log'), 'utf8')
    expect(log).toMatch(
      /accounts: lead Bartek201301 \(admin\); builder1 not checked, the scenario acts only as the Lead/,
    )

    // solo is the Lead, and the Lead is still checked.
    const notAdmin = fakeFixtureRepo('hackwin-fixture-c', {
      collaborators: { [accounts.lead.login]: 'write' },
    }).fake
    await expect(
      withFixtureRepo('hackwin-fixture-c', async () => {}, {
        stateDir,
        executors: { lead: notAdmin.as(accounts.lead.login) },
        accounts: ['solo'],
      }),
    ).rejects.toThrow(/the Lead \(Bartek201301\) is not an admin/)

    for (const accountsOption of [[], ['builder2'], ['someone']]) {
      await expect(
        withFixtureRepo('hackwin-fixture-c', async () => {}, {
          stateDir,
          executors: { lead: fake.as(accounts.lead.login) },
          accounts: accountsOption,
        }),
      ).rejects.toThrow(/at least one account|only against the fake GitHub|not someone/)
    }
    expect(existsSync(join(stateDir, 'locks', 'hackwin-fixture-c.lock'))).toBe(false)
  })

  test('a failing scenario releases the lock, and a missing account or access fails by name', async () => {
    const stateDir = tempDir()
    const { fake } = fakeFixtureRepo('hackwin-fixture-a')
    const executors = {
      lead: fake.as(accounts.lead.login),
      builder1: fake.as(accounts.builder1.login),
    }
    await expect(
      withFixtureRepo(
        'hackwin-fixture-a',
        async () => {
          throw new Error('scenario broke')
        },
        { stateDir, executors },
      ),
    ).rejects.toThrow('scenario broke')
    expect(existsSync(join(stateDir, 'locks', 'hackwin-fixture-a.lock'))).toBe(false)

    const noWrite = fakeFixtureRepo('hackwin-fixture-a', {
      collaborators: { [accounts.lead.login]: 'admin' },
    }).fake
    await expect(
      withFixtureRepo('hackwin-fixture-a', async () => {}, {
        stateDir,
        executors: {
          lead: noWrite.as(accounts.lead.login),
          builder1: noWrite.as(accounts.builder1.login),
        },
      }),
    ).rejects.toThrow(
      /builder1 \(test-bot-builder\) has no write access to Bartek201301\/hackwin-fixture-a/,
    )

    await expect(
      withFixtureRepo('hackwin-fixture-a', async () => {}, {
        stateDir,
        executors: { lead: fake.as(accounts.lead.login), builder1: fake.as('someone-else') },
      }),
    ).rejects.toThrow(new RegExp(`${TOKEN_VARIABLE} belongs to someone-else`))

    const notAdmin = fakeFixtureRepo('hackwin-fixture-a', {
      collaborators: { [accounts.lead.login]: 'write', [accounts.builder1.login]: 'write' },
    }).fake
    await expect(
      withFixtureRepo('hackwin-fixture-a', async () => {}, {
        stateDir,
        executors: {
          lead: notAdmin.as(accounts.lead.login),
          builder1: notAdmin.as(accounts.builder1.login),
        },
      }),
    ).rejects.toThrow(/the Lead \(Bartek201301\) is not an admin/)
  })
})

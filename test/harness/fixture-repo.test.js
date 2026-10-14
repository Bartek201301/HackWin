// Offline tests of the fixture repository driver: the repository list, the accounts, the lock,
// the guard, the reset and withFixtureRepo, all against the fake GitHub. The same driver runs on
// real GitHub in fixture-repo.fixture.test.js.

import { afterEach, describe, expect, test } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGitHub } from '../../src/core/github/index.js'
import { NAME_ONLY_LOGINS, REDACTED, TOKEN_VARIABLE, accounts, redact } from './accounts.js'
import { createFakeGitHub } from './fake-github.js'
import { FIXTURE_REPOS, RESET_SHA, SANDBOX, fixtureRepo } from './fixture-repos.js'
import { inspectFixtureRepo, withFixtureRepo } from './fixture-repo.js'
import { guardExecutor, refusalOf } from './guard.js'
import { acquireLock } from './lock.js'
import { resetFixtureRepo } from './reset.js'
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

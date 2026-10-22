import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { hoursAndMinutes } from '../../../src/commands/gate/digest.js'
import { gateFiles, writeHeartbeat } from '../../../src/commands/gate/state.js'
import { unreachable } from '../../../src/commands/status/index.js'
import { RemoteError } from '../../../src/core/runtime/index.js'
import { readLastStatus } from '../../../src/core/state/index.js'
import { accounts, createFakeGitHub, createFixture, httpError } from '../../harness/index.js'
import { fixedClock, runStatus, sharedSections, statusIssue, taskIssue } from './helpers.js'

/** @typedef {import('../../harness/index.js').Fixture} Fixture */

const LEAD = accounts.lead.login
const BUILDER1 = accounts.builder1.login
const BUILDER2 = accounts.builder2.login
const NOW = '2026-10-24T12:00:00.000Z'
const SHA = 'a'.repeat(40)

/** @type {Fixture} */
let fixture

beforeAll(async () => {
  fixture = await createFixture({ team: 3 })
})

afterAll(() => fixture.cleanup())

/**
 * One GitHub state with an item in every section: tasks in progress and in review, two of them
 * overdue, a task that waits for a dependency, an invalid block, a cut task, the Gate's queue, a
 * pull request the Gate has not seen, a draft, a failed pull request and an attention item. The
 * tasks of wave 1 carry its milestone: 2 of its 13 issues are closed.
 */
function teamGitHub() {
  return createFakeGitHub({
    milestones: [{ number: 1, title: 'Wave 1', due_on: '2026-10-25T10:00:00Z' }],
    issues: [
      statusIssue(1, {
        heartbeat_at: '2026-10-24T11:59:00.000Z',
        queue: [21, 20],
        attention: [
          {
            type: 'repeated-failure',
            pr: 22,
            since: '2026-10-24T11:40:00.000Z',
            todo: 'stage merge-test failed twice; look at #22',
          },
        ],
        digest: [
          {
            time: '2026-10-24T11:50:00.000Z',
            pr: 22,
            author: BUILDER2,
            result: 'needs-owner',
            stage: 'conflicts',
            duration: '1m05s',
            note: 'conflict in 1 file',
          },
          {
            time: '2026-10-24T11:30:00.000Z',
            pr: 9,
            author: BUILDER1,
            result: 'merged',
            stage: 'after-merge',
            duration: '3m10s',
            note: '',
          },
        ],
      }),
      // Closed during the event, and before it: both count as done.
      {
        ...taskIssue(4, { role: 'counter', status: null, milestone: 1 }),
        state: 'closed',
        updatedAt: '2026-10-20T08:00:00Z',
      },
      {
        ...taskIssue(5, { role: 'counter', status: null, milestone: 1 }),
        state: 'closed',
        updatedAt: '2026-10-24T08:00:00Z',
      },
      taskIssue(10, {
        role: 'counter',
        title: 'Counter button',
        milestone: 1,
        status: 'in-review',
        assignees: [BUILDER1],
        deadline: '2026-10-24T13:00:00+02:00',
      }),
      taskIssue(11, {
        role: 'todos',
        title: 'Todo list',
        milestone: 1,
        status: 'in-review',
        assignees: [BUILDER1],
        deadline: '2026-10-24T20:00:00+02:00',
      }),
      taskIssue(12, {
        role: 'greeting',
        title: 'Greeting',
        milestone: 1,
        status: 'in-review',
        assignees: [BUILDER2],
      }),
      taskIssue(13, {
        role: 'counter',
        title: 'Counter reset',
        milestone: 1,
        status: 'in-progress',
        assignees: [BUILDER1],
        deadline: '2026-10-24T12:00:00+02:00',
      }),
      taskIssue(14, { role: 'todos', title: 'Todo filter', dependsOn: [10], milestone: 1 }),
      taskIssue(15, { role: 'counter', title: 'Counter step', dependsOn: [4, 5], milestone: 1 }),
      taskIssue(16, {
        role: 'shared',
        title: 'Shared layout',
        status: 'in-progress',
        milestone: 1,
      }),
      taskIssue(17, {
        role: 'todos',
        title: 'No deadline',
        status: null,
        deadline: null,
        milestone: 1,
      }),
      taskIssue(18, { role: 'greeting', title: 'Dropped', labels: ['cut'], milestone: 1 }),
      taskIssue(19, {
        role: 'shared',
        title: 'Shared styles',
        milestone: 1,
        deadline: '2026-10-24T11:30:00+02:00',
      }),
      taskIssue(25, { role: 'greeting', title: 'Greeting style', status: 'blocked', milestone: 1 }),
      taskIssue(31, { role: 'todos', title: 'Todo export', wave: 2 }),
      { number: 30, title: 'Question for the Lead', body: 'Which colour?', labels: ['needs-lead'] },
    ],
    pulls: [
      {
        number: 20,
        title: 'Counter button',
        head: 'task/10-counter-button',
        headSha: SHA,
        author: BUILDER1,
        labels: ['gate:queued'],
      },
      {
        number: 21,
        title: 'Todo list',
        head: 'task/11-todo-list',
        headSha: SHA,
        author: BUILDER1,
        labels: ['gate:testing'],
      },
      {
        number: 22,
        title: 'Greeting',
        head: 'task/12-greeting',
        headSha: SHA,
        author: BUILDER2,
        labels: ['gate:failed', 'needs-owner'],
      },
      {
        number: 23,
        title: 'Shared layout',
        head: 'task/16-shared-layout',
        headSha: SHA,
        author: LEAD,
      },
      {
        number: 24,
        title: 'Counter reset',
        head: 'task/13-counter-reset',
        headSha: SHA,
        author: BUILDER1,
        draft: true,
      },
      {
        number: 26,
        title: 'Elsewhere',
        head: 'feature',
        headSha: SHA,
        base: 'release',
        author: LEAD,
      },
    ],
  })
}

/** The sections of the JSON that the same GitHub state makes the same on every machine. */
const sharedData = (/** @type {any} */ data) => ({
  attention: data.attention,
  who: data.who,
  waiting: data.waiting,
  blocked: data.blocked,
})

describe('AC44: status from GitHub alone', () => {
  test("a fresh clone after join shows the same sections as the Lead's laptop, marks overdue tasks, and --json carries the same items", async () => {
    const fake = teamGitHub()
    const clock = fixedClock(NOW)
    // The Lead's laptop holds the Gate's local heartbeat, newer than the status issue.
    await writeHeartbeat(gateFiles(await fixture.git.commonDir()).heartbeat, {
      pid: 4242,
      heartbeat_at: '2026-10-24T11:59:50.000Z',
      last_github_ok_at: '2026-10-24T11:59:50.000Z',
      stopped_at: null,
    })
    const fresh = await fixture.joinedClone({ name: 'fresh-lead', login: LEAD })
    const lead = { env: fixture.env, executor: fake.as(LEAD), clock }

    const onLaptop = await runStatus({ cwd: fixture.main, ...lead })
    const onClone = await runStatus({ cwd: fresh.path, ...lead })
    expect(onLaptop.code).toBe(0)
    expect(onClone.code).toBe(0)
    expect(sharedSections(onClone.lines)).toEqual(sharedSections(onLaptop.lines))
    expect(sharedSections(onLaptop.lines)).toEqual([
      'attention:',
      '  ATTENTION repeated-failure #22: stage merge-test failed twice; look at #22',
      '  needs-lead: issue #30: Question for the Lead',
      'who does what:',
      `  ${LEAD}: #16 in progress, due in 22h00m: Shared layout`,
      `  ${LEAD}: next #19 (OVERDUE by 2h30m) Shared styles`,
      `  ${BUILDER1}: #10 in review, OVERDUE by 1h00m: Counter button`,
      `  ${BUILDER1}: #11 in review, due in 6h00m: Todo list`,
      `  ${BUILDER1}: #13 in progress, OVERDUE by 2h00m: Counter reset`,
      `  ${BUILDER1}: next #15 Counter step; #31 Todo export`,
      `  ${BUILDER2}: #12 in review, due in 22h00m: Greeting`,
      `  ${BUILDER2}: next #25 Greeting style`,
      'waiting for merge:',
      `  1. #21 testing: Todo list (${BUILDER1})`,
      `  2. #20 queued: Counter button (${BUILDER1})`,
      `  #23 not seen by the Gate yet: Shared layout (${LEAD})`,
      `  #24 draft, ignored by the Gate: Counter reset (${BUILDER1})`,
      'blocked:',
      '  #14 waits for #10: Todo filter',
      '  #17 has an invalid task block: deadline is missing; every task has one (T11): No deadline',
      `  pull request #22 (${BUILDER2}) failed: needs-owner at stage conflicts: conflict in 1 file: Greeting`,
    ])
    // Only the header differs: the Lead's laptop reads the newer local heartbeat.
    expect(onLaptop.lines[0]).toBe('gate: running, heartbeat 10s ago on this laptop')
    expect(onLaptop.lines[1]).toBe(
      'the status issue shows the heartbeat of 2026-10-24T11:59:00.000Z, 1m00s ago',
    )
    expect(onClone.lines[0]).toBe('gate: running, heartbeat 1m00s ago')
    expect(onClone.lines.slice(1, 5)).toEqual([
      "protection: only the Gate can merge, so GitHub shows every pull request as BLOCKED, the Lead's included, and that is expected. Details: full-restricted; the update restriction is active, so the Gate merges with --admin, and only after its own stages pass",
      'event: ends in 25h00m, at 2026-10-25T15:00:00+02:00',
      'status issue: #1 https://github.com/hackwin-test/app/issues/1',
      'wave 1: 9 open tasks; milestone Wave 1: 2 of 13 issues closed',
    ])

    const jsonLaptop = await runStatus({ cwd: fixture.main, ...lead, json: true })
    const jsonClone = await runStatus({ cwd: fresh.path, ...lead, json: true })
    expect(jsonLaptop.code).toBe(0)
    expect(jsonLaptop.json).toMatchObject({ command: 'status', ok: true, exitCode: 0 })
    expect(sharedData(jsonClone.json.data)).toEqual(sharedData(jsonLaptop.json.data))
    expect(sharedSections(jsonClone.json.lines)).toEqual(sharedSections(onClone.lines))
    const data = jsonLaptop.json.data
    expect(data.attention).toEqual([
      {
        kind: 'gate',
        type: 'repeated-failure',
        pr: 22,
        since: '2026-10-24T11:40:00.000Z',
        todo: 'stage merge-test failed twice; look at #22',
      },
      {
        kind: 'needs-lead',
        number: 30,
        title: 'Question for the Lead',
        url: 'https://github.com/hackwin-test/app/issues/30',
        pull: false,
      },
    ])
    const builder1 = data.who.find((/** @type {any} */ member) => member.login === BUILDER1)
    expect(
      builder1.working.map((/** @type {any} */ task) => [task.number, task.status, task.overdue]),
    ).toEqual([
      [10, 'in-review', true],
      [11, 'in-review', false],
      [13, 'in-progress', true],
    ])
    expect(builder1.working[0]).toMatchObject({
      deadline: '2026-10-24T13:00:00+02:00',
      url: 'https://github.com/hackwin-test/app/issues/10',
    })
    expect(builder1.next.map((/** @type {any} */ task) => task.number)).toEqual([15, 31])
    expect(
      data.waiting.map((/** @type {any} */ pull) => [pull.pr, pull.stage, pull.position]),
    ).toEqual([
      [21, 'testing', 1],
      [20, 'queued', 2],
      [23, 'not-seen', null],
      [24, 'draft', null],
    ])
    expect(data.blocked).toEqual([
      {
        kind: 'dependencies',
        issue: 14,
        title: 'Todo filter',
        waits_for: [10],
        url: 'https://github.com/hackwin-test/app/issues/14',
      },
      {
        kind: 'invalid',
        issue: 17,
        title: 'No deadline',
        errors: ['deadline is missing; every task has one (T11)'],
        url: 'https://github.com/hackwin-test/app/issues/17',
      },
      {
        kind: 'failed-pull',
        pr: 22,
        title: 'Greeting',
        author: BUILDER2,
        labels: ['gate:failed', 'needs-owner'],
        reason: 'needs-owner at stage conflicts: conflict in 1 file',
        url: 'https://github.com/hackwin-test/app/pull/22',
      },
    ])
    expect(data.wave).toEqual({
      number: 1,
      open_tasks: 9,
      milestone: {
        number: 1,
        title: 'Wave 1',
        state: 'open',
        open_issues: 11,
        closed_issues: 2,
        due_on: '2026-10-25T10:00:00Z',
        url: 'https://github.com/hackwin-test/app/milestone/1',
      },
    })
    expect(data.gate).toMatchObject({ state: 'running', source: 'local', age_seconds: 10 })
    expect(jsonClone.json.data.gate).toMatchObject({
      state: 'running',
      source: 'status-issue',
      age_seconds: 60,
    })
  })

  test("a builder's fresh clone shows the same sections, with the builder's own pull requests among the attention items", async () => {
    const fake = teamGitHub()
    const clock = fixedClock(NOW)
    const builder = await fixture.joinedClone({ name: 'fresh-builder2', login: BUILDER2 })
    const lead = await fixture.joinedClone({ name: 'fresh-lead-2', login: LEAD })
    const asBuilder = await runStatus({
      cwd: builder.path,
      env: fixture.env,
      executor: fake.as(BUILDER2),
      clock,
      json: true,
    })
    const asLead = await runStatus({
      cwd: lead.path,
      env: fixture.env,
      executor: fake.as(LEAD),
      clock,
      json: true,
    })
    expect(asBuilder.code).toBe(0)
    const { who, waiting, blocked } = asBuilder.json.data
    expect({ who, waiting, blocked }).toEqual({
      who: asLead.json.data.who,
      waiting: asLead.json.data.waiting,
      blocked: asLead.json.data.blocked,
    })
    expect(asBuilder.json.data.attention).toEqual([
      asLead.json.data.attention[0],
      {
        kind: 'your-pull',
        pr: 22,
        title: 'Greeting',
        labels: ['needs-owner', 'gate:failed'],
        reason: 'needs-owner at stage conflicts: conflict in 1 file',
        url: 'https://github.com/hackwin-test/app/pull/22',
      },
    ])
    expect(asBuilder.json.lines).toContain(
      '  your pull request #22 (needs-owner, gate:failed): needs-owner at stage conflicts: conflict in 1 file',
    )
  })

  test('with GitHub unreachable, status exits 3', async () => {
    const down = async () => ({
      code: 1,
      stdout: '',
      stderr:
        'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com\n',
    })
    const result = await runStatus({
      cwd: fixture.main,
      env: fixture.env,
      executor: down,
      clock: fixedClock(NOW),
    })
    expect(result.code).toBe(3)
    expect(result.err).toContain('hackwin status: GitHub call failed')
    // The runner calls `unreachable` of status: the Lead's laptop still shows the local heartbeat.
    expect(result.lines).toEqual([
      "the Gate's local heartbeat on this laptop: 2026-10-24T11:59:50.000Z, 10s ago; GitHub last answered the Gate at 2026-10-24T11:59:50.000Z, 10s ago",
    ])
  })
})

describe('1.6f/unreachable: the local heartbeat when GitHub is unreachable', () => {
  /** A fake GitHub that answers the runner, then fails every list of issues. */
  function failingGitHub() {
    const fake = createFakeGitHub()
    fake.on('GET repos/{owner}/{repo}/issues', () => {
      throw httpError(502, 'Bad Gateway')
    })
    return fake
  }

  test("on the Lead's laptop status prints the local heartbeat and exits 3; on another clone it prints none", async () => {
    const own = await createFixture({ team: 3 })
    try {
      await writeHeartbeat(gateFiles(await own.git.commonDir()).heartbeat, {
        pid: 4242,
        heartbeat_at: '2026-10-24T11:58:00.000Z',
        last_github_ok_at: '2026-10-24T11:50:00.000Z',
        stopped_at: null,
      })
      const clock = fixedClock(NOW)
      const laptop = await runStatus({
        cwd: own.main,
        env: own.env,
        executor: failingGitHub().as(LEAD),
        clock,
      })
      expect(laptop.code).toBe(3)
      expect(laptop.lines).toEqual([
        "the Gate's local heartbeat on this laptop: 2026-10-24T11:58:00.000Z, 2m00s ago; GitHub last answered the Gate at 2026-10-24T11:50:00.000Z, 10m00s ago",
      ])
      expect(laptop.err).toContain('(HTTP 502)')

      const clone = await own.joinedClone({ name: 'builder', login: BUILDER1 })
      const builder = await runStatus({
        cwd: clone.path,
        env: own.env,
        executor: failingGitHub().as(BUILDER1),
        clock,
      })
      expect(builder.code).toBe(3)
      expect(builder.out).toBe('')
    } finally {
      own.cleanup()
    }
  })

  test('unreachable needs only the git common directory and the clock: no network, configuration or identity', async () => {
    const own = await createFixture()
    try {
      const gitCommonDir = await own.git.commonDir()
      const clock = fixedClock(NOW)
      const error = new RemoteError('GitHub call failed')
      expect(await unreachable({ gitCommonDir, clock }, error)).toEqual({
        lines: [],
        data: { local_heartbeat: null },
      })
      const heartbeat = {
        pid: 4242,
        heartbeat_at: '2026-10-24T11:00:00.000Z',
        last_github_ok_at: null,
        stopped_at: '2026-10-24T11:00:00.000Z',
      }
      await writeHeartbeat(gateFiles(gitCommonDir).heartbeat, heartbeat)
      expect(await unreachable({ gitCommonDir, clock }, error)).toEqual({
        lines: [
          "the Gate's local heartbeat on this laptop: 2026-10-24T11:00:00.000Z, 1h00m ago; stopped by the Lead at 2026-10-24T11:00:00.000Z, 1h00m ago",
        ],
        data: { local_heartbeat: { schema: 1, ...heartbeat } },
      })
    } finally {
      own.cleanup()
    }
  })
})

describe('1.6f/header: the first line and the header', () => {
  /** @type {Fixture} */
  let own
  beforeAll(async () => {
    own = await createFixture({ team: 3 })
  })
  afterAll(() => own.cleanup())

  /**
   * @param {any[]} issues
   * @param {string} [now]
   */
  const statusWith = async (issues, now = NOW) =>
    runStatus({
      cwd: own.main,
      env: own.env,
      executor: createFakeGitHub({ issues }).as(BUILDER1),
      clock: fixedClock(now),
    })

  test('without a status issue the Gate has not been started, and the protection state is unknown', async () => {
    const result = await statusWith([])
    expect(result.code).toBe(0)
    expect(result.lines.slice(0, 3)).toEqual([
      'the Gate has not been started: no status issue exists yet; merges wait until the Lead runs `hackwin gate`',
      "protection: unknown until the Gate's first start",
      'event: ends in 25h00m, at 2026-10-25T15:00:00+02:00',
    ])
    expect(result.lines).toContain("gate digest: none before the Gate's first start")
  })

  test('a heartbeat older than the stale threshold without a stop time starts with a warning', async () => {
    const result = await statusWith([
      statusIssue(1, {
        heartbeat_at: '2026-10-24T11:54:59.000Z',
        protection: 'full',
        update_restricted: false,
      }),
    ])
    expect(result.lines[0]).toBe(
      "warning: the Gate's heartbeat is 5m01s old (2026-10-24T11:54:59.000Z), older than 300s, and the Lead has not stopped it: the Gate may be down, and merges wait while it is; ask the Lead to look at the Gate terminal",
    )
    expect(result.lines[1]).toBe('protection: full')
  })

  test('a heartbeat younger than the threshold is a running Gate', async () => {
    const result = await statusWith([
      statusIssue(1, {
        heartbeat_at: '2026-10-24T11:55:01.000Z',
        protection: 'soft',
        update_restricted: false,
      }),
    ])
    expect(result.lines.slice(0, 2)).toEqual([
      'gate: running, heartbeat 4m59s ago',
      'protection: soft',
    ])
  })

  test('after quit the first line is the stop notice, however old the heartbeat', async () => {
    const result = await statusWith([
      statusIssue(1, {
        heartbeat_at: '2026-10-24T09:00:00.000Z',
        stopped_at: '2026-10-24T09:00:00.000Z',
      }),
    ])
    expect(result.lines[0]).toBe(
      'the Lead stopped the Gate at 2026-10-24T09:00:00.000Z, 3h00m ago; merges wait until the Lead starts it again',
    )
  })

  test('a status issue without a readable block is a warning, and the event that ended says so', async () => {
    const result = await statusWith(
      [
        {
          number: 1,
          title: 'HackWin Gate status',
          body: 'edited by hand',
          labels: ['gate-status'],
        },
      ],
      '2026-10-25T14:00:00.000Z',
    )
    expect(result.lines[0]).toMatch(/^warning: the status issue holds no readable/)
    expect(result.lines).toContain('event: ended 1h00m ago, at 2026-10-25T15:00:00+02:00')
    expect(result.lines).toContain('status issue: #1 https://github.com/hackwin-test/app/issues/1')
  })

  test("on the Lead's laptop a fresh local heartbeat wins, and a stale status issue is a warning about what teammates see", async () => {
    const file = gateFiles(await own.git.commonDir()).heartbeat
    await writeHeartbeat(file, {
      pid: 4242,
      heartbeat_at: '2026-10-24T11:59:30.000Z',
      last_github_ok_at: '2026-10-24T11:50:00.000Z',
      stopped_at: null,
    })
    try {
      const result = await statusWith([
        statusIssue(1, { heartbeat_at: '2026-10-24T11:50:00.000Z' }),
      ])
      expect(result.lines.slice(0, 3)).toEqual([
        'gate: running, heartbeat 30s ago on this laptop',
        'the status issue shows the heartbeat of 2026-10-24T11:50:00.000Z, 10m00s ago',
        "warning: the status issue's heartbeat is 10m00s old, so teammates see the Gate as stale; GitHub last answered the Gate at 2026-10-24T11:50:00.000Z",
      ])

      // Without a status issue the Gate has not been started, and the Lead sees the local one.
      const none = await statusWith([])
      expect(none.lines.slice(0, 2)).toEqual([
        'the Gate has not been started: no status issue exists yet; merges wait until the Lead runs `hackwin gate`',
        "the Gate's local heartbeat on this laptop: 2026-10-24T11:59:30.000Z, 30s ago; GitHub last answered the Gate at 2026-10-24T11:50:00.000Z, 10m00s ago",
      ])
    } finally {
      rmSync(file)
    }
  })
})

describe('1.6f/digest: the Gate digest since the previous call', () => {
  test('shows the lines published since the previous call, and the earlier ones that still need action', async () => {
    const own = await createFixture({ team: 3 })
    try {
      const failed = {
        time: '2026-10-24T11:00:00.000Z',
        pr: 22,
        author: BUILDER2,
        result: 'needs-owner',
        stage: 'conflicts',
        duration: '1m05s',
        note: 'conflict in 1 file',
      }
      const merged = {
        ...failed,
        time: '2026-10-24T11:10:00.000Z',
        pr: 20,
        author: BUILDER1,
        result: 'merged',
        stage: 'after-merge',
        note: '',
      }
      const later = { ...merged, time: '2026-10-24T11:20:00.000Z', pr: 21 }
      const fake = createFakeGitHub({
        issues: [
          statusIssue(1, { heartbeat_at: '2026-10-24T11:15:00.000Z', digest: [merged, failed] }),
        ],
        pulls: [
          {
            number: 22,
            title: 'Greeting',
            head: 'task/12-greeting',
            headSha: SHA,
            author: BUILDER2,
            labels: ['gate:failed', 'needs-owner'],
          },
        ],
      })
      const run = (/** @type {string} */ now) =>
        runStatus({
          cwd: own.main,
          env: own.env,
          executor: fake.as(BUILDER1),
          clock: fixedClock(now),
        })
      const digestOf = (/** @type {string[]} */ lines) =>
        lines.slice(lines.findIndex((line) => line.startsWith('gate digest')))
      const hm = (/** @type {string} */ time) => hoursAndMinutes(new Date(time))
      const commonDir = await own.git.commonDir()

      const first = await run('2026-10-24T11:16:00.000Z')
      expect(digestOf(first.lines)).toEqual([
        'gate digest:',
        `  ${hm(merged.time)} #20 ${BUILDER1} merged stage=after-merge 1m05s`,
        `  ${hm(failed.time)} #22 ${BUILDER2} needs-owner stage=conflicts 1m05s conflict in 1 file`,
      ])
      // Seen up to the heartbeat of the issue this call read, on the Gate's clock.
      expect(await readLastStatus(commonDir)).toBe('2026-10-24T11:15:00.000Z')

      const issue = /** @type {any} */ (fake.find(1))
      issue.body = statusIssue(1, {
        heartbeat_at: '2026-10-24T11:21:00.000Z',
        digest: [later, merged, failed],
      }).body
      const second = await run('2026-10-24T11:22:00.000Z')
      expect(digestOf(second.lines)).toEqual([
        'gate digest since your last status (2026-10-24T11:15:00.000Z):',
        `  ${hm(later.time)} #21 ${BUILDER1} merged stage=after-merge 1m05s`,
        `  still needs action: ${hm(failed.time)} #22 ${BUILDER2} needs-owner stage=conflicts 1m05s conflict in 1 file`,
      ])
      expect(await readLastStatus(commonDir)).toBe('2026-10-24T11:21:00.000Z')

      // The pull request was fixed and queued again: nothing is left to do.
      const pull = /** @type {any} */ (fake.find(22))
      pull.labels = ['gate:queued']
      const third = await run('2026-10-24T11:23:00.000Z')
      expect(digestOf(third.lines)).toEqual([
        'gate digest since your last status (2026-10-24T11:21:00.000Z): nothing new',
      ])
    } finally {
      own.cleanup()
    }
  })
})

describe('AC60: status and the main checkout (CM10)', () => {
  test('on the default branch with a clean tree, status leaves the main checkout at origin/main', async () => {
    const own = await createFixture({ team: 3 })
    try {
      const before = await own.git.revParse('HEAD')
      const pushed = await own.publish({ 'docs/notes.md': 'merged elsewhere\n' })
      expect(pushed).not.toBe(before)
      const result = await runStatus({
        cwd: own.main,
        env: own.env,
        executor: createFakeGitHub().as(LEAD),
        clock: fixedClock(NOW),
      })
      expect(result.code).toBe(0)
      expect(result.err).toBe('')
      expect(await own.git.revParse('HEAD')).toBe(pushed)
      expect(await own.git.revParse('origin/main')).toBe(pushed)
      expect(await own.git.isClean()).toBe(true)
    } finally {
      own.cleanup()
    }
  })

  test('with local changes, status warns and changes nothing', async () => {
    const own = await createFixture({ team: 3 })
    try {
      const before = await own.git.revParse('HEAD')
      own.write({ 'README.md': '# Fixture\n\nA local change.\n' })
      const pushed = await own.publish({ 'docs/notes.md': 'merged elsewhere\n' })
      const result = await runStatus({
        cwd: own.main,
        env: own.env,
        executor: createFakeGitHub().as(LEAD),
        clock: fixedClock(NOW),
      })
      expect(result.code).toBe(0)
      expect(result.err).toContain(
        'warning: the main checkout is behind origin/main and was not fast-forwarded, because it has local changes',
      )
      expect(await own.git.revParse('HEAD')).toBe(before)
      expect(await own.git.revParse('origin/main')).toBe(pushed)
      expect(readFileSync(join(own.main, 'README.md'), 'utf8')).toBe(
        '# Fixture\n\nA local change.\n',
      )
      expect(result.lines[0]).toMatch(/^the Gate has not been started/)
    } finally {
      own.cleanup()
    }
  })
})

describe('1.6h/next: the last line gives a caller with a next task the take command to paste', () => {
  /** A running Gate and one ready task each for builder1 and builder2; none for the Lead. */
  const readyTasks = () =>
    createFakeGitHub({
      issues: [
        statusIssue(1, { heartbeat_at: '2026-10-24T11:59:00.000Z' }),
        taskIssue(10, { role: 'counter', title: 'Counter step' }),
        taskIssue(11, { role: 'greeting', title: 'Greeting style' }),
      ],
    })
  /** @param {{ cwd: string, env: Record<string, string>, login: string, json?: boolean }} where */
  const statusAs = ({ cwd, env, login, json = false }) =>
    runStatus({ cwd, env, executor: readyTasks().as(login), clock: fixedClock(NOW), json })
  /** The lines of who does what, as they were before #148. */
  const whoDoesWhat = [
    'who does what:',
    `  ${LEAD}: nothing in progress`,
    `  ${LEAD}: no ready task`,
    `  ${BUILDER1}: nothing in progress`,
    `  ${BUILDER1}: next #10 Counter step`,
    `  ${BUILDER2}: nothing in progress`,
    `  ${BUILDER2}: next #11 Greeting style`,
  ]
  /** @param {string[]} lines */
  const sectionOf = (lines) => {
    const start = lines.indexOf('who does what:')
    return lines.slice(start, lines.indexOf('waiting for merge: none'))
  }

  test('after the digest, `hackwin take` without a number in the main checkout; who does what stays as it was', async () => {
    const result = await statusAs({ cwd: fixture.main, env: fixture.env, login: BUILDER1 })
    expect(result.code).toBe(0)
    expect(sectionOf(result.lines)).toEqual(whoDoesWhat)
    // The digest line's heading depends on an earlier call in this clone.
    const [digest, take] = result.lines.slice(-2)
    expect(digest).toMatch(/^gate digest/)
    expect(take).toBe(`to start your next task, run \`cd ${fixture.main} && hackwin take\``)
    expect(result.out.match(/hackwin take/g)).toHaveLength(1)
  })

  test('--json prints the same lines, and its data carries no command', async () => {
    const result = await statusAs({
      cwd: fixture.main,
      env: fixture.env,
      login: BUILDER1,
      json: true,
    })
    expect(result.code).toBe(0)
    expect(sectionOf(result.json.lines)).toEqual(whoDoesWhat)
    expect(result.json.lines.at(-1)).toBe(
      `to start your next task, run \`cd ${fixture.main} && hackwin take\``,
    )
    expect(JSON.stringify(result.json.data)).not.toContain('hackwin take')
    for (const member of result.json.data.who) {
      expect(Object.keys(member)).toEqual(['login', 'name', 'roles', 'working', 'next'])
    }
  })

  test('a caller without a ready task gets no command', async () => {
    const result = await statusAs({ cwd: fixture.main, env: fixture.env, login: LEAD })
    expect(result.code).toBe(0)
    expect(sectionOf(result.lines)).toEqual(whoDoesWhat)
    expect(result.out).not.toContain('hackwin take')
  })

  test('in a task worktree the command names the main checkout, where take runs', async () => {
    const own = await createFixture({ team: 3 })
    try {
      const worktree = await own.worktree({ issue: 77, title: 'Elsewhere' })
      const result = await statusAs({ cwd: worktree.path, env: own.env, login: BUILDER1 })
      expect(result.code).toBe(0)
      expect(result.lines.at(-1)).toBe(
        `to start your next task, run \`cd ${own.main} && hackwin take\``,
      )
    } finally {
      own.cleanup()
    }
  })
})

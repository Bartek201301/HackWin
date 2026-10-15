// The Lead's review of #73: text from GitHub never reaches the terminal with a control
// character, only members' issues are tasks, every state says what is true, the BLOCKED notice
// in any protection state, and the local heartbeat through the runner when GitHub is unreachable.

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { gateFiles, writeHeartbeat } from '../../../src/commands/gate/state.js'
import { accounts, createFakeGitHub, createFixture } from '../../harness/index.js'
import {
  fixedClock,
  runStatus,
  serveMilestones,
  statusIssue,
  taskBody,
  taskIssue,
} from './helpers.js'

/** @typedef {import('../../harness/index.js').Fixture} Fixture */

const LEAD = accounts.lead.login
const BUILDER1 = accounts.builder1.login
const NOW = '2026-10-24T12:00:00.000Z'
const SHA = 'a'.repeat(40)
/** A login outside the team. */
const OUTSIDER = 'someone-else'

// Control characters, built from their codes so that this file holds none.
const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)
const CSI = String.fromCharCode(0x9b)
/** An OSC 8 hyperlink: a terminal shows `click` and hides where it leads. */
const LINK = `${ESC}]8;;https://evil.example${BEL}click${ESC}]8;;${BEL}`
/** Every character that status must not print: C0 but the line feed between lines, DEL, C1. */
const UNSAFE = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(9)}${String.fromCharCode(11)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}]`,
)

/** @type {Fixture} */
let fixture

beforeAll(async () => {
  fixture = await createFixture({ team: 3 })
})

afterAll(() => fixture.cleanup())

/**
 * @param {any} state The fake GitHub's state.
 * @param {{ login?: string, json?: boolean, now?: string, cwd?: string, milestones?: Record<number, object> }} [options]
 */
async function statusOf(state, options = {}) {
  const fake = createFakeGitHub(state)
  if (options.milestones) serveMilestones(fake, options.milestones)
  const login = options.login ?? BUILDER1
  return runStatus({
    cwd: options.cwd ?? fixture.main,
    env: fixture.env,
    executor: fake.as(login),
    clock: fixedClock(options.now ?? NOW),
    json: options.json ?? false,
  })
}

describe('1.6f/terminal: no text from GitHub puts a control character or a line break into the output', () => {
  // A task block whose YAML escapes decode into ESC, BEL and a line break inside its errors.
  const forgedBlock = [
    '```yaml',
    '# hackwin:task',
    'kind: task',
    'role: "\\e]8;;https://evil.example\\aclick\\e]8;;\\a"',
    '"x\\ngate: running": 1',
    'paths: ["src/features/counter/**"]',
    'depends_on: []',
    'acceptance_tests: ["test/features.test.js"]',
    'deadline: "2026-10-25T12:00:00+02:00"',
    '```',
  ].join('\n')
  const state = {
    issues: [
      statusIssue(1, {
        heartbeat_at: '2026-10-24T11:00:00.000Z',
        stopped_at: '2026-10-24T11:00:00.000Z',
        attention: [
          {
            type: `secret${ESC}[31m`,
            pr: 40,
            since: '2026-10-24T10:00:00.000Z',
            todo: `rotate ${LINK}\nwarning: forged line`,
          },
        ],
        digest: [
          {
            time: '2026-10-24T10:30:00.000Z',
            pr: 40,
            author: BUILDER1,
            result: 'failed',
            stage: 'merge-test',
            duration: '1m',
            note: `check failed ${ESC}[2J${LINK}`,
          },
        ],
      }),
      taskIssue(10, { role: 'counter', title: `Counter ${LINK}\ngate: running, heartbeat 1s ago` }),
      { number: 42, title: 'Forged block', body: forgedBlock, labels: [] },
    ],
    pulls: [
      {
        number: 40,
        title: `Fix ${LINK}\ngate: running, heartbeat 1s ago ${CSI}31m`,
        head: 'task/10-counter',
        headSha: SHA,
        author: BUILDER1,
        labels: ['gate:failed'],
      },
      {
        number: 41,
        // Long enough that the line is cut where the hyperlink starts.
        title: `${'A'.repeat(55)}${LINK} the rest of the output`,
        head: 'task/11-other',
        headSha: SHA,
        author: BUILDER1,
      },
    ],
  }
  const milestones = { 10: { number: 1, title: `Wave ${LINK}`, open_issues: 1, closed_issues: 0 } }

  test('a pull request title, a task block error, an attention item, a digest note and a milestone title are printed with visible escapes', async () => {
    const result = await statusOf(state, { milestones })
    expect(result.code).toBe(0)
    expect(result.out).not.toMatch(UNSAFE)
    // The line breaks inside the texts forged no line.
    expect(result.lines.filter((line) => /^\s*(gate: running|warning: forged)/.test(line))).toEqual(
      [],
    )
    expect(result.lines[0]).toMatch(/^the Lead stopped the Gate/)
    const visible = '\\u001b]8;;https://evil.example\\u0007click\\u001b]8;;\\u0007'
    expect(result.lines).toContain(
      `  ATTENTION secret\\u001b[31m #40: rotate ${visible} warning: forged line`,
    )
    expect(result.lines).toContain(
      `  #42 has an invalid task block: "x\\ngate: running" is not a key of the task block; role "${visible}" is not a role of owners.yml: Forged block`,
    )
    const pull = result.lines.find((line) => line.startsWith('  pull request #40'))
    expect(pull).toContain(`check failed \\u001b[2J${visible}: Fix \\u001b]8;;https://evil.example`)
    expect(pull).toMatch(/\.\.\.$/)
    expect(result.lines).toContain(
      `  #41 not seen by the Gate yet: ${'A'.repeat(55)}\\u... (${BUILDER1})`,
    )
    expect(result.lines).toContain(
      `wave 1: 1 open task; milestone Wave ${visible}: 0 of 1 issues closed`,
    )
    expect(result.lines).toContain(`  ${BUILDER1}: next #10 Counter ${visible.slice(0, 49)}...`)
  })

  test('--json carries the same cleaned text, so no control character reaches the terminal there either', async () => {
    const result = await statusOf(state, { json: true, milestones })
    expect(result.code).toBe(0)
    expect(result.out).not.toMatch(UNSAFE)
    // A control character would be a JSON escape such as \u001b; the cleaned text is \\u001b.
    expect(result.out).not.toMatch(/(?<!\\)\\(u00[0-1][0-9a-f]|u00[89][0-9a-f]|n|r|t)/)
    const { data } = result.json
    expect(data.waiting[0].title).toBe(
      `${'A'.repeat(55)}\\u001b]8;;https://evil.example\\u0007click\\u001b]8;;\\u0007 the rest of the output`,
    )
    expect(data.blocked[1].reason).toBe(
      'failed at stage merge-test: check failed \\u001b[2J\\u001b]8;;https://evil.example\\u0007click\\u001b]8;;\\u0007',
    )
    expect(data.blocked[1].title).toBe(
      'Fix \\u001b]8;;https://evil.example\\u0007click\\u001b]8;;\\u0007 gate: running, heartbeat 1s ago \\u009b31m',
    )
  })
})

describe('1.6f/members: only issues of members are tasks', () => {
  test("a task block in an outsider's issue is no task: not next, not blocked, not in the wave; an outsider's pull request is not tested", async () => {
    const result = await statusOf(
      {
        issues: [
          statusIssue(1, { heartbeat_at: '2026-10-24T11:59:00.000Z' }),
          taskIssue(10, { role: 'counter', title: 'Real task' }),
          {
            ...taskIssue(11, { role: 'counter', title: 'Planted task', wave: 0 }),
            author: OUTSIDER,
          },
          {
            number: 12,
            title: 'Planted invalid',
            body: taskBody({ role: 'nobody' }),
            author: OUTSIDER,
          },
          {
            ...taskIssue(13, { role: 'counter', title: 'Waits for the Lead' }),
            labels: ['needs-lead', 'role:counter'],
          },
        ],
        pulls: [
          {
            number: 20,
            title: 'From outside',
            head: 'task/11-planted',
            headSha: SHA,
            author: OUTSIDER,
          },
          { number: 21, title: 'Not seen', head: 'task/10-real', headSha: SHA, author: BUILDER1 },
        ],
      },
      { json: true },
    )
    expect(result.code).toBe(0)
    const { data, lines } = result.json
    const builder = data.who.find((/** @type {any} */ member) => member.login === BUILDER1)
    expect(builder.next.map((/** @type {any} */ task) => task.number)).toEqual([10])
    expect(data.blocked).toEqual([])
    expect(data.wave).toMatchObject({ number: 1, open_tasks: 2 })
    expect(data.waiting.map((/** @type {any} */ pull) => [pull.pr, pull.stage])).toEqual([
      [21, 'not-seen'],
      [20, 'outsider'],
    ])
    expect(lines).toContain(
      `  #20 not from a member of the team, so the Gate does not test it: From outside (${OUTSIDER})`,
    )
    expect(lines).toContain(`  ${BUILDER1}: next #10 Real task`)
  })
})

describe('1.6f/states: each state says what is true', () => {
  test('a closed status issue that the Gate still edits shows the running Gate and a warning', async () => {
    const result = await statusOf({
      issues: [
        { ...statusIssue(7, { heartbeat_at: '2026-10-24T11:59:00.000Z' }), state: 'closed' },
      ],
    })
    expect(result.lines.slice(0, 5)).toEqual([
      'gate: running, heartbeat 1m00s ago',
      'warning: the status issue #7 is closed; a running Gate keeps editing it, but the next start of the Gate creates a new status issue; to keep this one, reopen #7',
      "protection: full-restricted; the update restriction is active, so GitHub shows every pull request as BLOCKED, the Lead's included: that is expected, the Gate merges with --admin after its own stages pass",
      'event: ends in 25h00m, at 2026-10-25T15:00:00+02:00',
      'status issue: #7 https://github.com/hackwin-test/app/issues/7',
    ])
    expect(result.out).not.toContain('not been started')
  })

  test('an open status issue wins over a closed one', async () => {
    const result = await statusOf({
      issues: [
        { ...statusIssue(7, { heartbeat_at: '2026-10-24T11:59:00.000Z' }), state: 'closed' },
        statusIssue(8, {
          heartbeat_at: '2026-10-24T11:00:00.000Z',
          stopped_at: '2026-10-24T11:00:00.000Z',
        }),
      ],
    })
    expect(result.lines[0]).toMatch(/^the Lead stopped the Gate at 2026-10-24T11:00:00.000Z/)
    expect(result.lines).toContain('status issue: #8 https://github.com/hackwin-test/app/issues/8')
    expect(result.out).not.toContain('is closed')
  })

  test('an unreadable status block says that the protection state and the digest are unknown', async () => {
    const result = await statusOf({
      issues: [
        {
          number: 1,
          title: 'HackWin Gate status',
          body: 'edited by hand',
          labels: ['gate-status'],
        },
      ],
    })
    expect(result.lines).toContain('protection: unknown, the status issue holds no readable block')
    expect(result.lines).toContain('gate digest: unknown, the status issue holds no readable block')
    expect(result.out).not.toContain('first start')
  })
})

describe('1.6f/blocked-notice: BLOCKED is expected while the update restriction is active, in any protection state', () => {
  const notice =
    "the update restriction is active, so GitHub shows every pull request as BLOCKED, the Lead's included: that is expected, the Gate merges with --admin after its own stages pass"

  test.each(['full', 'soft', 'full-restricted'])(
    'protection %s with the update restriction',
    async (protection) => {
      const result = await statusOf(
        {
          issues: [
            statusIssue(1, {
              heartbeat_at: '2026-10-24T11:59:00.000Z',
              protection: /** @type {any} */ (protection),
              update_restricted: true,
            }),
          ],
        },
        { json: true },
      )
      expect(result.json.lines[1]).toBe(`protection: ${protection}; ${notice}`)
      expect(result.json.data.protection).toEqual({ state: protection, update_restricted: true })
    },
  )

  test('without the update restriction there is no notice', async () => {
    const result = await statusOf({
      issues: [
        statusIssue(1, {
          heartbeat_at: '2026-10-24T11:59:00.000Z',
          protection: 'full',
          update_restricted: false,
        }),
      ],
    })
    expect(result.lines[1]).toBe('protection: full')
  })
})

describe('1.6f/unreachable: through the runner when GitHub is unreachable before status runs', () => {
  const heartbeat = {
    pid: 4242,
    heartbeat_at: '2026-10-24T11:58:00.000Z',
    last_github_ok_at: '2026-10-24T11:50:00.000Z',
    stopped_at: null,
  }
  const line =
    "the Gate's local heartbeat on this laptop: 2026-10-24T11:58:00.000Z, 2m00s ago; GitHub last answered the Gate at 2026-10-24T11:50:00.000Z, 10m00s ago"
  /** Every gh call fails as without a network. */
  const down = async () => ({
    code: 1,
    stdout: '',
    stderr:
      'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com\n',
  })

  test("with gh unreachable, the Lead's laptop prints the local heartbeat and exits 3, also with --json; another clone prints none", async () => {
    const own = await createFixture({ team: 3 })
    try {
      await writeHeartbeat(gateFiles(await own.git.commonDir()).heartbeat, heartbeat)
      const options = { cwd: own.main, env: own.env, executor: down, clock: fixedClock(NOW) }
      const plain = await runStatus(options)
      expect(plain.code).toBe(3)
      expect(plain.lines).toEqual([line])
      expect(plain.err).toContain('hackwin status: GitHub call failed')

      const json = await runStatus({ ...options, json: true })
      expect(json.code).toBe(3)
      expect(json.json).toMatchObject({
        command: 'status',
        ok: false,
        exitCode: 3,
        lines: [line],
        data: { local_heartbeat: { schema: 1, ...heartbeat } },
        error: { kind: 'remote' },
      })

      const clone = await own.joinedClone({ name: 'builder', login: BUILDER1 })
      const other = await runStatus({ ...options, cwd: clone.path })
      expect(other.code).toBe(3)
      expect(other.out).toBe('')
    } finally {
      own.cleanup()
    }
  })

  test("with origin unreachable, the fetch fails, and the Lead's laptop prints the local heartbeat and exits 3", async () => {
    const own = await createFixture({ team: 3 })
    try {
      await writeHeartbeat(gateFiles(await own.git.commonDir()).heartbeat, heartbeat)
      await own.git.run(['remote', 'set-url', 'origin', `${own.dir}/no-such-origin.git`])
      const result = await runStatus({
        cwd: own.main,
        env: own.env,
        executor: createFakeGitHub().as(LEAD),
        clock: fixedClock(NOW),
      })
      expect(result.code).toBe(3)
      expect(result.lines).toEqual([line])
    } finally {
      own.cleanup()
    }
  })
})

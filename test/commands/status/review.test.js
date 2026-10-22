// The Lead's review of #73: text from GitHub never reaches the terminal with a control
// character, only members' issues are tasks, every state says what is true, the BLOCKED notice
// in any protection state, and the local heartbeat through the runner when GitHub is unreachable.
// And #79: the team is who `writtenByTeam` of src/core/tasks accepts, `team.lead` included.
// And #115: a closed status issue counts only when its own issue carries the label `gate-status`.

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { gateFiles, writeHeartbeat } from '../../../src/commands/gate/state.js'
import { STATUS_LABEL } from '../../../src/commands/gate/status-issue.js'
import { buildStatus } from '../../../src/commands/status/view.js'
import { parseHackwinConfig, parseOwners, resolveIdentity } from '../../../src/core/config/index.js'
import { accounts, createFakeGitHub, createFixture, teamConfig } from '../../harness/index.js'
import { fixedClock, runStatus, statusIssue, taskBody, taskIssue } from './helpers.js'

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
 * @param {{ login?: string, json?: boolean, now?: string, cwd?: string }} [options]
 */
async function statusOf(state, options = {}) {
  const fake = createFakeGitHub(state)
  const login = options.login ?? BUILDER1
  return runStatus({
    cwd: options.cwd ?? fixture.main,
    env: fixture.env,
    executor: fake.as(login),
    clock: fixedClock(options.now ?? NOW),
    json: options.json ?? false,
  })
}

/**
 * The fake GitHub of `current`, behind an executor whose listing of the closed issues with the
 * label `gate-status` answers from the earlier state `listed` instead: GitHub's label filter kept
 * returning an issue for minutes after its label was deleted (#115).
 * @param {any} current
 * @param {any} listed
 */
function staleClosedListing(current, listed) {
  const fake = createFakeGitHub(current)
  const now = fake.as(BUILDER1)
  const earlier = createFakeGitHub(listed).as(BUILDER1)
  /** @type {import('../../../src/core/github/index.js').GhExecutor} */
  const executor = async (args, call) => {
    const [path = '', query = ''] = (args.find((arg) => arg.includes('/issues?')) ?? '').split('?')
    const wanted = new URLSearchParams(query)
    const listing =
      path.endsWith('/issues') &&
      wanted.get('state') === 'closed' &&
      wanted.get('labels') === STATUS_LABEL
    return listing ? earlier(args, call) : now(args, call)
  }
  return { fake, executor }
}

/**
 * The numbers of the issues read one by one, in order.
 * @param {import('../../harness/index.js').FakeGitHub} fake
 */
function issuesReadByNumber(fake) {
  return fake.calls
    .map((call) => /^repos\/\{owner\}\/\{repo\}\/issues\/(\d+)$/.exec(call.endpoint ?? ''))
    .filter((match) => match !== null)
    .map((match) => Number(match[1]))
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
    milestones: [{ number: 1, title: `Wave ${LINK}` }],
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
      taskIssue(10, {
        role: 'counter',
        title: `Counter ${LINK}\ngate: running, heartbeat 1s ago`,
        milestone: 1,
      }),
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

  test('a pull request title, a task block error, an attention item, a digest note and a milestone title are printed with visible escapes', async () => {
    const result = await statusOf(state)
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
    const result = await statusOf(state, { json: true })
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

describe('1.6g/members: status counts the team as writtenByTeam does', () => {
  test("an outsider's task issue is not listed and the same issue of team.lead or a member is, in any case of the login; an outsider's pull request does not wait for the Gate", async () => {
    for (const [author, team] of /** @type {const} */ ([
      [OUTSIDER, false],
      [LEAD, true],
      [LEAD.toUpperCase(), true],
      [BUILDER1, true],
      [BUILDER1.toUpperCase(), true],
    ])) {
      const result = await statusOf(
        {
          issues: [
            statusIssue(1, { heartbeat_at: '2026-10-24T11:59:00.000Z' }),
            { ...taskIssue(10, { role: 'counter', title: 'Counter' }), author },
            {
              ...taskIssue(11, { role: 'todos', title: 'No deadline', deadline: null }),
              author,
            },
          ],
          pulls: [{ number: 20, title: 'Counter', head: 'task/10-counter', headSha: SHA, author }],
        },
        { json: true },
      )
      expect(result.code, author).toBe(0)
      const { data, lines } = result.json
      const builder = data.who.find((/** @type {any} */ member) => member.login === BUILDER1)
      const waiting = data.waiting.map((/** @type {any} */ pull) => [pull.pr, pull.stage])
      if (team) {
        expect(
          builder.next.map((/** @type {any} */ task) => task.number),
          author,
        ).toEqual([10])
        expect(data.wave, author).toMatchObject({ number: 1, open_tasks: 1 })
        expect(
          data.blocked.map((/** @type {any} */ entry) => [entry.kind, entry.issue]),
          author,
        ).toEqual([['invalid', 11]])
        expect(waiting, author).toEqual([[20, 'not-seen']])
        expect(lines).toContain(`  #20 not seen by the Gate yet: Counter (${author})`)
      } else {
        expect(builder.next, author).toEqual([])
        expect(data.wave, author).toBeNull()
        expect(data.blocked, author).toEqual([])
        expect(waiting, author).toEqual([[20, 'outsider']])
        expect(lines).toContain(
          `  #20 not from a member of the team, so the Gate does not test it: Counter (${author})`,
        )
      }
    }
  })

  test('team.lead counts also where team.members leaves the Lead out', () => {
    const { files } = teamConfig(3)
    const parsed = {
      hackwin: parseHackwinConfig(files['hackwin.yml']),
      owners: parseOwners(files['owners.yml']),
      ref: 'origin/main',
      sha: SHA,
    }
    // hackwin.yml fails validation without the Lead among the members; writtenByTeam does not
    // depend on it.
    const chief = 'The-Chief'
    const team = { lead: chief, members: parsed.hackwin.team.members }
    const config = { ...parsed, hackwin: { ...parsed.hackwin, team } }
    /** @param {number} number @param {string} author @param {string} [body] */
    const issue = (number, author, body = taskBody({ role: 'counter' })) => ({
      number,
      title: `Task ${number}`,
      body,
      state: /** @type {const} */ ('open'),
      stateReason: null,
      labels: ['ready', 'role:counter'],
      assignees: [],
      author,
      url: `https://github.com/hackwin-test/app/issues/${number}`,
      createdAt: NOW,
      updatedAt: NOW,
      closedAt: null,
      isPullRequest: false,
    })
    /** @param {number} number @param {string} author */
    const pull = (number, author) => ({
      number,
      title: `Pull ${number}`,
      body: '',
      state: /** @type {const} */ ('open'),
      draft: false,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: `task/${number}-pull`,
      headSha: SHA,
      headRepo: 'hackwin-test/app',
      baseRef: 'main',
      labels: [],
      author,
      url: `https://github.com/hackwin-test/app/pull/${number}`,
      createdAt: NOW,
      updatedAt: NOW,
      closedAt: null,
    })
    const openIssues = [
      issue(10, chief.toLowerCase()),
      issue(11, OUTSIDER),
      issue(12, chief.toUpperCase(), taskBody({ role: 'todos', deadline: null })),
      issue(13, OUTSIDER, taskBody({ role: 'todos', deadline: null })),
    ]
    const data = buildStatus({
      config,
      identity: resolveIdentity(config, BUILDER1),
      now: new Date(NOW),
      openIssues,
      issues: new Map(openIssues.map((entry) => [entry.number, entry])),
      pulls: [pull(20, chief.toUpperCase()), pull(21, OUTSIDER)],
      statusIssue: null,
      gateStatus: null,
      localHeartbeat: null,
      lastStatusAt: null,
      milestone: null,
    })
    const builder = data.who.find((member) => member.login === BUILDER1)
    expect(builder?.next.map((task) => task.number)).toEqual([10])
    expect(data.wave).toMatchObject({ number: 1, open_tasks: 1 })
    expect(data.blocked).toMatchObject([{ kind: 'invalid', issue: 12 }])
    expect(data.waiting.map((entry) => [entry.pr, entry.stage])).toEqual([
      [20, 'not-seen'],
      [21, 'outsider'],
    ])
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
      "protection: only the Gate can merge, so GitHub shows every pull request as BLOCKED, the Lead's included, and that is expected. Details: full-restricted; the update restriction is active, so the Gate merges with --admin, and only after its own stages pass",
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

  /**
   * A closed status issue of the fake's state.
   * @param {number} number
   * @param {string} updatedAt
   * @param {Partial<import('../../../src/commands/gate/status-issue.js').GateStatus> & { heartbeat_at: string }} status
   */
  const closedStatus = (number, updatedAt, status) => ({
    ...statusIssue(number, status),
    state: 'closed',
    updatedAt,
  })
  /** @param {{ labels: string[] }} issue */
  const unlabeled = (issue) => ({ ...issue, labels: [] })

  test('a closed issue that the label filter lists but whose own issue has no label is no status issue, as with an empty listing', async () => {
    const old = closedStatus(7, '2026-10-24T11:59:00Z', {
      heartbeat_at: '2026-10-24T11:59:00.000Z',
      digest: [
        {
          time: '2026-10-24T11:58:00.000Z',
          pr: 3,
          author: BUILDER1,
          result: 'merged',
          stage: 'after-merge',
          duration: '2m10s',
          note: '',
        },
      ],
    })
    const { fake, executor } = staleClosedListing({ issues: [unlabeled(old)] }, { issues: [old] })
    const result = await runStatus({
      cwd: fixture.main,
      env: fixture.env,
      executor,
      clock: fixedClock(NOW),
    })
    expect(result.code).toBe(0)
    expect(result.lines[0]).toMatch(/^the Gate has not been started/)
    expect(result.lines).toEqual((await statusOf({ issues: [unlabeled(old)] })).lines)
    // Nothing else of this state is read by its number: the listing named #7.
    expect(issuesReadByNumber(fake)).toEqual([7])
  })

  test('of two listed closed issues, the newer without the label and the older with it, the older is the closed status issue', async () => {
    const older = closedStatus(7, '2026-10-24T11:59:00Z', {
      heartbeat_at: '2026-10-24T11:59:00.000Z',
    })
    const newer = closedStatus(9, '2026-10-24T11:59:30Z', {
      heartbeat_at: '2026-10-24T11:00:00.000Z',
      stopped_at: '2026-10-24T11:00:00.000Z',
    })
    const { fake, executor } = staleClosedListing(
      { issues: [older, unlabeled(newer)] },
      { issues: [older, newer] },
    )
    const result = await runStatus({
      cwd: fixture.main,
      env: fixture.env,
      executor,
      clock: fixedClock(NOW),
    })
    expect(result.lines.slice(0, 2)).toEqual([
      'gate: running, heartbeat 1m00s ago',
      'warning: the status issue #7 is closed; a running Gate keeps editing it, but the next start of the Gate creates a new status issue; to keep this one, reopen #7',
    ])
    expect(result.lines).toContain('status issue: #7 https://github.com/hackwin-test/app/issues/7')
    expect(result.out).not.toContain('#9')
    expect(issuesReadByNumber(fake)).toEqual([9, 7])
  })

  test('status reads at most three listed closed issues, last edited first', async () => {
    const listed = [9, 10, 11, 12].map((number) =>
      closedStatus(number, `2026-10-24T11:${String(number).padStart(2, '0')}:00Z`, {
        heartbeat_at: '2026-10-24T11:59:00.000Z',
      }),
    )
    // Only the one edited first, #9, still carries the label.
    const current = listed.map((issue) => (issue.number === 9 ? issue : unlabeled(issue)))
    const { fake, executor } = staleClosedListing({ issues: current }, { issues: listed })
    const result = await runStatus({
      cwd: fixture.main,
      env: fixture.env,
      executor,
      clock: fixedClock(NOW),
    })
    expect(result.lines[0]).toMatch(/^the Gate has not been started/)
    expect(issuesReadByNumber(fake)).toEqual([12, 11, 10])
  })

  test('with an open status issue, status reads no closed one by its number', async () => {
    const closed = closedStatus(7, '2026-10-24T11:59:30Z', {
      heartbeat_at: '2026-10-24T11:59:00.000Z',
    })
    const open = statusIssue(8, { heartbeat_at: '2026-10-24T11:59:00.000Z' })
    const { fake, executor } = staleClosedListing(
      { issues: [unlabeled(closed), open] },
      { issues: [closed, open] },
    )
    const result = await runStatus({
      cwd: fixture.main,
      env: fixture.env,
      executor,
      clock: fixedClock(NOW),
    })
    expect(issuesReadByNumber(fake)).toEqual([])
    expect(result.lines).toContain('status issue: #8 https://github.com/hackwin-test/app/issues/8')
  })
})

describe('1.6f/blocked-notice: BLOCKED is expected while the update restriction is active, in any protection state', () => {
  const plain =
    "only the Gate can merge, so GitHub shows every pull request as BLOCKED, the Lead's included, and that is expected."
  const details =
    'the update restriction is active, so the Gate merges with --admin, and only after its own stages pass'

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
      expect(result.json.lines[1]).toBe(`protection: ${plain} Details: ${protection}; ${details}`)
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

describe('1.6h/plain-words: the protection line of status starts with one plain sentence', () => {
  test('under the update restriction it says that only the Gate can merge and that BLOCKED is expected, then the details', async () => {
    const result = await statusOf({
      issues: [statusIssue(1, { heartbeat_at: '2026-10-24T11:59:00.000Z' })],
    })
    expect(result.lines[1]).toBe(
      "protection: only the Gate can merge, so GitHub shows every pull request as BLOCKED, the Lead's included, and that is expected. Details: full-restricted; the update restriction is active, so the Gate merges with --admin, and only after its own stages pass",
    )
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

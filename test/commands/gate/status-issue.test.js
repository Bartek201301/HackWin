import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { existsSync, rmSync } from 'node:fs'
import { hostname } from 'node:os'
import {
  appendDigestLine,
  formatDigestLine,
  parseDigestLine,
  readDigest,
} from '../../../src/commands/gate/digest.js'
import { gateFiles, readHeartbeat, writeHeartbeat } from '../../../src/commands/gate/state.js'
import {
  MAX_BODY_LENGTH,
  STATUS_LABEL,
  STATUS_TITLE,
  findStatusIssue,
  formatStatusBody,
  parseStatusBody,
  writeStatusIssue,
} from '../../../src/commands/gate/status-issue.js'
import { createGitHub } from '../../../src/core/github/index.js'
import {
  DEFAULT_FAKE_REPO,
  accounts,
  createFakeGitHub,
  createFixture,
  httpError,
  rawResult,
} from '../../harness/index.js'
import { leadGitHub, manualClock, noKeepAwake, readJson, startDirect, until } from './helpers.js'

/** @typedef {import('../../harness/index.js').Fixture} Fixture */
/** @typedef {import('../../harness/index.js').FakeGitHub} FakeGitHub */
/** @typedef {import('../../../src/commands/gate/status-issue.js').GateStatus} GateStatus */
/** @typedef {import('../../../src/commands/gate/digest.js').DigestEntry} DigestEntry */
/** @typedef {Awaited<ReturnType<typeof startDirect>>} StartedGate */

const LEAD = accounts.lead.login
const BUILDER1 = accounts.builder1.login
const START = '2026-10-24T10:00:00.000Z'
const INTERVAL_MS = 120_000
const MACHINE = 'lead-laptop'
const ISSUES = 'repos/{owner}/{repo}/issues'
const HEADER_END = 'type `retry <PR>`, `ack <PR>` or `quit`'

/** @type {Fixture} */
let fixture
/** @type {import('../../../src/commands/gate/state.js').GateFiles} */
let files
/** @type {StartedGate[]} */
let running = []

beforeAll(async () => {
  fixture = await createFixture({ team: 3 })
  files = gateFiles(await fixture.git.commonDir())
})

afterAll(() => fixture.cleanup())

beforeEach(() => {
  rmSync(files.root, { recursive: true, force: true })
})

afterEach(async () => {
  for (const gate of running) gate.io.type('quit')
  await Promise.allSettled(running.map((gate) => gate.done))
  running = []
})

/**
 * Start a Gate of the Lead, without a pipeline, and wait for its header.
 * @param {{ fake: FakeGitHub, clock?: ReturnType<typeof manualClock>, cwd?: string, machine?: string }} options
 */
async function startLead({ fake, clock = manualClock(START), cwd, machine = MACHINE }) {
  const gate = await startDirect(fixture, {
    fake,
    login: LEAD,
    clock,
    cwd,
    options: { keepAwake: noKeepAwake, machine },
  })
  running.push(gate)
  /** @type {unknown} */
  let failure = null
  gate.done.catch((error) => (failure = error ?? new Error('the Gate failed')))
  await until(() => gate.io.out.includes(HEADER_END) || failure, 'the header')
  if (failure) throw failure
  return gate
}

/**
 * Start a Gate that is refused, and return the error.
 * @param {{ fake: FakeGitHub, clock?: ReturnType<typeof manualClock>, cwd?: string, machine?: string }} options
 * @returns {Promise<any>}
 */
async function refusedStart({ fake, clock = manualClock(START), cwd, machine = MACHINE }) {
  const gate = await startDirect(fixture, {
    fake,
    login: LEAD,
    clock,
    cwd,
    options: { keepAwake: noKeepAwake, machine },
  })
  return gate.done.then(
    () => {
      throw new Error('the Gate started')
    },
    (error) => error,
  )
}

/** @param {StartedGate} gate */
async function quit(gate) {
  gate.io.type('quit')
  const result = await gate.done
  running = running.filter((own) => own !== gate)
  return result
}

/**
 * A status as the Gate publishes it.
 * @param {Partial<GateStatus>} [overrides]
 * @returns {GateStatus}
 */
function statusOf(overrides = {}) {
  return {
    heartbeat_at: START,
    stopped_at: null,
    starts: 1,
    machine: MACHINE,
    protection: 'full-restricted',
    update_restricted: true,
    queue: [],
    attention: [],
    digest: [],
    ...overrides,
  }
}

/**
 * A digest entry `minutes` after START.
 * @param {number} pr
 * @param {number} minutes
 * @param {string} result
 * @param {Partial<DigestEntry>} [extra]
 * @returns {DigestEntry}
 */
function entry(pr, minutes, result, extra = {}) {
  return {
    time: new Date(Date.parse(START) + minutes * 60_000).toISOString(),
    pr,
    author: BUILDER1,
    result,
    stage: result === 'merged' ? 'after-merge' : 'merge-test',
    duration: '3m12s',
    note: result === 'merged' ? '' : 'commands.check failed; see the comment on the pull request',
    ...extra,
  }
}

/**
 * A digest of `count` pull requests, newest first; every third one did not merge.
 * @param {number} count
 * @param {Partial<DigestEntry>} [extra]
 */
function longDigest(count, extra = {}) {
  return Array.from({ length: count }, (_, index) =>
    entry(1000 + index, index, index % 3 === 2 ? 'failed' : 'merged', extra),
  ).reverse()
}

/**
 * Check that the kept lines are the newest merged lines and every other line.
 * @param {DigestEntry[]} digest Newest first.
 * @param {DigestEntry[]} kept
 */
function expectOldestMergedLeftOut(digest, kept) {
  const keptPulls = new Set(kept.map((own) => own.pr))
  const dropped = digest.filter((own) => !keptPulls.has(own.pr))
  expect(dropped.length).toBeGreaterThan(0)
  expect(dropped.every((own) => own.result === 'merged')).toBe(true)
  expect(kept).toEqual(digest.filter((own) => keptPulls.has(own.pr)))
  const newestDropped = Math.max(...dropped.map((own) => Date.parse(own.time)))
  const keptMerged = kept.filter((own) => own.result === 'merged')
  expect(keptMerged.every((own) => Date.parse(own.time) > newestDropped)).toBe(true)
}

/**
 * The lines of a body that lie outside every fenced code block.
 * @param {string} body
 */
function outsideFences(body) {
  /** @type {string[]} */
  const outside = []
  let fence = null
  for (const line of body.split('\n')) {
    const marker = /^(`{3,})/.exec(line)?.[1]
    if (fence === null && marker) fence = marker
    else if (fence !== null && line.trim() === fence) fence = null
    else if (fence === null) outside.push(line)
  }
  return outside
}

/**
 * The status issue of the fake with this number.
 * @param {FakeGitHub} fake
 * @param {number} [number]
 */
function issueOf(fake, number = 1) {
  const issue = fake.find(number)
  if (!issue) throw new Error(`the fake has no #${number}`)
  return issue
}

describe('1.6b/status-issue: the body of the status issue and its parser', () => {
  test('the body holds the block of 9.6 and the digest, newest first, and round-trips', () => {
    const status = statusOf({
      starts: 3,
      protection: 'soft',
      update_restricted: true,
      queue: [12, 15],
      attention: [
        {
          type: 'secret',
          pr: 9,
          since: '2026-10-24T09:10:00.000Z',
          todo: 'rotate the key "AWS": revoke it, then type `ack 9`\n```\n@lead #12 é 😀',
        },
        {
          type: 'migration',
          pr: 15,
          since: '2026-10-24T09:20:00.000Z',
          todo: 'apply db/migrations/003.sql and record it in docs/ledger.md',
        },
      ],
      digest: [entry(15, 30, 'failed'), entry(12, 20, 'merged'), entry(9, 10, 'failed')],
    })
    const { body, dropped } = formatStatusBody(status)
    expect(dropped).toEqual([])
    expect(body.startsWith('```yaml\n# hackwin:gate-status\nschema: 1\n')).toBe(true)
    expect(body).toContain(
      [
        `heartbeat_at: "${START}"`,
        'stopped_at: null',
        'starts: 3',
        `machine: "${MACHINE}"`,
        'protection: soft',
        'update_restricted: true',
        'queue: [12, 15]',
        'attention:',
        '  - type: secret',
        '    pr: 9',
        '    since: "2026-10-24T09:10:00.000Z"',
      ].join('\n'),
    )
    expect(body).toContain(
      ['## Digest', '', '```text', ...status.digest.map(formatDigestLine), '```', ''].join('\n'),
    )
    // Nothing that GitHub links or mentions lies outside a code block.
    expect(outsideFences(body).filter((line) => line !== '')).toEqual(['## Digest'])
    expect(parseStatusBody(body)).toEqual(status)

    const stopped = statusOf({ stopped_at: '2026-10-24T11:00:00.000Z', protection: 'full' })
    const empty = formatStatusBody(stopped).body
    expect(empty).toContain('attention: []\n')
    expect(empty).toContain('queue: []\n')
    expect(empty).toContain('## Digest\n\nNo pull request has finished a run yet.\n')
    expect(parseStatusBody(empty)).toEqual(stopped)
  })

  test('a body without a readable block reads as null, and missing fields read as empty', () => {
    expect(parseStatusBody('')).toBe(null)
    expect(parseStatusBody(null)).toBe(null)
    expect(parseStatusBody('```yaml\n# hackwin:task\nkind: task\n```\n')).toBe(null)
    expect(parseStatusBody('```yaml\n# hackwin:gate-status\nschema: 2\n```\n')).toBe(null)
    expect(parseStatusBody('```yaml\n# hackwin:gate-status\nschema: 1\n```\n')).toBe(null)
    expect(parseStatusBody('```yaml\n# hackwin:gate-status\nschema: [1\n```\n')).toBe(null)
    expect(parseStatusBody(`# hackwin:gate-status\nschema: 1\nheartbeat_at: "${START}"\n`)).toBe(
      null,
    )
    expect(
      parseStatusBody(
        `\`\`\`yaml\n# hackwin:gate-status\nschema: 1\nheartbeat_at: "${START}"\nprotection: strong\nqueue: [3, x]\nattention: [{ type: secret }]\n\`\`\`\n`,
      ),
    ).toEqual({
      heartbeat_at: START,
      stopped_at: null,
      starts: 0,
      machine: null,
      protection: null,
      update_restricted: false,
      queue: [3],
      attention: [],
      digest: [],
    })
  })

  test('digest lines: the format of 9.6, and the latest line of each pull request', async () => {
    const line = formatDigestLine(entry(12, 5, 'failed', { note: 'two\nlines' }))
    expect(line).toBe(
      `2026-10-24T10:05:00.000Z #12 ${BUILDER1} failed stage=merge-test 3m12s two lines`,
    )
    expect(parseDigestLine(line)).toEqual(entry(12, 5, 'failed', { note: 'two lines' }))
    expect(parseDigestLine(formatDigestLine(entry(3, 0, 'merged')))).toEqual(entry(3, 0, 'merged'))
    expect(parseDigestLine('12:05 #12 x failed stage=ci 1m')).toBe(null)

    const file = `${files.root}/digest.log`
    await appendDigestLine(file, entry(12, 1, 'failed'))
    await appendDigestLine(file, entry(13, 2, 'merged'))
    await appendDigestLine(file, entry(12, 3, 'merged'))
    expect(await readDigest(file)).toEqual([entry(12, 3, 'merged'), entry(13, 2, 'merged')])
    expect(await readDigest(`${files.root}/none.log`)).toEqual([])
  })

  test('a body above 65,536 characters leaves out the oldest lines of merged pull requests first', () => {
    const digest = longDigest(900)
    const full = formatStatusBody(statusOf({ digest }), { maxLength: Infinity }).body
    expect(full.length).toBeGreaterThan(MAX_BODY_LENGTH)

    const { body, dropped } = formatStatusBody(statusOf({ digest }))
    expect(body.length).toBeLessThanOrEqual(MAX_BODY_LENGTH)
    const kept = /** @type {GateStatus} */ (parseStatusBody(body)).digest
    expectOldestMergedLeftOut(digest, kept)
    expect(dropped).toEqual(digest.filter((own) => !kept.some((k) => k.pr === own.pr)).reverse())
    // One more line would not fit.
    const longer = formatStatusBody(statusOf({ digest: kept.concat(dropped.at(-1) ?? []) }), {
      maxLength: Infinity,
    })
    expect(longer.body.length).toBeGreaterThan(MAX_BODY_LENGTH)

    // When the merged lines are not enough, the oldest others go next.
    const tight = formatStatusBody(statusOf({ digest }), { maxLength: 20_000 })
    expect(tight.body.length).toBeLessThanOrEqual(20_000)
    const merged = digest.filter((own) => own.result === 'merged')
    expect(tight.dropped.slice(0, merged.length)).toEqual([...merged].reverse())
    const others = /** @type {GateStatus} */ (parseStatusBody(tight.body)).digest
    expect(others.every((own) => own.result === 'failed')).toBe(true)
    expect(others).toEqual(digest.filter((own) => own.result === 'failed').slice(0, others.length))
  })

  test('a body that GitHub refuses as too long is sent again within the maximum it names', async () => {
    const fake = createFakeGitHub({
      issues: [{ number: 4, title: STATUS_TITLE, labels: [STATUS_LABEL] }],
    })
    const limit = 50_000
    refuseLongBodies(
      fake,
      limit,
      `Validation Failed: body is too long (maximum is ${limit} characters)`,
    )
    const github = createGitHub({ executor: fake.executor, repo: DEFAULT_FAKE_REPO })
    const digest = longDigest(900)
    const issue = await findStatusIssue(github)
    const written = await writeStatusIssue(github, { issue, status: statusOf({ digest }) })
    expect(written.maxLength).toBe(limit)
    expect(issueOf(fake, 4).body.length).toBeLessThanOrEqual(limit)
    expect(edits(fake, 4).map((call) => call.code)).toEqual([1, 0])
    expectOldestMergedLeftOut(
      digest,
      /** @type {GateStatus} */ (parseStatusBody(issueOf(fake, 4).body)).digest,
    )
  })
})

describe('1.6b/status-issue: created and pinned at the first start, found by its label later', () => {
  test('the first start creates and pins it, quit sets the stop time, the next start finds it', async () => {
    const fake = leadGitHub()
    const clock = manualClock(START)
    const first = await startLead({ fake, clock })
    expect(fake.state.items).toHaveLength(1)
    const issue = issueOf(fake)
    expect(issue).toMatchObject({
      title: STATUS_TITLE,
      labels: [STATUS_LABEL],
      pinned: true,
      state: 'open',
      author: LEAD,
    })
    expect(parseStatusBody(issue.body)).toEqual(statusOf())
    expect(first.io.out).toContain(
      `status issue: #1 https://github.com/${DEFAULT_FAKE_REPO}/issues/1\n`,
    )
    expect(first.io.err).not.toContain('status issue')
    // The first heartbeat in the issue is also the local one.
    expect(readJson(files.heartbeat).heartbeat_at).toBe(START)

    clock.advance(30_000)
    await quit(first)
    const stopped = clock.iso()
    expect(parseStatusBody(issueOf(fake).body)).toMatchObject({
      heartbeat_at: stopped,
      stopped_at: stopped,
    })
    expect(readJson(files.state).status_issue).toEqual({ number: 1, last_edit_at: stopped })

    clock.advance(600_000)
    const second = await startLead({ fake, clock })
    expect(fake.state.items).toHaveLength(1)
    expect(parseStatusBody(issueOf(fake).body)).toEqual(
      statusOf({ heartbeat_at: clock.iso(), starts: 2 }),
    )
    expect(second.io.out).toContain(
      `status issue: #1 https://github.com/${DEFAULT_FAKE_REPO}/issues/1\n`,
    )
    await quit(second)

    const calls = fake.calls.map((call) => call.endpoint ?? call.args.slice(0, 2).join(' '))
    expect(calls.filter((call) => call === ISSUES)).toHaveLength(3)
    expect(
      fake.calls.filter((call) => call.method === 'POST' && call.endpoint === ISSUES),
    ).toHaveLength(1)
    expect(calls.filter((call) => call === 'issue pin')).toHaveLength(1)
    expect(issueOf(fake).comments).toEqual([])
    expect(calls.some((call) => call.endsWith('/comments'))).toBe(false)
  })

  test('of several open issues with the label, the oldest is the status issue', async () => {
    const fake = leadGitHub(undefined, {
      issues: [
        { number: 2, title: 'Closed status', labels: [STATUS_LABEL], state: 'closed' },
        { number: 3, title: 'Task', labels: ['ready'] },
        { number: 5, title: STATUS_TITLE, labels: [STATUS_LABEL] },
        { number: 7, title: STATUS_TITLE, labels: [STATUS_LABEL] },
      ],
    })
    const gate = await startLead({ fake })
    expect(gate.io.out).toContain(
      `status issue: #5 https://github.com/${DEFAULT_FAKE_REPO}/issues/5\n`,
    )
    expect(parseStatusBody(issueOf(fake, 5).body)?.heartbeat_at).toBe(START)
    expect(issueOf(fake, 7).body).toBe('')
    expect(fake.state.items).toHaveLength(4)
    await quit(gate)
  })

  test('when GitHub refuses the pin, the Gate warns and names the label and the link', async () => {
    const fake = leadGitHub(undefined, {
      issues: [1, 2, 3].map((number) => ({ number, title: `Pinned ${number}`, pinned: true })),
    })
    const gate = await startLead({ fake })
    expect(issueOf(fake, 4)).toMatchObject({ labels: [STATUS_LABEL], pinned: false })
    expect(gate.io.err).toContain(
      `warning: the status issue #4 is not pinned: GitHub call failed: gh issue pin 4: GraphQL: A repository can have at most 3 pinned issues. (pinIssue); it is found by its label gate-status: https://github.com/${DEFAULT_FAKE_REPO}/issues/4`,
    )
    expect(gate.io.out).toContain(
      `status issue: #4 https://github.com/${DEFAULT_FAKE_REPO}/issues/4\n`,
    )
    await quit(gate)
  })

  test('when GitHub fails at the start, the Gate runs on and creates the issue one interval later', async () => {
    const fake = leadGitHub()
    const off = fake.on(`POST ${ISSUES}`, () => {
      off()
      throw httpError(502, 'Bad Gateway')
    })
    const clock = manualClock(START)
    const gate = await startLead({ fake, clock })
    expect(gate.io.out).toContain(
      `status issue: not written, the Gate tries again in 120 s: GitHub call failed: gh api --method POST ${ISSUES}: gh: Bad Gateway (HTTP 502)`,
    )
    expect(gate.io.out).toContain('status issue: not created yet\n')
    expect(fake.state.items).toHaveLength(0)

    await until(() => readJson(files.state).last_poll_at === START, 'the first poll')
    clock.advance(60_000)
    await until(() => readJson(files.state).last_poll_at === clock.iso(), 'the second poll')
    expect(fake.state.items).toHaveLength(0)
    clock.advance(60_000)
    await until(() => fake.state.items.length === 1, 'the status issue')
    expect(parseStatusBody(issueOf(fake).body)?.heartbeat_at).toBe(clock.iso())
    expect(issueOf(fake).pinned).toBe(true)
    await quit(gate)
  })
})

describe('1.6b/status-issue: the Gate keeps the body within the size GitHub accepts', () => {
  test('a long digest leaves out the oldest merged lines, and a refusal is retried with fewer', async () => {
    const digest = longDigest(900, { note: '' })
    for (const own of [...digest].reverse()) await appendDigestLine(files.digest, own)
    const fake = leadGitHub(undefined, {
      issues: [{ number: 1, title: STATUS_TITLE, labels: [STATUS_LABEL] }],
    })
    // GitHub's GraphQL message names no maximum: the Gate tries three quarters of the length.
    const limit = 40_000
    refuseLongBodies(fake, limit, 'GraphQL: Body is too long (updateIssue)')
    const clock = manualClock(START)
    const gate = await startLead({ fake, clock })

    const startEdits = edits(fake, 1)
    expect(startEdits.map((call) => call.code)).toEqual([1, 1, 0])
    expect(startEdits[0].body.body.length).toBeLessThanOrEqual(MAX_BODY_LENGTH)
    expect(startEdits[0].body.body.length).toBeGreaterThan(MAX_BODY_LENGTH - 200)
    const body = issueOf(fake).body
    expect(body.length).toBeLessThanOrEqual(limit)
    const kept = /** @type {GateStatus} */ (parseStatusBody(body)).digest
    expectOldestMergedLeftOut(digest, kept)
    expect(gate.io.out).toMatch(
      new RegExp(
        `status issue: the ${digest.length - kept.length} oldest digest lines are left out to stay within \\d+ characters; digest.log keeps every run`,
      ),
    )

    // The next edit stays within the limit that GitHub took, and is not refused.
    clock.advance(INTERVAL_MS)
    await until(() => parseStatusBody(issueOf(fake).body)?.heartbeat_at === clock.iso(), 'the edit')
    expect(edits(fake, 1).map((call) => call.code)).toEqual([1, 1, 0, 0])
    await quit(gate)
  })
})

describe("1.6b/status-issue: a start refuses while the status issue shows another Gate's heartbeat", () => {
  /**
   * The fake with a status issue that another Gate wrote.
   * @param {Partial<GateStatus>} overrides
   */
  function withStatus(overrides) {
    const { body } = formatStatusBody(statusOf(overrides))
    return leadGitHub(undefined, {
      issues: [{ number: 1, title: STATUS_TITLE, labels: [STATUS_LABEL], body }],
    })
  }

  test('a fresh heartbeat of a Gate on another machine refuses the start with exit 2', async () => {
    const fake = withStatus({ heartbeat_at: '2026-10-24T09:59:30.000Z', machine: 'other-laptop' })
    const error = await refusedStart({ fake })
    expect(error.exitCode).toBe(2)
    expect(error.message).toBe(
      'another Gate is running on the machine other-laptop: the status issue #1 shows its heartbeat of 2026-10-24T09:59:30.000Z, 30 s old, and no stop; there is one Gate per project',
    )
    expect(error.resolve).toBe(
      `type \`quit\` in that Gate's terminal; if it no longer runs, wait until 2026-10-24T10:04:30.000Z, when its heartbeat is 300 s old; then run \`hackwin gate\` in ${fixture.main}`,
    )
    // Nothing was started: no start counted, no heartbeat, no edit, no lock left.
    expect(existsSync(files.state)).toBe(false)
    expect(existsSync(files.heartbeat)).toBe(false)
    expect(existsSync(files.lock)).toBe(false)
    expect(edits(fake, 1)).toEqual([])
  })

  test('the message names this machine for a Gate in another clone, and an unnamed one', async () => {
    const same = await refusedStart({
      fake: withStatus({ heartbeat_at: '2026-10-24T09:58:00.000Z' }),
    })
    expect(same.message).toContain(
      `another Gate is running in another clone on this machine (${MACHINE}): the status issue #1 shows its heartbeat of 2026-10-24T09:58:00.000Z, 120 s old`,
    )
    const unnamed = await refusedStart({
      fake: withStatus({ heartbeat_at: '2026-10-24T09:58:00.000Z', machine: null }),
    })
    expect(unnamed.message).toContain(
      'another Gate is running on another machine or in another clone',
    )
  })

  test('a stale heartbeat, or one with a stop time, lets the start go on and take over', async () => {
    for (const overrides of [
      { heartbeat_at: '2026-10-24T09:55:00.000Z', machine: 'other-laptop' },
      {
        heartbeat_at: '2026-10-24T09:59:50.000Z',
        stopped_at: '2026-10-24T09:59:50.000Z',
        machine: 'other-laptop',
      },
    ]) {
      rmSync(files.root, { recursive: true, force: true })
      const fake = withStatus(overrides)
      const gate = await startLead({ fake })
      expect(parseStatusBody(issueOf(fake).body)).toMatchObject({
        heartbeat_at: START,
        stopped_at: null,
        machine: MACHINE,
      })
      await quit(gate)
    }
  })

  test("a heartbeat this clone's Gate wrote before a crash does not count", async () => {
    const fake = leadGitHub()
    const clock = manualClock(START)
    const gate = await startLead({ fake, clock })
    clock.advance(INTERVAL_MS)
    await until(() => parseStatusBody(issueOf(fake).body)?.heartbeat_at === clock.iso(), 'the edit')
    clock.advance(60_000)
    await until(() => readJson(files.heartbeat).heartbeat_at === clock.iso(), 'the heartbeat')
    // The state just before a crash: the issue and the local heartbeat as they were.
    const body = issueOf(fake).body
    const heartbeat = await readHeartbeat(files.heartbeat)
    await quit(gate)
    issueOf(fake).body = body
    await writeHeartbeat(files.heartbeat, /** @type {any} */ (heartbeat))

    clock.advance(30_000)
    const restarted = await startLead({ fake, clock })
    expect(restarted.io.out).toContain('Gate started: start 2, restart 1')
    expect(parseStatusBody(issueOf(fake).body)).toMatchObject({
      heartbeat_at: clock.iso(),
      starts: 2,
    })
    await quit(restarted)

    // The same issue with a heartbeat one second newer than this clone's own was another Gate's.
    issueOf(fake).body = formatStatusBody(
      statusOf({ heartbeat_at: new Date(Date.parse(clock.iso()) + 1000).toISOString() }),
    ).body
    await writeHeartbeat(files.heartbeat, {
      pid: 1,
      heartbeat_at: clock.iso(),
      last_github_ok_at: null,
      stopped_at: null,
    })
    const refused = await refusedStart({ fake, clock })
    expect(refused.message).toContain('another Gate is running in another clone on this machine')
  })

  test('two clones on one machine: the second Gate is refused until the first quits', async () => {
    const fake = leadGitHub()
    const clock = manualClock(START)
    const other = await fixture.clone('lead-second-clone')
    const otherFiles = gateFiles(await other.git.commonDir())
    const first = await startLead({ fake, clock, machine: hostname().split('.')[0] })

    clock.advance(10_000)
    const refused = await refusedStart({
      fake,
      clock,
      cwd: other.path,
      machine: hostname().split('.')[0],
    })
    expect(refused.message).toContain(
      `another Gate is running in another clone on this machine (${hostname().split('.')[0]}): the status issue #1 shows its heartbeat of ${START}, 10 s old`,
    )
    expect(existsSync(otherFiles.state)).toBe(false)

    await quit(first)
    const second = await startLead({ fake, clock, cwd: other.path })
    expect(second.io.out).toContain('Gate started: start 1, pid')
    expect(parseStatusBody(issueOf(fake).body)).toMatchObject({
      heartbeat_at: clock.iso(),
      stopped_at: null,
    })
    await quit(second)
    expect(fake.state.items).toHaveLength(1)
  })
})

/**
 * Refuse every body edit of an issue longer than `limit` with this message, as GitHub would.
 * @param {FakeGitHub} fake
 * @param {number} limit
 * @param {string} message
 */
function refuseLongBodies(fake, limit, message) {
  fake.on(`PATCH ${ISSUES}/:number`, async ({ params, body }) => {
    if (typeof body?.body === 'string' && body.body.length > limit) {
      throw httpError(422, message)
    }
    issueOf(fake, Number(params.number)).body = body.body
    return rawResult(await fake.executor(['api', '--method', 'GET', `${ISSUES}/${params.number}`]))
  })
}

/**
 * The body edits of an issue, in order, with gh's exit codes.
 * @param {FakeGitHub} fake
 * @param {number} number
 */
function edits(fake, number) {
  return fake.calls.filter(
    (call) => call.method === 'PATCH' && call.endpoint === `${ISSUES}/${number}`,
  )
}

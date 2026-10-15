import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { existsSync, rmSync } from 'node:fs'
import {
  appendDigestLine,
  formatDigestLine,
  parseDigestLine,
  readDigest,
} from '../../../src/commands/gate/digest.js'
import {
  gateFiles,
  loadGateId,
  readHeartbeat,
  writeHeartbeat,
} from '../../../src/commands/gate/state.js'
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
/** The Gate id of another clone, in the issues of the tests. */
const OTHER_ID = '0123456789abcdef'
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
 * @param {{ fake: FakeGitHub, clock?: ReturnType<typeof manualClock>, cwd?: string }} options
 */
async function startLead({ fake, clock = manualClock(START), cwd }) {
  const gate = await startDirect(fixture, {
    fake,
    login: LEAD,
    clock,
    cwd,
    options: { keepAwake: noKeepAwake },
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
 * @param {{ fake: FakeGitHub, clock?: ReturnType<typeof manualClock>, cwd?: string }} options
 * @returns {Promise<any>}
 */
async function refusedStart({ fake, clock = manualClock(START), cwd }) {
  const gate = await startDirect(fixture, {
    fake,
    login: LEAD,
    clock,
    cwd,
    options: { keepAwake: noKeepAwake },
  })
  return gate.done.then(
    () => {
      throw new Error('the Gate started')
    },
    (error) => error,
  )
}

/**
 * The Gate id of a clone, from its `gate/gate-id`.
 * @param {import('../../../src/commands/gate/state.js').GateFiles} [own]
 * @returns {string}
 */
function gateIdOf(own = files) {
  return readJson(own.id).gate_id
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
    gate_id: OTHER_ID,
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
        `gate_id: "${OTHER_ID}"`,
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
    // No `#<PR>` lies outside a code block, where GitHub would link it.
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
      gate_id: null,
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

  test('a body refused with HTTP 422 is sent again with fewer lines, whatever the message', async () => {
    const fake = createFakeGitHub({
      issues: [{ number: 4, title: STATUS_TITLE, labels: [STATUS_LABEL] }],
    })
    refuseBodies(fake, (body) => body.length > 50_000)
    const github = createGitHub({ executor: fake.executor, repo: DEFAULT_FAKE_REPO })
    const digest = longDigest(900)
    const issue = await findStatusIssue(github)
    const limits = { maxLength: MAX_BODY_LENGTH }
    await writeStatusIssue(github, { issue, status: statusOf({ digest }), limits })
    const sent = edits(fake, 4)
    expect(sent.map((call) => call.code)).toEqual([1, 0])
    expect(limits.maxLength).toBe(Math.floor((sent[0].body.body.length * 3) / 4))
    expect(issueOf(fake, 4).body.length).toBeLessThanOrEqual(limits.maxLength)
    expectOldestMergedLeftOut(
      digest,
      /** @type {GateStatus} */ (parseStatusBody(issueOf(fake, 4).body)).digest,
    )
  })

  test('after a write whose every try was refused, the next write starts below every refused size', async () => {
    const fake = createFakeGitHub({
      issues: [{ number: 4, title: STATUS_TITLE, labels: [STATUS_LABEL] }],
    })
    let refuseAll = true
    refuseBodies(fake, () => refuseAll)
    const github = createGitHub({ executor: fake.executor, repo: DEFAULT_FAKE_REPO })
    const issue = await findStatusIssue(github)
    const status = statusOf({ digest: longDigest(900) })
    const limits = { maxLength: MAX_BODY_LENGTH }
    await expect(writeStatusIssue(github, { issue, status, limits })).rejects.toMatchObject({
      status: 422,
    })
    const refused = edits(fake, 4).map((call) => call.body.body.length)
    expect(refused).toHaveLength(4)
    expect(refused.every((length, index) => index === 0 || length < refused[index - 1])).toBe(true)
    expect(limits.maxLength).toBe(Math.floor(((refused.at(-1) ?? 0) * 3) / 4))

    refuseAll = false
    await writeStatusIssue(github, { issue, status, limits })
    const next = edits(fake, 4).slice(4)
    expect(next.map((call) => call.code)).toEqual([0])
    expect(next[0].body.body.length).toBeLessThan(Math.min(...refused))

    // A body without a digest line to leave out is sent once; another failure is never retried.
    refuseAll = true
    const empty = { maxLength: MAX_BODY_LENGTH }
    await expect(
      writeStatusIssue(github, { issue, status: statusOf(), limits: empty }),
    ).rejects.toMatchObject({ status: 422 })
    expect(edits(fake, 4).slice(5)).toHaveLength(1)
    const off = fake.on(`PATCH ${ISSUES}/:number`, () => {
      throw httpError(502, 'Bad Gateway')
    })
    const unchanged = { maxLength: MAX_BODY_LENGTH }
    await expect(
      writeStatusIssue(github, { issue, status, limits: unchanged }),
    ).rejects.toMatchObject({ status: 502 })
    off()
    expect(edits(fake, 4).slice(6)).toHaveLength(1)
    expect(unchanged.maxLength).toBe(MAX_BODY_LENGTH)
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
    expect(parseStatusBody(issue.body)).toEqual(statusOf({ gate_id: gateIdOf() }))
    expect(gateIdOf()).toMatch(/^[0-9a-f]{16}$/)
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
      statusOf({ heartbeat_at: clock.iso(), starts: 2, gate_id: gateIdOf() }),
    )
    expect(second.io.out).toContain(
      `status issue: #1 https://github.com/${DEFAULT_FAKE_REPO}/issues/1\n`,
    )
    await quit(second)

    const calls = fake.calls.map((call) => call.endpoint ?? call.args.slice(0, 2).join(' '))
    // Each start finds the issue by its label, and each edit after a start reads it first (#24).
    expect(
      fake.calls.filter((call) => call.method === 'GET' && call.endpoint === ISSUES),
    ).toHaveLength(4)
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
    const limit = 40_000
    refuseBodies(fake, (body) => body.length > limit)
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
    const allowed = Math.floor((startEdits[1].body.body.length * 3) / 4)
    expect(gate.io.out).toContain(
      `status issue: GitHub refused a body with HTTP 422, so the Gate writes at most ${allowed} characters from now on`,
    )
    expect(gate.io.out).toContain(
      `status issue: the ${digest.length - kept.length} oldest digest lines are left out to stay within ${allowed} characters; digest.log keeps every run`,
    )

    // The next edit stays within the size that GitHub took, and is not refused.
    clock.advance(INTERVAL_MS)
    await until(() => parseStatusBody(issueOf(fake).body)?.heartbeat_at === clock.iso(), 'the edit')
    expect(edits(fake, 1).map((call) => call.code)).toEqual([1, 1, 0, 0])
    await quit(gate)
  })

  test('when every try of an edit is refused, the next interval sends a smaller body once', async () => {
    const digest = longDigest(900, { note: '' })
    for (const own of [...digest].reverse()) await appendDigestLine(files.digest, own)
    const fake = leadGitHub(undefined, {
      issues: [{ number: 1, title: STATUS_TITLE, labels: [STATUS_LABEL] }],
    })
    let refuseAll = true
    refuseBodies(fake, () => refuseAll)
    const clock = manualClock(START)
    const gate = await startLead({ fake, clock })
    const refused = edits(fake, 1).map((call) => call.body.body.length)
    expect(refused).toHaveLength(4)
    expect(gate.io.out).toContain(
      'status issue: not written, the Gate tries again in 120 s: GitHub call failed: gh api --method PATCH',
    )

    refuseAll = false
    clock.advance(INTERVAL_MS)
    await until(() => parseStatusBody(issueOf(fake).body)?.heartbeat_at === clock.iso(), 'the edit')
    const next = edits(fake, 1).slice(4)
    expect(next.map((call) => call.code)).toEqual([0])
    expect(next[0].body.body.length).toBeLessThanOrEqual(
      Math.floor(((refused.at(-1) ?? 0) * 3) / 4),
    )
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

  test("a fresh heartbeat of another clone's Gate refuses the start with exit 2", async () => {
    const fake = withStatus({ heartbeat_at: '2026-10-24T09:59:30.000Z' })
    const error = await refusedStart({ fake })
    const own = gateIdOf()
    expect(own).not.toBe(OTHER_ID)
    expect(error.exitCode).toBe(2)
    expect(error.message).toBe(
      `another Gate is running for this project: the status issue #1 shows the heartbeat of the Gate ${OTHER_ID} at 2026-10-24T09:59:30.000Z, 30 s old, and no stop; this clone's Gate is ${own}; there is one Gate per project`,
    )
    expect(error.resolve).toBe(
      `type \`quit\` in that Gate's terminal (its clone holds ${OTHER_ID} in .git/hackwin/gate/gate-id); if it no longer runs, wait until 2026-10-24T10:04:30.000Z, when its heartbeat is 300 s old; then run \`hackwin gate\` in ${fixture.main}`,
    )
    // Nothing was started: no start counted, no heartbeat, no edit, no lock left. Only the
    // clone's Gate id now exists.
    expect(existsSync(files.state)).toBe(false)
    expect(existsSync(files.heartbeat)).toBe(false)
    expect(existsSync(files.lock)).toBe(false)
    expect(edits(fake, 1)).toEqual([])
  })

  test("this clone's id decides: no local heartbeat or a clock ahead does not matter, an older heartbeat of another id does", async () => {
    const { id } = await loadGateId(files.id, new Date(START))
    // The issue shows this clone's id 40 s ahead of this clock, and there is no local heartbeat.
    const ahead = withStatus({ heartbeat_at: '2026-10-24T10:00:40.000Z', gate_id: id })
    const gate = await startLead({ fake: ahead })
    // The clone has no state file, so the count goes on from the start the status issue counts.
    expect(gate.io.out).toContain('Gate started: start 2, restart 1')
    await quit(gate)

    // Another id is another Gate, even when its heartbeat is older than this clone's local one.
    await writeHeartbeat(files.heartbeat, {
      pid: 1,
      heartbeat_at: START,
      last_github_ok_at: null,
      stopped_at: null,
    })
    const older = await refusedStart({
      fake: withStatus({ heartbeat_at: '2026-10-24T09:59:00.000Z' }),
    })
    expect(older.message).toContain(`shows the heartbeat of the Gate ${OTHER_ID}`)
  })

  test('without an id in the block, or with a new id of this clone, the local heartbeat decides', async () => {
    const heartbeat = '2026-10-24T09:59:30.000Z'
    const local = () =>
      writeHeartbeat(files.heartbeat, {
        pid: 1,
        heartbeat_at: heartbeat,
        last_github_ok_at: null,
        stopped_at: null,
      })

    // No id, no local heartbeat: another Gate.
    const unnamed = await refusedStart({
      fake: withStatus({ heartbeat_at: heartbeat, gate_id: null }),
    })
    expect(unnamed.message).toContain(
      'another Gate is running for this project: the status issue #1 shows the heartbeat of a Gate without an id at 2026-10-24T09:59:30.000Z, 30 s old',
    )
    expect(unnamed.resolve).toMatch(/^type `quit` in that Gate's terminal; if it no longer runs/)

    // No id, and the local heartbeat is as new: this clone's own.
    await local()
    const own = await startLead({ fake: withStatus({ heartbeat_at: heartbeat, gate_id: null }) })
    await quit(own)

    // This clone's id file was lost, so its new id says nothing; the local heartbeat decides.
    rmSync(files.root, { recursive: true, force: true })
    await local()
    const lost = await startLead({ fake: withStatus({ heartbeat_at: heartbeat }) })
    expect(gateIdOf()).not.toBe(OTHER_ID)
    await quit(lost)
  })

  test('a stale heartbeat, or one with a stop time, lets the start go on and take over', async () => {
    for (const overrides of [
      { heartbeat_at: '2026-10-24T09:55:00.000Z' },
      { heartbeat_at: '2026-10-24T09:59:50.000Z', stopped_at: '2026-10-24T09:59:50.000Z' },
    ]) {
      rmSync(files.root, { recursive: true, force: true })
      const fake = withStatus(overrides)
      const gate = await startLead({ fake })
      expect(parseStatusBody(issueOf(fake).body)).toMatchObject({
        heartbeat_at: START,
        stopped_at: null,
        gate_id: gateIdOf(),
      })
      await quit(gate)
    }
  })

  test("a heartbeat this clone's Gate wrote before a crash does not count, also without the local heartbeat", async () => {
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

    // The same crash, and the local heartbeat file is gone too.
    issueOf(fake).body = body
    rmSync(files.heartbeat)
    clock.advance(10_000)
    const again = await startLead({ fake, clock })
    expect(again.io.out).toContain('Gate started: start 3, restart 2')
    await quit(again)
  })

  test('two clones on one machine: the second Gate is refused until the first quits', async () => {
    const fake = leadGitHub()
    const clock = manualClock(START)
    const other = await fixture.clone('lead-second-clone')
    const otherFiles = gateFiles(await other.git.commonDir())
    const first = await startLead({ fake, clock })

    clock.advance(10_000)
    const refused = await refusedStart({ fake, clock, cwd: other.path })
    expect(gateIdOf(otherFiles)).not.toBe(gateIdOf())
    expect(refused.message).toBe(
      `another Gate is running for this project: the status issue #1 shows the heartbeat of the Gate ${gateIdOf()} at ${START}, 10 s old, and no stop; this clone's Gate is ${gateIdOf(otherFiles)}; there is one Gate per project`,
    )
    expect(existsSync(otherFiles.state)).toBe(false)

    await quit(first)
    const second = await startLead({ fake, clock, cwd: other.path })
    // A start in another clone is a restart as well (M7; scope change on #24).
    expect(second.io.out).toContain(
      'the status issue #1 counts 1 Gate starts and this clone 0, so the count goes on from the status issue (M7)',
    )
    expect(second.io.out).toContain('Gate started: start 2, restart 1, pid')
    expect(parseStatusBody(issueOf(fake).body)).toMatchObject({
      heartbeat_at: clock.iso(),
      stopped_at: null,
      starts: 2,
      gate_id: gateIdOf(otherFiles),
    })
    await quit(second)
    expect(fake.state.items).toHaveLength(1)
  })
})

/**
 * Refuse the body edits that `refuse` names with HTTP 422 "Validation Failed", the status that
 * GitHub's reference lists for "Update an issue", and take the others.
 * @param {FakeGitHub} fake
 * @param {(body: string) => boolean} refuse
 */
function refuseBodies(fake, refuse) {
  fake.on(`PATCH ${ISSUES}/:number`, async ({ params, body }) => {
    if (refuse(body.body)) throw httpError(422, 'Validation Failed')
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

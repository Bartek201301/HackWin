import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { rmSync } from 'node:fs'
import { appendDigestLine, readDigest } from '../../../src/commands/gate/digest.js'
import { gateFiles, pullRecord } from '../../../src/commands/gate/state.js'
import {
  STATUS_LABEL,
  STATUS_TITLE,
  parseStatusBody,
} from '../../../src/commands/gate/status-issue.js'
import { accounts, createFixture } from '../../harness/index.js'
import { leadGitHub, manualClock, noKeepAwake, readJson, startDirect, until } from './helpers.js'

/** @typedef {import('../../harness/index.js').Fixture} Fixture */
/** @typedef {import('../../harness/index.js').FakeGitHub} FakeGitHub */
/** @typedef {import('../../../src/commands/gate/gate.js').Gate} Gate */
/** @typedef {import('../../../src/commands/gate/gate.js').Pipeline} Pipeline */
/** @typedef {Awaited<ReturnType<typeof startDirect>>} StartedGate */

const LEAD = accounts.lead.login
const BUILDER1 = accounts.builder1.login
const START = '2026-10-24T10:00:00.000Z'
const POLL_MS = 60_000
const INTERVAL_MS = 120_000
const ISSUES = 'repos/{owner}/{repo}/issues'
const HEAD = 'a'.repeat(40)

/** @type {Fixture} */
let fixture
/** @type {import('../../../src/commands/gate/state.js').GateFiles} */
let files
/** @type {StartedGate[]} */
let running = []

beforeAll(async () => {
  fixture = await createFixture({ team: 3 })
  files = gateFiles(await fixture.git.commonDir())
  rmSync(files.root, { recursive: true, force: true })
})

afterAll(() => fixture.cleanup())

afterEach(async () => {
  for (const gate of running) gate.io.type('quit')
  await Promise.allSettled(running.map((gate) => gate.done))
  running = []
})

/**
 * @typedef {{ kind: 'queued', pr: number }
 *   | { kind: 'ran', pr: number, result: 'merged' | 'failed' }
 *   | { kind: 'attention', pr: number, type: string }
 *   | { kind: 'resolved', pr: number }} PullEvent
 */

/**
 * 45 events of 15 pull requests: each joins the queue and runs; five fail, raise or close an
 * attention item, join again and merge.
 * @returns {PullEvent[]}
 */
function pullEvents() {
  /** @type {PullEvent[]} */
  const events = []
  for (let pr = 101; pr <= 115; pr += 1) {
    events.push(
      { kind: 'queued', pr },
      { kind: 'ran', pr, result: pr % 3 === 0 ? 'failed' : 'merged' },
    )
  }
  events.push(
    { kind: 'attention', pr: 105, type: 'scope-violation' },
    { kind: 'attention', pr: 108, type: 'secret' },
    { kind: 'attention', pr: 111, type: 'repeated-failure' },
  )
  for (const pr of [102, 105, 108, 111, 114]) {
    events.push({ kind: 'queued', pr }, { kind: 'ran', pr, result: 'merged' })
    if (pr === 105 || pr === 111) events.push({ kind: 'resolved', pr })
  }
  return events
}

/**
 * Apply one event to the Gate's state and digest, as the pipeline would.
 * @param {Gate} gate
 * @param {PullEvent} event
 */
async function apply(gate, event) {
  const { state } = gate
  const now = gate.ctx.clock.now().toISOString()
  switch (event.kind) {
    case 'queued':
      state.queue.push(event.pr)
      state.prs[String(event.pr)] = pullRecord(HEAD, now)
      return
    case 'ran':
      state.queue = state.queue.filter((pr) => pr !== event.pr)
      state.prs[String(event.pr)].result = event.result
      await appendDigestLine(gate.files.digest, {
        time: now,
        pr: event.pr,
        author: BUILDER1,
        result: event.result,
        stage: event.result === 'merged' ? 'after-merge' : 'merge-test',
        duration: '2m',
        note: event.result === 'merged' ? '' : 'commands.check failed',
      })
      return
    case 'attention':
      state.attention.push({
        type: event.type,
        pr: event.pr,
        since: now,
        todo: `look at #${event.pr}`,
        resolved_at: null,
      })
      return
    case 'resolved':
      for (const item of state.attention) if (item.pr === event.pr) item.resolved_at = now
  }
}

/**
 * Every write of the status issue body that GitHub took, in order.
 * @param {FakeGitHub} fake
 */
function writes(fake) {
  return fake.calls
    .filter(
      (call) =>
        call.code === 0 &&
        ((call.method === 'POST' && call.endpoint === ISSUES) ||
          (call.method === 'PATCH' && call.endpoint === `${ISSUES}/1`)),
    )
    .map((call) => {
      const status = parseStatusBody(call.body.body)
      if (status === null) throw new Error('a write without a status block')
      return status
    })
}

describe('AC62: the status issue over a run of 45 pull request events', () => {
  test('no comment, an advancing heartbeat, and no two edits closer than the interval but at start and quit', async () => {
    const fake = leadGitHub()
    const clock = manualClock(START)
    const events = pullEvents()
    expect(events).toHaveLength(45)
    let applied = 0
    let polls = 0
    /** @type {Pipeline} */
    const pipeline = {
      async intake(gate) {
        // One to three events per poll.
        for (const event of events.splice(0, (polls % 3) + 1)) {
          await apply(gate, event)
          applied += 1
        }
        polls += 1
      },
    }

    const start = async () => {
      const gate = await startDirect(fixture, {
        fake,
        login: LEAD,
        clock,
        options: { pipeline, keepAwake: noKeepAwake },
      })
      running.push(gate)
      await until(() => gate.io.out.includes('`quit`'), 'the header')
      await until(() => readJson(files.state).last_poll_at === clock.iso(), 'the first poll')
      return gate
    }
    /** @param {StartedGate} gate */
    const quit = async (gate) => {
      gate.io.type('quit')
      await gate.done
      running = running.filter((own) => own !== gate)
    }
    const issueHeartbeat = () => parseStatusBody(fake.find(1)?.body)?.heartbeat_at
    /** One poll interval later: the poll, and the edit once one is due. */
    const nextPoll = async () => {
      const before = polls
      const lastEdit = Date.parse(issueHeartbeat() ?? START)
      clock.advance(POLL_MS)
      await until(
        () => polls > before && readJson(files.state).last_poll_at === clock.iso(),
        'the poll',
      )
      if (clock.now().getTime() - lastEdit >= INTERVAL_MS) {
        await until(() => issueHeartbeat() === clock.iso(), `the edit at ${clock.iso()}`)
      }
    }

    // The first Gate runs through 25 events and stops between two polls.
    const first = await start()
    while (applied < 25) await nextPoll()
    // The Gate wrote its own local heartbeat at least as late as the one in the issue.
    expect(readJson(files.heartbeat).heartbeat_at >= /** @type {string} */ (issueHeartbeat())).toBe(
      true,
    )
    clock.advance(30_000)
    await quit(first)
    const firstStop = clock.iso()

    // The restart, ten seconds later, runs through the rest.
    clock.advance(10_000)
    const second = await start()
    while (events.length > 0) await nextPoll()
    clock.advance(45_000)
    await quit(second)
    const secondStop = clock.iso()
    expect(applied).toBe(45)

    const all = writes(fake)
    const quits = all.filter((own) => own.stopped_at !== null)
    expect(quits.map((own) => own.stopped_at)).toEqual([firstStop, secondStop])
    expect(all.at(-1)?.stopped_at).toBe(secondStop)
    // The start edits: the first write and the one after the first quit; both clear the stop time.
    const startEdits = [all[0], all[all.indexOf(quits[0]) + 1]]
    expect(startEdits.map((own) => [own.starts, own.stopped_at])).toEqual([
      [1, null],
      [2, null],
    ])

    // The heartbeat advances with every edit.
    const times = all.map((own) => Date.parse(own.heartbeat_at))
    for (let index = 1; index < times.length; index += 1) {
      expect(times[index]).toBeGreaterThan(times[index - 1])
    }
    // Every other edit follows the edit before it by at least the interval, and by no more than
    // the interval while the Gate runs.
    for (let index = 1; index < all.length; index += 1) {
      if (startEdits.includes(all[index]) || quits.includes(all[index])) continue
      expect(times[index] - times[index - 1]).toBeGreaterThanOrEqual(INTERVAL_MS)
      expect(times[index] - times[index - 1]).toBeLessThanOrEqual(INTERVAL_MS)
    }
    expect(all.length).toBeGreaterThan(10)

    // The issue: created once, pinned, no comment.
    expect(fake.state.items).toHaveLength(1)
    expect(fake.find(1)).toMatchObject({
      title: STATUS_TITLE,
      labels: [STATUS_LABEL],
      pinned: true,
      comments: [],
    })
    expect(fake.calls.some((call) => call.endpoint?.endsWith('/comments'))).toBe(false)
    expect(
      fake.calls.filter((call) => call.method === 'POST' && call.endpoint === ISSUES),
    ).toHaveLength(1)

    // What the edits carried: the attention items while open, and at the end the latest line of
    // each pull request, newest first.
    expect(all.some((own) => own.attention.some((item) => item.pr === 105))).toBe(true)
    expect(all.some((own) => own.queue.length > 0)).toBe(true)
    const last = /** @type {NonNullable<ReturnType<typeof parseStatusBody>>} */ (all.at(-1))
    expect(last.queue).toEqual([])
    expect(last.attention.map((item) => [item.type, item.pr])).toEqual([['secret', 108]])
    expect(last.digest).toEqual(await readDigest(files.digest))
    expect(last.digest.map((own) => own.pr).sort()).toEqual(
      Array.from({ length: 15 }, (_, index) => 101 + index),
    )
    expect(last.digest.every((own) => own.result === 'merged')).toBe(true)
  })
})

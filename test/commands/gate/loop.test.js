import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { emptyState, gateFiles, pullRecord, saveState } from '../../../src/commands/gate/state.js'
import { exec } from '../../../src/core/runtime/index.js'
import { DEFAULT_FAKE_REPO, accounts, createFixture } from '../../harness/index.js'
import {
  isPending,
  leadGitHub,
  manualClock,
  noKeepAwake,
  readJson,
  startDirect,
  until,
  waitForFile,
} from './helpers.js'

/** @typedef {import('../../harness/index.js').Fixture} Fixture */
/** @typedef {import('../../../src/commands/gate/gate.js').Pipeline} Pipeline */
/** @typedef {Awaited<ReturnType<typeof startDirect>>} StartedGate */

const LEAD = accounts.lead.login
const POLL_MS = 60_000
const PR = 12

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
 * Start a Gate with a pipeline, after writing a state whose queue holds PR.
 * @param {{ pipeline?: Pipeline, queued?: boolean, keepAwake?: any, prepare?: (ctx: any) => void, fake?: import('../../harness/index.js').FakeGitHub }} [options]
 */
async function start({
  pipeline = {},
  queued = false,
  keepAwake = noKeepAwake,
  prepare,
  fake = leadGitHub(),
} = {}) {
  if (queued) {
    const state = emptyState()
    state.queue = [PR]
    state.prs[String(PR)] = pullRecord(await fixture.git.revParse('HEAD'), '2026-10-24T09:00:00Z')
    await saveState(files.state, state)
  }
  const gate = await startDirect(fixture, {
    fake,
    login: LEAD,
    clock: manualClock(),
    options: { pipeline, keepAwake },
    prepare,
  })
  running.push(gate)
  /** @type {unknown} */
  let failure = null
  gate.done.catch((error) => (failure = error ?? new Error('the Gate failed')))
  await until(() => gate.io.out.includes('`quit`') || failure, 'the header')
  if (failure) throw failure
  return gate
}

/**
 * @param {StartedGate} gate
 */
async function quit(gate) {
  gate.io.type('quit')
  const result = await gate.done
  running = running.filter((own) => own !== gate)
  return result
}

/**
 * A pipeline whose run has two stages; the command of the first runs until the test creates
 * the file `release`.
 * @param {string} release
 */
function twoStages(release) {
  /** @type {string[]} */
  const steps = []
  /** @type {Pipeline} */
  const pipeline = {
    async run(gate, pr) {
      await gate.stage(pr, 'merge-test')
      steps.push('merge-test started')
      await exec(process.execPath, ['-e', waitForFile(release)])
      steps.push('merge-test finished')
      if (gate.stopping) return
      await gate.stage(pr, 'ci')
      steps.push('ci')
      gate.state.queue.shift()
      gate.state.prs[String(pr)].result = 'merged'
    },
  }
  return { pipeline, steps }
}

describe('AC31/gate: the local heartbeat is renewed at least once per poll interval', () => {
  test('also while a stage command runs as a child process (G5)', async () => {
    const release = join(fixture.dir, 'release-heartbeat')
    const { pipeline, steps } = twoStages(release)
    const gate = await start({ pipeline, queued: true })
    await until(() => steps.includes('merge-test started'), 'the stage')
    expect(readJson(files.state).prs[String(PR)].stage).toBe('merge-test')

    /** @type {string[]} */
    const beats = [readJson(files.heartbeat).heartbeat_at]
    for (let poll = 1; poll <= 3; poll += 1) {
      gate.clock.advance(POLL_MS)
      const at = gate.clock.iso()
      await until(() => readJson(files.heartbeat).heartbeat_at === at, `heartbeat ${poll}`)
      await until(() => readJson(files.state).last_poll_at === at, `poll ${poll}`)
      beats.push(at)
    }
    // The stage command ran through all three polls.
    expect(steps).toEqual(['merge-test started'])
    const gaps = beats.slice(1).map((at, index) => Date.parse(at) - Date.parse(beats[index]))
    expect(gaps.every((gap) => gap <= POLL_MS)).toBe(true)

    writeFileSync(release, '')
    await until(() => steps.includes('ci'), 'the second stage')
    await until(() => readJson(files.state).queue.length === 0, 'the end of the run')
    expect(readJson(files.state).prs[String(PR)]).toMatchObject({ stage: 'ci', result: 'merged' })
    expect((await quit(gate)).data).toMatchObject({ starts: 1, queue: [] })
  })
})

describe('1.6a/input: quit stops after the current step', () => {
  test('a running stage finishes, and no later stage starts', async () => {
    const release = join(fixture.dir, 'release-quit')
    const { pipeline, steps } = twoStages(release)
    const gate = await start({ pipeline, queued: true })
    await until(() => steps.includes('merge-test started'), 'the stage')

    gate.io.type('quit')
    await until(() => gate.io.out.includes('quit: the Gate stops after the current step'), 'quit')
    expect(await isPending(gate.done)).toBe(true)
    expect(existsSync(files.lock)).toBe(true)

    writeFileSync(release, '')
    const result = await gate.done
    running = []
    expect(steps).toEqual(['merge-test started', 'merge-test finished'])
    expect(result.lines[0]).toMatch(/Gate stopped; to start it again, run `hackwin gate` in /)
    const state = readJson(files.state)
    expect(state.queue).toEqual([PR])
    expect(state.prs[String(PR)].stage).toBe('merge-test')
    expect(readJson(files.heartbeat).stopped_at).toBe(gate.clock.iso())
    expect(existsSync(files.lock)).toBe(false)
  })

  test('a running poll finishes, and no later poll starts', async () => {
    /** @type {string[]} */
    const polls = []
    /** @type {() => void} */
    let finishPoll = () => {}
    /** @type {Pipeline} */
    const pipeline = {
      async intake(gate) {
        polls.push(gate.ctx.clock.now().toISOString())
        if (polls.length === 2) await new Promise((resolve) => (finishPoll = () => resolve(null)))
      },
    }
    const gate = await start({ pipeline })
    await until(() => polls.length === 1, 'the first poll')
    gate.clock.advance(POLL_MS)
    await until(() => polls.length === 2, 'the second poll')

    gate.io.type('quit')
    await until(() => gate.io.out.includes('quit: the Gate stops after the current step'), 'quit')
    gate.clock.advance(POLL_MS)
    expect(await isPending(gate.done)).toBe(true)

    finishPoll()
    await gate.done
    running = []
    expect(polls).toHaveLength(2)
    expect(readJson(files.state).last_poll_at).toBe(polls[1])
  })

  test('an idle Gate stops at once', async () => {
    const gate = await start()
    expect(await quit(gate)).toMatchObject({ data: { starts: 1, queue: [] } })
    expect(existsSync(files.lock)).toBe(false)
  })
})

describe('1.6a/typed: retry, ack and other input', () => {
  test('ack closes the open secret attention item of the pull request', async () => {
    mkdirSync(files.root, { recursive: true })
    const state = emptyState()
    state.attention = [
      { type: 'secret', pr: 9, since: '2026-10-24T09:00:00Z', todo: 'rotate', resolved_at: null },
      {
        type: 'migration',
        pr: 10,
        since: '2026-10-24T09:00:00Z',
        todo: 'apply',
        resolved_at: null,
      },
    ]
    await saveState(files.state, state)
    const gate = await start()

    gate.io.type('ack #9')
    await until(
      () => gate.io.out.includes('ack #9: the secret attention item of #9 is closed'),
      'ack',
    )
    gate.io.type('ack 10')
    await until(() => gate.io.out.includes('ack #10: #10 has no open secret attention item'), 'ack')
    await quit(gate)
    expect(readJson(files.state).attention).toEqual([
      { ...state.attention[0], resolved_at: gate.clock.iso() },
      state.attention[1],
    ])
  })

  test('retry queues only a failed or flaky run again, and other input gets the help', async () => {
    const head = await fixture.git.revParse('HEAD')
    const state = emptyState()
    state.prs['5'] = { ...pullRecord(head, '2026-10-24T09:00:00Z'), result: 'failed' }
    state.prs['6'] = { ...pullRecord(head, '2026-10-24T09:00:00Z'), result: 'needs-owner' }
    await saveState(files.state, state)
    /** @type {number[][]} */
    const retried = []
    const gate = await start({
      pipeline: {
        async intake(gate) {
          retried.push([...gate.retries])
        },
      },
    })
    await until(() => retried.length === 1, 'the first poll')

    gate.io.type('retry 5')
    gate.io.type('retry 5')
    gate.io.type('retry 6')
    gate.io.type('retry 7')
    gate.io.type('merge 5')
    await until(() => gate.io.out.includes('unknown input'), 'the help')
    expect(gate.io.out).toContain('retry #5: queued again at the next poll')
    expect(gate.io.out).toContain('retry #5: #5 is queued already')
    expect(gate.io.out).toContain(
      'retry #6: only a failed or flaky run is retried, and the last run of #6 ended needs-owner; a new head SHA queues it again',
    )
    expect(gate.io.out).toContain('retry #7: the Gate has not seen #7')
    expect(gate.io.out).toContain('unknown input: merge 5; type `retry <PR>`, `ack <PR>` or `quit`')

    gate.clock.advance(POLL_MS)
    await until(() => retried.length === 2, 'the next poll')
    expect(retried[1]).toEqual([5])
    await quit(gate)
  })
})

describe('1.6a/awake: a Gate that cannot keep the laptop awake warns', () => {
  test('when no command exists, and when the command ends while the Gate runs', async () => {
    /** @type {(reason: string) => void} */
    let lose = () => {}
    const gate = await start({
      keepAwake: async (/** @type {any} */ { onLost }) => {
        lose = onLost
        return { active: true, command: 'caffeinate -i -w 1', reason: null, stop: () => {} }
      },
    })
    expect(gate.io.out).toContain('keep awake: caffeinate -i -w 1\n')
    lose('caffeinate exited with code 1')
    expect(gate.io.err).toContain(
      'warning: the laptop may sleep now: caffeinate exited with code 1; merges wait while it sleeps',
    )
    await quit(gate)

    const without = await start({
      keepAwake: async () => ({
        active: false,
        command: null,
        reason: 'Windows through WSL offers no command that keeps the laptop awake',
        stop: () => {},
      }),
    })
    expect(without.io.err).toContain(
      'warning: the Gate cannot keep this laptop awake: Windows through WSL offers no command that keeps the laptop awake; merges wait while it sleeps',
    )
    expect(without.io.out).toContain('keep awake: off\n')
    await quit(without)
  })
})

describe('1.6a/header: the gated notice and the status issue', () => {
  test('no notice while paths.gated has a glob, and the status issue once it exists', async () => {
    const fake = leadGitHub(undefined, {
      issues: [{ number: 31, title: 'HackWin Gate status', labels: ['gate-status'] }],
    })
    const gate = await start({
      fake,
      prepare: (ctx) => {
        ctx.config.hackwin.paths.gated.migrations = ['db/migrations/**']
      },
    })
    expect(gate.io.out).toContain(
      `status issue: #31 https://github.com/${DEFAULT_FAKE_REPO}/issues/31\n`,
    )
    expect(gate.io.out).not.toContain('paths.gated is empty')
    await quit(gate)
  })
})

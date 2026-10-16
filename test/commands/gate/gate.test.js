import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { INHIBITOR_WHO } from '../../../src/commands/gate/awake.js'
import { emptyState, gateFiles, pullRecord } from '../../../src/commands/gate/state.js'
import { DEFAULT_FAKE_REPO, accounts, createFixture } from '../../harness/index.js'
import {
  ADMIN_BYPASS,
  ONE_APPROVAL,
  branchRulesBody,
  updateRestrictionBody,
} from '../../core/protection/rulesets.js'
import {
  leadGitHub,
  manualClock,
  noKeepAwake,
  readJson,
  startDirect,
  startMain,
  terminal,
  until,
} from './helpers.js'

// The waits of these tests are long (helpers.js, until; scene.js), so that a loaded machine
// fails no test; a test may take as long as its waits.
vi.setConfig({ testTimeout: 120_000 })

/** @typedef {import('../../harness/index.js').Fixture} Fixture */
/** @typedef {import('./helpers.js').Terminal} Terminal */

const LEAD = accounts.lead.login
const BUILDER1 = accounts.builder1.login
const POLL_MS = 60_000
const HEADER_END = 'type `retry <PR>`, `ack <PR>` or `quit`'

/** @type {Fixture} */
let fixture
/** @type {import('../../../src/commands/gate/state.js').GateFiles} */
let files
/** @type {Array<{ io: Terminal, done: Promise<number> }>} */
let running = []

beforeAll(async () => {
  fixture = await createFixture({ team: 3 })
  files = gateFiles(await fixture.git.commonDir())
})

afterAll(() => fixture.cleanup())

beforeEach(() => {
  rmSync(files.root, { recursive: true, force: true })
})

// A Gate that a failed test left running would hold the lock for the next test.
afterEach(async () => {
  for (const gate of running) gate.io.type('quit')
  await Promise.allSettled(running.map((gate) => gate.done))
  running = []
})

/**
 * Start a Gate of the Lead in a terminal and wait for its header.
 * @param {Parameters<typeof startMain>[1] extends infer O ? Partial<O> : never} [options]
 */
async function startLeadGate(options = {}) {
  const gate = startMain(fixture, { fake: leadGitHub(), login: LEAD, ...options })
  running.push(gate)
  await until(
    async () => gate.io.out.includes(HEADER_END) || (await isSettled(gate.done)),
    'the header',
  )
  if (!gate.io.out.includes(HEADER_END)) throw new Error(`the Gate did not start: ${gate.io.err}`)
  return gate
}

/**
 * Start a Gate of the Lead without a pipeline, on a context that the runner prepared as for
 * `hackwin gate` in a terminal, and wait for its header. `done` settles with the exit code.
 */
async function startProcessGate() {
  const started = await startDirect(fixture, {
    fake: leadGitHub(),
    login: LEAD,
    options: { pipeline: {}, keepAwake: noKeepAwake },
  })
  const gate = { io: started.io, done: started.done.then(() => 0) }
  running.push(gate)
  await until(
    async () => gate.io.out.includes(HEADER_END) || (await isSettled(gate.done)),
    'the header',
  )
  if (!gate.io.out.includes(HEADER_END)) throw new Error(`the Gate did not start: ${gate.io.err}`)
  return gate
}

/**
 * @param {{ io: Terminal, done: Promise<number> }} gate
 * @returns {Promise<number>}
 */
async function quit(gate) {
  gate.io.type('quit')
  const code = await gate.done
  running = running.filter((own) => own !== gate)
  return code
}

/** @param {Promise<unknown>} promise */
async function isSettled(promise) {
  let settled = false
  promise.then(
    () => (settled = true),
    () => (settled = true),
  )
  await new Promise((resolve) => setImmediate(resolve))
  return settled
}

/** The files a Gate leaves in the gate directory. */
function gateFilesPresent() {
  return {
    lock: existsSync(files.lock),
    state: existsSync(files.state),
    heartbeat: existsSync(files.heartbeat),
  }
}

describe("AC30: only the Lead starts the Gate, and only one Gate runs on the Lead's laptop", () => {
  test('gate under a builder account exits 2 and starts nothing', async () => {
    const builder = await fixture.clone('builder1-clone')
    const { io, done } = startMain(fixture, {
      cwd: builder.path,
      fake: leadGitHub(),
      login: BUILDER1,
    })
    expect(await done).toBe(2)
    expect(io.err).toContain(
      `there is one Gate, on the Lead's laptop under the Lead's account ${LEAD}, and merges wait while it is down; gh is logged in as ${BUILDER1}`,
    )
    expect(io.err).toContain(`to resolve: ask the Lead (${LEAD}) to start the Gate if it is down`)
    const builderFiles = gateFiles(await builder.git.commonDir())
    expect(existsSync(builderFiles.root)).toBe(false)
  })

  test('a second gate exits 2 while the first holds the lock', async () => {
    const first = await startLeadGate()
    expect(readJson(files.lock).pid).toBe(process.pid)

    const second = startMain(fixture, { fake: leadGitHub(), login: LEAD })
    expect(await second.done).toBe(2)
    expect(second.io.err).toContain(
      `another Gate is running on this machine: pid ${process.pid}, started ${readJson(files.lock).started_at}; there is one Gate per project`,
    )
    expect(second.io.out).toBe('')
    expect(readJson(files.state).starts).toBe(1)

    expect(await quit(first)).toBe(0)
    expect(existsSync(files.lock)).toBe(false)
  })
})

describe('AC58: the /gate wrapper inside an agent session starts no Gate', () => {
  const wrapperEnv = () => ({ ...fixture.env, HACKWIN_CALLER: 'claude-code' })

  test('it prints the instruction to run hackwin gate in a separate terminal', async () => {
    const { io, done } = startMain(fixture, { fake: leadGitHub(), login: LEAD, env: wrapperEnv() })
    expect(await done).toBe(2)
    expect(io.err).toContain(
      'the Gate starts only in its own terminal, never inside an agent session or a script: open a separate terminal for it; no Gate is running on this machine',
    )
    expect(io.err).toContain(`to resolve: run \`hackwin gate\` in ${fixture.main}`)
    expect(gateFilesPresent()).toEqual({ lock: false, state: false, heartbeat: false })
  })

  test('it says that a Gate is already running, with its pid and heartbeat', async () => {
    const gate = await startLeadGate()
    const heartbeat = await until(
      () => existsSync(files.heartbeat) && readJson(files.heartbeat),
      'the first heartbeat',
    )

    const { io, done } = startMain(fixture, {
      fake: leadGitHub(),
      login: LEAD,
      env: wrapperEnv(),
      args: ['--json'],
    })
    expect(await done).toBe(2)
    const result = JSON.parse(io.out)
    expect(result.error.kind).toBe('precondition')
    expect(result.error.message).toContain(
      `a Gate is already running on this machine: pid ${process.pid}, started ${readJson(files.lock).started_at}, last heartbeat ${heartbeat.heartbeat_at}`,
    )
    expect(result.error.resolve).toEqual({ command: 'hackwin gate', dir: fixture.main })
    expect(result.error.details.caller).toBe('claude-code')

    expect(await quit(gate)).toBe(0)
    expect(readJson(files.state).starts).toBe(1)
  })

  test('a script without a terminal is refused the same way', async () => {
    const io = terminal()
    io.stdin.isTTY = false
    const { done } = startMain(fixture, { fake: leadGitHub(), login: LEAD, io })
    expect(await done).toBe(2)
    expect(io.err).toContain('the Gate starts only in its own terminal')
    expect(io.err).toContain(`to resolve: run \`hackwin gate\` in ${fixture.main}`)
    expect(gateFilesPresent()).toEqual({ lock: false, state: false, heartbeat: false })
  })
})

describe('1.6a/state: the state file survives a restart and counts every start', () => {
  test('the start count grows by one per start, and what a run recorded survives', async () => {
    const first = await startLeadGate()
    expect(first.io.out).toContain('Gate started: start 1, pid')
    expect(await quit(first)).toBe(0)
    expect(readJson(files.state)).toMatchObject({ schema: 1, starts: 1 })

    // What a pipeline would have recorded before the Gate stopped.
    const head = await fixture.git.revParse('HEAD')
    const state = readJson(files.state)
    state.queue = [7]
    state.prs['7'] = { ...pullRecord(head, '2026-10-24T09:00:00.000Z'), stage: 'merge-test' }
    state.attention = [
      {
        type: 'secret',
        pr: 9,
        since: '2026-10-24T09:10:00.000Z',
        todo: 'rotate',
        resolved_at: null,
      },
    ]
    writeFileSync(files.state, JSON.stringify(state))

    // Without a pipeline: intake would drop #7, which the fake GitHub does not hold.
    const second = await startProcessGate()
    expect(second.io.out).toContain('Gate started: start 2, restart 1, pid')
    expect(second.io.out).toContain('queue: 1 pull request\n')
    expect(await quit(second)).toBe(0)
    const after = readJson(files.state)
    expect(after.starts).toBe(2)
    expect(after.queue).toEqual([7])
    expect(after.prs['7']).toEqual(state.prs['7'])
    expect(after.attention).toEqual(state.attention)
  })

  test('a lock left by a crashed Gate is replaced, and the restart is counted', async () => {
    mkdirSync(files.root, { recursive: true })
    writeFileSync(files.state, JSON.stringify({ ...emptyState(), starts: 4 }))
    const dead = deadPid()
    writeFileSync(
      files.lock,
      JSON.stringify({
        schema: 1,
        pid: dead,
        started_at: '2026-10-24T08:00:00.000Z',
        token: 'old',
      }),
    )

    const gate = await startLeadGate()
    expect(gate.io.out).toContain(`replaced the lock of a Gate that no longer runs (pid ${dead})`)
    expect(gate.io.out).toContain('Gate started: start 5, restart 4')
    expect(readJson(files.lock).pid).toBe(process.pid)
    expect(await quit(gate)).toBe(0)
    expect(readJson(files.state).starts).toBe(5)
  })

  test('the state is written after every poll, and the stop time into the heartbeat', async () => {
    const clock = manualClock()
    const gate = await startLeadGate({ clock })
    const firstPoll = clock.iso()
    await until(() => readJson(files.state).last_poll_at === firstPoll, 'the first poll')
    const state = readJson(files.state)
    expect(state.main_sha).toBe(await fixture.git.revParse('origin/main'))
    expect(state.last_github_ok_at).toBe(firstPoll)

    clock.advance(POLL_MS)
    await until(() => readJson(files.state).last_poll_at === clock.iso(), 'the second poll')

    expect(await quit(gate)).toBe(0)
    expect(readJson(files.heartbeat)).toMatchObject({
      schema: 1,
      pid: process.pid,
      heartbeat_at: clock.iso(),
      stopped_at: clock.iso(),
    })
    expect(gate.io.out).toContain(
      `Gate stopped; to start it again, run \`hackwin gate\` in ${fixture.main}`,
    )
  })

  test('a state file that is not readable is kept aside, and the Gate starts empty', async () => {
    mkdirSync(files.root, { recursive: true })
    writeFileSync(files.state, '{ not json')
    const gate = await startLeadGate()
    const kept = `${files.state}.unreadable-2026-10-24T10-00-00-000Z`
    expect(gate.io.err).toContain(
      `warning: the state file was not readable; it is kept as ${kept}, and the Gate starts empty`,
    )
    expect(existsSync(kept)).toBe(true)
    expect(await quit(gate)).toBe(0)
    expect(readJson(files.state).starts).toBe(1)
  })
})

describe('1.6a/header: the header of a starting Gate', () => {
  test('protection, Resolver, poll interval, queue, status issue and the gated notice', async () => {
    const gate = await startLeadGate()
    const header = gate.io.out.split('\n')
    expect(header[0]).toMatch(
      new RegExp(`^\\d\\d:\\d\\d Gate started: start 1, pid ${process.pid}$`),
    )
    expect(header.slice(1, 6)).toEqual([
      'protection: full-restricted',
      'resolver: none',
      'poll: every 60 s',
      'queue: 0 pull requests',
      `status issue: #1 https://github.com/${DEFAULT_FAKE_REPO}/issues/1`,
    ])
    expect(header).toContain(
      'notice: paths.gated is empty, so the Gate can raise no attention line for a migration or a production config change',
    )
    expect(header).toContain(
      "notice: the update restriction is active, so GitHub shows every pull request as BLOCKED, the Lead's included; that is expected: the Gate merges with --admin, and only after its own stages pass",
    )
    expect(header.filter((line) => line.includes('not built yet'))).toEqual([])
    expect(header).not.toContain(
      'notice: the pipeline is not built yet: this Gate polls, but takes no pull request',
    )
    expect(await quit(gate)).toBe(0)
  })
})

describe('1.6a/protection: under the update restriction the Lead may bypass nothing else', () => {
  test('a rule that the Lead can bypass besides the update restriction refuses the start', async () => {
    const restriction = updateRestrictionBody()
    const fake = leadGitHub([
      branchRulesBody(),
      { ...restriction, rules: [...restriction.rules, ONE_APPROVAL] },
    ])
    const { io, done } = startMain(fixture, { fake, login: LEAD })
    expect(await done).toBe(2)
    expect(io.err).toContain(
      "the update restriction is active, so the Gate merges with --admin, which would also skip these rules that the Lead's account can bypass: pull_request (rule set hackwin-update-restriction)",
    )
    expect(io.err).toContain('to resolve: put these rules into a rule set without bypass actors')
    expect(gateFilesPresent()).toEqual({ lock: false, state: false, heartbeat: false })
  })

  test('without the update restriction, rules the Lead can bypass do not stop the start', async () => {
    const fake = leadGitHub([{ ...branchRulesBody(), bypass_actors: [ADMIN_BYPASS] }])
    const gate = await startLeadGate({ fake })
    expect(gate.io.out).toContain('protection: soft\n')
    expect(await quit(gate)).toBe(0)
  })
})

describe('1.6a/hooks: the Gate runs git with the member hooks switched off', () => {
  test('a fetch of the Gate runs no hook of the clone', async () => {
    const hooks = join(fixture.dir, 'member-hooks')
    const marker = join(fixture.dir, 'hook-ran')
    mkdirSync(hooks, { recursive: true })
    writeFileSync(join(hooks, 'reference-transaction'), `#!/bin/sh\ntouch '${marker}'\n`)
    chmodSync(join(hooks, 'reference-transaction'), 0o755)
    await fixture.git.configSet('core.hooksPath', hooks)
    try {
      const clock = manualClock()
      const gate = await startLeadGate({ clock })
      await until(() => readJson(files.state).last_poll_at === clock.iso(), 'the first poll')
      rmSync(marker, { force: true })

      const pushed = await fixture.publish({ 'hooks.txt': 'one\n' }, { message: 'Move main' })
      clock.advance(POLL_MS)
      await until(() => readJson(files.state).main_sha === pushed, 'the fetch of the new main')
      expect(existsSync(marker)).toBe(false)
      expect(await quit(gate)).toBe(0)

      // The same fetch with the hooks on runs the hook.
      await fixture.publish({ 'hooks.txt': 'two\n' }, { message: 'Move main again' })
      await fixture.git.fetch({ remote: 'origin' })
      expect(existsSync(marker)).toBe(true)
    } finally {
      await fixture.git.run(['config', '--unset', 'core.hooksPath'])
    }
  })
})

const inhibitor = sleepInhibitor()

describe('AC31/gate: the operating system reports a sleep inhibitor while the Gate runs', () => {
  test.skipIf(inhibitor === null)(
    `${inhibitor?.name ?? 'no inhibitor on this platform'} lists the Gate's inhibitor until quit`,
    async () => {
      const check = /** @type {NonNullable<typeof inhibitor>} */ (inhibitor)
      const gate = await startLeadGate()
      expect(gate.io.err).not.toContain('cannot keep this laptop awake')
      await until(() => check.active(process.pid), 'the inhibitor', 5000)
      expect(await quit(gate)).toBe(0)
      await until(() => !check.active(process.pid), 'the end of the inhibitor', 5000)
    },
  )
})

/**
 * How the operating system lists the Gate's sleep inhibitor: `pmset -g assertions` on macOS,
 * `systemd-inhibit --list` on Linux where systemd-logind grants this user a lock. Null elsewhere.
 * @returns {{ name: string, active: (pid: number) => boolean } | null}
 */
function sleepInhibitor() {
  if (process.platform === 'darwin') {
    return {
      name: 'pmset -g assertions',
      active: (pid) => {
        const text = execFileSync('pmset', ['-g', 'assertions'], { encoding: 'utf8' })
        const pattern =
          /\(caffeinate\): [^\n]*PreventUserIdleSystemSleep[^\n]*\n\s*Details: caffeinate asserting on behalf of Process ID (\d+)/g
        return [...text.matchAll(pattern)].some((match) => Number(match[1]) === pid)
      },
    }
  }
  if (
    process.platform === 'linux' &&
    !/microsoft/i.test(execFileSync('uname', ['-r']).toString())
  ) {
    const probe = spawnSync(
      'systemd-inhibit',
      ['--what=idle:sleep', '--who=probe', '--why=probe', '--mode=block', 'true'],
      { stdio: 'ignore' },
    )
    if (probe.status !== 0) return null
    return {
      name: 'systemd-inhibit --list',
      active: () =>
        execFileSync('systemd-inhibit', ['--list', '--no-pager'], { encoding: 'utf8' }).includes(
          INHIBITOR_WHO,
        ),
    }
  }
  return null
}

/** The pid of a process that has ended. */
function deadPid() {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
    encoding: 'utf8',
  })
  return Number(child.stdout)
}

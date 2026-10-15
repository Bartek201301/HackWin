// Helpers of the Gate's tests: a terminal to type into, a clock that moves only when the test
// moves it, the Lead's fake GitHub with the rule sets of `setup`, and ways to start a Gate.

import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { createContext } from '../../../src/cli/context.js'
import { main, prepareContext } from '../../../src/cli/main.js'
import { COMMANDS } from '../../../src/cli/registry.js'
import { startGate } from '../../../src/commands/gate/gate.js'
import { createOutput } from '../../../src/core/runtime/index.js'
import { createFakeGitHub } from '../../harness/index.js'
import {
  branchRulesBody,
  serveRulesets,
  updateRestrictionBody,
} from '../../core/protection/rulesets.js'

/** @typedef {import('../../harness/index.js').Fixture} Fixture */
/** @typedef {import('../../harness/index.js').FakeGitHub} FakeGitHub */

/**
 * The streams of an interactive terminal: stdin and stdout are TTYs, so the caller kind is
 * `terminal` unless HACKWIN_CALLER says otherwise.
 */
export function terminal() {
  const stdin = Object.assign(new PassThrough(), { isTTY: true })
  let out = ''
  let err = ''
  return {
    stdin,
    stdout: {
      isTTY: true,
      write: (/** @type {string} */ chunk) => {
        out += chunk
        return true
      },
    },
    stderr: {
      write: (/** @type {string} */ chunk) => {
        err += chunk
        return true
      },
    },
    get out() {
      return out
    },
    get err() {
      return err
    },
    /** @param {string} line */
    type: (line) => stdin.write(`${line}\n`),
  }
}

/** @typedef {ReturnType<typeof terminal>} Terminal */

/**
 * A clock whose time moves only through advance(): a sleep ends when the time reaches its end.
 * @param {string} [start]
 */
export function manualClock(start = '2026-10-24T10:00:00.000Z') {
  let time = Date.parse(start)
  /** @type {Array<{ at: number, resolve: () => void }>} */
  let sleepers = []
  return {
    now: () => new Date(time),
    sleep: (/** @type {number} */ ms) =>
      ms <= 0
        ? Promise.resolve()
        : new Promise((resolve) => sleepers.push({ at: time + ms, resolve: () => resolve() })),
    /** @param {number} ms */
    advance(ms) {
      time += ms
      const due = sleepers.filter((sleeper) => sleeper.at <= time)
      sleepers = sleepers.filter((sleeper) => sleeper.at > time)
      for (const sleeper of due) sleeper.resolve()
    },
    iso: () => new Date(time).toISOString(),
  }
}

/** @typedef {ReturnType<typeof manualClock>} ManualClock */

/**
 * The fake GitHub with the rule sets that `setup` creates: the protection state is
 * `full-restricted`, and the Lead can bypass only the update restriction.
 * @param {any[]} [rulesets]
 * @param {Parameters<typeof createFakeGitHub>[0]} [initial] The rest of the fake's state.
 * @returns {FakeGitHub}
 */
export function leadGitHub(rulesets = [branchRulesBody(), updateRestrictionBody()], initial = {}) {
  const fake = createFakeGitHub(initial)
  serveRulesets(fake, rulesets)
  return fake
}

/**
 * Run `hackwin gate` in-process; `done` settles with the exit code when the Gate stops.
 * @param {Fixture} fixture
 * @param {{ cwd?: string, fake: FakeGitHub, login: string, clock?: ManualClock, io?: Terminal, env?: Record<string, string | undefined>, args?: string[] }} options
 */
export function startMain(fixture, options) {
  const { cwd = fixture.main, fake, login, clock = manualClock(), io = terminal() } = options
  const done = main(['gate', ...(options.args ?? [])], {
    cwd,
    env: options.env ?? fixture.env,
    stdin: io.stdin,
    stdout: io.stdout,
    stderr: io.stderr,
    clock,
    ghExecutor: fake.as(login),
  })
  return { io, clock, done }
}

/**
 * Start the Gate with its options (a pipeline, a keep awake), on a context that the runner
 * prepared as for `hackwin gate` in a terminal. `done` settles with the result.
 * @param {Fixture} fixture
 * @param {{ fake: FakeGitHub, login: string, clock?: ManualClock, io?: Terminal, options?: import('../../../src/commands/gate/gate.js').GateOptions, prepare?: (ctx: any) => void, cwd?: string, env?: Record<string, string | undefined> }} setup
 *   `cwd` is a checkout of another clone; the main checkout by default. `env` is the Gate's
 *   environment; the fixture's by default.
 */
export async function startDirect(fixture, setup) {
  const { fake, login, clock = manualClock(), io = terminal(), cwd = fixture.main } = setup
  const ctx = await createContext({
    command: 'gate',
    args: [],
    flags: {},
    cwd,
    env: setup.env ?? fixture.env,
    stdin: io.stdin,
    stdoutIsTTY: true,
    out: createOutput({ stdout: io.stdout, stderr: io.stderr }),
    clock,
    ghExecutor: fake.as(login),
  })
  await prepareContext(ctx, /** @type {any} */ (COMMANDS.find((entry) => entry.name === 'gate')))
  setup.prepare?.(ctx)
  const done = startGate(ctx, setup.options)
  return { io, clock, ctx, done }
}

/** A keep awake that starts nothing, for tests that do not look at the operating system. */
export async function noKeepAwake() {
  return { active: true, command: 'test keep awake', reason: null, stop: () => {} }
}

/**
 * Wait until `check` returns a truthy value, looking every 10 ms. The wait is long, so that a
 * loaded machine does not fail a test; it only delays the report of a real failure.
 * @template T
 * @param {() => T | Promise<T>} check
 * @param {string} what
 * @param {number} [timeoutMs]
 * @returns {Promise<T>}
 */
export async function until(check, what, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/**
 * True when the promise has not settled within a few event loop turns.
 * @param {Promise<unknown>} promise
 */
export async function isPending(promise) {
  const pending = Symbol('pending')
  const value = await Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(pending), 50)),
  ])
  return value === pending
}

/**
 * The parsed JSON of a file.
 * @param {string} file
 */
export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/**
 * A script for `node -e` that runs until the file `release` exists: a stage command that the
 * test ends.
 * @param {string} release
 */
export function waitForFile(release) {
  return `const fs = require('node:fs'); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) clearInterval(timer) }, 10)`
}

// A Gate in a process of its own, for the tests that kill it (AC22) or trace it (AC35). It runs
// `hackwin gate` of the Lead as the runner prepares it in a terminal, with the real pipeline and
// the system clock, and sends every gh call to the test's fake GitHub over the IPC channel of
// `fork` (scene.js, fork). A message `quit` types `quit` into its terminal. When the Gate stops,
// the process sends `done` with the result, or `error` with the error, and ends.
//
// The argument is JSON: `cwd` and `env` of the Gate, and `notify`, the platform, kernel release
// and environment of the notifier (notify.js); without it the notifier shows nothing and records
// nothing. The keep awake starts nothing.

import { PassThrough } from 'node:stream'
import { createContext } from '../../../src/cli/context.js'
import { prepareContext } from '../../../src/cli/main.js'
import { COMMANDS } from '../../../src/cli/registry.js'
import { startGate } from '../../../src/commands/gate/gate.js'
import { createNotifier } from '../../../src/commands/gate/notify.js'
import { createPipeline } from '../../../src/commands/gate/pipeline.js'
import { createOutput, systemClock } from '../../../src/core/runtime/index.js'

const post = /** @type {NonNullable<typeof process.send>} */ (process.send).bind(process)
/**
 * Send a message to the test, and settle once it went out.
 * @param {unknown} message
 * @returns {Promise<void>}
 */
const send = (message) => new Promise((resolve) => post(message, undefined, {}, () => resolve()))
const options = JSON.parse(process.argv[2])
const stdin = Object.assign(new PassThrough(), { isTTY: true })

/** @type {Map<number, (answer: { code: number, stdout: string, stderr: string }) => void>} */
const waiting = new Map()
let next = 0
process.on('message', (/** @type {any} */ message) => {
  if (message.type === 'gh') {
    waiting.get(message.id)?.(message.answer)
    waiting.delete(message.id)
  } else if (message.type === 'quit') {
    stdin.write('quit\n')
  }
})

/** @type {import('../../../src/core/github/executor.js').GhExecutor} */
const executor = (args, call = {}) =>
  new Promise((resolve) => {
    const id = next
    next += 1
    waiting.set(id, resolve)
    void send({ type: 'gh', id, args, input: call.input, env: call.env })
  })

try {
  const ctx = await createContext({
    command: 'gate',
    args: [],
    flags: {},
    cwd: options.cwd,
    env: options.env,
    stdin,
    stdoutIsTTY: true,
    out: createOutput({ stdout: process.stdout, stderr: process.stderr }),
    clock: systemClock,
    ghExecutor: executor,
  })
  await prepareContext(ctx, /** @type {any} */ (COMMANDS.find((entry) => entry.name === 'gate')))
  const notifier = options.notify
    ? createNotifier(options.notify)
    : async () => ({ shown: true, reason: null })
  const result = await startGate(ctx, {
    pipeline: createPipeline({ notifier }),
    keepAwake: async () => ({
      active: true,
      command: 'none, a test',
      reason: null,
      stop: () => {},
    }),
  })
  await send({ type: 'done', result })
} catch (error) {
  await send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  process.exitCode = 2
}
process.disconnect()

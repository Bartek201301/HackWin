// The pipeline of section 9 that the Gate loop runs (gate.js, Pipeline): intake at every poll,
// and the run of the pull request at the head of the queue through the stages, one after another
// (G8, G17). Stages 1 to 6 decide whether a pull request may be tested at all (stages.js); stages
// 7 to 11 follow in 1.6d. Until then a pull request that passes stage 6 waits at the head of the
// queue.
//
// A run checks between two stages whether the Lead typed `quit`, and returns then, so that the
// Gate stops after the current step. It also checks whether intake replaced the pull request's
// record: a new head SHA ends the run as `requeued` (9.6), a draft or a closed pull request ends
// it without a digest line.

import { intake } from './intake.js'
import { createNotifier } from './notify.js'
import { duration, endFailed, leaveQueue, writeDigest } from './pulls.js'
import { STAGES, STOP, stageTitle } from './stages.js'

/** @import { Gate, Pipeline } from './gate.js' */
/** @import { Notifier } from './notify.js' */
/** @import { PullRun } from './stages.js' */

/**
 * What intake and the runs share.
 * @typedef {object} Tools
 * @property {Notifier} notifier The operating system notification for a secret (G26).
 * @property {<T>(pr: number, work: () => Promise<T>) => Promise<T>} serial Runs the work for one
 *   pull request after the work for it that started earlier, so that intake and a run never write
 *   to the same pull request at once.
 * @property {Map<number, string | null>} authors The author of each open pull request, from the
 *   latest intake.
 * @property {Set<string>} waiting `<PR>:<sha>` of the head SHAs that passed every built stage.
 */

/**
 * The pipeline of stages 1 to 6.
 * @param {{ notifier?: Notifier }} [options] The notifier; the one of this machine by default.
 * @returns {Pipeline}
 */
export function createPipeline({ notifier = createNotifier() } = {}) {
  /** @type {Tools} */
  const tools = { notifier, serial: createSerial(), authors: new Map(), waiting: new Set() }
  const last = STAGES[STAGES.length - 1]
  return {
    intake: (gate) => intake(gate, tools),
    run: (gate, pr) => runPull(gate, tools, pr),
    notices:
      last.number < 11
        ? [
            `stages ${last.number + 1} to 11 are not built yet: a pull request that passes stage ${last.number} waits at the head of the queue`,
          ]
        : [],
  }
}

/**
 * Take the pull request at the head of the queue through the stages.
 * @param {Gate} gate
 * @param {Tools} tools
 * @param {number} pr
 * @returns {Promise<void>}
 */
async function runPull(gate, tools, pr) {
  const { state, ctx } = gate
  const key = String(pr)
  const record = state.prs[key]
  if (!record) {
    leaveQueue(state, pr)
    return
  }
  const sha = record.head_sha
  if (tools.waiting.has(`${pr}:${sha}`)) return
  /** @type {PullRun} */
  const run = {
    gate,
    notifier: tools.notifier,
    pr,
    sha,
    record,
    startedAt: ctx.clock.now().getTime(),
    author: tools.authors.get(pr) ?? null,
    main: '',
    config: gate.config,
    task: null,
    changed: [],
    superseded: () => state.prs[key] !== record,
    act: (write) =>
      tools.serial(pr, async () => {
        if (run.superseded()) return false
        await write()
        return true
      }),
  }

  for (const stage of STAGES) {
    if (gate.stopping) return
    if (run.superseded()) return superseded(run)
    await gate.stage(pr, stage.name)
    const started = ctx.clock.now().getTime()
    const outcome = await stage.run(run)
    record.stage_times[stage.name] = Math.round((ctx.clock.now().getTime() - started) / 1000)
    if (outcome === STOP) return run.superseded() ? superseded(run) : undefined
    if (outcome) {
      const failure = { ...outcome, stage: stage.name, title: stageTitle(stage) }
      const ended = await run.act(() =>
        endFailed(gate, tools.notifier, {
          pr,
          record,
          author: run.author,
          main: run.main,
          startedAt: run.startedAt,
          failure,
        }),
      )
      if (!ended) await superseded(run)
      return
    }
  }
  if (run.superseded()) return superseded(run)
  const last = STAGES[STAGES.length - 1]
  if (last.number >= 11) return
  tools.waiting.add(`${pr}:${sha}`)
  await gate.save()
  gate.line(
    `#${pr} passed stages 1 to ${last.number} with head ${sha}; stages ${last.number + 1} to 11 are not built yet, so it waits at the head of the queue`,
  )
}

/**
 * The end of a run whose record intake replaced. When a new head SHA joined the queue, the run
 * ends as `requeued` (9.6); a draft, a closed pull request or a new head SHA that failed at
 * intake leaves no line of this run.
 * @param {PullRun} run
 * @returns {Promise<void>}
 */
async function superseded(run) {
  const { gate, pr, record } = run
  const current = gate.state.prs[String(pr)]
  if (!current || current.result !== null || !gate.state.queue.includes(pr)) return
  const now = gate.ctx.clock.now()
  await writeDigest(gate, {
    time: now.toISOString(),
    pr,
    author: run.author ?? '-',
    result: 'requeued',
    stage: record.stage ?? 'intake',
    duration: duration(now.getTime() - run.startedAt),
    note: `the new head ${current.head_sha} joined the back of the queue`,
  })
}

/**
 * One queue of work per pull request.
 * @returns {Tools['serial']}
 */
function createSerial() {
  /** @type {Map<number, Promise<unknown>>} */
  const tails = new Map()
  return (pr, work) => {
    const next = (tails.get(pr) ?? Promise.resolve()).then(work)
    const tail = next.then(
      () => {},
      () => {},
    )
    tails.set(pr, tail)
    tail.then(() => {
      if (tails.get(pr) === tail) tails.delete(pr)
    })
    return next
  }
}

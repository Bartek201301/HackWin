// The pipeline of section 9 that the Gate loop runs (gate.js, Pipeline): intake at every poll,
// and the run of the pull request at the head of the queue through stages 1 to 11, one after
// another (G8, G17). Stages 1 to 6 decide whether a pull request may be tested at all
// (stages.js); stage 7 tests its merge with main (merge-test.js), stage 8 waits for CI (ci.js),
// and stages 9 to 11 merge it (merge.js). When main moved since the merge test, stage 9 sends the
// run back to stage 6 (G20).
//
// A run checks between two stages whether the Lead typed `quit`, and returns then, so that the
// Gate stops after the current step. It also checks whether intake replaced the pull request's
// record: a new head SHA ends the run as `requeued` (9.6), a draft or a closed pull request ends
// it without a digest line. A run that stopped after its merge takes up again at stage 10, which
// does not merge a second time.

import { admitHead, intake } from './intake.js'
import { createNotifier } from './notify.js'
import { duration, endFailed, leaveQueue, writeDigest } from './pulls.js'
import { REPEAT, STAGES, STOP, stageNamed, stageTitle } from './stages.js'

/** @import { PullRequest } from '../../core/github/index.js' */
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
 * @property {Set<string>} scanned `<PR>:<sha>` of the head SHAs into another branch that intake
 *   scanned without a finding.
 * @property {Promise<string> | null} repository `owner/name` of this repository in lower case,
 *   once asked (pulls.js, thisRepository).
 * @property {(gate: Gate, pull: PullRequest) => Promise<void>} admit Admits a new head SHA as
 *   intake does, for a run that found it: the head moved before the merge (stage 10).
 * @property {() => Promise<void>} nextIntake Settles when the next intake has ended, so that a
 *   run that waits sees at once when intake took its pull request away.
 */

/**
 * The pipeline of stages 1 to 11.
 * @param {{ notifier?: Notifier }} [options] The notifier; the one of this machine by default.
 * @returns {Pipeline}
 */
export function createPipeline({ notifier = createNotifier() } = {}) {
  /** @type {Array<() => void>} */
  let waiting = []
  /** @type {Tools} */
  const tools = {
    notifier,
    serial: createSerial(),
    authors: new Map(),
    scanned: new Set(),
    repository: null,
    admit: (gate, pull) => admitHead(gate, tools, pull),
    nextIntake: () => new Promise((resolve) => waiting.push(resolve)),
  }
  return {
    intake: async (gate) => {
      try {
        await intake(gate, tools)
      } finally {
        const ended = waiting
        waiting = []
        for (const resolve of ended) resolve()
      }
    },
    run: (gate, pr) => runPull(gate, tools, pr),
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
  /** @type {PullRun} */
  const run = {
    gate,
    tools,
    pr,
    sha: record.head_sha,
    record,
    startedAt: ctx.clock.now().getTime(),
    author: tools.authors.get(pr) ?? null,
    main: record.tested_main_sha ?? '',
    config: gate.config,
    task: null,
    changed: [],
    reruns: 0,
    pull: null,
    superseded: () => state.prs[key] !== record,
    act: (write) =>
      tools.serial(pr, async () => {
        if (run.superseded()) return false
        await write()
        return true
      }),
  }

  const again = STAGES.indexOf(stageNamed('conflicts'))
  let index = record.result === 'merged' ? STAGES.indexOf(stageNamed('merge')) : 0
  while (index < STAGES.length) {
    const stage = STAGES[index]
    if (gate.stopping) return
    if (run.superseded()) return superseded(run)
    await gate.stage(pr, stage.name)
    const started = ctx.clock.now().getTime()
    const outcome = await stage.run(run)
    const seconds = Math.round((ctx.clock.now().getTime() - started) / 1000)
    record.stage_times[stage.name] = (record.stage_times[stage.name] ?? 0) + seconds
    if (outcome === STOP) return run.superseded() ? superseded(run) : undefined
    if (outcome === REPEAT) {
      index = again
      continue
    }
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
    index += 1
  }
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

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
// it without a digest line.
//
// Restart (7.5 step 5): the queue and every record are in the state file, so a pull request that
// was inside the pipeline when the Gate stopped runs again from stage 1 with its recorded head
// SHA, and the merge test builds its scratch worktree again. No merge is repeated: a run that
// stopped after its merge takes up again at stage 10, which does not merge a second time, and a
// run that stopped inside stage 10 first asks GitHub whether its head was merged. No comment is
// repeated either (pulls.js, endFailed).
//
// Failure behavior (7.5): when GitHub or the network fails inside a stage, the stage runs again
// after a wait that doubles each time, up to a poll interval, until it gets through, the Lead
// types `quit` or intake takes the pull request away. Any other error inside a run is a fault of
// the Gate: the run fails with the reason `gate-error`, the full error stays in the Gate's log
// directory, and the loop goes on with the next pull request. After a merge such a fault leaves
// the pull request merged; the run then ends with the digest line of the merge and a note of what
// was not done. A run that cannot even end through GitHub still leaves the queue.
//
// Every stage that passes ends the streaks of that stage and closes the repeated failure items
// that its pass closes (repeated.js).

import { join } from 'node:path'
import { writeAtomic } from '../../core/state/index.js'
import { inlineCode } from './comment.js'
import { hasMergedLine } from './digest.js'
import { admitHead, intake, tookOwnMerge } from './intake.js'
import { stepTimeoutMs as stepTimeoutOf } from './merge-test.js'
import { createNotifier } from './notify.js'
import {
  FIRST_RETRY_WAIT_MS,
  duration,
  endFailed,
  isGitHubFailure,
  leaveQueue,
  messageOf,
  nextWait,
  pause,
  retrying,
  withoutSecrets,
  writeDigest,
} from './pulls.js'
import { recordPass } from './repeated.js'
import { REPEAT, STAGES, STOP, stageNamed, stageTitle } from './stages.js'

/** @import { Config } from '../../core/config/index.js' */
/** @import { PullRequest } from '../../core/github/index.js' */
/** @import { Gate, Pipeline } from './gate.js' */
/** @import { Notifier } from './notify.js' */
/** @import { Failure, StageFailure } from './pulls.js' */
/** @import { PullRun, Stage } from './stages.js' */

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
 * @property {(config: Config) => number} stepTimeoutMs How long a command of the merge test or
 *   the smoke test may run, in milliseconds.
 */

/**
 * The pipeline of stages 1 to 11.
 * @param {{ notifier?: Notifier, stepTimeoutMs?: (config: Config) => number }} [options] The
 *   notifier, the one of this machine by default; the step timeout, `gate.step_timeout_minutes`
 *   by default.
 * @returns {Pipeline}
 */
export function createPipeline({
  notifier = createNotifier(),
  stepTimeoutMs = stepTimeoutOf,
} = {}) {
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
    stepTimeoutMs,
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
 * Take the pull request at the head of the queue through the stages. Never throws: a run that
 * cannot end through GitHub leaves the queue all the same, so that the loop goes on with the
 * next pull request.
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
  try {
    await runStages(run)
  } catch (error) {
    await abandon(run, error)
  }
}

/**
 * The stages of one run, from stage 1, or from stage 10 after a merge.
 * @param {PullRun} run
 * @returns {Promise<void>}
 */
async function runStages(run) {
  const { gate, pr, record } = run
  const { ctx } = gate
  const again = STAGES.indexOf(stageNamed('conflicts'))
  const resumed = await resumeAt(run)
  if (resumed === STOP) return
  let index = resumed
  let wait = FIRST_RETRY_WAIT_MS
  while (index < STAGES.length) {
    const stage = STAGES[index]
    if (gate.stopping) return
    if (run.superseded()) return superseded(run)
    await gate.stage(pr, stage.name)
    const started = ctx.clock.now().getTime()
    /** @type {Awaited<ReturnType<Stage['run']>>} */
    let outcome
    try {
      outcome = await stage.run(run)
    } catch (error) {
      if (!isGitHubFailure(error)) {
        outcome = await gateError(run, stage, error)
      } else {
        gate.line(
          `#${pr} ${stageTitle(stage)}: GitHub or the network failed, the Gate runs the stage again in ${Math.round(wait / 1000)} s: ${messageOf(error)}`,
        )
        await pause(run, wait)
        wait = nextWait(gate, wait)
        continue
      }
    }
    wait = FIRST_RETRY_WAIT_MS
    const seconds = Math.round((ctx.clock.now().getTime() - started) / 1000)
    record.stage_times[stage.name] = (record.stage_times[stage.name] ?? 0) + seconds
    if (outcome === STOP) return run.superseded() ? superseded(run) : undefined
    if (outcome === REPEAT) {
      index = again
      continue
    }
    if (outcome) {
      const failure = { ...outcome, stage: stage.name, title: stageTitle(stage) }
      if (record.result === 'merged') return endMerged(run, failure)
      return endRun(run, failure)
    }
    recordPass(gate, { pr, sha: run.sha, stage: stage.name, title: stageTitle(stage) })
    index += 1
  }
}

/**
 * Where a run starts: stage 10 once its head is merged, otherwise stage 1. A run that stopped
 * inside stage 10 may have stopped after GitHub merged and before the state file said so, as when
 * the Gate was killed then; GitHub's answer decides.
 * @param {PullRun} run
 * @returns {Promise<number | typeof STOP>}
 */
async function resumeAt(run) {
  const { gate, pr, record } = run
  const merge = STAGES.indexOf(stageNamed('merge'))
  if (record.result === 'merged') return merge
  if (record.stage !== 'merge' || record.result !== null) return 0
  const pull = await retrying(run, 'stage 10, merge', () => gate.ctx.github.getPullRequest(pr))
  if (pull === STOP) return STOP
  if (pull === null) return 0
  let own = false
  // After the work for the pull request that started earlier: intake may have taken it already.
  const acted = await run.act(async () => {
    own = tookOwnMerge(gate, pr, pull)
  })
  if (!acted || !own) return 0
  await gate.save()
  return merge
}

/**
 * The failure of a run that an unexpected error stopped (`gate-error`, 7.5): the error and its
 * stack go to the Gate's log directory, and the comment names the stage and the message, with
 * every line that matches a secret pattern hidden.
 * @param {PullRun} run
 * @param {Stage} stage
 * @param {unknown} error
 * @returns {Promise<Failure>}
 */
async function gateError(run, stage, error) {
  const { gate, pr, sha } = run
  const [message] = withoutSecrets([firstLine(messageOf(error))], run.config)
  const file = `logs/pr-${pr}/${sha.slice(0, 12)}-gate-error-${stage.name}.log`
  /** @type {string | null} */
  let kept = `.git/hackwin/gate/${file}`
  try {
    const text = error instanceof Error ? (error.stack ?? error.message) : String(error)
    await writeAtomic(join(gate.files.root, file), `${text}\n`)
  } catch {
    kept = null
  }
  gate.line(
    `#${pr} ${stageTitle(stage)}: an unexpected error of the Gate stopped the run (gate-error): ${message}${kept ? `; the full error is in ${kept}` : ''}`,
  )
  return {
    result: 'failed',
    labels: [],
    reason: `an unexpected error of the Gate stopped the run at this stage (\`gate-error\`): ${inlineCode(message)}${kept ? `. The full error stays on the Lead's laptop, in the Gate's directory: ${inlineCode(kept)}` : ''}`,
    details: [],
    next: `nothing for the author unless the error names the pull request. The Lead looks into the error and types \`retry ${pr}\` in the Gate terminal once its cause is fixed.`,
    note: `gate-error: ${message}`,
  }
}

/**
 * End a failed run (9.2) through GitHub, after the work for the pull request that started
 * earlier, and only while intake has not taken the pull request away. When GitHub or the network
 * fails, the end is tried again with increasing waits; when the Lead types `quit` meanwhile, the
 * run stops and the restart runs it again. Any other error leaves the queue all the same.
 * @param {PullRun} run
 * @param {StageFailure} failure
 * @returns {Promise<void>}
 */
async function endRun(run, failure) {
  const { gate, tools, pr, record } = run
  for (let wait = FIRST_RETRY_WAIT_MS; ; wait = nextWait(gate, wait)) {
    try {
      const ended = await run.act(() =>
        endFailed(gate, tools.notifier, {
          pr,
          record,
          author: run.author,
          main: run.main,
          startedAt: run.startedAt,
          failure,
          config: run.config,
        }),
      )
      if (!ended) await superseded(run)
      return
    } catch (error) {
      if (!isGitHubFailure(error)) return abandon(run, error, failure)
      gate.line(
        `#${pr} ${failure.title}: the end of the failed run did not reach GitHub, the Gate tries again in ${Math.round(wait / 1000)} s: ${messageOf(error)}`,
      )
      await pause(run, wait)
      if (gate.stopping) return
      if (run.superseded()) return superseded(run)
    }
  }
}

/**
 * The end of a run whose head is merged, but that a fault of the Gate stopped in stage 10 or 11:
 * the pull request stays merged and leaves the queue, and the digest line of the merge says what
 * was not done.
 * @param {PullRun} run
 * @param {StageFailure} failure
 * @returns {Promise<void>}
 */
async function endMerged(run, failure) {
  const { gate, pr, record } = run
  const now = gate.ctx.clock.now()
  leaveQueue(gate.state, pr)
  record.stage = failure.stage
  gate.line(
    `#${pr} is merged, but ${failure.title} did not finish: ${failure.note}; the Lead finishes it by hand: the label gate:merged, the task issue, its dependents and the remote branch`,
  )
  if (!(await hasMergedLine(gate.files.digest, pr))) {
    await writeDigest(gate, {
      time: now.toISOString(),
      pr,
      author: run.author ?? '-',
      result: 'merged',
      stage: failure.stage,
      duration: duration(now.getTime() - run.startedAt),
      note: `${failure.title} did not finish: ${failure.note}`,
    })
  }
  await gate.save()
}

/**
 * The last resort of a run that an error stopped outside its stages, or whose end failed: it
 * leaves the queue with its record ended in the state file alone, so that the loop goes on.
 * @param {PullRun} run
 * @param {unknown} error
 * @param {StageFailure} [failure] The failure the run tried to end with.
 * @returns {Promise<void>}
 */
async function abandon(run, error, failure) {
  const { gate, pr, record } = run
  const message = firstLine(messageOf(error))
  try {
    // A newer head SHA that intake queued meanwhile keeps its place.
    if (!run.superseded()) {
      leaveQueue(gate.state, pr)
      if (record.result !== 'merged') {
        record.result = failure?.result ?? 'failed'
        record.stage = failure?.stage ?? record.stage
      }
    }
    gate.line(
      `#${pr}: the run stopped on an unexpected error and left the queue without its label, comment or digest line: ${message}; the Lead looks into it and types \`retry ${pr}\` once its cause is fixed`,
    )
    await gate.save()
  } catch (again) {
    gate.line(`#${pr}: the state file was not written: ${messageOf(again)}`)
  }
}

/** How long an error message in a comment, a line or the digest may be. */
const MAX_MESSAGE = 300

/**
 * The first line of a text, at most MAX_MESSAGE characters long.
 * @param {string} text
 * @returns {string}
 */
function firstLine(text) {
  const line = text.split('\n').find((each) => each.trim() !== '') ?? text
  return line.length > MAX_MESSAGE ? `${line.slice(0, MAX_MESSAGE)}…` : line
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

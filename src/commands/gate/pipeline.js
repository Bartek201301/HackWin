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
// Failure behavior (7.5): while GitHub or the network is down (pulls.js, isOutage), a stage runs
// again after a wait that doubles each time, up to a poll interval, until it gets through, the
// Lead types `quit` or intake takes the pull request away; after LONG_RETRY_MS of tries the Lead
// gets an attention item. A refusal of GitHub that waiting does not change, and any other error,
// a fault of the Gate, fail the run with the reason `gate-error` and an attention item; the full
// error stays in the Gate's log directory, and the loop goes on with the next pull request.
// Before a run in stage 10 ends failed or is given up, GitHub's answer decides whether it merged
// after all: then the run goes on after the merge, with stage 11. After a merge, a fault leaves
// the pull request merged; the run then ends with the digest line of the merge and a note of what
// was not done. A run that cannot even end through GitHub still leaves the queue, with the digest
// line and an attention item (abandon).
//
// Every stage that passes ends the streaks of that stage and closes the repeated failure items
// that its pass closes (repeated.js).

import { join } from 'node:path'
import { RemoteError } from '../../core/runtime/index.js'
import { writeAtomic } from '../../core/state/index.js'
import { raiseAttention } from './attention.js'
import { cutText, inlineCode } from './comment.js'
import { hasMergedLine } from './digest.js'
import { admitHead, intake, tookOwnMerge } from './intake.js'
import { stepTimeoutMs as stepTimeoutOf } from './merge-test.js'
import { createNotifier } from './notify.js'
import {
  duration,
  endFailed,
  isOutage,
  leaveQueue,
  messageOf,
  retrySeries,
  retrying,
  setGateLabels,
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
    // Before a run in stage 10 is given up, GitHub's answer decides whether it merged.
    const merged = await mergedMeanwhile(run)
    if (merged === STOP) return
    if (!merged) return abandon(run, error)
    try {
      await runStages(run)
    } catch (again) {
      await abandon(run, again)
    }
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
  const merge = STAGES.indexOf(stageNamed('merge'))
  const resumed = await resumeAt(run)
  if (resumed === STOP) return
  let index = resumed
  /** @type {ReturnType<typeof retrySeries> | null} */
  let tries = null
  while (index < STAGES.length) {
    const stage = STAGES[index]
    if (gate.stopping) return
    if (run.superseded()) return superseded(run)
    // A fault of a stage that began after the merge leaves the pull request merged (endMerged).
    const mergedBefore = record.result === 'merged'
    await gate.stage(pr, stage.name)
    const started = ctx.clock.now().getTime()
    /** @type {Awaited<ReturnType<Stage['run']>>} */
    let outcome
    let fault = false
    try {
      outcome = await stage.run(run)
    } catch (error) {
      if (isOutage(error)) {
        tries ??= retrySeries(run, { stage: stage.name, title: stageTitle(stage) })
        await tries.after(error, 'GitHub or the network failed, the Gate runs the stage again')
        continue
      }
      fault = true
      outcome = await gateError(run, stage, error)
    }
    tries = null
    const seconds = Math.round((ctx.clock.now().getTime() - started) / 1000)
    record.stage_times[stage.name] = (record.stage_times[stage.name] ?? 0) + seconds
    if (outcome === STOP) return run.superseded() ? superseded(run) : undefined
    if (outcome === REPEAT) {
      index = again
      continue
    }
    if (outcome) {
      const failure = { ...outcome, stage: stage.name, title: stageTitle(stage) }
      if (mergedBefore) return endMerged(run, failure)
      // Only a fault leaves open whether GitHub merged: a refusal of the merge was read.
      if (stage.name === 'merge') record.merge_unknown = fault
      const merged = await mergedMeanwhile(run)
      if (merged === STOP) return run.superseded() ? superseded(run) : undefined
      if (merged || (await endRun(run, failure))) {
        index = merge
        continue
      }
      return
    }
    recordPass(gate, { pr, sha: run.sha, stage: stage.name, title: stageTitle(stage) })
    index += 1
  }
}

/**
 * Where a run starts: stage 10 once its head is merged, otherwise stage 1. A run that stopped
 * inside stage 10 may have stopped after GitHub merged and before the state file said so, as when
 * the Gate was killed then; GitHub's answer decides. An answer that cannot be read throws, and
 * runPull asks once more before it gives the run up.
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
  return (await takeMerge(run, pull)) ? merge : 0
}

/**
 * Whether GitHub merged the head of a run in stage 10 after all, before the run ends failed or
 * is given up: the answer to the merge may have been lost, or not readable, after GitHub merged.
 * When it did, the record is merged and the run goes on after the merge. Never throws: an answer
 * that cannot be read leaves the question open, and the run ends as it would have.
 * @param {PullRun} run
 * @returns {Promise<boolean | typeof STOP>} STOP after `quit`, or when intake took the pull
 *   request away.
 */
async function mergedMeanwhile(run) {
  const { gate, pr, record } = run
  if (run.superseded()) return false
  // Intake took GitHub's merge of this head as the Gate's own already.
  if (record.result === 'merged') return true
  if (record.result !== null || record.stage !== 'merge') return false
  try {
    const pull = await retrying(run, 'stage 10, merge', () => gate.ctx.github.getPullRequest(pr))
    if (pull === STOP) return STOP
    return pull !== null && (await takeMerge(run, pull))
  } catch (error) {
    gate.line(
      `#${pr} stage 10, merge: GitHub's answer whether it merged head ${run.sha} is not readable: ${firstLine(messageOf(error))}`,
    )
    return false
  }
}

/**
 * Take GitHub's merge of the run's head as the Gate's own (intake.js, tookOwnMerge), after the
 * work for the pull request that started earlier. When intake took it meanwhile, the record is
 * merged already, and the run goes on after the merge all the same.
 * @param {PullRun} run
 * @param {PullRequest} pull
 * @returns {Promise<boolean>}
 */
async function takeMerge(run, pull) {
  let own = false
  const acted = await run.act(async () => {
    own = run.record.result === 'merged' || tookOwnMerge(run.gate, run.pr, pull)
  })
  if (!acted || !own) return false
  await run.gate.save()
  return true
}

/**
 * The failure of a run that an error stopped which waiting does not change (`gate-error`, 7.5):
 * a refusal of GitHub (an HTTP status that `isOutage` does not wait out) or any other error,
 * a fault of the Gate. The error and its stack go to the Gate's log directory, the comment names
 * the stage and the message, with every line that matches a secret pattern hidden, and the Lead
 * gets an attention item of the repeated failure type, which closes when the stage passes again.
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
  const status = error instanceof RemoteError ? error.status : undefined
  const what =
    status === undefined
      ? 'an unexpected error of the Gate'
      : `GitHub refused a call with HTTP ${status}, which waiting does not change, and`
  gate.line(
    `#${pr} ${stageTitle(stage)}: ${what} stopped the run (gate-error): ${message}${kept ? `; the full error is in ${kept}` : ''}`,
  )
  return {
    result: 'failed',
    labels: [],
    reason: `${what} stopped the run at this stage (\`gate-error\`): ${inlineCode(message)}${kept ? `. The full error stays on the Lead's laptop, in the Gate's directory: ${inlineCode(kept)}` : ''}`,
    details: [],
    next: `nothing for the author unless the error names the pull request. The Lead looks into the error and types \`retry ${pr}\` in the Gate terminal once its cause is fixed.`,
    note: `gate-error: ${message}`,
    attention: {
      type: 'repeated-failure',
      todo: `${stageTitle(stage)} of #${pr} failed with gate-error (${message}); look into ${kept ?? 'the error in the Gate terminal'}, then type \`retry ${pr}\``,
    },
  }
}

/**
 * End a failed run (9.2) through GitHub, after the work for the pull request that started
 * earlier, and only while intake has not taken the pull request away. While GitHub or the network
 * is down, the end is tried again with increasing waits (retrySeries); when the Lead types `quit`
 * meanwhile, the run stops and the restart runs it again. A refusal of GitHub or any other error
 * gives the run up (abandon). When intake took GitHub's merge of the head as the Gate's own
 * meanwhile, the run does not end failed: it goes on after the merge.
 * @param {PullRun} run
 * @param {StageFailure} failure
 * @returns {Promise<boolean>} True when the head is merged, and the run goes on with stage 10.
 */
async function endRun(run, failure) {
  const { gate, tools, pr, record } = run
  const tries = retrySeries(run, { stage: failure.stage, title: failure.title })
  for (;;) {
    let merged = false
    try {
      const ended = await run.act(async () => {
        merged = record.result === 'merged'
        if (merged) return
        await endFailed(gate, tools.notifier, {
          pr,
          record,
          author: run.author,
          main: run.main,
          startedAt: run.startedAt,
          failure,
          config: run.config,
        })
      })
      if (merged) return true
      if (!ended) await superseded(run)
      return false
    } catch (error) {
      if (record.result === 'merged') return true
      if (!isOutage(error)) {
        await abandon(run, error, failure)
        return false
      }
      await tries.after(
        error,
        'the end of the failed run did not reach GitHub, the Gate tries again',
      )
      if (gate.stopping) return false
      if (run.superseded()) {
        await superseded(run)
        return false
      }
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
 * The last resort of a run that an error stopped outside its stages, or whose end GitHub refused:
 * it leaves the queue, so that the loop goes on, and stays visible: the label `gate:failed` when
 * GitHub takes it, the digest line, and an attention item of the repeated failure type for its
 * stage, which closes when the stage passes again or the pull request is closed. It posts no
 * comment. A newer head SHA that intake queued meanwhile keeps its place.
 * @param {PullRun} run
 * @param {unknown} error
 * @param {StageFailure} [failure] The failure the run tried to end with.
 * @returns {Promise<void>}
 */
async function abandon(run, error, failure) {
  const { gate, tools, pr, record } = run
  const message = withoutSecrets([firstLine(messageOf(error))], run.config)[0]
  if (run.superseded()) {
    gate.line(
      `#${pr}: the run of head ${run.sha} stopped on an error, and the newer head stays queued: ${message}`,
    )
    return
  }
  try {
    let merged = false
    let labelled = false
    // The record and the label change after the work for the pull request that started earlier.
    const acted = await run.act(async () => {
      leaveQueue(gate.state, pr)
      merged = record.result === 'merged'
      if (merged) return
      record.result = failure?.result ?? 'failed'
      record.stage = failure?.stage ?? record.stage
      // An error outside a stage's end at stage 10 left open whether GitHub merged.
      if (record.stage === 'merge' && failure === undefined) record.merge_unknown = true
      try {
        await setGateLabels(gate.ctx.github, pr, ['gate:failed'])
        labelled = true
      } catch {
        // GitHub may be what failed; the line and the attention item say so.
      }
    })
    if (!acted) {
      gate.line(
        `#${pr}: the run of head ${run.sha} stopped on an error, and the newer head stays queued: ${message}`,
      )
      return
    }
    labelled ||= merged
    const stage = record.stage ?? 'intake'
    gate.line(
      `#${pr}: the run stopped on an error at ${stage} and left the queue without a comment${labelled ? '' : ' and with the labels of the run'}: ${message}`,
    )
    if (!merged) {
      await raiseAttention(gate, tools.notifier, {
        type: 'repeated-failure',
        pr,
        stage,
        todo: `the run of #${pr} stopped on an error at ${stage} and could not end through GitHub (${message}); look at #${pr}${labelled ? '' : ', whose labels still show the run,'} and type \`retry ${pr}\` once the cause is fixed`,
      })
    }
    if (!merged || !(await hasMergedLine(gate.files.digest, pr))) {
      const now = gate.ctx.clock.now()
      await writeDigest(gate, {
        time: now.toISOString(),
        pr,
        author: run.author ?? '-',
        result: record.result ?? 'failed',
        stage,
        duration: duration(now.getTime() - run.startedAt),
        note: `abandoned: ${message}`,
      })
    }
    await gate.save()
  } catch (again) {
    gate.line(`#${pr}: the end of the abandoned run was not written: ${messageOf(again)}`)
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
  return cutText(line, MAX_MESSAGE)
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

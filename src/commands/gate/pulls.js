// What intake and the stages share about one pull request (9.2): the fetched head, the Gate
// labels, the queue, the configuration on main, the digest line and the end of a failed run,
// which sets `gate:failed`, posts exactly one comment with the stage, the reason and the next
// action (G21), writes the digest line and leaves the queue.
//
// The Gate fetches a pull request's head by its full SHA into `refs/hackwin/pr/<PR>`, a ref of
// its own outside the branches and remote branches of the Lead's clone. GitHub served such a fetch
// of a commit that is not the tip of a branch (Bartek201301/HackWin, 2026-10-15), so the fetch
// gets exactly the head SHA the Gate recorded, also when the author pushed again since.

import { loadConfig } from '../../core/config/index.js'
import { scanDiff } from '../../core/secrets/index.js'
import { parseTaskLink } from '../../core/tasks/index.js'
import { raiseAttention } from './attention.js'
import { failureComment } from './comment.js'
import { appendDigestLine, formatDigestLine, hoursAndMinutes } from './digest.js'

/** @import { Config } from '../../core/config/index.js' */
/** @import { ChangedFile } from '../../core/git/index.js' */
/** @import { GitHub, PullRequest } from '../../core/github/index.js' */
/** @import { Finding } from '../../core/secrets/index.js' */
/** @import { DigestEntry } from './digest.js' */
/** @import { Gate } from './gate.js' */
/** @import { Notifier } from './notify.js' */
/** @import { GateState, PullRecord } from './state.js' */

/** The labels of a Gate run on a pull request (8.2); the Gate is their only writer. */
export const GATE_LABELS = Object.freeze([
  'gate:queued',
  'gate:testing',
  'gate:waiting-ci',
  'gate:merged',
  'gate:failed',
  'needs-owner',
  'scope-violation',
])

/** Where a `take` command of a next action runs (CM4). */
export const IN_MAIN_CHECKOUT = 'in your main checkout of the repository'

/**
 * Why a run failed, as a stage returns it.
 * @typedef {object} Failure
 * @property {'failed' | 'needs-owner' | 'scope-violation'} result The digest result (9.6).
 * @property {string[]} labels The labels beside `gate:failed`.
 * @property {string} reason
 * @property {string[]} details One list item each in the comment.
 * @property {string} next The next action.
 * @property {string} note The note of the digest line.
 * @property {{ type: string, todo: string }} [attention]
 */

/**
 * @typedef {Failure & { stage: string, title: string }} StageFailure A failure with the stage
 *   name of the marker, the state and the digest, and the stage as the comment names it.
 */

/**
 * The ref that holds the fetched head of a pull request.
 * @param {number} pr
 * @returns {string}
 */
export function pullRef(pr) {
  return `refs/hackwin/pr/${pr}`
}

/**
 * Fetch the head of a pull request by its full SHA, and with `main` also the default branch.
 * Throws a RemoteError when the fetch fails.
 * @param {Gate} gate
 * @param {number} pr
 * @param {string} sha
 * @param {{ main?: boolean }} [options]
 * @returns {Promise<void>}
 */
export async function fetchHead(gate, pr, sha, { main = false } = {}) {
  const branch = gate.config.hackwin.project.default_branch
  const refspecs = main ? [`+refs/heads/${branch}:refs/remotes/origin/${branch}`] : []
  await gate.git.fetch({ remote: 'origin', refspecs: [...refspecs, `+${sha}:${pullRef(pr)}`] })
}

/**
 * The secret scan of the lines and files a head adds since its merge base with `base` (G12,
 * A41): the built-in patterns and `gate.secret_patterns` of the configuration on main.
 * @param {Gate} gate
 * @param {Config} config
 * @param {{ base: string, head: string }} range
 * @returns {Promise<Finding[]>}
 */
export function scanHead(gate, config, { base, head }) {
  return scanDiff(
    gate.git,
    { base, head, threeDot: true },
    { extraPatterns: config.hackwin.gate.secret_patterns },
  )
}

/**
 * Both paths of every changed file: a rename moves a file out of one place and into another.
 * @param {ChangedFile[]} files
 * @returns {string[]}
 */
export function changedPaths(files) {
  return [
    ...new Set(files.flatMap((file) => (file.oldPath ? [file.oldPath, file.path] : [file.path]))),
  ]
}

/**
 * The configuration on main at `ref` (A17): the Gate runs for the whole event, so a role swap
 * merged during it counts from the next run. Without a readable one the Gate goes on with the
 * configuration of its start and says so.
 * @param {Gate} gate
 * @param {string} ref
 * @returns {Promise<Config>}
 */
export async function currentConfig(gate, ref) {
  try {
    return await loadConfig(gate.git, { ref, fetch: false })
  } catch (error) {
    gate.line(
      `the configuration on ${ref} is not readable, so the Gate uses the one of its start: ${messageOf(error)}`,
    )
    return gate.config
  }
}

/**
 * Set the Gate labels of a pull request: add these, then remove every other Gate label it carries,
 * so that exactly one Gate stage label shows (8.2).
 * @param {GitHub} github
 * @param {number} pr
 * @param {string[]} wanted
 * @returns {Promise<void>}
 */
export async function setGateLabels(github, pr, wanted) {
  const labels = await github.addLabels(pr, wanted)
  for (const label of labels) {
    if (GATE_LABELS.includes(label) && !wanted.includes(label)) await github.removeLabel(pr, label)
  }
}

/**
 * Remove the Gate labels among `labels` from a pull request.
 * @param {GitHub} github
 * @param {number} pr
 * @param {string[]} labels The labels it carries.
 * @param {readonly string[]} [which] The Gate labels to remove; all by default.
 * @returns {Promise<void>}
 */
export async function removeGateLabels(github, pr, labels, which = GATE_LABELS) {
  for (const label of labels) if (which.includes(label)) await github.removeLabel(pr, label)
}

/**
 * Put a pull request at the back of the queue (G7, G17).
 * @param {GateState} state
 * @param {number} pr
 */
export function joinQueue(state, pr) {
  leaveQueue(state, pr)
  state.queue.push(pr)
}

/**
 * Take a pull request out of the queue, wherever it stands.
 * @param {GateState} state
 * @param {number} pr
 */
export function leaveQueue(state, pr) {
  for (let index = state.queue.indexOf(pr); index !== -1; index = state.queue.indexOf(pr)) {
    state.queue.splice(index, 1)
  }
}

/**
 * The task a pull request names, from its branch and body alone, or null.
 * @param {Pick<PullRequest, 'headRef' | 'body'>} pull
 * @returns {number | null}
 */
export function taskOf(pull) {
  const link = parseTaskLink({ branch: pull.headRef, body: pull.body })
  return link.ok ? link.issue : null
}

/**
 * The `take` command that resumes a task, for a next action.
 * @param {number | null} task
 * @returns {string}
 */
export function takeCommand(task) {
  return task === null ? '`hackwin take <task>`' : `\`hackwin take ${task}\``
}

/**
 * A list of items for one line: the first `max`, then how many more.
 * @param {string[]} items
 * @param {number} [max]
 * @returns {string}
 */
export function listed(items, max = 5) {
  const shown = items.slice(0, max).join(', ')
  return items.length > max ? `${shown} and ${items.length - max} more` : shown
}

/**
 * A duration for the digest line: `42s`, `3m05s` or `1h02m`.
 * @param {number} ms
 * @returns {string}
 */
export function duration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  const pad = (/** @type {number} */ value) => String(value).padStart(2, '0')
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${pad(seconds % 60)}s`
  return `${Math.floor(minutes / 60)}h${pad(minutes % 60)}m`
}

/**
 * Write the digest line of a run that ended (9.6): into `digest.log` with the full time, and into
 * the terminal with hours and minutes.
 * @param {Gate} gate
 * @param {DigestEntry} entry
 * @returns {Promise<void>}
 */
export async function writeDigest(gate, entry) {
  await appendDigestLine(gate.files.digest, entry)
  gate.ctx.out.line(formatDigestLine({ ...entry, time: hoursAndMinutes(new Date(entry.time)) }))
}

/**
 * End a run as failed (9.2): the attention item first, so that a secret reaches the Lead also
 * while GitHub fails; then `gate:failed` with the failure's labels and exactly one comment (G21);
 * then the record, which leaves the queue, and the digest line. A GitHub call that fails throws
 * before the state changes, so the next try writes everything again.
 * @param {Gate} gate
 * @param {Notifier} notifier
 * @param {{ pr: number, record: PullRecord, author: string | null, main: string | null, startedAt: number, failure: StageFailure }} ending
 *   `record` becomes the pull request's record: intake passes the record of a new head SHA.
 * @returns {Promise<void>}
 */
export async function endFailed(gate, notifier, { pr, record, author, main, startedAt, failure }) {
  const { ctx, state } = gate
  const sha = record.head_sha
  if (failure.attention) await raiseAttention(gate, notifier, { pr, ...failure.attention })
  await setGateLabels(ctx.github, pr, ['gate:failed', ...failure.labels])
  await ctx.github.createComment(
    pr,
    failureComment({
      marker: { pr, sha, stage: failure.stage, result: failure.result },
      title: failure.title,
      reason: failure.reason,
      details: failure.details,
      next: failure.next,
      main,
    }),
  )
  const now = ctx.clock.now()
  state.prs[String(pr)] = record
  record.stage = failure.stage
  record.result = failure.result
  record.failures.push({ stage: failure.stage, sha, at: now.toISOString() })
  leaveQueue(state, pr)
  await writeDigest(gate, {
    time: now.toISOString(),
    pr,
    author: author ?? '-',
    result: failure.result,
    stage: failure.stage,
    duration: duration(now.getTime() - startedAt),
    note: failure.note,
  })
  await gate.save()
}

/** @param {unknown} error */
export function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

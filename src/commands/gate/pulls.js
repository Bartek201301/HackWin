// What intake and the stages share about one pull request (9.2): the fetched head, the Gate
// labels, the queue, the configuration on main, the digest line and the end of a failed run,
// which sets `gate:failed`, posts exactly one comment with the stage, the reason and the next
// action (G21), writes the digest line and leaves the queue.
//
// A failed run posts its comment before the state file records the failure, so a Gate that
// stops in between, killed or after an answer of GitHub that got lost, runs the same head SHA
// again after its restart. Before it comments, the Gate therefore counts its own comments for
// that head SHA and stage: comments of `team.lead` (A5) whose marker names the pull request, the
// head SHA and the stage (comment.js). When there are more of them than failures the state file
// records for that head SHA and stage, the comment of this run is there already, and no second
// one is posted (AC22; scope change on #24). A marker that the Lead types by hand under the same
// account cannot be told apart from the Gate's; the head SHA must match it as well.
//
// The Gate fetches a pull request's head by its full SHA into `refs/hackwin/pr/<PR>`, a ref of
// its own outside the branches and remote branches of the Lead's clone, so the fetch gets exactly
// the head SHA the Gate recorded, also when the author pushed again since. What was observed:
// GitHub served a fetch by SHA of 98e8488 on Bartek201301/HackWin (2026-10-15), a commit that is
// reachable from main and is not the tip of a branch. A head that only the pull request's own ref
// reaches was not tried. Every stage works from the full head SHA recorded for its run, never
// from this ref: the fetch of a run that intake superseded can move the ref back to an older
// head (the Lead's review of #64).
//
// The Gate tests only the pull requests of the team (the Lead's review of #64): one whose head
// lies in another repository, such as a fork, or whose author is not a member in hackwin.yml
// never goes through the stages. It gets an attention item that names it, and the Gate leaves it
// alone.

import { loadConfig, rolesOf } from '../../core/config/index.js'
import { PreconditionError, RemoteError } from '../../core/runtime/index.js'
import { scanAddedLines, scanDiff } from '../../core/secrets/index.js'
import { parseTaskLink } from '../../core/tasks/index.js'
import { raiseAttention } from './attention.js'
import { failureComment, parseGateMarker } from './comment.js'
import { appendDigestLine, formatDigestLine, hoursAndMinutes } from './digest.js'
import { recordFailure } from './repeated.js'

/** @import { Config } from '../../core/config/index.js' */
/** @import { ChangedFile } from '../../core/git/index.js' */
/** @import { GitHub, PullRequest } from '../../core/github/index.js' */
/** @import { Finding } from '../../core/secrets/index.js' */
/** @import { DigestEntry } from './digest.js' */
/** @import { Gate } from './gate.js' */
/** @import { Notifier } from './notify.js' */
/** @import { Tools } from './pipeline.js' */
/** @import { PullRun } from './stages.js' */
/** @import { GateState, PullRecord } from './state.js' */

/** A stage's answer that ends the run without a result. */
export const STOP = Symbol('stop')

/** Stage 9's answer when main moved since the merge test: the run goes back to stage 6 (G20). */
export const REPEAT = Symbol('repeat from stage 6')

/** The first wait before a failed GitHub or network call is made again; each later wait doubles, up to a poll interval. */
export const FIRST_RETRY_WAIT_MS = 5000

/** How many items a comment lists at most. */
export const MAX_DETAILS = 50

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

/** The labels of a run under way, which a pull request loses when it leaves the queue unended. */
export const UNDER_WAY = Object.freeze(['gate:queued', 'gate:testing', 'gate:waiting-ci'])

/** Where a `take` command of a next action runs (CM4). */
export const IN_MAIN_CHECKOUT = 'in your main checkout of the repository'

/**
 * Why a run failed, as a stage returns it.
 * @typedef {object} Failure
 * @property {'failed' | 'needs-owner' | 'scope-violation' | 'flaky'} result The digest result
 *   (9.6).
 * @property {string[]} labels The labels beside `gate:failed`.
 * @property {string} reason
 * @property {string[]} details One list item each in the comment.
 * @property {import('./comment.js').CommentLog} [log] The command and the last lines of its log.
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
 * Fetch the default branch into its remote-tracking ref. Throws a RemoteError when the fetch
 * fails.
 * @param {Gate} gate
 * @returns {Promise<string>} The full SHA of main.
 */
export async function fetchMain(gate) {
  const branch = gate.config.hackwin.project.default_branch
  const tracking = `refs/remotes/origin/${branch}`
  await gate.git.fetch({ remote: 'origin', refspecs: [`+refs/heads/${branch}:${tracking}`] })
  return gate.git.revParse(tracking)
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
 * Lines of a log, or of gh's output, with every line that matches a secret pattern (A41) replaced
 * by a note that names the pattern, never the text, so that no comment, digest line or attention
 * text carries a secret from a log. The commands of a pull request write these logs.
 * @param {string[]} lines
 * @param {Config} config The configuration on main, for `gate.secret_patterns`.
 * @returns {string[]}
 */
export function withoutSecrets(lines, config) {
  const findings = scanAddedLines(
    lines.map((text, index) => ({ path: 'log', line: index + 1, text })),
    { extraPatterns: config.hackwin.gate.secret_patterns },
  )
  /** @type {Map<number, string[]>} */
  const hidden = new Map()
  for (const { line, pattern } of findings) {
    if (line !== null) hidden.set(line, [...(hidden.get(line) ?? []), pattern])
  }
  return lines.map((text, index) => {
    const patterns = hidden.get(index + 1)
    if (patterns === undefined) return text
    return `[the Gate hides this line: it matches the secret pattern ${patterns.join(', ')}]`
  })
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
 * `1 file`, `2 files`.
 * @param {number} n
 * @param {string} one
 * @param {string} many
 * @returns {string}
 */
export function count(n, one, many) {
  return `${n} ${n === 1 ? one : many}`
}

/**
 * The first MAX_DETAILS items, then how many more.
 * @param {string[]} items
 * @returns {string[]}
 */
export function capped(items) {
  if (items.length <= MAX_DETAILS) return items
  return [...items.slice(0, MAX_DETAILS), `and ${items.length - MAX_DETAILS} more`]
}

/**
 * Do the work of a stage that calls GitHub or the network, and do it again with increasing waits
 * while GitHub or the network is down (7.5, failure behavior; `isOutage`), until it succeeds, the
 * Lead types `quit` or intake takes the pull request away. Any other error, a refusal of GitHub
 * included, ends the run.
 * @template T
 * @param {PullRun} run
 * @param {string} title The stage as the line names it: `stage 1, fetch`.
 * @param {() => Promise<T>} work
 * @returns {Promise<T | typeof STOP>}
 */
export async function retrying(run, title, work) {
  const { gate } = run
  const tries = retrySeries(run, { stage: run.record.stage ?? 'fetch', title })
  for (;;) {
    try {
      return await work()
    } catch (error) {
      if (!isOutage(error)) throw error
      await tries.after(error, 'failed, the Gate tries again')
      if (gate.stopping || run.superseded()) return STOP
    }
  }
}

/** How long a run tries a call again before the Lead gets an attention item. */
export const LONG_RETRY_MS = 10 * 60_000

/**
 * The waits between the tries of a call that GitHub or the network failed (7.5): 5 s first, then
 * twice as long each time, up to a poll interval. Each failed try prints a line. Once the tries
 * of one series have gone on for LONG_RETRY_MS, the Lead gets one attention item of the repeated
 * failure type for the stage, which closes when the stage passes again (9.6).
 * @param {PullRun} run
 * @param {{ stage: string, title: string }} where The stage, by its name and as a line names it.
 */
export function retrySeries(run, { stage, title }) {
  const { gate, pr } = run
  const since = gate.ctx.clock.now().getTime()
  let wait = FIRST_RETRY_WAIT_MS
  let raised = false
  return {
    /**
     * After a failed try: the line, the attention item when it is due, and the wait.
     * @param {unknown} error
     * @param {string} what What the line says before the wait, such as `failed, the Gate tries
     *   again`.
     * @returns {Promise<void>}
     */
    async after(error, what) {
      gate.line(`#${pr} ${title}: ${what} in ${Math.round(wait / 1000)} s: ${messageOf(error)}`)
      const ms = gate.ctx.clock.now().getTime() - since
      if (!raised && ms >= LONG_RETRY_MS) {
        raised = true
        const [why] = withoutSecrets([messageOf(error)], run.config)
        await raiseAttention(gate, run.tools.notifier, {
          type: 'repeated-failure',
          pr,
          stage,
          todo: `GitHub or the network has failed ${title} of #${pr} for ${duration(ms)} (${why}); the Gate goes on trying: check GitHub's status, the network and \`gh auth status\` on the Lead's laptop`,
        })
        await gate.save()
      }
      await pause(run, wait)
      wait = nextWait(gate, wait)
    },
  }
}

/**
 * The wait after `wait` before a failed GitHub or network call is made again: twice as long, up
 * to a poll interval.
 * @param {Gate} gate
 * @param {number} wait
 * @returns {number}
 */
export function nextWait(gate, wait) {
  return Math.min(wait * 2, gate.config.hackwin.gate.poll_seconds * 1000)
}

/**
 * True when GitHub or the network is down, which the Gate waits out (7.5, failure behavior): a
 * failed fetch or gh call without an HTTP status, a server error (5xx), a rate limit (HTTP 429,
 * or a 403 whose answer names a rate limit), a login that GitHub no longer takes (HTTP 401), and
 * gh that lost its login, which the Lead renews with `gh auth login`. Every other answer of
 * GitHub is a refusal that waiting does not change, and any other error a fault of the Gate:
 * both end the run with `gate-error`.
 * @param {unknown} error
 * @returns {boolean}
 */
export function isOutage(error) {
  if (error instanceof RemoteError) {
    const { status } = error
    if (status === undefined || status === null || status >= 500) return true
    if (status === 429 || status === 401) return true
    const said = [error.message, .../** @type {string[]} */ (error.details?.tail ?? [])]
    return status === 403 && said.some((line) => /rate limit/i.test(line))
  }
  if (!(error instanceof PreconditionError)) return false
  const resolve = /** @type {any} */ (error.resolve)
  return resolve?.command === 'gh auth login'
}

/**
 * Wait inside a run: until the time has passed, the Lead typed `quit`, or an intake took the
 * pull request away from the run, whichever comes first.
 * @param {PullRun} run
 * @param {number} ms
 * @returns {Promise<void>}
 */
export async function pause(run, ms) {
  const { gate } = run
  const timer = gate.ctx.clock.sleep(ms).then(() => 'time')
  const stopped = gate.stopped.then(() => 'stop')
  for (;;) {
    const woke = await Promise.race([timer, stopped, run.tools.nextIntake().then(() => 'intake')])
    if (woke !== 'intake' || run.superseded()) return
  }
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
 * then the record, which leaves the queue, the repeated failures (repeated.js) and the digest
 * line. A GitHub call that fails throws before the state changes, so the next try writes
 * everything again, and finds the comment that it posted already.
 * @param {Gate} gate
 * @param {Notifier} notifier
 * @param {{ pr: number, record: PullRecord, author: string | null, main: string | null, startedAt: number, failure: StageFailure, config?: Config, queued?: boolean }} ending
 *   `record` becomes the pull request's record: intake passes the record of a new head SHA.
 *   `config` is the configuration on main, the one of the Gate's start by default. `queued` is
 *   false for a head SHA that failed at intake, before it joined the queue.
 * @returns {Promise<void>}
 */
export async function endFailed(gate, notifier, ending) {
  const { pr, record, author, main, startedAt, failure } = ending
  const { config = gate.config, queued = true } = ending
  const { ctx, state } = gate
  const sha = record.head_sha
  if (failure.attention) {
    await raiseAttention(gate, notifier, { pr, ...failure.attention, stage: failure.stage })
  }
  await setGateLabels(ctx.github, pr, ['gate:failed', ...failure.labels])
  if (await commentedAlready(gate, { pr, record, stage: failure.stage })) {
    gate.line(
      `#${pr}: the comment of this failure of head ${sha} at ${failure.title} is on the pull request already, from before the Gate stopped, so it posts no second one`,
    )
  } else {
    await ctx.github.createComment(
      pr,
      failureComment({
        marker: { pr, sha, stage: failure.stage, result: failure.result },
        title: failure.title,
        reason: failure.reason,
        details: failure.details,
        log: failure.log,
        next: failure.next,
        main,
      }),
    )
  }
  const now = ctx.clock.now()
  state.prs[String(pr)] = record
  record.stage = failure.stage
  record.result = failure.result
  record.failures.push({ stage: failure.stage, sha, at: now.toISOString() })
  leaveQueue(state, pr)
  await recordFailure(gate, notifier, {
    pr,
    sha,
    stage: failure.stage,
    title: failure.title,
    queued,
    threshold: config.hackwin.gate.repeated_failure_threshold,
  })
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

/**
 * True when the comment of this run's failure is on the pull request already: the Gate's comments
 * for its head SHA and stage outnumber the failures that the record holds for them. Only a
 * comment of `team.lead` whose marker names the pull request counts (contracts 5.7).
 * @param {Gate} gate
 * @param {{ pr: number, record: PullRecord, stage: string }} failed
 * @returns {Promise<boolean>}
 */
async function commentedAlready(gate, { pr, record, stage }) {
  const sha = record.head_sha
  const lead = gate.config.hackwin.team.lead.toLowerCase()
  const comments = await gate.ctx.github.listComments(pr)
  const posted = comments.filter((comment) => {
    if (comment.author?.toLowerCase() !== lead) return false
    const marker = parseGateMarker(comment.body)
    return marker !== null && marker.pr === pr && marker.sha === sha && marker.stage === stage
  }).length
  const recorded = record.failures.filter(
    (failure) => failure.sha === sha && failure.stage === stage,
  ).length
  return posted > recorded
}

/** @param {unknown} error */
export function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * `owner/name` of the repository, in lower case, asked once per Gate.
 * @param {Gate} gate
 * @param {Tools} tools
 * @returns {Promise<string>}
 */
export function thisRepository(gate, tools) {
  tools.repository ??= gate.ctx.github.repository().then(
    (repository) => repository.nameWithOwner.toLowerCase(),
    (error) => {
      tools.repository = null
      throw error
    },
  )
  return tools.repository
}

/**
 * Why the Gate does not test a pull request, or null for one of the team: its head lies in
 * another repository, such as a fork, or its author is not a member in hackwin.yml.
 * @param {Gate} gate
 * @param {Tools} tools
 * @param {Config} config The configuration on main.
 * @param {PullRequest} pull
 * @returns {Promise<string | null>}
 */
export async function outsiderOf(gate, tools, config, pull) {
  const repository = await thisRepository(gate, tools)
  if (pull.headRepo?.toLowerCase() !== repository) {
    const where = pull.headRepo === null ? 'a repository that no longer exists' : pull.headRepo
    return `its head lies in ${where}, not in this repository, and the Gate tests only branches of this repository; close it, or move the change to a task branch of this repository`
  }
  const author = pull.author ?? 'an unknown account'
  if (rolesOf(config, pull.author ?? '').length === 0) {
    return `its author ${author} is not a member of the team in hackwin.yml, and the Gate tests only the pull requests of members; close it, or add ${author} to hackwin.yml first`
  }
  return null
}

/**
 * Leave a pull request of no member, or from another repository, alone (the Lead's review of
 * #64): no stage, label or comment, only an attention item that names it. A run under way for it
 * ends, and it leaves the queue with the labels of that run; the record of an ended run stays.
 * The item has the type `scope-violation`, the closest of the five types (G18): it closes when
 * the pull request is closed, or when a later head SHA of it passes stage 3.
 * @param {Gate} gate
 * @param {Tools} tools
 * @param {PullRequest} pull
 * @param {string} why From outsiderOf.
 * @returns {Promise<void>}
 */
export async function leaveAlone(gate, tools, pull, why) {
  const { ctx, state } = gate
  const pr = pull.number
  if (state.prs[String(pr)]?.result === null) {
    await removeGateLabels(ctx.github, pr, pull.labels, UNDER_WAY)
    leaveQueue(state, pr)
    delete state.prs[String(pr)]
  }
  await raiseAttention(gate, tools.notifier, {
    type: 'scope-violation',
    pr,
    todo: `the Gate does not test #${pr}: ${why}`,
  })
}

// Intake (9.2; G7, G12, G17; A23, A53), at every poll after the fetch of origin. The Gate lists
// the open pull requests into the default branch. A draft is ignored. For a head SHA it has not
// seen, it removes the labels of the earlier run, fetches the head and runs the secret scan at
// once, so that a secret reaches the Lead without waiting for the pull request's turn. With a
// finding the pull request fails as at stage 4 and does not join the queue; without one it gets
// `gate:queued` and joins the back of the queue, which keeps the order in which head SHAs joined.
// A pull request closed without a merge leaves the queue, and its task, when still open, returns
// to `in-progress` (8.3, A35). The pull requests of `retry` join the queue again (A43).
//
// Intake runs beside the run of the pull request at the head of the queue. A new head SHA of
// that pull request replaces its record, and the run stops after its current stage; GitHub
// writes for one pull request run one after another (Tools.serial).

import { setTaskStatus } from '../../core/tasks/index.js'
import { closeAttention } from './attention.js'
import {
  currentConfig,
  endFailed,
  fetchHead,
  joinQueue,
  leaveQueue,
  messageOf,
  pullRef,
  removeGateLabels,
  scanHead,
  setGateLabels,
  taskOf,
} from './pulls.js'
import { SECRETS_STAGE, secretFailure, stageTitle } from './stages.js'
import { addsSecret, pullRecord } from './state.js'

/** @import { PullRequest } from '../../core/github/index.js' */
/** @import { Gate } from './gate.js' */
/** @import { Tools } from './pipeline.js' */
/** @import { PullRecord } from './state.js' */

/** The attention types that close when the pull request is merged or closed (9.6). */
const CLOSED_WITH_THE_PULL = Object.freeze([
  'migration',
  'production-config',
  'scope-violation',
  'repeated-failure',
])

/** The labels of a run under way, which a draft drops. */
const UNDER_WAY = Object.freeze(['gate:queued', 'gate:testing', 'gate:waiting-ci'])

/**
 * One intake.
 * @param {Gate} gate
 * @param {Tools} tools
 * @returns {Promise<void>}
 */
export async function intake(gate, tools) {
  const { ctx, state } = gate
  const branch = gate.config.hackwin.project.default_branch
  const pulls = await ctx.github.listPullRequests({ state: 'open' })
  /** @type {Map<number, PullRequest>} */
  const open = new Map(pulls.map((pull) => [pull.number, pull]))
  for (const pull of pulls) tools.authors.set(pull.number, pull.author)
  const taken = (/** @type {PullRequest} */ pull) => !pull.draft && pull.baseRef === branch

  for (const key of Object.keys(state.prs)) {
    const pr = Number(key)
    const pull = open.get(pr)
    const record = state.prs[key]
    if (record.result === 'merged' || (pull && taken(pull))) continue
    // A draft keeps the record of an ended run: the same head SHA does not run again.
    if (pull && record.result !== null) continue
    await guarded(gate, `#${pr}`, () =>
      tools.serial(pr, () => (pull ? leaveAsDraft(gate, pull) : leaveClosed(gate, pr, pulls))),
    )
  }

  const fresh = pulls
    .filter((pull) => taken(pull) && state.prs[String(pull.number)]?.head_sha !== pull.headSha)
    .sort((a, b) => a.number - b.number)
  const config =
    fresh.length === 0 ? gate.config : await currentConfig(gate, `refs/remotes/origin/${branch}`)
  for (const pull of fresh) {
    await guarded(gate, `#${pull.number}`, () =>
      tools.serial(pull.number, () => admit(gate, tools, config, pull)),
    )
  }

  for (const pr of [...gate.retries]) {
    gate.retries.delete(pr)
    const pull = open.get(pr)
    const done = await guarded(gate, `retry #${pr}`, () =>
      tools.serial(pr, () => requeue(gate, pr, pull && taken(pull) ? pull : null)),
    )
    if (!done) gate.retries.add(pr)
  }
}

/**
 * A new head SHA: the labels of the earlier run go, the head is fetched and scanned, and the pull
 * request joins the back of the queue or fails.
 * @param {Gate} gate
 * @param {Tools} tools
 * @param {import('../../core/config/index.js').Config} config The configuration on main.
 * @param {PullRequest} pull
 * @returns {Promise<void>}
 */
async function admit(gate, tools, config, pull) {
  const { ctx, state } = gate
  const pr = pull.number
  const sha = pull.headSha
  const startedAt = ctx.clock.now().getTime()
  const branch = gate.config.hackwin.project.default_branch
  const earlier = state.prs[String(pr)]
  await removeGateLabels(ctx.github, pr, pull.labels)
  await fetchHead(gate, pr, sha)
  const main = `refs/remotes/origin/${branch}`
  const findings = await scanHead(gate, config, { base: main, head: sha })
  /** @type {PullRecord} */
  const record = {
    ...pullRecord(sha, ctx.clock.now().toISOString()),
    stage: 'intake',
    secret_scanned_sha: sha,
    failures: earlier?.failures ?? [],
  }
  if (earlier && gate.running === pr) {
    gate.line(
      `#${pr}: the new head ${sha} arrived during the run of ${earlier.head_sha}, which stops after its current stage`,
    )
  }
  if (findings.length > 0) {
    await endFailed(gate, tools.notifier, {
      pr,
      record,
      author: pull.author,
      main: await gate.git.tryRevParse(main),
      startedAt,
      failure: {
        ...secretFailure({ pr, findings, task: taskOf(pull), atIntake: true }),
        stage: SECRETS_STAGE.name,
        title: `${stageTitle(SECRETS_STAGE)}, at intake`,
      },
    })
    return
  }
  await setGateLabels(ctx.github, pr, ['gate:queued'])
  state.prs[String(pr)] = record
  joinQueue(state, pr)
}

/**
 * A pull request that is closed, merged or gone: it leaves the queue, its attention items close
 * except a secret's (9.6), and the task of one closed without a merge returns to `in-progress`
 * unless another open pull request names it.
 * @param {Gate} gate
 * @param {number} pr
 * @param {PullRequest[]} pulls The open pull requests.
 * @returns {Promise<void>}
 */
async function leaveClosed(gate, pr, pulls) {
  const { ctx, state } = gate
  if (!state.prs[String(pr)]) return
  const pull = await ctx.github.getPullRequest(pr)
  // The list was older than this answer.
  if (pull !== null && pull.state === 'open') return
  const merged = pull?.merged === true
  /** @type {number | null} */
  let task = null
  const named = pull === null || merged ? null : taskOf(pull)
  if (named !== null && !pulls.some((other) => other.number !== pr && taskOf(other) === named)) {
    const issue = await ctx.github.getIssue(named)
    if (issue !== null && issue.state === 'open' && !issue.isPullRequest) {
      await setTaskStatus(ctx.github, named, 'in-progress')
      task = named
    }
  }
  leaveQueue(state, pr)
  closeAttention(gate, {
    pr,
    types: CLOSED_WITH_THE_PULL,
    why: merged ? 'the pull request is merged' : 'the pull request is closed',
  })
  await gate.git.run(['update-ref', '-d', pullRef(pr)], { allowFailure: true })
  delete state.prs[String(pr)]
  const how = merged ? 'was merged outside the Gate' : 'was closed without a merge'
  gate.line(
    `#${pr} ${how} and left the queue${task === null ? '' : `; its task #${task} is in-progress again`}`,
  )
}

/**
 * A queued pull request that became a draft, or now targets another branch, leaves the queue and
 * loses the labels of the run; it joins again when it is ready for review into the default branch.
 * @param {Gate} gate
 * @param {PullRequest} pull
 * @returns {Promise<void>}
 */
async function leaveAsDraft(gate, pull) {
  const { ctx, state } = gate
  const pr = pull.number
  if (state.prs[String(pr)]?.result !== null) return
  await removeGateLabels(ctx.github, pr, pull.labels, UNDER_WAY)
  leaveQueue(state, pr)
  delete state.prs[String(pr)]
  const why = pull.draft ? 'is a draft' : `targets ${pull.baseRef}`
  gate.line(`#${pr} ${why} and left the queue; the Gate ignores it until it is ready for review`)
}

/**
 * `retry <PR>` (A43): the current head SHA joins the back of the queue again, with the labels of
 * the earlier run removed. A head SHA that adds a secret never does: a new one without it does.
 * @param {Gate} gate
 * @param {number} pr
 * @param {PullRequest | null} pull The open pull request, ready for review into the default branch.
 * @returns {Promise<void>}
 */
async function requeue(gate, pr, pull) {
  const { ctx, state } = gate
  const record = state.prs[String(pr)]
  if (pull === null || !record) {
    gate.line(`retry #${pr}: #${pr} is not an open pull request that the Gate takes`)
    return
  }
  // A new head SHA joined the queue at this intake already.
  if (record.head_sha !== pull.headSha || state.queue.includes(pr)) return
  if (record.result !== 'failed' && record.result !== 'flaky') return
  if (addsSecret(record)) {
    gate.line(
      `retry #${pr}: the head ${record.head_sha} adds a secret, so it does not join the queue; a new head SHA without it does`,
    )
    return
  }
  await setGateLabels(ctx.github, pr, ['gate:queued'])
  record.stage = 'intake'
  record.result = null
  joinQueue(state, pr)
  gate.line(`retry #${pr}: the head ${record.head_sha} joined the back of the queue`)
}

/**
 * Run one part of intake; a failure is a line, and the next poll tries again.
 * @param {Gate} gate
 * @param {string} what
 * @param {() => Promise<void>} work
 * @returns {Promise<boolean>} True when it succeeded.
 */
async function guarded(gate, what, work) {
  try {
    await work()
    return true
  } catch (error) {
    gate.line(`intake ${what}: ${messageOf(error)}; the next poll tries again`)
    return false
  }
}

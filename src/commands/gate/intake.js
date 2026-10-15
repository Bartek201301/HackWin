// Intake (9.2; G7, G12, G17; A23, A53), at every poll after the fetch of origin. The Gate lists
// the open pull requests; a draft is ignored. For a head SHA it has not seen, it removes the
// labels of the earlier run, fetches the head and runs the secret scan at once, so that a secret
// reaches the Lead without waiting for the pull request's turn. Every head SHA is scanned once,
// whatever the pull request's base (G12), but only a pull request into the default branch joins
// the queue (the Lead's review of #64). With a finding the pull request fails as at stage 4 and
// does not join the queue; without one a pull request into the default branch gets `gate:queued`
// and joins the back of the queue, which keeps the order in which head SHAs joined. A pull
// request from another repository or of no member is left alone with an attention item
// (pulls.js, leaveAlone). A pull request closed without a merge leaves the queue, and its task,
// when still open, returns to `in-progress` (8.3, A35). The pull requests of `retry` join the
// queue again (A43). Once the Lead typed `quit`, intake starts no new work.
//
// Intake runs beside the run of the pull request at the head of the queue. A new head SHA of
// that pull request replaces its record, and the run stops after its current stage; GitHub
// writes for one pull request run one after another (Tools.serial).

import { setTaskStatus } from '../../core/tasks/index.js'
import { CLOSED_WITH_THE_PULL, closeAttention } from './attention.js'
import {
  UNDER_WAY,
  currentConfig,
  endFailed,
  fetchHead,
  joinQueue,
  leaveAlone,
  leaveQueue,
  messageOf,
  outsiderOf,
  pullRef,
  removeGateLabels,
  scanHead,
  setGateLabels,
  taskOf,
} from './pulls.js'
import { forgetPull } from './repeated.js'
import { SECRETS_STAGE, secretFailure, stageTitle } from './stages.js'
import { addsSecret, pullRecord } from './state.js'

/** @import { PullRequest } from '../../core/github/index.js' */
/** @import { Gate } from './gate.js' */
/** @import { Tools } from './pipeline.js' */
/** @import { PullRecord } from './state.js' */

/**
 * One intake.
 * @param {Gate} gate
 * @param {Tools} tools
 * @returns {Promise<void>}
 */
export async function intake(gate, tools) {
  if (gate.stopping) return
  const { ctx, state } = gate
  const branch = gate.config.hackwin.project.default_branch
  const pulls = await ctx.github.listPullRequests({ state: 'open' })
  /** @type {Map<number, PullRequest>} */
  const open = new Map(pulls.map((pull) => [pull.number, pull]))
  for (const pull of pulls) tools.authors.set(pull.number, pull.author)
  const queueable = (/** @type {PullRequest} */ pull) => !pull.draft && pull.baseRef === branch

  for (const key of Object.keys(state.prs)) {
    if (gate.stopping) return
    const pr = Number(key)
    const pull = open.get(pr)
    const record = state.prs[key]
    if (record.result === 'merged' || (pull && queueable(pull))) continue
    // A draft keeps the record of an ended run: the same head SHA does not run again.
    if (pull && record.result !== null) continue
    await guarded(gate, `#${pr}`, () =>
      tools.serial(pr, () => (pull ? leaveAsDraft(gate, pull) : leaveClosed(gate, pr, pulls))),
    )
  }
  await closeItemsOfClosed(gate, tools, open)

  const fresh = pulls
    .filter(
      (pull) =>
        !pull.draft &&
        state.prs[String(pull.number)]?.head_sha !== pull.headSha &&
        (pull.baseRef === branch || !tools.scanned.has(scanKey(pull))),
    )
    .sort((a, b) => a.number - b.number)
  const config =
    fresh.length === 0 ? gate.config : await currentConfig(gate, `refs/remotes/origin/${branch}`)
  for (const pull of fresh) {
    if (gate.stopping) return
    await guarded(gate, `#${pull.number}`, () =>
      tools.serial(pull.number, () => admit(gate, tools, config, pull)),
    )
  }

  for (const pr of [...gate.retries]) {
    if (gate.stopping) return
    gate.retries.delete(pr)
    const pull = open.get(pr)
    const done = await guarded(gate, `retry #${pr}`, () =>
      tools.serial(pr, () => requeue(gate, pr, pull && queueable(pull) ? pull : null)),
    )
    if (!done) gate.retries.add(pr)
  }
}

/**
 * The key of a head SHA that intake scanned without a finding and did not queue: the head of a
 * pull request into another branch than the default branch. It is not scanned again while the
 * Gate runs and the pull request targets that branch; retargeted to the default branch, it is
 * scanned again and joins the queue.
 * @param {PullRequest} pull
 * @returns {string}
 */
function scanKey(pull) {
  return `${pull.number}:${pull.headSha}`
}

/**
 * Close the attention items, except a secret's, of the pull requests without a record that are
 * no longer open: those the Gate left alone (9.6).
 * @param {Gate} gate
 * @param {Tools} tools
 * @param {Map<number, PullRequest>} open
 * @returns {Promise<void>}
 */
async function closeItemsOfClosed(gate, tools, open) {
  const { ctx, state } = gate
  const prs = new Set(
    state.attention
      .filter(
        (item) =>
          !item.resolved_at &&
          CLOSED_WITH_THE_PULL.includes(item.type) &&
          !open.has(Number(item.pr)) &&
          !state.prs[String(item.pr)],
      )
      .map((item) => Number(item.pr)),
  )
  for (const pr of prs) {
    if (gate.stopping) return
    await guarded(gate, `#${pr}`, () =>
      tools.serial(pr, async () => {
        const pull = await ctx.github.getPullRequest(pr)
        if (pull !== null && pull.state === 'open') return
        closeAttention(gate, {
          pr,
          types: CLOSED_WITH_THE_PULL,
          why: pull?.merged ? 'the pull request is merged' : 'the pull request is closed',
        })
      }),
    )
  }
}

/**
 * A new head SHA that a run found, as stage 10 does when the head moved after the merge test: it
 * is admitted as at intake, after the work for the pull request that started earlier.
 * @param {Gate} gate
 * @param {Tools} tools
 * @param {PullRequest} pull
 * @returns {Promise<void>}
 */
export async function admitHead(gate, tools, pull) {
  const branch = gate.config.hackwin.project.default_branch
  const config = await currentConfig(gate, `refs/remotes/origin/${branch}`)
  await tools.serial(pull.number, async () => {
    if (gate.state.prs[String(pull.number)]?.head_sha === pull.headSha) return
    await admit(gate, tools, config, pull)
  })
}

/**
 * A new head SHA: a pull request of no member or from another repository is left alone.
 * Otherwise the labels of the earlier run go, the head is fetched and scanned, and the pull
 * request fails, or joins the back of the queue when it targets the default branch.
 * @param {Gate} gate
 * @param {Tools} tools
 * @param {import('../../core/config/index.js').Config} config The configuration on main.
 * @param {PullRequest} pull
 * @returns {Promise<void>}
 */
async function admit(gate, tools, config, pull) {
  const { ctx, state } = gate
  const why = await outsiderOf(gate, tools, config, pull)
  if (why !== null) {
    await leaveAlone(gate, tools, pull, why)
    return
  }
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
      config,
      queued: false,
    })
    return
  }
  if (pull.baseRef !== branch) {
    tools.scanned.add(scanKey(pull))
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
  // The Gate's own merge: its run ends the record (stage 11).
  if (!state.prs[String(pr)] || state.prs[String(pr)].result === 'merged') return
  const pull = await ctx.github.getPullRequest(pr)
  // The list was older than this answer.
  if (pull !== null && pull.state === 'open') return
  if (pull !== null && tookOwnMerge(gate, pr, pull)) return
  const merged = pull?.merged === true
  /** @type {number | null} */
  let task = null
  // Only a pull request into the default branch had its task in review.
  const branch = gate.config.hackwin.project.default_branch
  const named = pull === null || merged || pull.baseRef !== branch ? null : taskOf(pull)
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
  forgetPull(gate, pr)
  const how = merged ? 'was merged outside the Gate' : 'was closed without a merge'
  gate.line(
    `#${pr} ${how} and left the queue${task === null ? '' : `; its task #${task} is in-progress again`}`,
  )
}

/**
 * Take a merge as the Gate's own when GitHub merged the head SHA that the record's run took into
 * stage 10: the run stopped there, as when the Gate was killed after GitHub merged and before the
 * state file said so, or it ended failed or was given up there because the answer to the merge
 * was lost or not readable. The record is then merged and in the queue, and its run takes up
 * again after the merge (pipeline.js): stage 11 labels it, closes its task and readies the
 * dependents. Every other merge of a pull request with a record happened outside the Gate.
 * @param {Gate} gate
 * @param {number} pr
 * @param {PullRequest} pull
 * @returns {boolean} True when the merge is the Gate's own.
 */
export function tookOwnMerge(gate, pr, pull) {
  const { state } = gate
  const record = state.prs[String(pr)]
  if (!record || record.stage !== 'merge') return false
  if (record.result !== null && record.result !== 'failed') return false
  if (!pull.merged || pull.headSha !== record.head_sha) return false
  const ended = record.result === 'failed'
  record.result = 'merged'
  if (!state.queue.includes(pr)) state.queue.unshift(pr)
  gate.line(
    ended
      ? `#${pr}: GitHub merged head ${record.head_sha}, whose run ended at stage 10, so the Gate finishes it after the merge`
      : `#${pr}: GitHub merged head ${record.head_sha}, which the Gate had not recorded, so the run goes on after the merge`,
  )
  return true
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
  // The Lead's retry tries the head again, CI reruns included (G14).
  record.ci_reruns = 0
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

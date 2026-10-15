// Repeated failures (G23; A24, A42; 9.6). Besides a known flaky test that fails again after its
// rerun (merge-test.js, ci.js) and a failed smoke test after a merge (merge.js), two runs of
// failures make a repeated failure, each at `gate.repeated_failure_threshold`, two by default:
//
// - the same pull request fails the same stage on that many head SHAs in a row;
// - that many queue items in a row fail the same stage.
//
// The streaks live in the state file (`streaks`), so a restart keeps them. A run that fails a
// stage adds to the streak of that stage and starts a new one for any other stage; a run that
// passes the stage ends its streak. A run that ended without passing or failing the stage, as
// one that a new head SHA replaced before it got there, neither adds to a streak nor ends it. A
// head SHA counts once for its pull request, so a `retry` that fails again does not make a run of
// head SHAs; it is another queue item, though.
//
// Each streak raises one repeated failure item for its stage, which closes when the stage passes
// again (9.6): for the pull request's own item, a pass of that pull request with a later head SHA
// or after `retry`; for the item across queue items, the pass of any queue item. When every queue
// item of a streak is a head SHA of the one pull request whose own item is open, that item says
// it all, and no second line is raised.

import { closeOnPass, raiseAttention } from './attention.js'

/** @import { Gate } from './gate.js' */
/** @import { Notifier } from './notify.js' */
/** @import { Streak } from './state.js' */

/**
 * Add a failed run to the streaks and raise the repeated failure items that a streak now calls
 * for.
 * @param {Gate} gate
 * @param {Notifier} notifier
 * @param {{ pr: number, sha: string, stage: string, title: string, queued: boolean, threshold: number }} failed
 *   `title` names the stage as the comment does; `queued` is false for a head SHA that failed at
 *   intake and never joined the queue.
 * @returns {Promise<void>}
 */
export async function recordFailure(gate, notifier, failed) {
  const { pr, sha, stage, title, queued, threshold } = failed
  const streaks = gate.state.streaks
  const at = gate.ctx.clock.now().toISOString()
  const earlier = streaks.prs[String(pr)]
  /** @type {Streak} */
  const own = earlier?.stage === stage ? earlier : { stage, runs: [] }
  if (!own.runs.some((run) => run.sha === sha)) own.runs.push({ pr, sha, at })
  streaks.prs[String(pr)] = own
  const ownItem = own.runs.length >= threshold
  if (ownItem) {
    await raiseAttention(gate, notifier, {
      type: 'repeated-failure',
      pr,
      stage,
      todo: `#${pr} failed ${title} on ${own.runs.length} head SHAs in a row (${latest(own.runs.map((run) => run.sha.slice(0, 12)))}); the comments on #${pr} give each failure: help its author, or look for a cause outside the pull request`,
    })
  }
  if (!queued) return
  /** @type {Streak} */
  const queue = streaks.queue?.stage === stage ? streaks.queue : { stage, runs: [] }
  queue.runs.push({ pr, sha, at })
  streaks.queue = queue
  if (queue.runs.length < threshold) return
  if (ownItem && queue.runs.every((run) => run.pr === pr)) return
  await raiseAttention(gate, notifier, {
    type: 'repeated-failure',
    pr,
    stage,
    across: true,
    todo: `${queue.runs.length} queue items in a row failed ${title} (${latest(queue.runs.map((run) => `#${run.pr}`))}); look for a cause they share, such as main, CI or the machine of the Gate`,
  })
}

/**
 * A run passed a stage: the streaks of that stage end, and the repeated failure items that the
 * pass closes close (9.6).
 * @param {Gate} gate
 * @param {{ pr: number, sha: string, stage: string, title: string }} passed
 */
export function recordPass(gate, { pr, sha, stage, title }) {
  const streaks = gate.state.streaks
  if (streaks.prs[String(pr)]?.stage === stage) delete streaks.prs[String(pr)]
  if (streaks.queue?.stage === stage) streaks.queue = null
  closeOnPass(gate, { pr, stage, why: `#${pr} passes ${title} with head ${sha}` })
}

/**
 * Forget the streak of a pull request that was merged or closed.
 * @param {Gate} gate
 * @param {number} pr
 */
export function forgetPull(gate, pr) {
  delete gate.state.streaks.prs[String(pr)]
}

/**
 * The newest five items, oldest first, and how many came before them.
 * @param {string[]} items
 * @returns {string}
 */
function latest(items) {
  if (items.length <= 5) return items.join(', ')
  return `${items.length - 5} earlier, then ${items.slice(-5).join(', ')}`
}

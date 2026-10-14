// Steps 10 to 15 of `ship` (7.9): push the checked commit, open or update the one pull request
// of the task, report on the issue, set the issue in-review and print the stop line. Each step
// first looks at what an earlier, interrupted `ship` left, so that a rerun never opens a second
// pull request or writes a second report (CM3). A failure in these steps exits 3.

import { parseTaskLink, setTaskStatus } from '../../core/tasks/index.js'
import { PUBLISH_STEPS, STEPS, listOf, plural, progress, publishing, seconds } from './steps.js'

/** @import { CommandContext } from '../../cli/context.js' */
/** @import { Config } from '../../core/config/index.js' */
/** @import { Comment, PullRequest } from '../../core/github/index.js' */
/** @import { CheckResult } from '../../core/state/index.js' */
/** @import { Task } from '../../core/tasks/index.js' */
/** @import { TaskWorktree } from '../../core/worktrees/index.js' */
/** @import { Checked } from './checks.js' */
/** @import { Synced } from './sync.js' */

/** The project's pull request template, the source of every pull request body (contracts 5.5). */
export const TEMPLATE_PATH = '.github/pull_request_template.md'

/** The line of the template that `ship` fills with the task: exactly `Closes #`. */
const EMPTY_CLOSES_LINE = /^Closes #[ \t]*(\r?)$/

/**
 * @typedef {object} OpenedPull
 * @property {PullRequest} pull
 * @property {'opened' | 'updated' | 'reused'} action `opened` for a new pull request; `updated`
 *   or `reused` for the open pull request of the task, with or without changes.
 * @property {string[]} changes What `ship` changed on an open pull request.
 */

/**
 * @typedef {object} Report
 * @property {Comment} comment
 * @property {boolean} created False when an earlier `ship` already wrote it.
 */

/**
 * @typedef {object} Published
 * @property {boolean} pushed False when origin already had the head commit on the branch.
 * @property {OpenedPull} pull
 * @property {Report} report
 * @property {string[]} labels The labels of the issue afterwards.
 * @property {string} stopLine
 */

/**
 * Steps 10 to 15, after every check passed for the head commit.
 * @param {CommandContext} ctx
 * @param {TaskWorktree} worktree
 * @param {Synced} synced
 * @param {Checked} checked
 * @returns {Promise<Published>}
 */
export async function publish(ctx, worktree, synced, checked) {
  const dir = worktree.path
  const pushed = await publishing(PUBLISH_STEPS.push, dir, () =>
    pushBranch(ctx, worktree, synced.head),
  )
  const pull = await publishing(PUBLISH_STEPS.pull, dir, () =>
    openPullRequest(ctx, worktree, synced),
  )
  const report = await publishing(PUBLISH_STEPS.report, dir, () =>
    reportOnIssue(ctx, synced, checked, pull.pull),
  )
  const labels = await publishing(PUBLISH_STEPS.label, dir, () => markInReview(ctx, synced.task))
  // Step 15.
  return { pushed, pull, report, labels, stopLine: stopLine(pull.pull.number, synced.head) }
}

/**
 * The last output line of `ship`, which tells the session to stop (P6).
 * @param {number} pull
 * @param {string} sha
 * @returns {string}
 */
export function stopLine(pull, sha) {
  return `PR #${pull} opened at ${sha}. Do not merge. Stop.`
}

/**
 * The body of the task's pull request (contracts 5.5): the template with its first line that is
 * exactly `Closes #` filled with the task; without such a line, `Closes #<N>` and an empty line
 * before the template; without a template, `Closes #<N>` alone.
 * @param {string | null} template The template's text, or null when the project has none.
 * @param {number} issue
 * @returns {string}
 */
export function pullRequestBody(template, issue) {
  const closes = `Closes #${issue}`
  if (template === null) return closes
  const lines = template.split('\n')
  const index = lines.findIndex((line) => EMPTY_CLOSES_LINE.test(line))
  if (index === -1) return `${closes}\n\n${template}`
  lines[index] = lines[index].replace(EMPTY_CLOSES_LINE, `${closes}$1`)
  return lines.join('\n')
}

/**
 * The first line of the report of one pull request at one head commit. A rerun finds the report
 * by it and does not write it again.
 * @param {number} pull
 * @param {string} sha
 * @returns {string}
 */
export function reportMarker(pull, sha) {
  return `<!-- hackwin:ship-report pr=${pull} sha=${sha} -->`
}

/**
 * The issue comment of step 13: the pull request, the full head SHA and the checks that ran on
 * that commit with their results.
 * @param {object} report
 * @param {number} report.pull
 * @param {string} report.sha
 * @param {CheckResult[]} report.checks
 * @param {string} report.recordedAt When the checks passed.
 * @returns {string}
 */
export function reportBody({ pull, sha, checks, recordedAt }) {
  const rows = checks.map((check) => {
    const step = Object.hasOwn(STEPS, check.name)
      ? STEPS[/** @type {keyof typeof STEPS} */ (check.name)]
      : null
    const result =
      check.duration_ms === undefined
        ? check.result
        : `${check.result} in ${seconds(check.duration_ms)}`
    return `| ${step?.number ?? ''} | ${step?.title ?? check.name} | ${result} |`
  })
  return [
    reportMarker(pull, sha),
    `\`hackwin ship\` opened PR #${pull} at ${sha}.`,
    '',
    `The checks that ran on this commit, passed at ${recordedAt}:`,
    '',
    '| Step | Check | Result |',
    '| --- | --- | --- |',
    ...rows,
    '',
  ].join('\n')
}

/**
 * Step 10: push the branch, never forced. The `pre-push` hook accepts it because the green check
 * record of the head commit exists (E4). Nothing is pushed when origin already has the head.
 * @param {CommandContext} ctx
 * @param {TaskWorktree} worktree
 * @param {string} head
 * @returns {Promise<boolean>} True when the push sent the head.
 */
async function pushBranch(ctx, worktree, head) {
  const { branch } = worktree
  if ((await ctx.git.tryRevParse(`refs/remotes/origin/${branch}`)) === head) {
    progress(ctx, PUBLISH_STEPS.push, `origin/${branch} is already at ${head}`)
    return false
  }
  await ctx.git.push({ refspecs: [`refs/heads/${branch}:refs/heads/${branch}`], setUpstream: true })
  progress(ctx, PUBLISH_STEPS.push, `pushed ${head} to origin/${branch}`)
  return true
}

/**
 * Step 11: open the pull request of the task, not as a draft, or update the open one (T1). A pull
 * request that was closed without a merge is not reused, and neither is one from a fork's branch
 * of the same name: only a head in this repository is the task's branch. An open one gets back
 * what `ship` would have opened it with: ready for review, into the default branch, a body that
 * closes the task.
 * @param {CommandContext} ctx
 * @param {TaskWorktree} worktree
 * @param {Synced} synced
 * @returns {Promise<OpenedPull>}
 */
async function openPullRequest(ctx, worktree, synced) {
  const config = /** @type {Config} */ (ctx.config)
  const base = config.hackwin.project.default_branch
  const { branch } = worktree
  const { task } = synced
  const body = pullRequestBody(await ctx.git.showFile(synced.head, TEMPLATE_PATH), task.number)
  const link = parseTaskLink({ branch, body })
  const repository = (await ctx.github.repository()).nameWithOwner.toLowerCase()
  const open = (await ctx.github.listPullRequests({ state: 'open', head: branch })).filter(
    (pull) => pull.headRepo?.toLowerCase() === repository,
  )
  const existing = open.find((pull) => pull.baseRef === base) ?? open[0]

  if (existing === undefined) {
    if (!link.ok) warnTemplate(ctx, link.reason)
    const pull = await ctx.github.createPullRequest({ title: task.title, head: branch, base, body })
    progress(ctx, PUBLISH_STEPS.pull, `opened PR #${pull.number} into ${base}: ${pull.url}`)
    return { pull, action: 'opened', changes: [] }
  }

  if (open.length > 1) {
    const numbers = open.map((pull) => `#${pull.number}`)
    ctx.out.warn(
      `${plural(open.length, 'open pull request')} come from ${branch}: ${listOf(numbers)}; ship updates #${existing.number} only (T1)`,
    )
  }
  let pull = existing
  /** @type {string[]} */
  const changes = []
  if (pull.draft) {
    await ctx.github.run(['pr', 'ready', String(pull.number)])
    pull = { ...pull, draft: false }
    changes.push('marked ready for review')
  }
  /** @type {{ base?: string, body?: string }} */
  const update = {}
  if (pull.baseRef !== base) {
    update.base = base
    changes.push(`base changed from ${pull.baseRef} to ${base}`)
  }
  const own = parseTaskLink({ branch, body: pull.body })
  if (!own.ok) {
    if (!link.ok) warnTemplate(ctx, link.reason)
    update.body = body
    changes.push(
      `body rebuilt from the template, because it did not close the task (${own.reason})`,
    )
  }
  if (update.base !== undefined || update.body !== undefined) {
    pull = await ctx.github.updatePullRequest(pull.number, update)
  }
  const what = changes.length === 0 ? 'is open' : `updated: ${changes.join('; ')}`
  progress(ctx, PUBLISH_STEPS.pull, `PR #${pull.number} of ${branch} ${what}: ${pull.url}`)
  return { pull, action: changes.length === 0 ? 'reused' : 'updated', changes }
}

/**
 * @param {CommandContext} ctx
 * @param {string} reason The reason of the task link parser.
 */
function warnTemplate(ctx, reason) {
  ctx.out.warn(
    `the pull request body built from ${TEMPLATE_PATH} has no valid task link (${reason}), so CI fails it (E11): the template should hold no closing keyword other than its \`Closes #\` line`,
  )
}

/**
 * Step 13: one comment on the task issue for this pull request and head commit, with the checks
 * that ran on the commit. A report that an earlier `ship` wrote is not written again.
 * @param {CommandContext} ctx
 * @param {Synced} synced
 * @param {Checked} checked
 * @param {PullRequest} pull
 * @returns {Promise<Report>}
 */
async function reportOnIssue(ctx, synced, checked, pull) {
  const { task, head } = synced
  const marker = reportMarker(pull.number, head)
  const comments = await ctx.github.listComments(task.number)
  const earlier = comments.find((comment) => comment.body.split('\n')[0].trim() === marker)
  if (earlier !== undefined) {
    progress(ctx, PUBLISH_STEPS.report, `issue #${task.number} already has it: ${earlier.url}`)
    return { comment: earlier, created: false }
  }
  const body = reportBody({
    pull: pull.number,
    sha: head,
    checks: checked.checks,
    recordedAt: checked.recordedAt,
  })
  const comment = await ctx.github.createComment(task.number, body)
  progress(ctx, PUBLISH_STEPS.report, `commented on issue #${task.number}: ${comment.url}`)
  return { comment, created: true }
}

/**
 * Step 14: the task's status label becomes `in-review`, replacing `in-progress` (8.3).
 * @param {CommandContext} ctx
 * @param {Task} task The task as step 1 read it.
 * @returns {Promise<string[]>}
 */
async function markInReview(ctx, task) {
  const labels = await setTaskStatus(ctx.github, task.number, 'in-review')
  const was = task.status === 'in-review' ? 'it already was' : `it was ${task.status}`
  progress(ctx, PUBLISH_STEPS.label, `issue #${task.number} is in-review; ${was}`)
  return labels
}

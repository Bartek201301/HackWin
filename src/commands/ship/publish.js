// Steps 10 to 15 of `ship` (7.9): push the checked commit, open or update the one pull request
// of the task, report on the issue, set the issue in-review and print the stop line. Each step
// first looks at what an earlier, interrupted `ship` left, so that a rerun never opens a second
// pull request or writes a second report (CM3). A failure in these steps exits 3.

import { parseTaskLink, setTaskStatus } from '../../core/tasks/index.js'
import { HTML_MARKERS } from '../../generate/blocks.js'
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

/** A line without its trailing spaces and tabs, and the `\r` of a CRLF line ending. */
const LINE_END = /^(.*?)[ \t]*(\r?)$/

/** The role line of HackWin's block: empty as in the template, or with one role name. */
const ROLE_LINE = /^- Ownership role:(?:[ \t]+[A-Za-z0-9][A-Za-z0-9._-]*)?$/

/** A verification line of HackWin's block, ticked or not. */
const CHECKBOX_LINE = /^- \[[ xX]\] (.*)$/

/** The start of the acceptance line of HackWin's block, after its checkbox. */
const ACCEPTANCE = 'Acceptance tests of the task passed:'

/** What follows `ACCEPTANCE`: nothing, as in the template, or what `ship` writes there. */
const ACCEPTANCE_TAIL = /^(?:| the task names none| `[^`]+`(?:, `[^`]+`)*)$/

/**
 * What `ship` vouches for in the body of the task's pull request (contracts 5.5).
 * @typedef {object} BodyFacts
 * @property {string} role The ownership role of the task.
 * @property {string} mainRef `origin/<default branch>`, which step 2 merged into the head commit.
 * @property {string[]} passed The steps that passed on the head commit, by their names in
 *   `STEPS`.
 * @property {string[]} tests The acceptance tests of the task, which step 8 ran.
 */

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
    openPullRequest(ctx, worktree, synced, checked),
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
 * A pull request body with what `ship` vouches for filled in (contracts 5.5): in HackWin's block
 * of the template, the ownership role of the task, a tick on each verification line whose step
 * passed on the head commit, and the acceptance tests. Only a line as the template has it, or as
 * `ship` filled it before, is filled; every other line stays as it is, and so does a body
 * without HackWin's block. The same facts give the same body, so a body filled for an earlier
 * head commit gets the facts of the new one.
 * @param {string} body
 * @param {BodyFacts} facts
 * @returns {string}
 */
export function fillPullRequestBody(body, facts) {
  const lines = body.split('\n')
  const begin = lines.findIndex((line) => line.trim() === HTML_MARKERS.begin)
  const end =
    begin === -1
      ? -1
      : lines.findIndex((line, index) => index > begin && line.trim() === HTML_MARKERS.end)
  if (end === -1) return body
  for (let index = begin + 1; index < end; index += 1) {
    lines[index] = fillLine(lines[index], facts)
  }
  return lines.join('\n')
}

/**
 * One line of HackWin's block, filled when `ship` vouches for it.
 * @param {string} line
 * @param {BodyFacts} facts
 * @returns {string}
 */
function fillLine(line, { role, mainRef, passed, tests }) {
  const match = LINE_END.exec(line)
  if (match === null) return line
  const [, text, cr] = match
  if (ROLE_LINE.test(text)) return `- Ownership role: ${role}${cr}`
  const item = CHECKBOX_LINE.exec(text)?.[1]
  if (item === undefined) return line
  if (item.startsWith(ACCEPTANCE)) {
    if (!passed.includes('acceptance') || !ACCEPTANCE_TAIL.test(item.slice(ACCEPTANCE.length))) {
      return line
    }
    const named =
      tests.length === 0 ? 'the task names none' : tests.map((test) => `\`${test}\``).join(', ')
    return `- [x] ${ACCEPTANCE} ${named}${cr}`
  }
  const step = verificationLines(mainRef).get(item)
  return step !== undefined && passed.includes(step) ? `- [x] ${item}${cr}` : line
}

/**
 * The verification lines of HackWin's block that a step vouches for, after their checkbox, with
 * the name of that step in `STEPS`. The merge line names the default branch, so it is not
 * ticked in a project whose default branch is not the one it names.
 * @param {string} mainRef
 * @returns {Map<string, string>}
 */
function verificationLines(mainRef) {
  return new Map([
    [`Merged the current \`${mainRef}\` into the branch; no rebase, no force push`, 'merge'],
    ['Full project check passed on the head commit', 'check'],
    ['Only the changed files were formatted', 'format'],
    ['No env file and no secret in the added lines', 'secrets'],
  ])
}

/**
 * What `ship` vouches for on the head commit: the role of the task, step 2, the checks that
 * passed and the acceptance tests of the task. A check record that an earlier `ship` wrote for
 * the same commit and task stands for its checks (7.9).
 * @param {Synced} synced
 * @param {Checked} checked
 * @returns {BodyFacts}
 */
function bodyFacts(synced, checked) {
  const { block } = synced.task
  return {
    role: block.role,
    mainRef: synced.mainRef,
    passed: [
      'merge',
      ...checked.checks.filter((check) => check.result === 'passed').map((check) => check.name),
    ],
    tests: block.acceptance_tests,
  }
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
 * closes the task, with what `ship` vouches for on the head commit filled in.
 * @param {CommandContext} ctx
 * @param {TaskWorktree} worktree
 * @param {Synced} synced
 * @param {Checked} checked
 * @returns {Promise<OpenedPull>}
 */
async function openPullRequest(ctx, worktree, synced, checked) {
  const config = /** @type {Config} */ (ctx.config)
  const base = config.hackwin.project.default_branch
  const { branch } = worktree
  const { task } = synced
  const facts = bodyFacts(synced, checked)
  const template = await ctx.git.showFile(synced.head, TEMPLATE_PATH)
  const body = fillPullRequestBody(pullRequestBody(template, task.number), facts)
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
  } else {
    const filled = fillPullRequestBody(pull.body, facts)
    if (filled !== pull.body) {
      update.body = filled
      changes.push(`body filled in with the role and the checks of ${synced.head}`)
    }
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

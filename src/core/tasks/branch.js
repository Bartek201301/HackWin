// Branch names and the task link of a pull request: a `task/<N>-<slug>` branch (A9) and a body
// with exactly one `Closes #<N>` line and no other closing reference (T1, E11). `spike/`
// branches are never merged (E16). The body format is docs/build/contracts.md section 5.5.

import { parseTaskBlock } from './block.js'

/** @import { GitHub, PullRequest } from '../github/index.js' */
/** @import { OwnershipConfig } from '../config/ownership.js' */

/**
 * @typedef {'no-task-branch' | 'spike-branch' | 'no-closes-line' | 'several-closing-references' | 'branch-issue-mismatch'} TaskLinkReason
 */

/**
 * @typedef {{ ok: true, issue: number } | { ok: false, reason: TaskLinkReason | 'issue-not-open' | 'invalid-task-block' }} TaskLink
 */

/** How many words of the title the slug keeps (A9). */
const SLUG_WORDS = 4

const CLOSES_LINE = /^Closes #(\d+)\s*$/

/** Any closing reference GitHub acts on: a keyword, an optional colon, then an issue. */
const CLOSING_REFERENCE =
  /\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\b:?\s+(?:[\w.-]+\/[\w.-]+#\d+|#\d+|https?:\/\/\S+\/(?:issues|pull)\/\d+)/gi

/**
 * The slug of a task branch: the first four words of the title, lower case, every run of
 * characters other than `a` to `z` and `0` to `9` replaced by one hyphen. A word is a run of
 * characters between spaces that keeps at least one such character.
 * @param {string} title
 * @returns {string}
 */
export function slugOf(title) {
  const words = title
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => /[a-z0-9]/.test(word))
    .slice(0, SLUG_WORDS)
  const slug = words
    .join('-')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug === '' ? 'task' : slug
}

/**
 * The branch of a task: `task/<N>-<slug>` (A9).
 * @param {number} number
 * @param {string} title
 * @returns {string}
 */
export function branchName(number, title) {
  return `task/${number}-${slugOf(title)}`
}

/**
 * What kind of branch a name is.
 * @param {string} name A branch name, with or without `refs/heads/`.
 * @returns {{ kind: 'task', issue: number } | { kind: 'spike' } | { kind: 'other' }}
 */
export function parseBranch(name) {
  const branch = name.replace(/^refs\/heads\//, '')
  const task = /^task\/(\d+)(?:-[^/]*)?$/.exec(branch)
  if (task) return { kind: 'task', issue: Number(task[1]) }
  if (branch.startsWith('spike/')) return { kind: 'spike' }
  return { kind: 'other' }
}

/**
 * The task link of a pull request from its branch and body alone (5.5).
 * @param {{ branch: string, body: string | null | undefined }} pull
 * @returns {{ ok: true, issue: number } | { ok: false, reason: TaskLinkReason }}
 */
export function parseTaskLink({ branch, body }) {
  const parsed = parseBranch(branch)
  if (parsed.kind === 'spike') return { ok: false, reason: 'spike-branch' }
  if (parsed.kind !== 'task') return { ok: false, reason: 'no-task-branch' }
  const text = (body ?? '').replace(/\r\n?/g, '\n')
  const closesLines = text
    .split('\n')
    .map((line) => CLOSES_LINE.exec(line))
    .filter((match) => match !== null)
  if (closesLines.length === 0) return { ok: false, reason: 'no-closes-line' }
  const references = text.match(CLOSING_REFERENCE) ?? []
  if (closesLines.length > 1 || references.length > 1) {
    return { ok: false, reason: 'several-closing-references' }
  }
  const issue = Number(closesLines[0][1])
  if (issue !== parsed.issue) return { ok: false, reason: 'branch-issue-mismatch' }
  return { ok: true, issue }
}

/**
 * The task link of a pull request, checked against GitHub: the named issue is open and has a
 * valid task block (E11, E16; Gate stage 2; CI step 2).
 * @param {GitHub} github
 * @param {OwnershipConfig} config
 * @param {Pick<PullRequest, 'headRef' | 'body'>} pull
 * @returns {Promise<TaskLink>}
 */
export async function checkTaskLink(github, config, pull) {
  const link = parseTaskLink({ branch: pull.headRef, body: pull.body })
  if (!link.ok) return link
  const issue = await github.getIssue(link.issue)
  if (issue === null || issue.state !== 'open') return { ok: false, reason: 'issue-not-open' }
  const parsed = issue.isPullRequest ? null : parseTaskBlock(issue.body, config)
  if (!parsed?.isTask || !parsed.valid) return { ok: false, reason: 'invalid-task-block' }
  return link
}

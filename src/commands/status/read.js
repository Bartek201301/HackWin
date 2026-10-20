// What `status` reads (7.6 steps 1 and 2): from GitHub the open and recently closed issues, the
// open pull requests with their labels, the status issue [D4] and the milestone of the current
// wave; from the clone the Gate's local heartbeat, which exists only on the Lead's laptop, and
// the member's previous call.
//
// "Recently closed" is every issue closed since the start of the event, or since now before the
// event. A dependency of an open task that is not among them is read by its number, so that
// whether a task can be taken follows the actual state of every dependency (8.3, I12).
//
// The milestone of the current wave is the milestone of the current wave's first task: the
// typed issues of src/core/github carry no milestone, so `status` reads that one issue as GitHub
// returns it.
//
// Without an open status issue, `status` looks for a closed one. A running Gate keeps editing the
// issue it found at its start, also after someone closed it; only its next start, which looks for
// an open one, creates a new issue. So a closed status issue still tells whether the Gate runs.
//
// A closed status issue counts only when GitHub's answer for that issue itself carries the label:
// GitHub's label filter can return an issue whose label was deleted, for minutes after the
// deletion (#115). The open lookup, findStatusIssue, is shared with the Gate and reads the filter
// alone.

import { nullWhenNotFound } from '../../core/github/index.js'
import { readLastStatus } from '../../core/state/index.js'
import { gateFiles, readHeartbeat } from '../gate/state.js'
import { STATUS_LABEL, findStatusIssue } from '../gate/status-issue.js'
import { currentWave, missingDependencies, openTasks } from './view.js'

/** @import { Config } from '../../core/config/index.js' */
/** @import { GitHub, Issue, PullRequest } from '../../core/github/index.js' */
/** @import { Heartbeat } from '../gate/state.js' */
/** @import { Milestone } from './view.js' */

/**
 * @typedef {object} GitHubRead
 * @property {Issue[]} openIssues
 * @property {Map<number, Issue>} issues
 * @property {PullRequest[]} pulls
 * @property {Issue | null} statusIssue
 * @property {Milestone | null} milestone
 */

/**
 * Read what `status` needs from GitHub. A failed call is a RemoteError (exit 3).
 * @param {GitHub} github
 * @param {{ config: Config, now: Date }} options
 * @returns {Promise<GitHubRead>}
 */
export async function readGitHub(github, { config, now }) {
  const start = Date.parse(config.hackwin.project.event.start)
  const since = new Date(Math.min(start, now.getTime())).toISOString()
  const [openIssues, closedIssues, pulls, openStatusIssue] = await Promise.all([
    github.listIssues({ state: 'open' }),
    github.listIssues({ state: 'closed', since }),
    github.listPullRequests({ state: 'open' }),
    findStatusIssue(github),
  ])
  const statusIssue = openStatusIssue ?? (await closedStatusIssue(github))
  /** @type {Map<number, Issue>} */
  const issues = new Map()
  for (const issue of [...closedIssues, ...openIssues]) issues.set(issue.number, issue)

  const tasks = openTasks(openIssues, config)
  const wave = currentWave(tasks)
  const [dependencies, milestone] = await Promise.all([
    Promise.all(missingDependencies(tasks, issues).map((number) => github.getIssue(number))),
    wave === null ? null : milestoneOf(github, wave.tasks[0].number),
  ])
  for (const issue of dependencies) if (issue !== null) issues.set(issue.number, issue)
  return { openIssues, issues, pulls, statusIssue, milestone }
}

/** How many listed closed issues `status` reads one by one, at most, for the label. */
const CLOSED_CANDIDATES = 3

/**
 * The closed issue with the label `gate-status` that was edited last, or null. The listing only
 * names the candidates: each is read by its number, last edited first, and the first whose own
 * answer carries the label counts, as GitHub returns it then.
 * @param {GitHub} github
 * @returns {Promise<Issue | null>}
 */
async function closedStatusIssue(github) {
  const closed = await github.listIssues({ state: 'closed', labels: [STATUS_LABEL] })
  const edited = (/** @type {Issue} */ issue) => Date.parse(issue.updatedAt) || 0
  const candidates = [...closed]
    .sort((a, b) => edited(b) - edited(a) || b.number - a.number)
    .slice(0, CLOSED_CANDIDATES)
  for (const candidate of candidates) {
    const issue = await github.getIssue(candidate.number)
    if (issue !== null && issue.labels.includes(STATUS_LABEL)) return issue
  }
  return null
}

/**
 * The milestone of an issue, or null when it has none.
 * @param {GitHub} github
 * @param {number} number
 * @returns {Promise<Milestone | null>}
 */
async function milestoneOf(github, number) {
  const raw = await nullWhenNotFound(() => github.api(`repos/{owner}/{repo}/issues/${number}`))
  const milestone = raw?.milestone
  if (milestone === null || typeof milestone !== 'object') return null
  return {
    number: milestone.number,
    title: String(milestone.title ?? ''),
    state: String(milestone.state ?? ''),
    open_issues: Number(milestone.open_issues ?? 0),
    closed_issues: Number(milestone.closed_issues ?? 0),
    due_on: typeof milestone.due_on === 'string' ? milestone.due_on : null,
    url: typeof milestone.html_url === 'string' ? milestone.html_url : null,
  }
}

/**
 * What `status` reads from the clone: the Gate's local heartbeat, which only the clone of the
 * Gate holds, on the Lead's laptop, and up to when the member saw the digest.
 * @param {string} gitCommonDir
 * @returns {Promise<{ localHeartbeat: Heartbeat | null, lastStatusAt: string | null }>}
 */
export async function readClone(gitCommonDir) {
  const [localHeartbeat, lastStatusAt] = await Promise.all([
    readLocalHeartbeat(gitCommonDir),
    readLastStatus(gitCommonDir),
  ])
  return { localHeartbeat, lastStatusAt }
}

/**
 * The Gate's heartbeat in this clone, or null. It reads one local file and needs neither the
 * network nor the configuration, so `status` can print it when GitHub is unreachable.
 * @param {string} gitCommonDir
 * @returns {Promise<Heartbeat | null>}
 */
export async function readLocalHeartbeat(gitCommonDir) {
  /** @type {Heartbeat | null} */
  let heartbeat
  try {
    heartbeat = await readHeartbeat(gateFiles(gitCommonDir).heartbeat)
  } catch {
    // An unreadable file counts as no heartbeat, as a missing local record does (contracts 4.7).
    return null
  }
  if (heartbeat === null || Number.isNaN(Date.parse(heartbeat.heartbeat_at))) return null
  return heartbeat
}

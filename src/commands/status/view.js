// The view of `status` (7.6): pure functions from what `status` read to the items of its
// sections. The same GitHub state gives the same attention items, "who does what", "waiting for
// merge" and "blocked" on every machine (AC44); only the header and the digest depend on the
// clone: the local heartbeat on the Lead's laptop and the member's previous call.
//
// Only an issue written by a member of the team in hackwin.yml counts as a task (the Lead's review
// of #73): on a public repository any account can open an issue with a task block, and `status`
// would list it among the next tasks of the members. Every string of the result is cleaned of
// control characters (text.js).

import { holderOf } from '../../core/config/index.js'
import { WAITING_LABELS, dependenciesOf, queueOf, toTask } from '../../core/tasks/index.js'
import { UNDER_WAY } from '../gate/pulls.js'
import { cleanStrings } from './text.js'

/** @import { Config, Identity } from '../../core/config/index.js' */
/** @import { Issue, PullRequest } from '../../core/github/index.js' */
/** @import { Task } from '../../core/tasks/index.js' */
/** @import { DigestEntry } from '../gate/digest.js' */
/** @import { Heartbeat } from '../gate/state.js' */
/** @import { GateStatus } from '../gate/status-issue.js' */

/** The digest results that leave a pull request waiting for its author or the Lead (9.6). */
const NEEDS_ACTION = Object.freeze(['failed', 'needs-owner', 'scope-violation', 'flaky'])

/** The task statuses of a task someone works on. */
const WORKING = Object.freeze(['in-progress', 'in-review'])

/**
 * The milestone of the current wave, as GitHub returns it on an issue.
 * @typedef {object} Milestone
 * @property {number} number
 * @property {string} title
 * @property {string} state
 * @property {number} open_issues
 * @property {number} closed_issues
 * @property {string | null} due_on
 * @property {string | null} url
 */

/**
 * What `status` read: from GitHub, and from the clone.
 * @typedef {object} StatusInput
 * @property {Config} config
 * @property {Identity} identity
 * @property {Date} now
 * @property {Issue[]} openIssues Every open issue, the status issue included.
 * @property {Map<number, Issue>} issues Every issue read, open or closed, by number: the
 *   dependencies of the open tasks are among them unless GitHub has no such issue.
 * @property {PullRequest[]} pulls The open pull requests.
 * @property {Issue | null} statusIssue
 * @property {Heartbeat | null} localHeartbeat The Gate's heartbeat in this clone: only on the
 *   Lead's laptop.
 * @property {string | null} lastStatusAt Up to when the member saw the digest: their previous
 *   call.
 * @property {Milestone | null} milestone
 */

/**
 * A task as the sections show it.
 * @typedef {object} TaskItem
 * @property {number} number
 * @property {string} title
 * @property {string} status
 * @property {string | null} deadline Null for a task whose block is invalid.
 * @property {boolean} overdue The deadline passed and the task is open (T11).
 * @property {string} url
 */

/**
 * @typedef {{ kind: 'gate', type: string, pr: number, since: string, todo: string }
 *   | { kind: 'needs-lead', number: number, title: string, url: string, pull: boolean }
 *   | { kind: 'your-pull', pr: number, title: string, labels: string[], reason: string | null, url: string }} AttentionEntry
 */

/**
 * @typedef {object} MemberEntry
 * @property {string} login
 * @property {string} name
 * @property {string[]} roles
 * @property {TaskItem[]} working The tasks in progress or in review, by number.
 * @property {TaskItem[]} next The member's queue (8.1) without the tasks whose dependencies are
 *   open: the next ready tasks.
 */

/**
 * @typedef {object} WaitingEntry
 * @property {number} pr
 * @property {string} title
 * @property {string | null} author
 * @property {string} stage `queued`, `testing`, `waiting-ci` or `merged` from the Gate label;
 *   `not-seen` without one; `draft` for a draft, which the Gate ignores (G7); `outsider` for a
 *   pull request whose author is not a member, which the Gate does not test (#64).
 * @property {number | null} position Its place in the Gate's queue, from 1, as the status issue
 *   shows it.
 * @property {string} url
 */

/**
 * @typedef {{ kind: 'dependencies', issue: number, title: string, waits_for: number[], url: string }
 *   | { kind: 'invalid', issue: number, title: string, errors: string[], url: string }
 *   | { kind: 'failed-pull', pr: number, title: string, author: string | null, labels: string[], reason: string, url: string }} BlockedEntry
 */

/**
 * @typedef {object} GateLiveness
 * @property {'not-started' | 'unreadable' | 'running' | 'stale' | 'stopped'} state
 * @property {'status-issue' | 'local' | null} source Where the heartbeat comes from: the newer
 *   of the status issue and, on the Lead's laptop, the local heartbeat.
 * @property {string | null} heartbeat_at
 * @property {number | null} age_seconds
 * @property {string | null} stopped_at
 * @property {number} stale_seconds `gate.heartbeat_stale_seconds`.
 * @property {string | null} status_issue_heartbeat_at
 * @property {boolean} status_issue_stale The status issue's heartbeat is stale while the local
 *   one is not: teammates see the Gate as stale.
 * @property {Heartbeat | null} local The local heartbeat, on the Lead's laptop.
 */

/**
 * Everything `status` shows, as `--json` prints it.
 * @typedef {object} StatusData
 * @property {string} login
 * @property {string} at
 * @property {GateLiveness} gate
 * @property {{ state: string | null, update_restricted: boolean }} protection As the Gate
 *   published it; null before its first start.
 * @property {{ end: string, seconds_left: number }} event
 * @property {{ number: number, url: string, state: 'open' | 'closed' } | null} status_issue The
 *   open status issue, or else the closed one that was edited last.
 * @property {{ number: number, open_tasks: number, milestone: Milestone | null } | null} wave
 * @property {AttentionEntry[]} attention
 * @property {MemberEntry[]} who
 * @property {WaitingEntry[]} waiting
 * @property {BlockedEntry[]} blocked
 * @property {{ since: string | null, lines: DigestEntry[], needs_action: DigestEntry[] }} digest
 */

/**
 * The open task issues that members of the team wrote, valid or not, by number.
 * @param {Issue[]} openIssues
 * @param {Config} config
 * @returns {Task[]}
 */
export function openTasks(openIssues, config) {
  return openIssues
    .filter((issue) => isMember(config, issue.author))
    .map((issue) => toTask(issue, config))
    .filter((task) => task !== null)
    .sort((a, b) => a.number - b.number)
}

/**
 * True when the login is a member of the team in hackwin.yml, compared without case.
 * @param {Config} config
 * @param {string | null} login
 * @returns {boolean}
 */
function isMember(config, login) {
  if (login === null) return false
  const wanted = login.toLowerCase()
  return config.hackwin.team.members.some((member) => member.github.toLowerCase() === wanted)
}

/**
 * The current wave: the lowest wave of the open tasks that are not cut, and its tasks by number.
 * Null when no such task names a wave.
 * @param {Task[]} tasks
 * @returns {{ number: number, tasks: Task[] } | null}
 */
export function currentWave(tasks) {
  const waved = tasks.filter(
    (task) => task.block !== null && task.block.wave !== null && task.status !== 'cut',
  )
  if (waved.length === 0) return null
  const number = Math.min(...waved.map((task) => /** @type {number} */ (task.block?.wave)))
  return { number, tasks: waved.filter((task) => task.block?.wave === number) }
}

/**
 * The dependencies of the open tasks that are missing from `issues`.
 * @param {Task[]} tasks
 * @param {Map<number, Issue>} issues
 * @returns {number[]}
 */
export function missingDependencies(tasks, issues) {
  const wanted = new Set(tasks.flatMap((task) => task.block?.depends_on ?? []))
  return [...wanted].filter((number) => !issues.has(number)).sort((a, b) => a - b)
}

/**
 * The Gate's liveness (7.6, header and failure behavior): the newer of the status issue's
 * heartbeat and the local one, which on the Lead's laptop is newer between two edits.
 * @param {{ statusIssue: Issue | null, gateStatus: GateStatus | null, local: Heartbeat | null, now: Date, staleSeconds: number }} input
 * @returns {GateLiveness}
 */
export function gateLiveness({ statusIssue, gateStatus, local, now, staleSeconds }) {
  const base = {
    stale_seconds: staleSeconds,
    status_issue_heartbeat_at: gateStatus?.heartbeat_at ?? null,
    status_issue_stale: false,
    local,
  }
  const ageOf = (/** @type {string} */ at) =>
    Math.max(0, Math.floor((now.getTime() - Date.parse(at)) / 1000))
  if (statusIssue === null || gateStatus === null) {
    const state = statusIssue === null ? 'not-started' : 'unreadable'
    return {
      ...base,
      state,
      source: local === null ? null : 'local',
      heartbeat_at: local?.heartbeat_at ?? null,
      age_seconds: local === null ? null : ageOf(local.heartbeat_at),
      stopped_at: local?.stopped_at ?? null,
    }
  }
  const useLocal =
    local !== null && Date.parse(local.heartbeat_at) > Date.parse(gateStatus.heartbeat_at)
  const chosen = useLocal ? /** @type {Heartbeat} */ (local) : gateStatus
  const age = ageOf(chosen.heartbeat_at)
  const stopped = chosen.stopped_at ?? null
  /** @type {GateLiveness['state']} */
  let state = 'running'
  if (stopped !== null) state = 'stopped'
  else if (age >= staleSeconds) state = 'stale'
  return {
    ...base,
    state,
    source: useLocal ? 'local' : 'status-issue',
    heartbeat_at: chosen.heartbeat_at,
    age_seconds: age,
    stopped_at: stopped,
    status_issue_stale:
      useLocal && stopped === null && ageOf(gateStatus.heartbeat_at) >= staleSeconds,
  }
}

/**
 * Build what `status` shows from what it read. Every string of the result is cleaned of control
 * characters, so the lines and `--json` show the same text.
 * @param {StatusInput & { gateStatus: GateStatus | null }} input
 * @returns {StatusData}
 */
export function buildStatus(input) {
  const { config, identity, now, openIssues, issues, statusIssue, gateStatus } = input
  const { hackwin } = config
  const defaultBranch = hackwin.project.default_branch
  const tasks = openTasks(openIssues, config)
  const pulls = input.pulls
    .filter((pull) => pull.state === 'open' && pull.baseRef === defaultBranch)
    .sort((a, b) => a.number - b.number)
  const digest = gateStatus?.digest ?? []
  const latest = new Map(digest.map((entry) => [entry.pr, entry]))
  const failed = pulls.filter((pull) => pull.labels.includes('gate:failed'))
  const wave = currentWave(tasks)

  return cleanStrings({
    login: identity.login,
    at: now.toISOString(),
    gate: gateLiveness({
      statusIssue,
      gateStatus,
      local: input.localHeartbeat,
      now,
      staleSeconds: hackwin.gate.heartbeat_stale_seconds,
    }),
    protection: {
      state: gateStatus?.protection ?? null,
      update_restricted: gateStatus?.update_restricted ?? false,
    },
    event: {
      end: hackwin.project.event.end,
      seconds_left: Math.floor((Date.parse(hackwin.project.event.end) - now.getTime()) / 1000),
    },
    status_issue:
      statusIssue === null
        ? null
        : { number: statusIssue.number, url: statusIssue.url, state: statusIssue.state },
    wave:
      wave === null
        ? null
        : { number: wave.number, open_tasks: wave.tasks.length, milestone: input.milestone },
    attention: attentionOf({ identity, gateStatus, openIssues, pulls, latest }),
    who: whoDoesWhat({ config, tasks, issues, now }),
    waiting: waitingFor(pulls, gateStatus?.queue ?? [], (login) => isMember(config, login)),
    blocked: blockedOf({ tasks, issues, failed, latest }),
    digest: digestOf(digest, input.lastStatusAt, new Set(failed.map((pull) => pull.number))),
  })
}

/**
 * The attention section: the open items of the status issue for everyone [D3][D4]; for the Lead
 * also everything labeled `needs-lead`; for any member their pull requests that wait for them.
 * @param {{ identity: Identity, gateStatus: GateStatus | null, openIssues: Issue[], pulls: PullRequest[], latest: Map<number, DigestEntry> }} input
 * @returns {AttentionEntry[]}
 */
function attentionOf({ identity, gateStatus, openIssues, pulls, latest }) {
  /** @type {AttentionEntry[]} */
  const entries = (gateStatus?.attention ?? []).map(({ type, pr, since, todo }) => ({
    kind: 'gate',
    type,
    pr,
    since,
    todo,
  }))
  if (identity.isLead) {
    const marked = [
      ...openIssues.map((issue) => ({ ...issue, pull: false })),
      ...pulls.map((pull) => ({ ...pull, pull: true })),
    ]
      .filter((item) => item.labels.includes('needs-lead'))
      .sort((a, b) => a.number - b.number)
    for (const item of marked) {
      entries.push({
        kind: 'needs-lead',
        number: item.number,
        title: item.title,
        url: item.url,
        pull: item.pull,
      })
    }
  }
  const login = identity.login.toLowerCase()
  for (const pull of pulls) {
    if (pull.author?.toLowerCase() !== login) continue
    const labels = WAITING_LABELS.filter((label) => pull.labels.includes(label))
    if (labels.length === 0) continue
    const entry = latest.get(pull.number)
    entries.push({
      kind: 'your-pull',
      pr: pull.number,
      title: pull.title,
      labels,
      reason: entry ? reasonOf(entry) : null,
      url: pull.url,
    })
  }
  return entries
}

/**
 * Who does what: per member of hackwin.yml, in its order, the tasks in progress or in review and
 * the next ready tasks: the member's queue without the tasks that wait for a dependency or for
 * the Lead (`needs-lead`), which `take` refuses (7.7, check 2). A task in progress belongs to its
 * assignees in the team, or else to the holder of its role.
 * @param {{ config: Config, tasks: Task[], issues: Map<number, Issue>, now: Date }} input
 * @returns {MemberEntry[]}
 */
function whoDoesWhat({ config, tasks, issues, now }) {
  const members = config.hackwin.team.members
  const loginOf = (/** @type {string} */ login) =>
    members.find((member) => member.github.toLowerCase() === login.toLowerCase())?.github
  /** @type {Map<string, Task[]>} */
  const working = new Map()
  for (const task of tasks) {
    if (!WORKING.includes(task.status)) continue
    let owners = task.assignees.map(loginOf).filter((login) => login !== undefined)
    if (owners.length === 0 && task.block !== null) {
      const holder = holderOf(config, task.block.role)
      owners = holder === null ? [] : [holder]
    }
    for (const login of new Set(owners)) working.set(login, [...(working.get(login) ?? []), task])
  }
  return members.map((member) => ({
    login: member.github,
    name: member.name,
    roles: [...member.roles],
    working: (working.get(member.github) ?? []).map((task) => taskItem(task, now, issues)),
    next: queueOf(tasks, member.roles)
      .filter((task) => !task.labels.includes('needs-lead'))
      .filter((task) => dependenciesOf(task, issues).takeable)
      .map((task) => taskItem(task, now, issues)),
  }))
}

/**
 * Waiting for merge: the Gate's queue in its order, as the status issue shows it, each pull
 * request with its Gate stage from its labels [D4]; then the other open pull requests into the
 * default branch that did not fail: those the Gate queued since its last edit, those it has not
 * seen, those of authors outside the team, which it does not test (#64), and the drafts it
 * ignores (G7).
 * @param {PullRequest[]} pulls Open, into the default branch, by number.
 * @param {number[]} queue
 * @param {(login: string | null) => boolean} member
 * @returns {WaitingEntry[]}
 */
function waitingFor(pulls, queue, member) {
  const waiting = pulls.filter((pull) => !pull.labels.includes('gate:failed'))
  const byNumber = new Map(waiting.map((pull) => [pull.number, pull]))
  const queued = queue.filter((pr) => byNumber.has(pr))
  /** @param {PullRequest} pull */
  const stage = (pull) => {
    if (pull.draft) return 'draft'
    if (!member(pull.author)) return 'outsider'
    return stageOf(pull)
  }
  const RANK = ['not-seen', 'outsider', 'draft']
  /** @param {PullRequest} pull */
  const rank = (pull) => RANK.indexOf(stage(pull)) + 1
  const others = waiting
    .filter((pull) => !queued.includes(pull.number))
    .sort((a, b) => rank(a) - rank(b) || a.number - b.number)
  /**
   * @param {PullRequest} pull
   * @param {number | null} position
   * @returns {WaitingEntry}
   */
  const entry = (pull, position) => ({
    pr: pull.number,
    title: pull.title,
    author: pull.author,
    stage: stage(pull),
    position,
    url: pull.url,
  })
  return [
    ...queued.map((pr, index) => entry(/** @type {PullRequest} */ (byNumber.get(pr)), index + 1)),
    ...others.map((pull) => entry(pull, null)),
  ]
}

/**
 * The Gate stage of a pull request from its labels (8.2): exactly one Gate label at a time.
 * @param {PullRequest} pull
 * @returns {string}
 */
function stageOf(pull) {
  const label = [...UNDER_WAY, 'gate:merged'].find((name) => pull.labels.includes(name))
  return label === undefined ? 'not-seen' : label.slice('gate:'.length)
}

/**
 * Blocked: the tasks that wait for a dependency, the task issues with an invalid block, and the
 * failed pull requests, each with the reason.
 * @param {{ tasks: Task[], issues: Map<number, Issue>, failed: PullRequest[], latest: Map<number, DigestEntry> }} input
 * @returns {BlockedEntry[]}
 */
function blockedOf({ tasks, issues, failed, latest }) {
  /** @type {BlockedEntry[]} */
  const entries = []
  for (const task of tasks) {
    if (task.status === 'cut') continue
    if (!task.valid) {
      const url = issues.get(task.number)?.url ?? ''
      entries.push({
        kind: 'invalid',
        issue: task.number,
        title: task.title,
        errors: task.errors,
        url,
      })
      continue
    }
    if (WORKING.includes(task.status)) continue
    const { open } = dependenciesOf(task, issues)
    if (open.length === 0) continue
    entries.push({
      kind: 'dependencies',
      issue: task.number,
      title: task.title,
      waits_for: open,
      url: issues.get(task.number)?.url ?? '',
    })
  }
  for (const pull of failed) {
    const entry = latest.get(pull.number)
    const labels = [
      'gate:failed',
      ...WAITING_LABELS.filter((label) => label !== 'gate:failed'),
    ].filter((label) => pull.labels.includes(label))
    entries.push({
      kind: 'failed-pull',
      pr: pull.number,
      title: pull.title,
      author: pull.author,
      labels,
      reason: entry ? reasonOf(entry) : labels.join(', '),
      url: pull.url,
    })
  }
  return entries
}

/**
 * The Gate digest: the lines since the member's previous call, newest first, and the earlier
 * lines of the pull requests that still wait for action: a failed result while the pull request
 * is open and labeled `gate:failed`.
 * @param {DigestEntry[]} digest Newest first, as the status issue holds it.
 * @param {string | null} since
 * @param {Set<number>} failed The open pull requests labeled `gate:failed`.
 */
function digestOf(digest, since, failed) {
  const after = since === null ? Number.NEGATIVE_INFINITY : Date.parse(since)
  const lines = digest.filter((entry) => Date.parse(entry.time) > after)
  const needs_action = digest.filter(
    (entry) =>
      !lines.includes(entry) && NEEDS_ACTION.includes(entry.result) && failed.has(entry.pr),
  )
  return { since, lines, needs_action }
}

/**
 * Why a run ended, from its digest line.
 * @param {DigestEntry} entry
 * @returns {string}
 */
function reasonOf(entry) {
  const note = entry.note === '' ? '' : `: ${entry.note}`
  return `${entry.result} at stage ${entry.stage}${note}`
}

/**
 * @param {Task} task
 * @param {Date} now
 * @param {Map<number, Issue>} issues
 * @returns {TaskItem}
 */
function taskItem(task, now, issues) {
  const deadline = task.block?.deadline ?? null
  return {
    number: task.number,
    title: task.title,
    status: task.status,
    deadline,
    overdue: deadline !== null && Date.parse(deadline) < now.getTime(),
    url: issues.get(task.number)?.url ?? '',
  }
}

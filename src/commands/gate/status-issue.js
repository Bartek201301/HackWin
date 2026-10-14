// The status issue (G25, 9.6, A55) [D4]: one pinned issue whose body holds the Gate's heartbeat,
// the open attention items and the digest, so that every member sees them on their own machine
// and nothing enters a conversation. The Gate creates it at its first start with the label
// `gate-status` and pins it (`gh issue pin`, docs/verification.md row 8); later it finds it by
// the label. It only edits the body and never comments, as G25 asks. Whether a body edit notifies
// the watchers of the repository is unknown: GitHub does not document it, and it was not observed
// (docs/verification.md row 9).
//
// The digest sits in a fenced code block, so that GitHub links no `#<PR>` in it, which would add
// a reference to the timeline of every pull request in the digest.
//
// `status` (1.6f) finds the issue with findStatusIssue and reads its body with parseStatusBody.

import { parse } from 'yaml'
import { PROTECTION_STATES } from '../../core/protection/index.js'
import { RemoteError } from '../../core/runtime/index.js'
import { formatDigestLine, parseDigestLine, readDigest } from './digest.js'

/** @import { GitHub, Issue } from '../../core/github/index.js' */
/** @import { DigestEntry } from './digest.js' */
/** @import { Gate } from './gate.js' */
/** @import { Heartbeat } from './state.js' */

export const STATUS_TITLE = 'HackWin Gate status'
export const STATUS_LABEL = 'gate-status'
export const STATUS_MARKER = '# hackwin:gate-status'

/**
 * The longest body the CLI writes, in UTF-16 code units, the length of a JavaScript string
 * (docs/verification.md row 10, the Lead's decision).
 */
export const MAX_BODY_LENGTH = 65_536

const DIGEST_HEADING = '## Digest'
const NO_DIGEST = 'No pull request has finished a run yet.'

/** How often one edit is sent at most, the first try and the tries after a refused body. */
const BODY_ATTEMPTS = 4

/**
 * An open attention item, as the status issue shows it.
 * @typedef {object} StatusAttention
 * @property {string} type `migration`, `production-config`, `scope-violation`,
 *   `repeated-failure` or `secret`.
 * @property {number} pr
 * @property {string} since ISO 8601.
 * @property {string} todo What the Lead must do.
 */

/**
 * The content of the status issue: the `# hackwin:gate-status` block (schema 1) and the digest.
 * @typedef {object} GateStatus
 * @property {string} heartbeat_at ISO 8601: the Gate was alive at this time.
 * @property {string | null} stopped_at Set by `quit`; a start clears it.
 * @property {number} starts How often a Gate started in the Gate's clone.
 * @property {string | null} gate_id The random id of the Gate's clone (`gate/gate-id`).
 * @property {'full-restricted' | 'full' | 'soft' | null} protection From the Gate's latest
 *   protection read.
 * @property {boolean} update_restricted `rules.updateRestricted` of that read.
 * @property {number[]} queue The head of the queue first.
 * @property {StatusAttention[]} attention The open items.
 * @property {DigestEntry[]} digest The latest line of each pull request, newest first.
 */

/**
 * The status issue: the open issue with the label `gate-status`, the oldest when there are
 * several. Null before the Gate's first start.
 * @param {GitHub} github
 * @returns {Promise<Issue | null>}
 */
export async function findStatusIssue(github) {
  const issues = await github.listIssues({ state: 'open', labels: [STATUS_LABEL] })
  return [...issues].sort((a, b) => a.number - b.number)[0] ?? null
}

/**
 * The body of the status issue, at most `maxLength` characters long. A body that would be longer
 * leaves out the oldest digest lines of merged pull requests first, then the oldest of the others
 * (9.6); `dropped` lists them.
 * @param {GateStatus} status
 * @param {{ maxLength?: number }} [options]
 * @returns {{ body: string, dropped: DigestEntry[] }}
 */
export function formatStatusBody(status, { maxLength = MAX_BODY_LENGTH } = {}) {
  const block = blockText(status)
  const lines = status.digest.map(formatDigestLine)
  const kept = lines.map(() => true)
  // Each line takes its length and one line break.
  let length = bodyText(block, lines).length
  /** @type {DigestEntry[]} */
  const dropped = []
  for (const index of dropOrder(status.digest)) {
    if (length <= maxLength) break
    kept[index] = false
    length -= lines[index].length + 1
    dropped.push(status.digest[index])
  }
  const keptLines = lines.filter((_, index) => kept[index])
  return { body: bodyText(block, keptLines), dropped }
}

/**
 * The content of a status issue body, or null when it holds no readable `# hackwin:gate-status`
 * block of schema 1 with a heartbeat time. Fields that are missing or of the wrong kind read as
 * empty: no stop time, no Gate id, an unknown protection state, an empty queue.
 * @param {string | null | undefined} body
 * @returns {GateStatus | null}
 */
export function parseStatusBody(body) {
  const lines = (body ?? '').replace(/\r\n?/g, '\n').split('\n')
  const found = findBlock(lines)
  if (found === null) return null
  /** @type {any} */
  let data
  try {
    data = parse(found.text)
  } catch {
    return null
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  if (data.schema !== 1) return null
  if (typeof data.heartbeat_at !== 'string' || Number.isNaN(Date.parse(data.heartbeat_at))) {
    return null
  }
  const heading = lines.findIndex(
    (line, index) => index > found.end && line.trim() === DIGEST_HEADING,
  )
  /** @type {DigestEntry[]} */
  const digest = []
  for (const line of heading === -1 ? [] : lines.slice(heading + 1)) {
    const entry = parseDigestLine(line)
    if (entry !== null) digest.push(entry)
  }
  return {
    heartbeat_at: data.heartbeat_at,
    stopped_at: typeof data.stopped_at === 'string' ? data.stopped_at : null,
    starts: Number.isInteger(data.starts) && data.starts >= 0 ? data.starts : 0,
    gate_id: typeof data.gate_id === 'string' ? data.gate_id : null,
    protection: PROTECTION_STATES.includes(data.protection) ? data.protection : null,
    update_restricted: data.update_restricted === true,
    queue: Array.isArray(data.queue) ? data.queue.filter(isPullNumber) : [],
    attention: Array.isArray(data.attention)
      ? data.attention.filter(isAttention).map(({ type, pr, since, todo }) => ({
          type,
          pr,
          since,
          todo,
        }))
      : [],
    digest,
  }
}

/**
 * Write the status into the status issue over REST: edit the body of `issue`, or, without one,
 * create the issue with its title and label and pin it. Only the body changes, never through a
 * comment.
 *
 * GitHub documents no limit for the body, and no refusal was seen over REST up to 1,048,576
 * characters (docs/verification.md row 10). Its reference lists HTTP 422, "Validation failed, or
 * the endpoint has been spammed", for both calls. So a 422 counts as a refused body, whatever
 * its text: `limits.maxLength` drops to three quarters of the refused length at once, and the
 * write is sent again with fewer digest lines, at most BODY_ATTEMPTS times in all. The caller
 * keeps `limits` for its next writes, so no later write tries a size that was refused, also
 * when every try of this one was.
 * @param {GitHub} github
 * @param {{ issue: Issue | null, status: GateStatus, limits: { maxLength: number } }} write
 * @returns {Promise<{ issue: Issue, created: boolean, pinError: string | null, dropped: DigestEntry[] }>}
 */
export async function writeStatusIssue(github, { issue, status, limits }) {
  for (let attempt = 1; ; attempt += 1) {
    const { body, dropped } = formatStatusBody(status, { maxLength: limits.maxLength })
    try {
      if (issue !== null) {
        const edited = await github.updateIssue(issue.number, { body })
        return { issue: edited, created: false, pinError: null, dropped }
      }
      const created = await github.createIssue({
        title: STATUS_TITLE,
        body,
        labels: [STATUS_LABEL],
      })
      const pinError = await pin(github, created.number)
      return { issue: created, created: true, pinError, dropped }
    } catch (error) {
      if (!isBodyRefused(error)) throw error
      limits.maxLength = Math.min(limits.maxLength, Math.floor((body.length * 3) / 4))
      // A body that has no digest line left to leave out is not sent again.
      const shorter = formatStatusBody(status, { maxLength: limits.maxLength }).body
      if (attempt >= BODY_ATTEMPTS || shorter.length >= body.length) throw error
    }
  }
}

/**
 * True when GitHub refused a write of the body with HTTP 422, which its reference lists for
 * "Create an issue" and "Update an issue".
 * @param {unknown} error
 */
export function isBodyRefused(error) {
  return error instanceof RemoteError && error.status === 422
}

/**
 * Another Gate's heartbeat in the status issue: less than `staleSeconds` old, without a stop
 * time, and written by another clone's Gate. A Gate id in the block decides that: the heartbeat
 * is this clone's own when the id is this clone's, so a missing local heartbeat or a clock that
 * differs between machines does not matter. Without an id in the block, or when this clone's id
 * was just made (its file was missing or unreadable), the heartbeat is this clone's own when it
 * is not newer than the last one in this clone's `gate/heartbeat`, which the Gate writes before
 * each edit with the time it publishes. So a restart after a crash goes on (#24, AC22).
 * @param {GateStatus | null} status The status issue's content.
 * @param {{ gateId: string, newId: boolean, local: Heartbeat | null, now: Date, staleSeconds: number }} context
 * @returns {{ heartbeat_at: string, age_seconds: number, gate_id: string | null } | null}
 */
export function otherGateHeartbeat(status, { gateId, newId, local, now, staleSeconds }) {
  if (status === null || status.stopped_at !== null) return null
  const at = Date.parse(status.heartbeat_at)
  const age = now.getTime() - at
  if (age >= staleSeconds * 1000) return null
  if (status.gate_id !== null && !newId) {
    if (status.gate_id === gateId) return null
  } else if (local !== null && Date.parse(local.heartbeat_at) >= at) {
    return null
  }
  return {
    heartbeat_at: status.heartbeat_at,
    age_seconds: Math.max(0, Math.floor(age / 1000)),
    gate_id: status.gate_id,
  }
}

/**
 * The Gate's writer of the status issue (G25): an edit at the start, which clears the stop time,
 * then one per `gate.status_issue_seconds`, and one at `quit`, which sets the stop time. Each
 * edit carries the time of its own heartbeat, which it first writes into the local heartbeat,
 * and everything that changed since the last one. A failed edit waits for the next interval;
 * without an issue it then looks for one by its label again before it creates one, in case
 * GitHub created the issue but the answer was lost. A refused body lowers the size of every
 * later edit of this run (writeStatusIssue). An edit records itself in `state.status_issue`,
 * which the next write of the state file keeps.
 * @param {Gate} gate
 * @param {Issue | null} issue The status issue found at the start, or null before the first.
 */
export function createStatusPublisher(gate, issue) {
  const { ctx, files, state } = gate
  const seconds = gate.config.hackwin.gate.status_issue_seconds
  let current = issue
  // False after a failure: GitHub may hold a status issue that `current` does not know.
  let known = true
  const limits = { maxLength: MAX_BODY_LENGTH }
  let droppedBefore = 0
  if (current !== null) state.status_issue.number = current.number

  const publisher = {
    /** The time, in milliseconds, from which the next edit is due. */
    nextAt: Number.NEGATIVE_INFINITY,
    /** The status issue, or null while it was not found or created. */
    get issue() {
      return current
    },
    /**
     * Write the status issue now. Never throws: a failure is a line in the terminal.
     * @param {{ stoppedAt?: string | null }} [options] The stop time, for the edit at `quit`.
     * @returns {Promise<boolean>} True when GitHub took the edit.
     */
    async publish({ stoppedAt = null } = {}) {
      const at = stoppedAt ?? ctx.clock.now().toISOString()
      publisher.nextAt = Date.parse(at) + seconds * 1000
      const limitBefore = limits.maxLength
      try {
        await gate.beat(stoppedAt, at)
        if (current === null && !known) current = await findStatusIssue(ctx.github)
        const digest = await readDigest(files.digest)
        const written = await writeStatusIssue(ctx.github, {
          issue: current,
          status: { ...gateStatus(gate, at, stoppedAt), digest },
          limits,
        }).finally(() => reportLimit(limitBefore))
        current = written.issue
        known = true
        state.status_issue = { number: current.number, last_edit_at: at }
        if (written.pinError !== null) {
          ctx.out.warn(
            `the status issue #${current.number} is not pinned: ${written.pinError}; it is found by its label ${STATUS_LABEL}: ${current.url}`,
          )
        }
        if (written.dropped.length !== droppedBefore) {
          droppedBefore = written.dropped.length
          gate.line(
            `status issue: the ${droppedBefore} oldest digest lines are left out to stay within ${limits.maxLength} characters; digest.log keeps every run`,
          )
        }
        return true
      } catch (error) {
        known = false
        if (error instanceof RemoteError && (error.status === 404 || error.status === 410)) {
          current = null
        }
        const message = error instanceof Error ? error.message : String(error)
        gate.line(
          stoppedAt === null
            ? `status issue: not written, the Gate tries again in ${seconds} s: ${message}`
            : `status issue: the stop time was not written: ${message}`,
        )
        return false
      }
    },
  }

  /** @param {number} before */
  const reportLimit = (before) => {
    if (limits.maxLength >= before) return
    gate.line(
      `status issue: GitHub refused a body with HTTP 422, so the Gate writes at most ${limits.maxLength} characters from now on`,
    )
  }
  return publisher
}

/** @typedef {ReturnType<typeof createStatusPublisher>} StatusPublisher */

/**
 * What the Gate publishes now, without the digest.
 * @param {Gate} gate
 * @param {string} at
 * @param {string | null} stoppedAt
 * @returns {Omit<GateStatus, 'digest'>}
 */
function gateStatus(gate, at, stoppedAt) {
  const { state, protection } = gate
  return {
    heartbeat_at: at,
    stopped_at: stoppedAt,
    starts: state.starts,
    gate_id: gate.id,
    protection: protection.state,
    update_restricted: protection.rules.updateRestricted,
    queue: [...state.queue],
    attention: state.attention
      .filter((item) => !item.resolved_at)
      .map(({ type, pr, since, todo }) => ({ type, pr: Number(pr), since, todo })),
  }
}

/**
 * The fenced `# hackwin:gate-status` block. Every string is a double-quoted scalar on one line,
 * so no text closes the fence; known words stay plain.
 * @param {GateStatus} status
 * @returns {string}
 */
function blockText(status) {
  const lines = [
    '```yaml',
    STATUS_MARKER,
    'schema: 1',
    `heartbeat_at: ${quoted(status.heartbeat_at)}`,
    `stopped_at: ${quoted(status.stopped_at)}`,
    `starts: ${status.starts}`,
    `gate_id: ${quoted(status.gate_id)}`,
    `protection: ${word(status.protection)}`,
    `update_restricted: ${status.update_restricted === true}`,
    `queue: [${status.queue.join(', ')}]`,
  ]
  if (status.attention.length === 0) lines.push('attention: []')
  else lines.push('attention:')
  for (const item of status.attention) {
    lines.push(
      `  - type: ${word(item.type)}`,
      `    pr: ${item.pr}`,
      `    since: ${quoted(item.since)}`,
      `    todo: ${quoted(item.todo)}`,
    )
  }
  lines.push('```')
  return lines.join('\n')
}

/**
 * @param {string} block
 * @param {string[]} lines The digest lines, newest first.
 */
function bodyText(block, lines) {
  const digest = lines.length === 0 ? [NO_DIGEST] : ['```text', ...lines, '```']
  return [block, '', DIGEST_HEADING, '', ...digest, ''].join('\n')
}

/**
 * The digest indices in the order they are left out: merged pull requests first, oldest first,
 * then the others, oldest first.
 * @param {DigestEntry[]} digest Newest first.
 * @returns {number[]}
 */
function dropOrder(digest) {
  const oldestFirst = digest
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => Date.parse(a.entry.time) - Date.parse(b.entry.time) || b.index - a.index)
  return [
    ...oldestFirst.filter(({ entry }) => entry.result === 'merged'),
    ...oldestFirst.filter(({ entry }) => entry.result !== 'merged'),
  ].map(({ index }) => index)
}

/**
 * The first fenced code block whose first line is the marker, with the index of its closing
 * fence, or null.
 * @param {string[]} lines
 * @returns {{ text: string, end: number } | null}
 */
function findBlock(lines) {
  for (let i = 0; i < lines.length; i += 1) {
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i])
    if (!open || (open[1][0] === '`' && open[2].includes('`'))) continue
    const fence = open[1]
    let end = i + 1
    while (end < lines.length) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[end])
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) break
      end += 1
    }
    const content = lines.slice(i + 1, end)
    const first = content.find((line) => line.trim() !== '')?.trim()
    if (end < lines.length && first === STATUS_MARKER) return { text: content.join('\n'), end }
    i = end
  }
  return null
}

/**
 * Pin the issue (docs/verification.md row 8). GitHub documents at most three pinned issues per
 * repository; a refused pin leaves the issue to be found by its label alone.
 * @param {GitHub} github
 * @param {number} number
 * @returns {Promise<string | null>} Null when pinned, else the reason.
 */
async function pin(github, number) {
  try {
    await github.run(['issue', 'pin', String(number)])
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** @param {string | null} value */
function quoted(value) {
  return value === null ? 'null' : JSON.stringify(value)
}

/**
 * A known word plain, anything else quoted.
 * @param {string | null} value
 */
function word(value) {
  return value !== null && /^[a-z]+(-[a-z]+)*$/.test(value) && !/^(true|false|null)$/.test(value)
    ? value
    : quoted(value)
}

/** @param {unknown} value */
function isPullNumber(value) {
  return Number.isInteger(value) && Number(value) > 0
}

/** @param {any} item */
function isAttention(item) {
  return (
    item !== null &&
    typeof item === 'object' &&
    typeof item.type === 'string' &&
    isPullNumber(item.pr) &&
    typeof item.since === 'string' &&
    typeof item.todo === 'string'
  )
}

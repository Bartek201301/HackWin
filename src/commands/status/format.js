// The short output of `status` (7.6, CM6): the header, then attention, who does what, waiting
// for merge, blocked and the Gate digest, in this order. `--json` carries the same items in full.
//
// The first line is the Gate's liveness: a warning when its heartbeat is stale without a stop
// time, the stop notice after `quit`, or that the Gate has not been started (7.6, failure
// behavior).

import { formatDigestLine, hoursAndMinutes } from '../gate/digest.js'
import { duration } from '../gate/pulls.js'

/** @import { DigestEntry } from '../gate/digest.js' */
/** @import { Heartbeat } from '../gate/state.js' */
/** @import { AttentionEntry, BlockedEntry, GateLiveness, MemberEntry, StatusData, TaskItem, WaitingEntry } from './view.js' */

/** How many next tasks a member's line names; `--json` has all. */
const NEXT_SHOWN = 3

/** How many digest lines since the previous call are printed; `--json` has all. */
const DIGEST_SHOWN = 10

/** The longest title a line shows. */
const TITLE_LENGTH = 60

const INDENT = '  '

/** How the waiting section names each Gate stage. */
const STAGE_WORDS = Object.freeze({
  queued: 'queued',
  testing: 'testing',
  'waiting-ci': 'waiting for CI',
  merged: 'merged',
  'not-seen': 'not seen by the Gate yet',
  draft: 'draft, ignored by the Gate',
})

/**
 * The lines of `status`.
 * @param {StatusData} data
 * @returns {string[]}
 */
export function statusLines(data) {
  const now = new Date(data.at)
  return [
    ...headerLines(data, now),
    ...section('attention', data.attention.map(attentionLine)),
    ...section(
      'who does what',
      data.who.flatMap((member) => memberLines(member, now)),
    ),
    ...section('waiting for merge', data.waiting.map(waitingLine)),
    ...section('blocked', data.blocked.map(blockedLine)),
    ...digestLines(data.digest),
  ]
}

/**
 * The line of a local heartbeat on the Lead's laptop, also when GitHub is unreachable: it needs
 * no configuration, so it judges no staleness.
 * @param {Heartbeat} heartbeat
 * @param {Date} now
 * @returns {string}
 */
export function localHeartbeatLine(heartbeat, now) {
  const parts = [
    `the Gate's local heartbeat on this laptop: ${heartbeat.heartbeat_at}, ${ago(heartbeat.heartbeat_at, now)}`,
  ]
  if (heartbeat.stopped_at) {
    parts.push(`stopped by the Lead at ${heartbeat.stopped_at}, ${ago(heartbeat.stopped_at, now)}`)
  }
  if (heartbeat.last_github_ok_at) {
    parts.push(
      `GitHub last answered the Gate at ${heartbeat.last_github_ok_at}, ${ago(heartbeat.last_github_ok_at, now)}`,
    )
  }
  return parts.join('; ')
}

/**
 * @param {StatusData} data
 * @param {Date} now
 * @returns {string[]}
 */
function headerLines(data, now) {
  const { gate, protection, event, status_issue: issue, wave } = data
  const lines = [livenessLine(gate, now)]
  const published = gate.status_issue_heartbeat_at
  if (gate.source === 'local' && published !== null) {
    // On the Lead's laptop the local heartbeat is newer than the status issue between two edits.
    lines.push(`the status issue shows the heartbeat of ${published}, ${ago(published, now)}`)
  }
  if (gate.status_issue_stale && published !== null) {
    lines.push(
      `warning: the status issue's heartbeat is ${duration(now.getTime() - Date.parse(published))} old, so teammates see the Gate as stale; GitHub last answered the Gate at ${gate.local?.last_github_ok_at ?? 'no time yet'}`,
    )
  }
  if (gate.local !== null && (gate.state === 'not-started' || gate.state === 'unreadable')) {
    lines.push(localHeartbeatLine(gate.local, now))
  }
  lines.push(protectionLine(protection))
  lines.push(
    event.seconds_left > 0
      ? `event: ends in ${duration(event.seconds_left * 1000)}, at ${event.end}`
      : `event: ended ${duration(-event.seconds_left * 1000)} ago, at ${event.end}`,
  )
  if (issue !== null) lines.push(`status issue: #${issue.number} ${issue.url}`)
  if (wave !== null) {
    const tasks = `${wave.open_tasks} open ${wave.open_tasks === 1 ? 'task' : 'tasks'}`
    const milestone = wave.milestone
    const of =
      milestone === null
        ? ''
        : `; milestone ${milestone.title}: ${milestone.closed_issues} of ${milestone.open_issues + milestone.closed_issues} issues closed`
    lines.push(`wave ${wave.number}: ${tasks}${of}`)
  }
  return lines
}

/**
 * The first line: the Gate's liveness.
 * @param {GateLiveness} gate
 * @param {Date} now
 * @returns {string}
 */
function livenessLine(gate, now) {
  const where = gate.source === 'local' ? ' on this laptop' : ''
  switch (gate.state) {
    case 'not-started':
      return 'the Gate has not been started: no status issue exists yet; merges wait until the Lead runs `hackwin gate`'
    case 'unreadable':
      return 'warning: the status issue holds no readable `# hackwin:gate-status` block, so the state of the Gate is unknown; the Gate writes the block again at its next edit'
    case 'stopped':
      return `the Lead stopped the Gate at ${gate.stopped_at}, ${ago(/** @type {string} */ (gate.stopped_at), now)}; merges wait until the Lead starts it again`
    case 'stale':
      return `warning: the Gate's heartbeat${where} is ${duration((gate.age_seconds ?? 0) * 1000)} old (${gate.heartbeat_at}), older than ${gate.stale_seconds}s, and the Lead has not stopped it: the Gate may be down, and merges wait while it is; ask the Lead to look at the Gate terminal`
    default:
      return `gate: running, heartbeat ${duration((gate.age_seconds ?? 0) * 1000)} ago${where}`
  }
}

/**
 * @param {StatusData['protection']} protection
 * @returns {string}
 */
function protectionLine({ state, update_restricted }) {
  if (state === null) return "protection: unknown until the Gate's first start"
  const blocked = update_restricted
    ? "; the update restriction is active, so GitHub shows every pull request as BLOCKED, the Lead's included: that is expected, the Gate merges with --admin after its own stages pass"
    : ''
  return `protection: ${state}${blocked}`
}

/**
 * A section: its heading with `none`, or the heading and one indented line per item.
 * @param {string} heading
 * @param {string[]} items
 * @returns {string[]}
 */
function section(heading, items) {
  if (items.length === 0) return [`${heading}: none`]
  return [`${heading}:`, ...items.map((item) => `${INDENT}${item}`)]
}

/**
 * @param {AttentionEntry} entry
 * @returns {string}
 */
function attentionLine(entry) {
  switch (entry.kind) {
    case 'gate':
      return `ATTENTION ${entry.type} #${entry.pr}: ${entry.todo}`
    case 'needs-lead':
      return `needs-lead: ${entry.pull ? 'pull request' : 'issue'} #${entry.number}: ${title(entry.title)}`
    default:
      return `your pull request #${entry.pr} (${entry.labels.join(', ')})${entry.reason ? `: ${entry.reason}` : ''}`
  }
}

/**
 * @param {MemberEntry} member
 * @param {Date} now
 * @returns {string[]}
 */
function memberLines(member, now) {
  const who = `${member.login}:`
  const lines =
    member.working.length === 0
      ? [`${who} nothing in progress`]
      : member.working.map(
          (task) =>
            `${who} #${task.number} ${task.status.replace('-', ' ')}, ${dueText(task, now)}: ${title(task.title)}`,
        )
  if (member.next.length === 0) {
    lines.push(`${who} no ready task`)
  } else {
    const shown = member.next.slice(0, NEXT_SHOWN).map((task) => {
      const due = task.overdue ? ` (${dueText(task, now)})` : ''
      return `#${task.number}${due} ${title(task.title)}`
    })
    const more = member.next.length - shown.length
    lines.push(`${who} next ${shown.join('; ')}${more > 0 ? `; and ${more} more` : ''}`)
  }
  return lines
}

/**
 * The deadline of a task: `OVERDUE by 1h02m` (T11), `due in 3h00m`, or none for an invalid block.
 * @param {TaskItem} task
 * @param {Date} now
 * @returns {string}
 */
function dueText(task, now) {
  if (task.deadline === null) return 'no valid deadline'
  const left = Date.parse(task.deadline) - now.getTime()
  return task.overdue ? `OVERDUE by ${duration(-left)}` : `due in ${duration(left)}`
}

/**
 * @param {WaitingEntry} entry
 * @returns {string}
 */
function waitingLine(entry) {
  const place = entry.position === null ? '' : `${entry.position}. `
  const stage = STAGE_WORDS[/** @type {keyof typeof STAGE_WORDS} */ (entry.stage)] ?? entry.stage
  return `${place}#${entry.pr} ${stage}: ${title(entry.title)}${by(entry.author)}`
}

/**
 * @param {BlockedEntry} entry
 * @returns {string}
 */
function blockedLine(entry) {
  switch (entry.kind) {
    case 'dependencies':
      return `#${entry.issue} waits for ${entry.waits_for.map((n) => `#${n}`).join(', ')}: ${title(entry.title)}`
    case 'invalid':
      return `#${entry.issue} has an invalid task block: ${entry.errors.join('; ')}: ${title(entry.title)}`
    default:
      return `pull request #${entry.pr}${by(entry.author)} failed: ${entry.reason}: ${title(entry.title)}`
  }
}

/**
 * The Gate digest: the lines since the member's previous call, at most DIGEST_SHOWN, then the
 * earlier lines of pull requests that still need action.
 * @param {StatusData['digest']} digest
 * @returns {string[]}
 */
function digestLines({ since, lines, needs_action }) {
  const heading = since === null ? 'gate digest' : `gate digest since your last status (${since})`
  if (lines.length === 0 && needs_action.length === 0) {
    return [since === null ? `${heading}: no run has finished yet` : `${heading}: nothing new`]
  }
  const shown = lines.slice(0, DIGEST_SHOWN).map(digestLine)
  if (lines.length > shown.length) {
    shown.push(`and ${lines.length - shown.length} earlier lines in the status issue`)
  }
  return [
    `${heading}:`,
    ...[...shown, ...needs_action.map((entry) => `still needs action: ${digestLine(entry)}`)].map(
      (line) => `${INDENT}${line}`,
    ),
  ]
}

/**
 * A digest line as the Gate terminal prints it: the time as hours and minutes (9.6).
 * @param {DigestEntry} entry
 * @returns {string}
 */
function digestLine(entry) {
  const rest = formatDigestLine(entry).split(' ').slice(1).join(' ')
  return `${hoursAndMinutes(new Date(entry.time))} ${rest}`
}

/**
 * @param {string} at ISO 8601.
 * @param {Date} now
 * @returns {string}
 */
function ago(at, now) {
  return `${duration(now.getTime() - Date.parse(at))} ago`
}

/** @param {string | null} author */
function by(author) {
  return author ? ` (${author})` : ''
}

/** @param {string} text */
function title(text) {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 3)}...` : line
}

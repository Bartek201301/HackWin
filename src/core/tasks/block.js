// The task block of an issue body (8.1, A7): a fenced YAML block whose first line is
// `# hackwin:task`. An issue without it is not a task. Three rules make a block invalid: a path
// that does not lie in exactly one role or on the `open` list, empty acceptance tests outside the
// kind `foundation`, and a missing deadline. Any account can write a block, and `take` prints its
// errors, so no error carries a control character, a line break or a bidirectional format
// character of the body. A deadline is an ISO 8601 time with an offset, or a date and time
// `YYYY-MM-DD HH:MM` in the event's time zone, which the block gives in the ISO form (#149).

import { parseDocument } from 'yaml'
import { isIsoTimeWithOffset } from '../config/fields.js'
import { globError } from '../config/glob.js'
import { rolesOfGlob } from '../config/ownership.js'

/** @import { OwnershipConfig } from '../config/ownership.js' */

/** The marker line that makes an issue a task issue. */
export const TASK_MARKER = '# hackwin:task'

/** An issue comment that starts with this is a scope change of the task (8.1). */
export const SCOPE_CHANGE = 'Scope change:'

/** The kinds of a task block (8.1). */
export const TASK_KINDS = Object.freeze([
  'task',
  'proposal',
  'integration',
  'contract-change',
  'foundation',
])

/**
 * A control character (C0, DEL and C1), the line or paragraph separator of Unicode, or a
 * bidirectional format character, which reorders what a line shows: the characters that `status`
 * escapes too (cleanText in src/commands/status/text.js).
 */
const UNSAFE =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/
const UNSAFE_ALL = new RegExp(UNSAFE.source, 'g')

const BLOCK_KEYS = Object.freeze([
  'kind',
  'role',
  'wave',
  'paths',
  'depends_on',
  'acceptance_tests',
  'deadline',
])

/**
 * A valid task block. Keys keep the names of 8.1.
 * @typedef {object} TaskBlock
 * @property {'task' | 'proposal' | 'integration' | 'contract-change'} kind
 * @property {string} role
 * @property {number | null} wave Null for a task without a wave.
 * @property {string[]} paths The allowed paths, globs.
 * @property {number[]} depends_on Issue numbers.
 * @property {string[]} acceptance_tests
 * @property {string} deadline ISO 8601 with an offset, also when the issue gives the short form.
 */

/**
 * @typedef {{ isTask: false } | { isTask: true, valid: true, block: TaskBlock } | { isTask: true, valid: false, errors: string[] }} ParsedTaskBlock
 */

/**
 * Find and check the task block of an issue body.
 * @param {string | null | undefined} body
 * @param {OwnershipConfig} config hackwin.yml and owners.yml, for the path rule.
 * @returns {ParsedTaskBlock}
 */
export function parseTaskBlock(body, config) {
  const found = findBlock(body ?? '')
  if (found.kind === 'none') return { isTask: false }
  if (found.kind === 'error') return { isTask: true, valid: false, errors: [found.reason] }

  const document = parseDocument(found.text, { prettyErrors: false })
  if (document.errors.length > 0) {
    // The parser's message can quote a character of the block, such as "Invalid escape sequence".
    const reason = escaped(document.errors[0].message.split('\n')[0])
    return { isTask: true, valid: false, errors: [`the task block is not valid YAML: ${reason}`] }
  }
  const data = document.toJS()
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { isTask: true, valid: false, errors: ['the task block must be a YAML mapping'] }
  }
  /** @type {string[]} */
  const errors = []
  for (const key of Object.keys(data)) {
    if (!BLOCK_KEYS.includes(key)) errors.push(`${shown(key)} is not a key of the task block`)
  }

  const kind = data.kind
  if (kind === undefined || kind === null) {
    errors.push(`kind is missing; it is one of ${TASK_KINDS.join(', ')}`)
  } else if (kind === 'foundation') {
    errors.push(
      'kind foundation arrives with Phase 2 (I15); in Phase 1 the foundation is a task of the kind task with at least one acceptance test',
    )
  } else if (!TASK_KINDS.includes(kind)) {
    errors.push(`kind ${quoted(kind)} is not one of ${TASK_KINDS.join(', ')}`)
  }

  const role = data.role
  const roleKnown = typeof role === 'string' && Object.hasOwn(config.owners.roles, role)
  if (typeof role !== 'string' || role === '') errors.push('role is missing')
  else if (!roleKnown) errors.push(`role ${shown(role)} is not a role of owners.yml`)

  const wave = data.wave ?? null
  if (wave !== null && !(Number.isInteger(wave) && wave >= 0)) {
    errors.push(`wave must be a whole number, not ${quoted(wave)}`)
  }

  const paths = stringList(data.paths, 'paths', errors, { required: true })
  if (paths && paths.length === 0) errors.push('paths is empty; a task names its allowed paths')
  for (const [index, glob] of (paths ?? []).entries()) {
    const syntax = globError(glob)
    const item = `paths[${index}] (${shown(glob)})`
    if (syntax) {
      errors.push(`${item} ${syntax}`)
      continue
    }
    const where = rolesOfGlob(config, glob)
    if (where.open) continue
    if (where.roles.length === 0) {
      errors.push(`${item} matches no file path`)
    } else if (where.roles.length > 1) {
      // A sample path comes from the glob, so it can hold the glob's characters.
      const spans = where.roles.map((entry) => `${entry.role} (${shown(entry.path)})`).join(', ')
      errors.push(
        `${item} spans the roles ${spans}; every path lies in exactly one role or on the open list`,
      )
    } else if (roleKnown && where.roles[0].role !== role) {
      errors.push(`${item} lies in the role ${where.roles[0].role}, not in the task's role ${role}`)
    }
  }

  const dependsOn = data.depends_on ?? []
  if (!Array.isArray(dependsOn) || !dependsOn.every((n) => Number.isInteger(n) && n > 0)) {
    errors.push('depends_on must be a list of issue numbers, such as [12, 15]')
  }

  const tests = stringList(data.acceptance_tests, 'acceptance_tests', errors, { required: true })
  if (tests && tests.length === 0) {
    errors.push(
      'acceptance_tests is empty; only the kind foundation may have none, and it arrives with Phase 2 (I15)',
    )
  }

  const deadline = data.deadline
  /** @type {string | null} */
  let due = null
  if (deadline === undefined || deadline === null || deadline === '') {
    errors.push('deadline is missing; every task has one (T11)')
  } else {
    const read = readDeadline(deadline, config)
    if ('error' in read) errors.push(read.error)
    else due = read.time
  }

  if (errors.length > 0) return { isTask: true, valid: false, errors }
  return {
    isTask: true,
    valid: true,
    block: {
      kind,
      role,
      wave,
      paths: /** @type {string[]} */ (paths),
      depends_on: dependsOn,
      acceptance_tests: /** @type {string[]} */ (tests),
      deadline: /** @type {string} */ (due),
    },
  }
}

/** A date and time without an offset, as people type it: `2026-10-24 20:00`. */
const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/

/**
 * The deadline of a block as an ISO 8601 time with an offset. The short form `YYYY-MM-DD HH:MM`
 * is read in the event's time zone, the offset of the event times in hackwin.yml. When the start
 * and the end of the event have different offsets, daylight saving time changes during the event
 * and either offset could be an hour off, so the short form is refused there.
 * @param {unknown} value
 * @param {OwnershipConfig} config
 * @returns {{ time: string } | { error: string }}
 */
function readDeadline(value, config) {
  if (isIsoTimeWithOffset(value)) return { time: /** @type {string} */ (value) }
  const local = typeof value === 'string' ? LOCAL_TIME.exec(value) : null
  const event = config.hackwin.project?.event
  if (local === null || !isCalendarTime(local.slice(1).map(Number)) || !event) {
    return {
      error: `deadline ${quoted(value)} is not an ISO 8601 time with an offset, such as "2026-10-17T23:59:00+02:00", or a date and time in the event's time zone, such as "2026-10-17 23:59"`,
    }
  }
  const [, year, month, day, hour, minute] = local
  const at = `${year}-${month}-${day}T${hour}:${minute}:00`
  const start = offsetOf(event.start)
  const end = offsetOf(event.end)
  if (start !== end) {
    return {
      error: `deadline ${quoted(value)} has no offset, and the event's start and end have different offsets (${start} and ${end}), so either could be an hour off; write it with its offset, such as "${at}${end}"`,
    }
  }
  return { time: `${at}${start}` }
}

/**
 * The offset of an ISO 8601 time with an offset, with `Z` written as `+00:00`.
 * @param {string} time
 * @returns {string}
 */
function offsetOf(time) {
  const offset = /(Z|[+-]\d{2}:\d{2})$/.exec(time)?.[1] ?? ''
  return offset === 'Z' ? '+00:00' : offset
}

/**
 * True when the numbers name a real day of the calendar and a time of that day.
 * @param {number[]} parts Year, month, day, hour and minute.
 * @returns {boolean}
 */
function isCalendarTime([year, month, day, hour, minute]) {
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    hour <= 23 &&
    minute <= 59
  )
}

/**
 * A value of the block as an error shows it: a string without a character of UNSAFE as it is,
 * anything else quoted. index.js exports it for any message that names a value of an issue.
 * @param {unknown} value
 * @returns {string}
 */
export function shown(value) {
  return typeof value === 'string' && !UNSAFE.test(value) ? value : quoted(value)
}

/**
 * A value quoted as JSON, with every character of UNSAFE escaped, also those that JSON leaves as
 * they are (DEL, C1, U+2028, U+2029 and the bidirectional format characters).
 * @param {unknown} value
 * @returns {string}
 */
function quoted(value) {
  return escaped(JSON.stringify(value) ?? String(value))
}

/**
 * Text with every character of UNSAFE written as a `\uXXXX` escape.
 * @param {string} text
 * @returns {string}
 */
function escaped(text) {
  return text.replace(
    UNSAFE_ALL,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}

/**
 * @param {unknown} value
 * @param {string} key
 * @param {string[]} errors
 * @param {{ required: boolean }} options
 * @returns {string[] | null} Null when the key is missing or not a list of strings.
 */
function stringList(value, key, errors, { required }) {
  if (value === undefined || value === null) {
    if (required) errors.push(`${key} is missing`)
    return null
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item !== '')) {
    errors.push(`${key} must be a list of non-empty strings`)
    return null
  }
  return value
}

/**
 * Find the one fenced block whose first non-empty line is the marker. Fences follow CommonMark:
 * three or more backticks or tildes, closed by a fence of the same character that is at least
 * as long, so an example block inside a longer fence is skipped.
 * @param {string} body
 * @returns {{ kind: 'none' } | { kind: 'error', reason: string } | { kind: 'block', text: string }}
 */
function findBlock(body) {
  const lines = body.replace(/\r\n?/g, '\n').split('\n')
  /** @type {string[]} */
  const blocks = []
  let unclosed = false
  let bareMarker = false
  for (let i = 0; i < lines.length; i += 1) {
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i])
    if (!open || (open[1][0] === '`' && open[2].includes('`'))) {
      if (lines[i].trim() === TASK_MARKER) bareMarker = true
      continue
    }
    const fence = open[1]
    let end = i + 1
    while (end < lines.length) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[end])
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) break
      end += 1
    }
    const content = lines.slice(i + 1, end)
    if (content.find((line) => line.trim() !== '')?.trim() === TASK_MARKER) {
      if (end === lines.length) unclosed = true
      blocks.push(content.join('\n'))
    }
    i = end
  }
  if (blocks.length > 1) {
    return {
      kind: 'error',
      reason: `the body has ${blocks.length} ${TASK_MARKER} blocks; a task issue has exactly one`,
    }
  }
  if (unclosed) return { kind: 'error', reason: `the ${TASK_MARKER} block has no closing fence` }
  if (blocks.length === 1) return { kind: 'block', text: blocks[0] }
  if (bareMarker) {
    return {
      kind: 'error',
      reason: `the ${TASK_MARKER} line must start a fenced yaml code block (8.1)`,
    }
  }
  return { kind: 'none' }
}

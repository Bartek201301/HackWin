// The task block of an issue body (8.1, A7): a fenced YAML block whose first line is
// `# hackwin:task`. An issue without it is not a task. Three rules make a block invalid: a path
// that does not lie in exactly one role or on the `open` list, empty acceptance tests outside the
// kind `foundation`, and a missing deadline. Any account can write a block, and `take` prints its
// errors, so no error carries a control character or a line break of the body.

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

/** A control character (C0, DEL and C1), or the line or paragraph separator of Unicode. */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/
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
 * @property {string} deadline ISO 8601 with an offset.
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
  if (deadline === undefined || deadline === null || deadline === '') {
    errors.push('deadline is missing; every task has one (T11)')
  } else if (!isIsoTimeWithOffset(deadline)) {
    errors.push(
      `deadline ${quoted(deadline)} is not an ISO 8601 time with an offset, such as "2026-10-17T23:59:00+02:00"`,
    )
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
      deadline,
    },
  }
}

/**
 * A value of the block as an error shows it: a string without a control character or line break
 * as it is, anything else quoted. Not exported by index.js.
 * @param {unknown} value
 * @returns {string}
 */
export function shown(value) {
  return typeof value === 'string' && !UNSAFE.test(value) ? value : quoted(value)
}

/**
 * A value quoted as JSON, with every control character and line break escaped, also those that
 * JSON leaves as they are (DEL, C1, U+2028 and U+2029).
 * @param {unknown} value
 * @returns {string}
 */
function quoted(value) {
  return escaped(JSON.stringify(value) ?? String(value))
}

/**
 * Text with every control character and line break written as a `\uXXXX` escape.
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

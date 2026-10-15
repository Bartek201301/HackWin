// The digest (9.6): one line per pull request run, written when the run ends, into `digest.log`
// and the Gate terminal. The status issue publishes the latest line of each pull request, so
// that `status` reads it on every machine [D4]:
//
//   <time> #<PR> <author> <result> stage=<stage> <duration> <note>
//
// `digest.log` and the status issue carry the full time; the terminal prints hours and minutes.

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { readText } from '../../core/state/index.js'

/**
 * One digest line.
 * @typedef {object} DigestEntry
 * @property {string} time ISO 8601.
 * @property {number} pr
 * @property {string} author The pull request author's login.
 * @property {string} result `merged`, `failed`, `needs-owner`, `scope-violation`, `flaky` or
 *   `requeued` (9.6).
 * @property {string} stage The stage where the run ended.
 * @property {string} duration How long the run took.
 * @property {string} note Empty when the line has none.
 */

const LINE = /^(\d{4}-\d\d-\d\dT\S+) #([1-9]\d*) (\S+) (\S+) stage=(\S+) (\S+)(?: (.*))?$/

/**
 * The text of a digest line. Every field but the note is one word; the note is one line.
 * @param {DigestEntry} entry
 * @returns {string}
 */
export function formatDigestLine(entry) {
  const word = (/** @type {string} */ value) => String(value).trim().replace(/\s+/g, '-') || '-'
  const note = String(entry.note ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  const words = [
    word(entry.time),
    `#${entry.pr}`,
    word(entry.author),
    word(entry.result),
    `stage=${word(entry.stage)}`,
    word(entry.duration),
  ]
  return note === '' ? words.join(' ') : `${words.join(' ')} ${note}`
}

/**
 * The entry of a digest line, or null when the text is not one.
 * @param {string} text
 * @returns {DigestEntry | null}
 */
export function parseDigestLine(text) {
  const match = LINE.exec(text.trim())
  if (!match || Number.isNaN(Date.parse(match[1]))) return null
  const [, time, pr, author, result, stage, duration, note = ''] = match
  return { time, pr: Number(pr), author, result, stage, duration, note }
}

/**
 * Add a line to `digest.log`, which keeps every run.
 * @param {string} file
 * @param {DigestEntry} entry
 * @returns {Promise<void>}
 */
export async function appendDigestLine(file, entry) {
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, `${formatDigestLine(entry)}\n`)
}

/**
 * The latest line of each pull request in `digest.log`, newest first: the digest of the status
 * issue (9.6). A missing file has none.
 * @param {string} file
 * @returns {Promise<DigestEntry[]>}
 */
export async function readDigest(file) {
  const text = await readText(file)
  /** @type {Map<number, { entry: DigestEntry, index: number }>} */
  const latest = new Map()
  for (const [index, line] of (text ?? '').split('\n').entries()) {
    const entry = parseDigestLine(line)
    if (entry !== null) latest.set(entry.pr, { entry, index })
  }
  return [...latest.values()]
    .sort((a, b) => Date.parse(b.entry.time) - Date.parse(a.entry.time) || b.index - a.index)
    .map(({ entry }) => entry)
}

/**
 * True when `digest.log` holds a merged line of the pull request. A pull request is merged once,
 * so a run that takes up again after the merge, at a restart, writes no second one.
 * @param {string} file
 * @param {number} pr
 * @returns {Promise<boolean>}
 */
export async function hasMergedLine(file, pr) {
  const digest = await readDigest(file)
  return digest.some((entry) => entry.pr === pr && entry.result === 'merged')
}

/**
 * The time as the terminal prints it (9.6): hours and minutes, local time.
 * @param {Date} time
 * @returns {string}
 */
export function hoursAndMinutes(time) {
  const pad = (/** @type {number} */ value) => String(value).padStart(2, '0')
  return `${pad(time.getHours())}:${pad(time.getMinutes())}`
}

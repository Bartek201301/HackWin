// HackWin's own block in a file that belongs to the team (6.5): the text between the markers
// `hackwin:begin` and `hackwin:end`. `setup` adds the block or replaces an earlier one and keeps
// every other line of the file, so a rerun never adds a second copy (20.1).

import { PreconditionError } from '../core/runtime/errors.js'

/**
 * The markers of a block, as a comment of the file's language.
 * @typedef {{ begin: string, end: string }} Markers
 */

/** The markers in Markdown files. */
export const HTML_MARKERS = Object.freeze({
  begin: '<!-- hackwin:begin -->',
  end: '<!-- hackwin:end -->',
})

/** The markers in files whose comments start with `#`, such as `.gitignore`. */
export const HASH_MARKERS = Object.freeze({ begin: '# hackwin:begin', end: '# hackwin:end' })

/**
 * The block of a text, markers included, or null when the text has none. A begin marker without
 * an end marker after it, or a second block, is an error that names the file.
 * @param {string} text
 * @param {Markers} markers
 * @param {string} path The file, for the message.
 * @returns {{ start: number, end: number } | null} The block's offsets in the text.
 */
export function findBlock(text, markers, path) {
  const begin = indexOfLine(text, markers.begin, 0)
  if (begin === -1) {
    if (indexOfLine(text, markers.end, 0) !== -1) throw brokenBlock(path, markers)
    return null
  }
  const end = indexOfLine(text, markers.end, begin)
  if (end === -1) throw brokenBlock(path, markers)
  const after = end + markers.end.length
  if (indexOfLine(text, markers.begin, after) !== -1) throw brokenBlock(path, markers)
  return { start: begin, end: after }
}

/**
 * The block of a template text, markers included.
 * @param {string} template
 * @param {Markers} markers
 * @returns {string}
 */
export function blockOf(template, markers) {
  const found = findBlock(template, markers, 'the template')
  if (found === null) throw new Error('the template has no hackwin block')
  return template.slice(found.start, found.end)
}

/**
 * A file's text with HackWin's block: the existing block is replaced, a file without one gets
 * the block appended after an empty line, and a missing or empty file becomes `whole`.
 * @param {string | null} existing The file's text, or null when it does not exist.
 * @param {object} options
 * @param {string} options.block The block, markers included.
 * @param {string} options.whole The text of a new file, which holds the block.
 * @param {Markers} options.markers
 * @param {string} options.path The file, for the message of a broken block.
 * @returns {string}
 */
export function withBlock(existing, { block, whole, markers, path }) {
  if (existing === null || existing.trim() === '') return whole
  const found = findBlock(existing, markers, path)
  if (found === null) return `${existing.replace(/\n*$/, '\n\n')}${block}\n`
  return `${existing.slice(0, found.start)}${block}${existing.slice(found.end)}`
}

/**
 * The offset of a line that is exactly `line` (leading and trailing spaces allowed), from
 * `from` on, or -1.
 * @param {string} text
 * @param {string} line
 * @param {number} from
 * @returns {number}
 */
function indexOfLine(text, line, from) {
  let index = text.indexOf(line, from)
  while (index !== -1) {
    const start = text.lastIndexOf('\n', index - 1) + 1
    const stop = text.indexOf('\n', index)
    const whole = text.slice(start, stop === -1 ? text.length : stop)
    if (whole.trim() === line) return index
    index = text.indexOf(line, index + line.length)
  }
  return -1
}

/**
 * @param {string} path
 * @param {Markers} markers
 * @returns {PreconditionError}
 */
function brokenBlock(path, markers) {
  return new PreconditionError(
    `${path} holds a broken hackwin block: it needs exactly one line \`${markers.begin}\` and one line \`${markers.end}\` after it`,
    {
      resolve: `correct the markers in ${path}, or remove both with the text between them, keeping your own lines, and commit the change`,
    },
  )
}

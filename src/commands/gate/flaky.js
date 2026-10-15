// Known flaky tests (G14): `gate.known_flaky_tests` lists test ids or file globs. The Gate looks
// for them in the failure lines of the log of a failed command, of the merge test or of CI: the
// lines that carry a failure mark of a test runner, such as `FAIL`, `FAILED`, `×`, `✗`, `●` or
// TAP's `not ok`. A line of a test that passed, such as `✓ test/clock/tick.test.js`, names
// nothing. An entry counts when a failure line holds it as written, or, for a glob, when a word of
// a failure line is a path that the glob matches: `test/clock/**` matches
// `test/clock/tick.test.js:12:5`.

import { createMatcher } from '../../core/config/index.js'

/** A failure mark of a test runner, as a word of its own. */
const FAILURE_MARK = /(?:^|\s)(?:FAIL|FAILED|FAILURE|×|✗|✕|✖|❌|●|not ok)(?=[\s:]|$)/

/**
 * The entries of `gate.known_flaky_tests` that the failure lines of a log name.
 * @param {string} text The log.
 * @param {string[]} entries
 * @returns {string[]}
 */
export function namedFlakyTests(text, entries) {
  const failures = text.split(/\r?\n/).filter((line) => FAILURE_MARK.test(line))
  /** @type {string[] | null} */
  let words = null
  return entries.filter((entry) => {
    if (typeof entry !== 'string' || entry === '') return false
    if (failures.some((line) => line.includes(entry))) return true
    if (!/[*?{]/.test(entry)) return false
    /** @type {(path: string) => boolean} */
    let matches
    try {
      matches = createMatcher([entry])
    } catch {
      return false
    }
    words ??= wordsOf(failures)
    return words.some((word) => matches(word))
  })
}

/**
 * The words of the failure lines that may be paths: split at spaces, quotes and brackets, without
 * a leading `./` and a trailing line and column.
 * @param {string[]} lines
 * @returns {string[]}
 */
function wordsOf(lines) {
  const words = new Set()
  for (const raw of lines.join('\n').split(/[\s"'`()[\]<>,;|]+/)) {
    const word = raw.replace(/^\.\//, '').replace(/(?::\d+){1,2}:?$/, '')
    if (word !== '') words.add(word)
  }
  return [...words]
}

// Known flaky tests (G14): `gate.known_flaky_tests` lists test ids or file globs. The Gate looks
// for them in the log of a failed command, of the merge test or of CI. An entry counts when the
// log holds it as written, or, for a glob, when a word of the log is a path that the glob
// matches: `test/clock/**` matches `test/clock/tick.test.js:12:5`.

import { createMatcher } from '../../core/config/index.js'

/**
 * The entries of `gate.known_flaky_tests` that a log names.
 * @param {string} text The log.
 * @param {string[]} entries
 * @returns {string[]}
 */
export function namedFlakyTests(text, entries) {
  /** @type {string[] | null} */
  let words = null
  return entries.filter((entry) => {
    if (typeof entry !== 'string' || entry === '') return false
    if (text.includes(entry)) return true
    if (!/[*?{]/.test(entry)) return false
    /** @type {(path: string) => boolean} */
    let matches
    try {
      matches = createMatcher([entry])
    } catch {
      return false
    }
    words ??= wordsOf(text)
    return words.some((word) => matches(word))
  })
}

/**
 * The words of a log that may be paths: split at spaces, quotes and brackets, without a leading
 * `./` and a trailing line and column.
 * @param {string} text
 * @returns {string[]}
 */
function wordsOf(text) {
  const words = new Set()
  for (const raw of text.split(/[\s"'`()[\]<>,;|]+/)) {
    const word = raw.replace(/^\.\//, '').replace(/(?::\d+){1,2}:?$/, '')
    if (word !== '') words.add(word)
  }
  return [...words]
}

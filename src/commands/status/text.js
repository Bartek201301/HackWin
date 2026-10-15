// Text from GitHub on a terminal (the Lead's review of #73). `status` prints titles, the errors of
// task blocks, the status issue's attention items and digest notes, milestone titles and logins
// that anyone who can open an issue on the repository may write. gh replaces control characters
// in the JSON it prints, but a YAML escape such as "\e" or "\n" in a task block or the status
// issue decodes into a real one. An ESC starts a terminal escape sequence (colours, cursor moves,
// an OSC 8 hyperlink, a window title) and a line break forges a line of `status`, so every string
// that `status` shows or puts into `--json` passes through cleanText first: a line break or tab
// becomes a space, and any other control character, C0, DEL or C1, and the bidirectional format
// characters, which reorder what a line shows, become a visible `\uXXXX`. Nothing is removed
// silently, and no escape sequence is left to be cut in half.

/** Control characters, DEL, C1, the line and paragraph separators and the bidi format characters. */
const UNSAFE =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g

/** The characters of UNSAFE that break or space a line: they become a space. */
const SPACING = /[\t\n\v\f\r\u0085\u2028\u2029]/

/**
 * The text with no character that a terminal acts on.
 * @param {string} text
 * @returns {string}
 */
export function cleanText(text) {
  return text.replace(UNSAFE, (char) =>
    SPACING.test(char) ? ' ' : `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}

/**
 * A copy of a value with cleanText applied to every string in it, in arrays and plain objects at
 * any depth. Other values stay as they are.
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function cleanStrings(value) {
  if (typeof value === 'string') return /** @type {T} */ (cleanText(value))
  if (Array.isArray(value)) return /** @type {T} */ (value.map(cleanStrings))
  if (value !== null && typeof value === 'object') {
    return /** @type {T} */ (
      Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cleanStrings(item)]))
    )
  }
  return value
}

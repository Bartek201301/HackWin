// The Gate's comments on pull requests (G21, A31): a failed run leaves exactly one, with the
// stage, the reason and the next action. The Gate, the Lead and the Lead's builder sessions all
// write as the Lead's account (A5), so every comment of the Gate starts with a marker that names
// the pull request, the full head SHA, the stage and the result:
//
//   <!-- hackwin:gate-comment pr=12 sha=<full sha> stage=scope result=scope-violation -->
//
// GitHub does not render an HTML comment, and the API returns the body as written. Only the exact
// marker the Gate writes counts, at the very start of the body: no space, tab, byte order mark or
// other character before it, the four keys in this order, nothing else up to the end of its line.
// So a reply that quotes a Gate comment, or a marker in a code block, is no Gate comment.
//
// A marker that the Lead types by hand under the Lead's account cannot be told apart from the
// Gate's (A5). A caller that acts on a Gate comment therefore also compares the marker's SHA with
// the head SHA it acts on. `take` finds the Gate's comment with latestGateComment.

/** @import { Comment } from '../../core/github/index.js' */

export const MARKER_NAME = 'hackwin:gate-comment'

/**
 * What the marker of a Gate comment names.
 * @typedef {object} GateMarker
 * @property {number} pr The pull request.
 * @property {string} sha The full head SHA of the run.
 * @property {string} stage The stage where the run ended, for example `scope`.
 * @property {string} result The digest result, for example `scope-violation` (9.6).
 */

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
const WORD = /^[a-z]+(?:-[a-z]+)*$/

/**
 * The marker at the start of a body. Every part is a fixed text or a run of one character class
 * that the next fixed text ends, so the match takes time linear in the body's length.
 */
const MARKER =
  /^<!-- hackwin:gate-comment pr=([1-9]\d{0,9}) sha=([0-9a-f]{40}(?:[0-9a-f]{24})?) stage=([a-z]+(?:-[a-z]+)*) result=([a-z]+(?:-[a-z]+)*) -->(?:\r?\n|$)/

/**
 * The marker line of a Gate comment.
 * @param {GateMarker} marker
 * @returns {string}
 */
export function formatGateMarker({ pr, sha, stage, result }) {
  if (!Number.isInteger(pr) || pr <= 0 || pr > 9_999_999_999) {
    throw new TypeError(`not a pull request number: ${pr}`)
  }
  if (!SHA.test(sha)) throw new TypeError(`not a full SHA: ${sha}`)
  for (const value of [stage, result]) {
    if (!WORD.test(value)) throw new TypeError(`not a stage or result word: ${value}`)
  }
  return `<!-- ${MARKER_NAME} pr=${pr} sha=${sha} stage=${stage} result=${result} -->`
}

/**
 * The marker of a comment body, or null when the body does not start with the exact marker of a
 * Gate comment.
 * @param {string | null | undefined} body
 * @returns {GateMarker | null}
 */
export function parseGateMarker(body) {
  const match = MARKER.exec(body ?? '')
  if (!match) return null
  const [, pr, sha, stage, result] = match
  return { pr: Number(pr), sha, stage, result }
}

/**
 * The newest Gate comment about this pull request, with its marker, or null: a comment of the
 * Lead's account, under which the Gate acts (A5), whose marker names the pull request. A marker
 * in a comment of any other account never counts. The Lead's own comments carry no marker, but
 * one the Lead types by hand counts as the Gate's, so a caller also compares `marker.sha` with
 * the head SHA it acts on.
 * @param {Comment[]} comments Oldest first, as `listComments` returns them.
 * @param {{ pr: number, lead: string }} wanted `lead` is `team.lead` of hackwin.yml.
 * @returns {{ comment: Comment, marker: GateMarker } | null}
 */
export function latestGateComment(comments, { pr, lead }) {
  const account = lead.toLowerCase()
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const comment = comments[index]
    if (comment.author?.toLowerCase() !== account) continue
    const marker = parseGateMarker(comment.body)
    if (marker !== null && marker.pr === pr) return { comment, marker }
  }
  return null
}

/**
 * The command of a failed step and the last lines of its log, for the comment of stage 7 (9.2).
 * @typedef {object} CommentLog
 * @property {string} command The command line that ran.
 * @property {string} outcome How it ended, such as `exit 1`.
 * @property {string[]} tail The last lines of its output.
 * @property {string | null} file Where the full log is, relative to the Gate's directory.
 */

/**
 * The longest comment body the Gate writes, in UTF-16 code units, the length of a JavaScript
 * string: the limit the CLI keeps for a body (MAX_BODY_LENGTH of status-issue.js,
 * docs/verification.md row 10), so that GitHub does not refuse a comment for its length.
 */
export const MAX_COMMENT_LENGTH = 65_536

/** How long one item of a list, or one line of a log, may be in a comment. */
export const MAX_ITEM = 1_000

/**
 * The body of the comment of a failed run (G21): the marker, then the stage, the reason with its
 * details and, for a failed command, the command and the last lines of its log, then the next
 * action. It stays within MAX_COMMENT_LENGTH: each log line is cut to MAX_ITEM characters (it
 * stands in a code block), then the oldest log lines and the last items are left out whole, with
 * a line that says how many, until the body fits. An item is never cut here, since a cut could
 * end an inline code span early and turn the rest into a mention or a link: a caller cuts the
 * raw text before it wraps it (codeSpan).
 * @param {object} comment
 * @param {GateMarker} comment.marker
 * @param {string} comment.title The stage, as the comment names it: `stage 3, scope`.
 * @param {string} comment.reason
 * @param {string[]} [comment.details] One list item each.
 * @param {CommentLog} [comment.log]
 * @param {string} comment.next The next action.
 * @param {string | null} [comment.main] The main commit the run tested against.
 * @returns {string}
 */
export function failureComment({ marker, title, reason, details = [], log, next, main = null }) {
  let items = details
  let tail = (log?.tail ?? []).map((line) => cutText(line, MAX_ITEM))
  let itemsLeft = 0
  let linesLeft = 0
  for (;;) {
    const body = commentBody({
      marker,
      title,
      reason,
      items: itemsLeft === 0 ? items : [...items, `and ${itemsLeft} more`],
      log: log ? { ...log, tail } : undefined,
      linesLeft,
      next,
      main,
    })
    if (body.length <= MAX_COMMENT_LENGTH) return body
    if (tail.length > 0) {
      tail = tail.slice(1)
      linesLeft += 1
    } else if (items.length > 0) {
      items = items.slice(0, -1)
      itemsLeft += 1
    } else {
      // Only a reason or a next action longer than any the Gate writes gets here.
      return commentBody({
        marker,
        title,
        reason:
          'the reason is too long for a comment; the Gate terminal and digest.log show the run',
        items: [],
        log: undefined,
        linesLeft: 0,
        next: 'the Lead reads the Gate terminal',
        main,
      })
    }
  }
}

/**
 * The text of a comment body.
 * @param {{ marker: GateMarker, title: string, reason: string, items: string[], log: CommentLog | undefined, linesLeft: number, next: string, main: string | null }} parts
 * @returns {string}
 */
function commentBody({ marker, title, reason, items, log, linesLeft, next, main }) {
  const tested = main === null ? '' : `, tested against main \`${main}\``
  return [
    formatGateMarker(marker),
    `**HackWin Gate: failed at ${title}.**`,
    '',
    `**Reason:** ${reason}`,
    ...(items.length === 0 ? [] : ['', ...items.map((item) => `- ${item}`)]),
    ...(log ? ['', ...logLines(log, linesLeft)] : []),
    '',
    `**Next action:** ${next}`,
    '',
    `Head \`${marker.sha}\`${tested}.`,
    '',
  ].join('\n')
}

/**
 * A text cut to at most `max` UTF-16 code units, the length of a JavaScript string, with `…` at
 * the end when it was cut. It cuts between whole characters, so no half of a surrogate pair is
 * left alone.
 * @param {string} text
 * @param {number} max At least 2.
 * @returns {string}
 */
export function cutText(text, max) {
  if (text.length <= max) return text
  let end = max - 1
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return `${text.slice(0, end)}…`
}

/**
 * Raw text as inline code, cut to MAX_ITEM characters first, so that the code span always
 * closes: no mention, issue reference or link in the text becomes live.
 * @param {string} text
 * @returns {string}
 */
export function codeSpan(text) {
  return inlineCode(cutText(text, MAX_ITEM))
}

/**
 * The command, the last lines of its log in a code block, and where the full log is. The fence is
 * longer than any run of backticks in the log, so no log line ends it, and a mention or a link in
 * the log stays text.
 * @param {CommentLog} log
 * @param {number} [left] How many earlier lines of the tail were left out for the length.
 * @returns {string[]}
 */
function logLines({ command, outcome, tail, file }, left = 0) {
  const longest = Math.max(0, ...tail.map((line) => Math.max(0, ...runsOf(line, '`'))))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  const lines = tail.length === 1 ? 'line' : `${tail.length} lines`
  return [
    `**Command:** ${inlineCode(command)}, ${outcome}. The last ${lines} of its log${left > 0 ? `, without ${left} earlier ${left === 1 ? 'line' : 'lines'} that would make the comment too long` : ''}:`,
    '',
    `${fence}text`,
    ...tail,
    fence,
    ...(file === null
      ? []
      : [
          '',
          `The full log stays on the Lead's laptop, in the Gate's directory: ${inlineCode(file)}.`,
        ]),
  ]
}

/**
 * The lengths of the runs of a character in a text.
 * @param {string} text
 * @param {string} char
 * @returns {number[]}
 */
function runsOf(text, char) {
  return [...text.matchAll(new RegExp(`\\${char}+`, 'g'))].map((match) => match[0].length)
}

/**
 * Text as inline code, with a fence longer than any run of backticks inside it.
 * @param {string} text
 * @returns {string}
 */
export function inlineCode(text) {
  const fence = '`'.repeat(Math.max(0, ...runsOf(text, '`')) + 1)
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${text}${pad}${fence}`
}

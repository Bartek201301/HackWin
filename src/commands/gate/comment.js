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
 * The body of the comment of a failed run (G21): the marker, then the stage, the reason with its
 * details, and the next action.
 * @param {object} comment
 * @param {GateMarker} comment.marker
 * @param {string} comment.title The stage, as the comment names it: `stage 3, scope`.
 * @param {string} comment.reason
 * @param {string[]} [comment.details] One list item each.
 * @param {string} comment.next The next action.
 * @param {string | null} [comment.main] The main commit the run tested against.
 * @returns {string}
 */
export function failureComment({ marker, title, reason, details = [], next, main = null }) {
  const tested = main === null ? '' : `, tested against main \`${main}\``
  return [
    formatGateMarker(marker),
    `**HackWin Gate: failed at ${title}.**`,
    '',
    `**Reason:** ${reason}`,
    ...(details.length === 0 ? [] : ['', ...details.map((detail) => `- ${detail}`)]),
    '',
    `**Next action:** ${next}`,
    '',
    `Head \`${marker.sha}\`${tested}.`,
    '',
  ].join('\n')
}

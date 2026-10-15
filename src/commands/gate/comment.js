// The Gate's comments on pull requests (G21, A31): a failed run leaves exactly one, with the
// stage, the reason and the next action. The Gate, the Lead and the Lead's builder sessions all
// write as the Lead's account (A5), so every comment of the Gate starts with a marker that names
// the pull request, the full head SHA, the stage and the result:
//
//   <!-- hackwin:gate-comment pr=12 sha=<full sha> stage=scope result=scope-violation -->
//
// GitHub does not render an HTML comment, and the API returns the body as written. The marker is
// the first line of the body, so a reply that quotes a Gate comment carries no marker of its own.
// `take` finds the Gate's comment with parseGateMarker or latestGateComment.

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

const MARKER = /^<!-- hackwin:gate-comment ((?:[a-z]+=\S+ ?)+)-->$/
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/
const WORD = /^[a-z]+(-[a-z]+)*$/

/**
 * The marker line of a Gate comment.
 * @param {GateMarker} marker
 * @returns {string}
 */
export function formatGateMarker({ pr, sha, stage, result }) {
  if (!Number.isInteger(pr) || pr <= 0) throw new TypeError(`not a pull request number: ${pr}`)
  if (!SHA.test(sha)) throw new TypeError(`not a full SHA: ${sha}`)
  for (const value of [stage, result]) {
    if (!WORD.test(value)) throw new TypeError(`not a stage or result word: ${value}`)
  }
  return `<!-- ${MARKER_NAME} pr=${pr} sha=${sha} stage=${stage} result=${result} -->`
}

/**
 * The marker of a comment body, or null when its first line is not the marker of a Gate comment.
 * @param {string | null | undefined} body
 * @returns {GateMarker | null}
 */
export function parseGateMarker(body) {
  const first = (body ?? '').replace(/\r\n?/g, '\n').split('\n')[0].trim()
  const match = MARKER.exec(first)
  if (!match) return null
  /** @type {Record<string, string>} */
  const fields = {}
  for (const pair of match[1].trim().split(' ')) {
    const [key, value] = pair.split('=')
    if (Object.hasOwn(fields, key)) return null
    fields[key] = value
  }
  const { pr, sha, stage, result } = fields
  if (!/^[1-9]\d*$/.test(pr ?? '') || !SHA.test(sha ?? '')) return null
  if (!WORD.test(stage ?? '') || !WORD.test(result ?? '')) return null
  return { pr: Number(pr), sha, stage, result }
}

/**
 * The newest Gate comment about this pull request, with its marker, or null.
 * @param {Comment[]} comments Oldest first, as `listComments` returns them.
 * @param {number} pr
 * @returns {{ comment: Comment, marker: GateMarker } | null}
 */
export function latestGateComment(comments, pr) {
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const marker = parseGateMarker(comments[index].body)
    if (marker !== null && marker.pr === pr) return { comment: comments[index], marker }
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

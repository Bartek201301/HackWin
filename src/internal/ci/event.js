// The pull request that a run of the hackwin workflow checks. GitHub Actions writes the payload of
// the event that started the run into the file that GITHUB_EVENT_PATH names; for a pull_request
// event it holds the pull request with its number and the head commit the run is for.

import { readFile } from 'node:fs/promises'
import { PreconditionError } from '../../core/runtime/errors.js'
import { WORKFLOW_PATH } from '../../generate/index.js'

/** The variable that names the file with the event payload. */
export const EVENT_PATH_ENV = 'GITHUB_EVENT_PATH'

/**
 * @typedef {object} PullEvent
 * @property {number} number The number of the pull request.
 * @property {string | null} headSha The head commit this run checks; null when the payload
 *   names none.
 */

/**
 * Read the pull request of the event that started this run.
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<PullEvent>} PreconditionError outside a run on a pull request event.
 */
export async function readPullEvent(env) {
  const path = env[EVENT_PATH_ENV]
  if (!path) throw notAPullRequest(`${EVENT_PATH_ENV} is not set`)
  /** @type {any} */
  let payload
  try {
    payload = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw notAPullRequest(`the event in ${path} cannot be read: ${error.message}`)
  }
  const pull = payload?.pull_request
  const number = pull?.number ?? payload?.number
  if (!Number.isInteger(number) || number < 1) {
    throw notAPullRequest(`the event in ${path} is not a pull request event`)
  }
  const sha = pull?.head?.sha
  return { number, headSha: typeof sha === 'string' && sha !== '' ? sha : null }
}

/**
 * @param {string} reason
 * @returns {PreconditionError}
 */
function notAPullRequest(reason) {
  return new PreconditionError(
    `hackwin internal ci checks one pull request in a run of the hackwin workflow: ${reason}`,
    { resolve: `let the workflow ${WORKFLOW_PATH} run it on a pull request` },
  )
}

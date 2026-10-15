// Step 13 of `setup` (7.1) [D19]: GitHub's secret scanning push protection, enabled with the
// Lead's token where GitHub offers it, and on or off as the setting reads back
// (docs/verification.md row 7). GitHub's answer to the enabling call proves nothing: on a private
// repository of a personal account it answered HTTP 200 and the setting read back stayed null.
// HackWin's own secret scans (E6) run in both cases.

import { RemoteError } from '../../core/runtime/index.js'

/** @import { GitHub } from '../../core/github/index.js' */

/** The setting's value when push protection is on. */
const ENABLED = 'enabled'

/**
 * @typedef {object} PushProtection
 * @property {boolean} on The setting read back is `enabled`.
 * @property {boolean} enabledNow Setup turned it on in this run.
 * @property {string | null} status The setting read back: `enabled`, `disabled`, or null where
 *   GitHub returns none.
 * @property {string | null} refused GitHub's refusal of the enabling call, if it refused.
 */

/**
 * Enable push protection unless it is on, then read the setting back.
 * @param {GitHub} github The Lead's client; GitHub returns the setting only to admins.
 * @returns {Promise<PushProtection>}
 */
export async function enablePushProtection(github) {
  const before = await readPushProtection(github)
  if (before === ENABLED) return { on: true, enabledNow: false, status: before, refused: null }
  /** @type {string | null} */
  let refused = null
  try {
    await github.api('repos/{owner}/{repo}', {
      method: 'PATCH',
      body: { security_and_analysis: { secret_scanning_push_protection: { status: ENABLED } } },
    })
  } catch (error) {
    // A refusal (4xx) means GitHub does not offer it here; a network or server failure is for
    // `setup --resume`.
    const status = error instanceof RemoteError ? error.status : undefined
    if (status === undefined || status < 400 || status >= 500) throw error
    refused = error.message
  }
  const status = await readPushProtection(github)
  return { on: status === ENABLED, enabledNow: status === ENABLED, status, refused }
}

/**
 * The push protection setting of the repository, or null where GitHub returns none.
 * @param {GitHub} github
 * @returns {Promise<string | null>}
 */
export async function readPushProtection(github) {
  const repository = await github.api('repos/{owner}/{repo}')
  const status = repository?.security_and_analysis?.secret_scanning_push_protection?.status
  return typeof status === 'string' ? status : null
}

/**
 * The line of the summary (step 15).
 * @param {PushProtection} result
 * @param {string} repository `owner/name`.
 * @returns {string}
 */
export function pushProtectionLine(result, repository) {
  return result.on
    ? `push protection: on${result.enabledNow ? ', enabled by setup' : ''}: GitHub blocks a push that holds a secret it recognizes, and HackWin's own secret scans run as well`
    : `push protection: off: GitHub does not offer it for ${repository}, so HackWin's own secret scans (E6) run alone`
}

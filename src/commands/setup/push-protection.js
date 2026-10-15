// Step 13 of `setup` (7.1) [D19]: GitHub's secret scanning push protection, enabled with the
// Lead's token where GitHub offers it, and on or off as the setting reads back
// (docs/verification.md row 7). GitHub's answer to the enabling call proves nothing: on a private
// repository of a personal account it answered HTTP 200 and the setting read back stayed null.
// Setup sends the enabling call even when a read shows the setting on, because a read can show a
// value GitHub no longer holds (settle.js). HackWin's own secret scans (E6) run in both cases.

import { RemoteError } from '../../core/runtime/index.js'
import { unsettled } from './settle.js'

/** @import { GitHub } from '../../core/github/index.js' */
/** @import { Settled } from './settle.js' */

/** The setting's value when push protection is on. */
export const ENABLED = 'enabled'

/**
 * Ask GitHub to enable push protection. The setting is read back afterwards, once GitHub's reads
 * have settled (settle.js).
 * @param {GitHub} github The Lead's client.
 * @returns {Promise<{ refused: string | null }>} GitHub's refusal of the call, if it refused.
 */
export async function enablePushProtection(github) {
  try {
    await github.api('repos/{owner}/{repo}', {
      method: 'PATCH',
      body: { security_and_analysis: { secret_scanning_push_protection: { status: ENABLED } } },
    })
    return { refused: null }
  } catch (error) {
    // A refusal (4xx) means GitHub does not offer it here; a network or server failure is for
    // `setup --resume`.
    const status = error instanceof RemoteError ? error.status : undefined
    if (status === undefined || status < 400 || status >= 500) throw error
    return { refused: error.message }
  }
}

/**
 * The push protection setting of the repository, or null where GitHub returns none. GitHub
 * returns it only to admins.
 * @param {GitHub} github
 * @returns {Promise<string | null>}
 */
export async function readPushProtection(github) {
  const repository = await github.api('repos/{owner}/{repo}')
  const status = repository?.security_and_analysis?.secret_scanning_push_protection?.status
  return typeof status === 'string' ? status : null
}

/**
 * The lines of the summary (step 15).
 * @param {Settled<string | null>} read The setting read back from GitHub.
 * @param {string} repository `owner/name`.
 * @param {string} root The main checkout, for the resume command.
 * @returns {string[]}
 */
export function pushProtectionLines(read, repository, root) {
  const line =
    read.value === ENABLED
      ? `push protection: on: GitHub blocks a push that holds a secret it recognizes, and HackWin's own secret scans run as well`
      : `push protection: off: GitHub does not offer it for ${repository}, so HackWin's own secret scans (E6) run alone`
  return read.settled ? [line] : [line, unsettled('push protection setting', read, root)]
}

// `hackwin status` (7.6): who does what, what waits for a merge, what is blocked and what the
// Gate did. It is built from GitHub, so it gives the same answer in a new session and on every
// laptop; the status issue [D4] carries the Gate's heartbeat, protection state, queue, attention
// items and digest. The runner has already fetched origin, loaded the configuration from
// origin/main, checked the version and fast-forwarded the main checkout (CM9, CM10, CM12).

import { RemoteError } from '../../core/runtime/index.js'
import { writeLastStatus } from '../../core/state/index.js'
import { mainCheckout } from '../../core/worktrees/index.js'
import { parseStatusBody } from '../gate/status-issue.js'
import { localHeartbeatLine, statusLines } from './format.js'
import { readClone, readGitHub, readLocalHeartbeat } from './read.js'
import { cleanStrings } from './text.js'
import { buildStatus } from './view.js'

/** @import { CommandContext, CommandResult } from '../../cli/context.js' */

/**
 * @param {CommandContext} ctx
 * @returns {Promise<CommandResult>}
 */
export async function run(ctx) {
  const { config, identity } = prepared(ctx)
  const now = ctx.clock.now()
  const clone = await readClone(ctx.gitCommonDir)
  /** @type {Awaited<ReturnType<typeof readGitHub>>} */
  let read
  try {
    read = await readGitHub(ctx.github, { config, now })
  } catch (error) {
    if (error instanceof RemoteError) {
      for (const line of (await unreachable(ctx, error)).lines ?? []) ctx.out.line(line)
    }
    throw error
  }
  const gateStatus = read.statusIssue === null ? null : parseStatusBody(read.statusIssue.body)
  const data = buildStatus({ config, identity, now, ...read, ...clone, gateStatus })
  await recordSeen(ctx, gateStatus?.heartbeat_at ?? null)
  return { lines: statusLines(data, { main: await mainCheckout(ctx.git) }), data }
}

/**
 * What `status` prints when GitHub is unreachable (7.6, failure behavior): on the Lead's laptop
 * the Gate's local heartbeat, before the error exits 3. The runner calls it when preparing the
 * context fails with a RemoteError, the fetch of origin or `gh api user`, instead of `run`
 * (contracts 3.2, #72); `run` calls it when one of its own GitHub reads fails. So it uses only
 * `gitCommonDir` and `clock` of the context: no network, no configuration and no identity.
 * @param {Pick<CommandContext, 'gitCommonDir' | 'clock'>} ctx
 * @param {unknown} error The RemoteError; the lines are the same for any.
 * @returns {Promise<CommandResult>}
 */
export async function unreachable(ctx, error) {
  void error
  const heartbeat = await readLocalHeartbeat(ctx.gitCommonDir)
  return {
    lines: heartbeat === null ? [] : [localHeartbeatLine(heartbeat, ctx.clock.now())],
    data: { local_heartbeat: cleanStrings(heartbeat) },
  }
}

/**
 * Record up to when the member has seen the digest. That is the heartbeat time of the status
 * issue this call read, not the time of the call: the Gate publishes a digest line at its next
 * edit after the run, so a line written just before a call but published after it is still
 * shown by the next call, and both times come from the Gate's clock. Without a readable status
 * issue there is no digest, and the record stays.
 * @param {CommandContext} ctx
 * @param {string | null} seen
 */
async function recordSeen(ctx, seen) {
  if (seen === null) return
  try {
    await writeLastStatus(ctx.gitCommonDir, seen)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    ctx.out.warn(
      `the time of this status call was not recorded, so the next digest repeats lines: ${reason}`,
    )
  }
}

/**
 * The configuration and identity the runner prepared for every user command (contracts 3.6).
 * @param {CommandContext} ctx
 */
function prepared(ctx) {
  if (!ctx.config || !ctx.identity) {
    throw new Error('status needs the configuration and identity that the runner prepares')
  }
  return { config: ctx.config, identity: ctx.identity }
}

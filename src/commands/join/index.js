// `hackwin join` (7.2): every member, the Lead included, prepares each machine once. It runs the
// checklist in order and prints one pass, fail or skip line per check as it ends; a failed check
// prints its fix and the checks after it still run. A run in which every check passed writes the
// join record to local.yml, which is what "`join` is complete" means for the other commands.
// Rerunning is always safe: each step leaves what is already right as it is.

import { HackwinError, RemoteError, formatResolve, runIn } from '../../core/runtime/index.js'
import { readLocal, statePaths, writeLocal } from '../../core/state/index.js'
import { mainCheckout } from '../../core/worktrees/index.js'
import { CHECKS } from './checks.js'
import { resolveAnswers } from './settings.js'

/** @import { CommandContext, CommandResult } from '../../cli/context.js' */
/** @import { Config, Identity } from '../../core/config/index.js' */
/** @import { Resolve } from '../../core/runtime/index.js' */
/** @import { LocalRecord } from '../../core/state/index.js' */
/** @import { CheckSpec, Outcome, Scope } from './checks.js' */

/** The first word of a checklist line. */
const MARKS = Object.freeze({ passed: 'pass', failed: 'fail', skipped: 'skip' })

/** The indent of the lines under a checklist line. */
const INDENT = '      '

/**
 * @typedef {Outcome & { name: string, error?: HackwinError }} Check
 */

/**
 * @param {CommandContext} ctx
 * @returns {Promise<CommandResult>}
 */
export async function run(ctx) {
  const { config, identity } = prepared(ctx)
  const main = await mainCheckout(ctx.git)
  const previous = await ownRecord(ctx, identity.login)
  const answers = await resolveAnswers(ctx, {
    previous,
    projectLanguage: config.hackwin.project.language,
  })
  const record = previous ?? (await recordLogin(ctx, identity.login))

  /** @type {Scope} */
  const scope = { ctx, config, identity, main, git: ctx.git.with({ cwd: main }), answers, record }
  /** @type {Check[]} */
  const checks = []
  for (const spec of CHECKS) {
    const check = await runCheck(spec, scope)
    print(ctx, check)
    checks.push(check)
  }

  const failures = checks.filter((check) => check.result === 'failed')
  const remote = failures.find((check) => check.error instanceof RemoteError)
  if (remote?.error) throw remote.error

  /** @type {LocalRecord['join'] | null} */
  let joinRecord = null
  if (failures.length === 0) {
    joinRecord = { completed_at: ctx.clock.now().toISOString(), cli_version: ctx.version }
    await writeLocal(ctx.gitCommonDir, { ...scope.record, join: joinRecord })
  }
  const summary =
    failures.length === 0
      ? `join complete for ${identity.login}: every check passed; the join record is in ${statePaths(ctx.gitCommonDir).local}`
      : `join not complete: ${failures.length} of ${checks.length} checks failed (${failures.map((check) => check.name).join(', ')}); fix them, then ${runIn('hackwin join', main)}`
  return {
    exitCode: failures.length === 0 ? 0 : 1,
    lines: [summary],
    data: {
      login: identity.login,
      member: identity.member.name,
      lead: identity.isLead,
      main,
      checks: checks.map(({ error, ...check }) => check),
      join: joinRecord,
    },
  }
}

/**
 * The caller's own record of local.yml, or null when the clone has none or another login's.
 * GitHub compares logins without case.
 * @param {CommandContext} ctx
 * @param {string} login
 * @returns {Promise<LocalRecord | null>}
 */
async function ownRecord(ctx, login) {
  const record = await readLocal(ctx.gitCommonDir)
  return record !== null && record.login.toLowerCase() === login.toLowerCase() ? record : null
}

/**
 * Start the caller's record of local.yml with the login alone, before any check runs: the git
 * hooks identify the committer by it, and the hooks' self test runs them before the settings are
 * written. Another login's settings and join record do not carry over.
 * @param {CommandContext} ctx
 * @param {string} login
 * @returns {Promise<LocalRecord>}
 */
async function recordLogin(ctx, login) {
  const record = { login }
  await writeLocal(ctx.gitCommonDir, record)
  return record
}

/**
 * Run one check. A HackwinError fails the check with its message and resolve; any other error is
 * a bug and ends the command.
 * @param {CheckSpec} spec
 * @param {Scope} scope
 * @returns {Promise<Check>}
 */
async function runCheck(spec, scope) {
  try {
    return { name: spec.name, ...(await spec.run(scope)) }
  } catch (error) {
    if (!(error instanceof HackwinError)) throw error
    /** @type {Resolve[]} */
    const fixes = error.resolve === undefined ? [] : [error.resolve]
    return { name: spec.name, result: 'failed', detail: error.message, fixes, error }
  }
}

/**
 * Print the checklist line of a check, its notes and, for a failed check, its fixes.
 * @param {CommandContext} ctx
 * @param {Check} check
 */
function print(ctx, check) {
  ctx.out.line(`${MARKS[check.result]}  ${check.name}: ${check.detail}`)
  for (const note of check.notes ?? []) ctx.out.line(`${INDENT}${note}`)
  for (const fix of check.fixes ?? []) ctx.out.line(`${INDENT}fix: ${formatResolve(fix)}`)
}

/**
 * The configuration and identity the runner prepared for every user command (contracts 3.6).
 * A login outside the team has already exited 2 there, with the resolve of 7.2.
 * @param {CommandContext} ctx
 * @returns {{ config: Config, identity: Identity }}
 */
function prepared(ctx) {
  if (!ctx.config || !ctx.identity) {
    throw new Error('join needs the configuration and identity that the runner prepares')
  }
  return { config: ctx.config, identity: ctx.identity }
}

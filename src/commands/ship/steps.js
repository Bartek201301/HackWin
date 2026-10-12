// The steps of `hackwin ship` (7.9) and how they report. A step runs only when every earlier step
// succeeded. A failed step from 2 on exits 1: it names the step, its rule and its log, prints the
// last lines of the log, and nothing is pushed.

import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { BlockedError } from '../../core/runtime/errors.js'

/** @import { CommandContext } from '../../cli/context.js' */
/** @import { ProjectRun } from '../../core/project/index.js' */
/** @import { Resolve } from '../../core/runtime/errors.js' */

/**
 * @typedef {object} Step
 * @property {number} number The step of 7.9.
 * @property {string} title
 * @property {string} rule What the step enforces, with the rule it comes from.
 */

/**
 * @param {number} number
 * @param {string} title
 * @param {string} rule
 * @returns {Readonly<Step>}
 */
const step = (number, title, rule) => Object.freeze({ number, title, rule })

/** Steps 1 to 9 of 7.9: everything `ship` does before it pushes. */
export const STEPS = Object.freeze({
  sync: step(
    1,
    'fetch and sync',
    'the commits of the remote branch are merged into the local branch, never rebased (E12)',
  ),
  merge: step(
    2,
    'merge main',
    'the default branch is merged into the branch, never rebased, before any check (E12, E13)',
  ),
  scope: step(3, 'scope check', "edits stay inside the author's ownership scope (E1)"),
  secrets: step(
    4,
    'secret scan',
    'no added line matches a secret pattern and no env file is added (E6)',
  ),
  format: step(5, 'format check', 'the changed files are formatted (E14)'),
  generated: step(6, 'generated file check', 'generated files are current (E10)'),
  check: step(7, 'full check', 'commands.check passes on the merged branch (E4)'),
  acceptance: step(
    8,
    'acceptance tests',
    'every acceptance test of the task exists and passes (T5)',
  ),
  record: step(9, 'check record', 'the green check record is for the commit that was checked (E4)'),
})

/** How many lines of a failed command's log a block prints. */
const TAIL_LINES = 20

/**
 * Print the line of a step that succeeded.
 * @param {CommandContext} ctx
 * @param {Step} step
 * @param {string} text
 */
export function progress(ctx, step, text) {
  ctx.out.line(`step ${step.number}, ${step.title}: ${text}`)
}

/**
 * Stop `ship` at a failed step (exit 1). With a run, the last lines of its log are printed
 * first, and the log file, when there is one, is the last object of the block.
 * @param {CommandContext} ctx
 * @param {Step} step
 * @param {string} message
 * @param {object} options
 * @param {string[]} options.objects The files or objects involved (CM5).
 * @param {Resolve} options.resolve
 * @param {ProjectRun | null} [options.run]
 * @returns {never}
 */
export function fail(ctx, step, message, { objects, resolve: how, run = null }) {
  const tail = run ? run.tail.slice(-TAIL_LINES) : []
  for (const line of tail) ctx.out.line(`  ${line}`)
  const log = run?.logFile ?? null
  throw new BlockedError(`step ${step.number}, ${step.title}: ${message}`, {
    rule: `ship step ${step.number}: ${step.rule}`,
    objects: log === null ? objects : [...objects, `log: ${log}`],
    resolve: how,
    details: { step: step.number, title: step.title, log, tail },
  })
}

/**
 * Why a project command failed, for the message of a block.
 * @param {ProjectRun} run
 * @returns {string}
 */
export function describeRun(run) {
  if (run.timedOut) return `\`${run.command}\` timed out after ${seconds(run.durationMs)}`
  if (run.code === null) return `\`${run.command}\` was ended by a signal`
  return `\`${run.command}\` exited ${run.code}`
}

/**
 * @param {number} ms
 * @returns {string}
 */
export function seconds(ms) {
  return `${(ms / 1000).toFixed(1)} s`
}

/**
 * The log file of one step. The logs of a task stay in one directory of the temporary
 * directory, outside the worktree, and each run replaces them.
 * @param {CommandContext} ctx
 * @param {number} issue
 * @param {string} name
 * @returns {string}
 */
export function logFile(ctx, issue, name) {
  const clone = createHash('sha256').update(resolve(ctx.gitCommonDir)).digest('hex').slice(0, 12)
  const base = ctx.env.TMPDIR || tmpdir()
  return join(base, 'hackwin-ship', `${clone}-${issue}`, `${name}.log`)
}

/**
 * At most `max` items of a list, and how many more there are.
 * @param {string[]} items
 * @param {number} [max]
 * @returns {string}
 */
export function listOf(items, max = 5) {
  const shown = items.slice(0, max).join(', ')
  return items.length > max ? `${shown} and ${items.length - max} more` : shown
}

/**
 * `1 file`, `2 files`.
 * @param {number} count
 * @param {string} noun
 * @returns {string}
 */
export function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/**
 * `is` for one, `are` for more.
 * @param {number} count
 * @returns {string}
 */
export function are(count) {
  return count === 1 ? 'is' : 'are'
}

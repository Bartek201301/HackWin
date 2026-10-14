// The steps of `hackwin internal ci` (10.2) and how they report. The steps run in order and the
// first failure stops the run. A failed check is a block (exit 1) that names the step and its
// rule; a failed project command prints its whole log first, because the log disappears with the
// run's scratch directory.

import { readFile } from 'node:fs/promises'
import { BlockedError } from '../../core/runtime/errors.js'

/** @import { CommandContext } from '../../cli/context.js' */
/** @import { ProjectRun } from '../../core/project/index.js' */
/** @import { Resolve } from '../../core/runtime/errors.js' */

/**
 * @typedef {object} Step
 * @property {number} number The step of 10.2.
 * @property {string} title
 */

/**
 * @typedef {object} StepResult
 * @property {number} step
 * @property {string} title
 * @property {'passed' | 'skipped'} result `skipped` when the project has nothing to run.
 */

/**
 * @param {number} number
 * @param {string} title
 * @returns {Readonly<Step>}
 */
const step = (number, title) => Object.freeze({ number, title })

/** Steps 1 to 4 and 6 to 9 of 10.2. Step 5, the contract paths (E9), arrives with Phase 2. */
export const STEPS = Object.freeze({
  config: step(1, 'configuration'),
  link: step(2, 'task link'),
  scope: step(3, 'scope check'),
  secrets: step(4, 'secret scan'),
  generated: step(6, 'generated files'),
  merge: step(7, 'merge with the base branch'),
  format: step(8, 'format check'),
  check: step(9, 'check and acceptance tests'),
})

/** The rules the steps enforce, as their blocks name them (10.5). */
export const RULES = Object.freeze({
  E1: "E1: edits stay inside the author's ownership scope",
  E6: 'E6: no env file other than .env.example and no secret is committed',
  E10: 'E10: generated files are produced only by the Lead and are current',
  E11: 'E11: one issue, one pull request; the pull request names a valid open task',
  E13: 'E13: merge test on the current base branch before every merge',
  E14: 'E14: the changed files are formatted',
  E16: 'E16: spike/ branches are never merged',
  E19: 'E19: generated wrappers and hook shims are not edited by hand',
  T5: 'T5: a named acceptance test that does not exist counts as a failure',
})

/**
 * Print the line of a step that passed or had nothing to run, and record it.
 * @param {CommandContext} ctx
 * @param {StepResult[]} results
 * @param {Step} step
 * @param {string} text
 * @param {'passed' | 'skipped'} [result]
 */
export function report(ctx, results, step, text, result = 'passed') {
  results.push({ step: step.number, title: step.title, result })
  ctx.out.line(`step ${step.number}, ${step.title}: ${text}`)
}

/**
 * Stop the run at a failed step (exit 1). With a run, its whole log is printed first, or its
 * last lines when it has no log file.
 * @param {CommandContext} ctx
 * @param {Step} step
 * @param {string} message
 * @param {object} options
 * @param {string} options.rule
 * @param {string[]} options.objects The files or objects involved (CM5).
 * @param {Resolve} options.resolve
 * @param {ProjectRun | null} [options.run]
 * @returns {Promise<never>}
 */
export async function fail(ctx, step, message, { rule, objects, resolve, run = null }) {
  if (run) {
    ctx.out.line(`output of \`${run.command}\`:`)
    for (const line of await logOf(run)) ctx.out.line(`  ${line}`)
  }
  throw new BlockedError(`step ${step.number}, ${step.title}: ${message}`, {
    rule,
    objects,
    resolve,
    details: { step: step.number, title: step.title },
  })
}

/**
 * Why a project command failed.
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
 * `1 file`, `2 files`.
 * @param {number} count
 * @param {string} noun
 * @returns {string}
 */
export function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/**
 * The lines of a run's log file, or its last lines when it has none.
 * @param {ProjectRun} run
 * @returns {Promise<string[]>}
 */
async function logOf(run) {
  if (run.logFile) {
    try {
      return (await readFile(run.logFile, 'utf8')).replace(/\n$/, '').split('\n')
    } catch {
      // The tail below is all there is.
    }
  }
  return run.tail
}

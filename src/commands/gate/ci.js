// Stage 8, CI (9.2; G14; docs/verification.md rows 5, 14 and 16). The Gate sets
// `gate:waiting-ci` and waits until the required checks succeed on the exact head SHA. A required
// check is one that the protection read names, or, when it names none, as in soft protection, the
// check `hackwin` of the CI workflow. The Gate reads the check runs of the head SHA: the newest
// run of each required check's name, from the app the check is pinned to. A green required check
// never stands in for the Gate's own stages; they ran before this one.
//
// A failed required check reruns the failed jobs of its workflow run with
// `gh run rerun <run-id> --failed`, at most `gate.ci_rerun_limit` times per head SHA. When no
// rerun is left, the Gate reads the failed log (`gh run view <run-id> --log-failed`) for the known
// flaky tests: a named one gives the result `flaky`, which does not blame the pull request and
// raises a repeated failure attention item; otherwise the run fails with the reason `ci-failed`.
// A rerun that GitHub refuses leaves no rerun: the run fails, and the Lead may type `retry`
// (5.6). After `gate.ci_timeout_minutes` without success the run fails with `ci-timeout`.

import { join } from 'node:path'
import { REQUIRED_CHECK } from '../../core/protection/index.js'
import { RemoteError } from '../../core/runtime/index.js'
import { namedFlakyTests } from './flaky.js'
import {
  IN_MAIN_CHECKOUT,
  STOP,
  count,
  listed,
  messageOf,
  pause,
  setGateLabels,
  takeCommand,
} from './pulls.js'
import { writeAtomic } from './state.js'

/** @import { GitHub } from '../../core/github/index.js' */
/** @import { Protection, RequiredCheck } from '../../core/protection/index.js' */
/** @import { Failure } from './pulls.js' */
/** @import { PullRun } from './stages.js' */

/** The longest wait between two looks at the checks: a poll interval, at most this. */
const CI_WAIT_MS = 30_000

/** The conclusions of a check run that GitHub counts as passed. */
const PASSED = Object.freeze(['success', 'neutral', 'skipped'])

/**
 * A check run of the head SHA, as GitHub returns it.
 * @typedef {object} CheckRun
 * @property {number} id
 * @property {string} name
 * @property {string} status `queued`, `in_progress` or `completed`.
 * @property {string | null} conclusion
 * @property {{ id: number } | null} [app]
 * @property {string | null} [details_url]
 * @property {string | null} [html_url]
 */

/**
 * Where the required checks stand.
 * @typedef {object} ChecksLook
 * @property {boolean} passed Every required check passed.
 * @property {CheckRun[]} failed The required checks whose newest run failed.
 * @property {string[]} pending The required checks without a finished run, with their state.
 */

/**
 * The required checks of a protection read; the check `hackwin` when it names none.
 * @param {Protection} protection
 * @returns {RequiredCheck[]}
 */
export function requiredChecks(protection) {
  const named = protection.rules.requiredChecks
  return named.length > 0 ? named : [{ context: REQUIRED_CHECK, integrationId: null }]
}

/**
 * Stage 8.
 * @param {PullRun} run
 * @returns {Promise<Failure | typeof STOP | void>}
 */
export async function ciStage(run) {
  const { gate, pr, sha, record } = run
  const { github } = gate.ctx
  const { clock } = gate.ctx
  if (!(await run.act(() => setGateLabels(github, pr, ['gate:waiting-ci'])))) return STOP
  const required = requiredChecks(gate.protection)
  const names = listed(required.map((check) => `\`${check.context}\``))
  const settings = run.config.hackwin.gate
  const timeoutMs = settings.ci_timeout_minutes * 60_000
  const waitMs = Math.min(CI_WAIT_MS, settings.poll_seconds * 1000)
  const started = clock.now().getTime()
  /** The check runs that a rerun replaces: they no longer count once it was asked for. */
  const replaced = new Set()
  let announced = false
  /** @type {ChecksLook | null} */
  let last = null

  for (;;) {
    if (gate.stopping || run.superseded()) return STOP
    /** @type {ChecksLook | null} */
    let look = null
    try {
      look = lookAt(await checkRuns(github, sha), required, replaced)
      last = look
    } catch (error) {
      if (!(error instanceof RemoteError)) throw error
      gate.line(
        `#${pr} stage 8, ci: the checks were not readable, the Gate looks again: ${messageOf(error)}`,
      )
    }
    if (look?.passed) return
    if (look !== null && look.failed.length > 0) {
      if (record.ci_reruns >= settings.ci_rerun_limit) return blame(run, look.failed, null)
      const rerun = await rerunFailed(run, look.failed)
      if (rerun !== null) return blame(run, look.failed, rerun)
      if (run.superseded()) return STOP
      record.ci_reruns += 1
      for (const check of look.failed) replaced.add(check.id)
      await gate.save()
      gate.line(
        `#${pr} stage 8, ci: ${listed(look.failed.map((check) => `\`${check.name}\``))} failed on head ${sha}; rerun ${record.ci_reruns} of the failed jobs started`,
      )
    } else if (!announced && look !== null) {
      announced = true
      gate.line(
        `#${pr} passed stages 1 to 7 with head ${sha}; stage 8 waits for the required ${required.length === 1 ? 'check' : 'checks'} ${names} on it`,
      )
    }
    const left = started + timeoutMs - clock.now().getTime()
    if (left <= 0) return ciTimeout(run, required, last)
    await pause(run, Math.min(waitMs, left))
  }
}

/**
 * Every check run of a commit.
 * @param {GitHub} github
 * @param {string} sha
 * @returns {Promise<CheckRun[]>}
 */
async function checkRuns(github, sha) {
  /** @type {CheckRun[]} */
  const runs = []
  for (let page = 1; page <= 10; page += 1) {
    const answer = await github.api(`repos/{owner}/{repo}/commits/${sha}/check-runs`, {
      query: { per_page: 100, page },
    })
    const batch = Array.isArray(answer?.check_runs) ? answer.check_runs : []
    runs.push(...batch)
    if (batch.length < 100) break
  }
  return runs
}

/**
 * Where the required checks stand: the newest run of each, from its pinned app, leaving out the
 * runs that a rerun replaces.
 * @param {CheckRun[]} runs
 * @param {RequiredCheck[]} required
 * @param {Set<number>} replaced
 * @returns {ChecksLook}
 */
function lookAt(runs, required, replaced) {
  /** @type {CheckRun[]} */
  const failed = []
  /** @type {string[]} */
  const pending = []
  for (const check of required) {
    const newest = runs
      .filter(
        (each) =>
          each.name === check.context &&
          (check.integrationId === null || each.app?.id === check.integrationId) &&
          !replaced.has(each.id),
      )
      .sort((a, b) => b.id - a.id)[0]
    if (!newest) pending.push(`\`${check.context}\`: no run yet`)
    else if (newest.status !== 'completed') pending.push(`\`${check.context}\`: ${newest.status}`)
    else if (!PASSED.includes(newest.conclusion ?? '')) failed.push(newest)
  }
  return { passed: failed.length === 0 && pending.length === 0, failed, pending }
}

/**
 * The workflow run of a check run from GitHub Actions, from its link
 * `https://github.com/<owner>/<repo>/actions/runs/<run-id>/job/<job-id>`, or null.
 * @param {CheckRun} check
 * @returns {number | null}
 */
function workflowRunOf(check) {
  for (const url of [check.details_url, check.html_url]) {
    const id = /\/actions\/runs\/(\d+)(?:\/|$)/.exec(url ?? '')?.[1]
    if (id) return Number(id)
  }
  return null
}

/**
 * Rerun the failed jobs of the workflow runs of the failed checks (docs/verification.md row 16).
 * @param {PullRun} run
 * @param {CheckRun[]} failed
 * @returns {Promise<string | null>} Why no rerun started, or null when every one started.
 */
async function rerunFailed(run, failed) {
  const { github } = run.gate.ctx
  const ids = [...new Set(failed.map(workflowRunOf))]
  if (ids.includes(null)) {
    const names = failed.filter((check) => workflowRunOf(check) === null).map((check) => check.name)
    return `the failed ${names.length === 1 ? 'check' : 'checks'} ${listed(names.map((name) => `\`${name}\``))} ${names.length === 1 ? 'names' : 'name'} no workflow run of GitHub Actions to rerun`
  }
  for (const id of ids) {
    try {
      await github.run(['run', 'rerun', String(id), '--failed'])
    } catch (error) {
      if (!(error instanceof RemoteError)) throw error
      return `GitHub refused the rerun of workflow run ${id}: ${messageOf(error)}`
    }
  }
  return null
}

/**
 * The failure of failed required checks with no rerun left: `flaky` when the failed log names a
 * known flaky test, `ci-failed` otherwise.
 * @param {PullRun} run
 * @param {CheckRun[]} failed
 * @param {string | null} noRerun Why the rerun did not start, when it did not.
 * @returns {Promise<Failure>}
 */
async function blame(run, failed, noRerun) {
  const { gate, pr, sha, record } = run
  const known = run.config.hackwin.gate.known_flaky_tests
  const links = failed.map((check) => {
    const url = check.details_url ?? check.html_url
    return `\`${check.name}\`: ${check.conclusion ?? 'failed'}${url ? `, ${url}` : ''}`
  })
  const reruns = count(record.ci_reruns, 'rerun', 'reruns')
  const named = noRerun === null && known.length > 0 ? await flakyInLogs(run, failed) : []
  if (named.length > 0) {
    return {
      result: 'flaky',
      labels: [],
      reason: `the required ${failed.length === 1 ? 'check' : 'checks'} failed on head \`${sha}\` after ${reruns}, and the failed log names the known flaky test ${named.map((test) => `\`${test}\``).join(', ')} (\`gate.known_flaky_tests\`). The pull request is not blamed (G14).`,
      details: links,
      next: `nothing for the author. The Lead asks for a fix of the flaky test, a task for the role that owns it, and types \`retry ${pr}\` in the Gate terminal to test this head again.`,
      note: `flaky: ${named.join(', ')}`,
      attention: {
        type: 'repeated-failure',
        todo: `the known flaky test ${listed(named)} failed again in CI of #${pr} after ${reruns}; write a task to fix the test, then type \`retry ${pr}\``,
      },
    }
  }
  const why = noRerun === null ? `after ${reruns}` : `and no rerun started: ${noRerun}`
  return {
    result: 'failed',
    labels: [],
    reason: `the required ${failed.length === 1 ? 'check' : 'checks'} failed on head \`${sha}\` ${why} (\`ci-failed\`):`,
    details: links,
    next: `the author fixes the failure that the CI log shows: ${takeCommand(run.task)} ${IN_MAIN_CHECKOUT} resumes the task; the session fixes it and runs \`hackwin ship\`.${noRerun === null ? '' : ` If the failure has nothing to do with the pull request, the Lead types \`retry ${pr}\` in the Gate terminal.`}`,
    note: 'ci-failed',
  }
}

/**
 * The known flaky tests that the failed logs of the failed checks' workflow runs name. Each log
 * stays in the Gate's log directory. A log that is not readable names none.
 * @param {PullRun} run
 * @param {CheckRun[]} failed
 * @returns {Promise<string[]>}
 */
async function flakyInLogs(run, failed) {
  const { gate, pr, sha } = run
  const known = run.config.hackwin.gate.known_flaky_tests
  /** @type {Set<string>} */
  const named = new Set()
  for (const id of new Set(failed.map(workflowRunOf))) {
    if (id === null) continue
    try {
      const { stdout } = await gate.ctx.github.run(['run', 'view', String(id), '--log-failed'])
      await writeAtomic(
        join(gate.files.logs, `pr-${pr}`, `${sha.slice(0, 12)}-ci-run-${id}.log`),
        stdout,
      )
      for (const test of namedFlakyTests(stdout, known)) named.add(test)
    } catch (error) {
      if (!(error instanceof RemoteError)) throw error
      gate.line(
        `#${pr} stage 8, ci: the failed log of workflow run ${id} is not readable: ${messageOf(error)}`,
      )
    }
  }
  return [...named]
}

/**
 * The failure after `gate.ci_timeout_minutes` without success.
 * @param {PullRun} run
 * @param {RequiredCheck[]} required
 * @param {ChecksLook | null} last
 * @returns {Failure}
 */
function ciTimeout(run, required, last) {
  const minutes = run.config.hackwin.gate.ci_timeout_minutes
  const waiting =
    last === null ? required.map((check) => `\`${check.context}\`: not readable`) : last.pending
  return {
    result: 'failed',
    labels: [],
    reason: `the required checks did not succeed on head \`${run.sha}\` within \`gate.ci_timeout_minutes\`, ${minutes} min (\`ci-timeout\`). Still waiting for:`,
    details: waiting,
    next: `nothing for the author unless CI shows a failure of the pull request. Once CI has run on this head, the Lead types \`retry ${run.pr}\` in the Gate terminal; if CI does not start, the Lead looks at the Actions tab of the repository.`,
    note: 'ci-timeout',
  }
}

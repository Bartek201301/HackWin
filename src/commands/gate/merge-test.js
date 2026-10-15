// Stage 7, the merge test (9.2; G13, G14; A11, A44). The Gate merges the head into the main that
// stage 6 checked, in its scratch worktree (scratch.js), installs from the cache when the lockfile
// hash matches, and runs `commands.check` and the task's acceptance tests with `commands.test`.
// Each command stops after `gate.step_timeout_minutes`, and the run then fails with the reason
// `step-timeout`. A failed command fails the run with the command and the last lines of its log in
// the comment; the full log stays in the Gate's log directory. A command whose log names a known
// flaky test runs again, up to `gate.ci_rerun_limit` times; when it fails again the result is
// `flaky` and the pull request is not blamed.
//
// Two pull requests that pass alone and fail together are caught here, because the merge test
// always merges with the newest main (semantic conflicts, 9.2). A new head SHA or `quit` ends the
// run after the command under way: `src/core/project` offers no way to stop a command early.

import { join } from 'node:path'
import { runAcceptanceTests, runCheck } from '../../core/project/index.js'
import { parseTaskBlock } from '../../core/tasks/index.js'
import { inlineCode } from './comment.js'
import { namedFlakyTests } from './flaky.js'
import { IN_MAIN_CHECKOUT, STOP, capped, count, listed, retrying, takeCommand } from './pulls.js'
import { closeScratch, installInScratch, openScratch, projectEnv } from './scratch.js'
import { readText } from './state.js'

/** @import { ProjectRun } from '../../core/project/index.js' */
/** @import { CommentLog } from './comment.js' */
/** @import { Failure } from './pulls.js' */
/** @import { PullRun } from './stages.js' */

/** How long a log line in a comment may be. */
const MAX_LINE = 300

/**
 * What a step of the merge test runs: the command's result, the acceptance tests that do not
 * exist, or nothing when the step has nothing to run.
 * @typedef {ProjectRun | { missing: string[] } | null} StepOutcome
 */

/**
 * Stage 7.
 * @param {PullRun} run
 * @returns {Promise<Failure | typeof STOP | void>}
 */
export async function mergeTestStage(run) {
  const { gate, pr, sha, main, config } = run
  const tests = await acceptanceTests(run)
  if (tests === STOP) return STOP
  if (!Array.isArray(tests)) return tests
  run.record.tested_main_sha = main
  const timeoutMs = config.hackwin.gate.step_timeout_minutes * 60_000
  const env = projectEnv(gate.ctx.env)
  const scratch = await openScratch(gate, main)
  try {
    const merge = await scratch.git.merge(sha, {
      noFastForward: true,
      message: `Merge #${pr} for the merge test of the HackWin Gate`,
    })
    if (merge.status === 'conflict') {
      return {
        result: 'needs-owner',
        labels: ['needs-owner'],
        reason: `the merge of the head with main conflicts in ${count(merge.conflicts.length, 'file', 'files')}, although stage 6 found no conflict:`,
        details: capped(merge.conflicts.map((file) => `\`${file}\``)),
        next: `the author resolves the conflicts: ${takeCommand(run.task)} ${IN_MAIN_CHECKOUT} resumes the task; the session merges main, resolves the conflicts in its files and runs \`hackwin ship\` (9.3).`,
        note: `merge test: conflict in ${count(merge.conflicts.length, 'file', 'files')}`,
      }
    }

    const install = await step(run, 'install', async (logFile) => {
      const installed = await installInScratch(gate, scratch, { config, timeoutMs, logFile, env })
      if (installed.cached) gate.line(`#${pr} stage 7, merge test: the install came from the cache`)
      if (installed.notice) gate.line(`#${pr} stage 7, merge test: ${installed.notice}`)
      return installed.run
    })
    if (install !== undefined) return install

    const check = await step(run, 'check', (logFile) =>
      runCheck({ cwd: scratch.path, config, timeoutMs, logFile, env }),
    )
    if (check !== undefined) return check

    return await step(run, 'acceptance', async (logFile) => {
      const result = await runAcceptanceTests({
        cwd: scratch.path,
        config,
        files: tests,
        timeoutMs,
        logFile,
        env,
      })
      return result.missing.length > 0 ? { missing: result.missing } : result.run
    })
  } finally {
    await closeScratch(gate)
  }
}

/**
 * The acceptance tests of the task the pull request names, read again from its issue: the block
 * may have changed since stage 2.
 * @param {PullRun} run
 * @returns {Promise<string[] | Failure | typeof STOP>}
 */
async function acceptanceTests(run) {
  const { gate, task } = run
  if (task === null) throw new Error('stage 7 runs only after stage 2 found the task')
  const issue = await retrying(run, 'stage 7, merge test', () => gate.ctx.github.getIssue(task))
  if (issue === STOP) return STOP
  const parsed = issue === null ? null : parseTaskBlock(issue.body, run.config)
  if (parsed !== null && parsed.isTask && parsed.valid) return parsed.block.acceptance_tests
  const why =
    parsed === null
      ? 'does not exist'
      : parsed.isTask && !parsed.valid
        ? `has no valid task block: ${parsed.errors.join('; ')}`
        : 'has no task block'
  return {
    result: 'failed',
    labels: [],
    reason: `the task #${task} ${why}, so the Gate does not know its acceptance tests (8.1)`,
    details: [],
    next: `ask the Lead to fix the task block of #${task}, then to type \`retry ${run.pr}\` in the Gate terminal`,
    note: 'merge test: no valid task block',
  }
}

/**
 * Run one step of the merge test, and run it again while its log names a known flaky test, up to
 * `gate.ci_rerun_limit` times (G14). Nothing when it passes; otherwise the failure, or STOP after
 * `quit` or a new head SHA.
 * @param {PullRun} run
 * @param {'install' | 'check' | 'acceptance'} name
 * @param {(logFile: string) => Promise<StepOutcome>} execute
 * @returns {Promise<Failure | typeof STOP | undefined>}
 */
async function step(run, name, execute) {
  const { gate, pr } = run
  const { ci_rerun_limit: limit, known_flaky_tests: flaky } = run.config.hackwin.gate
  for (let attempt = 0; ; attempt += 1) {
    if (gate.stopping || run.superseded()) return STOP
    const file = logName(run, name, attempt)
    const outcome = await execute(join(gate.files.root, file))
    if (outcome === null) return undefined
    if ('missing' in outcome) return missingTests(run, outcome.missing)
    if (outcome.ok) return undefined
    const named = outcome.timedOut
      ? []
      : namedFlakyTests((await readText(join(gate.files.root, file))) ?? '', flaky)
    if (named.length > 0 && attempt < limit) {
      run.reruns += 1
      gate.line(
        `#${pr} stage 7, merge test: ${inlineCode(outcome.command)} failed and its log names the known flaky test ${listed(named)}, so it runs again`,
      )
      continue
    }
    return commandFailure(run, { name, outcome, file, named, attempts: attempt + 1 })
  }
}

/**
 * The failure of a command of the merge test.
 * @param {PullRun} run
 * @param {{ name: 'install' | 'check' | 'acceptance', outcome: ProjectRun, file: string, named: string[], attempts: number }} failed
 * @returns {Failure}
 */
function commandFailure(run, { name, outcome, file, named, attempts }) {
  const { pr, main } = run
  const minutes = run.config.hackwin.gate.step_timeout_minutes
  const what = { install: 'the install', check: 'the check', acceptance: 'the acceptance tests' }[
    name
  ]
  /** @type {CommentLog} */
  const log = {
    command: outcome.command,
    outcome: outcome.timedOut
      ? `stopped after ${minutes} min`
      : outcome.code === null
        ? 'ended by a signal'
        : `exit ${outcome.code}`,
    tail: outcome.tail.map((line) =>
      line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line,
    ),
    file: `.git/hackwin/gate/${file}`,
  }
  const fix = `${takeCommand(run.task)} ${IN_MAIN_CHECKOUT} resumes the task; the session merges main, fixes it and runs \`hackwin ship\``
  if (outcome.timedOut) {
    return {
      result: 'failed',
      labels: [],
      reason: `${what} ran longer than \`gate.step_timeout_minutes\`, ${minutes} min, on the merge of the head with main \`${main}\`, and was stopped (\`step-timeout\`)`,
      details: [],
      log,
      next: `if the pull request makes ${what} slow or hang, the author fixes it: ${fix}. If it hangs only now and then, the Lead types \`retry ${pr}\` in the Gate terminal.`,
      note: `step-timeout: ${name}`,
    }
  }
  if (named.length > 0) {
    return {
      result: 'flaky',
      labels: [],
      reason: `${what} failed ${count(attempts, 'time', 'times')} on the merge of the head with main \`${main}\`, and its log names the known flaky test ${named.map((test) => `\`${test}\``).join(', ')} (\`gate.known_flaky_tests\`). The pull request is not blamed (G14).`,
      details: [],
      log,
      next: `nothing for the author. The Lead asks for a fix of the flaky test, a task for the role that owns it, and types \`retry ${pr}\` in the Gate terminal to test this head again.`,
      note: `flaky: ${named.join(', ')}`,
      attention: {
        type: 'repeated-failure',
        todo: `the known flaky test ${listed(named)} failed again in the merge test of #${pr} after ${count(attempts - 1, 'rerun', 'reruns')}; write a task to fix the test, then type \`retry ${pr}\``,
      },
    }
  }
  return {
    result: 'failed',
    labels: [],
    reason: `${what} failed on the merge of the head with main \`${main}\`. A head that passes alone can fail here when a change merged on main meanwhile does not fit it (9.2, semantic conflicts).`,
    details: [],
    log,
    next: `when the fix lies in the pull request's own files, the author makes it there: ${fix}. When it lies in another role's files, the author asks the Lead for a task for that role (I14) and ships again once that fix is merged. Nothing is committed on main directly (A44, G19).`,
    note: `merge test: ${name} failed`,
  }
}

/**
 * The failure of acceptance tests that do not exist in the merge (T5).
 * @param {PullRun} run
 * @param {string[]} missing
 * @returns {Failure}
 */
function missingTests(run, missing) {
  return {
    result: 'failed',
    labels: [],
    reason: `the task #${run.task} names ${count(missing.length, 'acceptance test that is', 'acceptance tests that are')} no file of the merge of the head with main, and every entry of \`acceptance_tests\` is a file path (T5):`,
    details: capped(missing.map((path) => `\`${path}\``)),
    next: `the author adds the tests: ${takeCommand(run.task)} ${IN_MAIN_CHECKOUT} resumes the task; the session writes them and runs \`hackwin ship\`. If the task block names the wrong files, the Lead fixes it and types \`retry ${run.pr}\` in the Gate terminal.`,
    note: 'merge test: acceptance tests missing',
  }
}

/**
 * The log of a step, relative to the Gate's directory: one per head, main, step and attempt.
 * @param {PullRun} run
 * @param {string} name
 * @param {number} attempt
 * @returns {string}
 */
function logName(run, name, attempt) {
  const again = attempt === 0 ? '' : `-rerun-${attempt}`
  return `logs/pr-${run.pr}/${run.sha.slice(0, 12)}-on-${run.main.slice(0, 12)}-${name}${again}.log`
}

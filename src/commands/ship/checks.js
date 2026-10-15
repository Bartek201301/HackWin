// Steps 3 to 9 of `ship` (7.9): the checks of the branch's own changes against the merged main,
// in a fixed order, then the green check record of the commit they ran on. They use only local
// data and the task issue that step 1 read. A commit that already has its green check record
// is not checked again: a rerun after a failure in steps 10 to 14 goes on with the record.

import { join } from 'node:path'
import { scopeCheck } from '../../core/config/index.js'
import {
  formatCheck,
  generatedFileCheck,
  runAcceptanceTests,
  runCheck,
} from '../../core/project/index.js'
import { quoteShellArg } from '../../core/runtime/exec.js'
import { formatFinding, scanDiff } from '../../core/secrets/index.js'
import { isGreen, readCheckRecord, statePaths, writeCheckRecord } from '../../core/state/index.js'
import {
  STEPS,
  are,
  describeRun,
  fail,
  listOf,
  logFile,
  plural,
  progress,
  seconds,
} from './steps.js'

/** @import { CommandContext } from '../../cli/context.js' */
/** @import { Config, Identity } from '../../core/config/index.js' */
/** @import { DiffRange } from '../../core/git/index.js' */
/** @import { CheckResult } from '../../core/state/index.js' */
/** @import { TaskWorktree } from '../../core/worktrees/index.js' */
/** @import { Synced } from './sync.js' */

/**
 * @typedef {object} Checked
 * @property {CheckResult[]} checks Steps 3 to 8, each `passed` or `skipped`.
 * @property {string[]} outsideTask Changed paths inside the author's roles but outside the
 *   task's paths: a warning only (A15).
 * @property {string} record The file of the green check record.
 * @property {string} recordedAt When the checks passed: the `created_at` of the record.
 * @property {boolean} reused True when the checks did not run again because the head commit
 *   already had its green check record.
 */

/**
 * The green check record of the head commit for this task, written by an earlier `ship` whose
 * later steps failed. The checks then do not run again for the same commit (7.9, failure
 * behavior). A record of the same commit for another task does not count: its acceptance tests
 * were others. Nor does a record that another version of hackwin wrote: its checks may differ.
 * @param {CommandContext} ctx
 * @param {TaskWorktree} worktree
 * @param {Synced} synced
 * @returns {Promise<Checked | null>} Null when the head commit has no green record of this task.
 */
export async function recordedChecks(ctx, worktree, synced) {
  const { head, task } = synced
  const record = await readCheckRecord(ctx.gitCommonDir, head)
  if (record === null || !isGreen(record, head)) return null
  if (record.issue !== task.number || record.branch !== worktree.branch) return null
  if (record.cli_version !== ctx.version) {
    ctx.out.line(
      `steps 3 to 9, checks: the green check record of ${head} was written by hackwin ${record.cli_version}, not ${ctx.version}, so the checks run again`,
    )
    return null
  }
  ctx.out.line(
    `steps 3 to 9, checks: passed for ${head} at ${record.created_at}, so they do not run again`,
  )
  return {
    checks: record.checks,
    outsideTask: [],
    record: join(statePaths(ctx.gitCommonDir).checks, `${head}.json`),
    recordedAt: record.created_at,
    reused: true,
  }
}

/**
 * Steps 3 to 9. Each failed step exits 1 and names itself; nothing is written then.
 * @param {CommandContext} ctx
 * @param {TaskWorktree} worktree
 * @param {Synced} synced
 * @returns {Promise<Checked>}
 */
export async function runChecks(ctx, worktree, synced) {
  const config = /** @type {Config} */ (ctx.config)
  const identity = /** @type {Identity} */ (ctx.identity)
  const { task, mainSha, mainRef, head } = synced
  const cwd = worktree.path
  /** @type {DiffRange} The branch's own changes since the merged main. */
  const range = { base: mainSha, head, threeDot: true }
  const changed = await ctx.git.changedFiles(range)
  /** @type {CheckResult[]} */
  const checks = []

  // Step 3: the scope of the author's roles blocks, the task's paths only warn (A15).
  const paths = [...new Set(changed.flatMap((file) => [file.oldPath ?? file.path, file.path]))]
  const scope = scopeCheck(config, {
    login: identity.login,
    files: paths,
    taskPaths: task.block.paths,
  })
  if (scope.violations.length > 0) {
    const objects = scope.violations.map(
      ({ path, role, holder }) => `${path} (role ${role}, held by ${holder ?? 'nobody'})`,
    )
    fail(
      ctx,
      STEPS.scope,
      `${plural(scope.violations.length, 'changed file')} of the branch ${are(scope.violations.length)} outside the roles of ${identity.login} (${identity.roles.join(', ') || 'none'})`,
      {
        objects,
        resolve: `undo the branch's changes to these files against ${mainRef}, or ask the holder of their role for the change`,
      },
    )
  }
  if (scope.outsideTask.length > 0) {
    ctx.out.warn(
      `${plural(scope.outsideTask.length, 'changed file')} outside the paths of task #${task.number}, inside your roles (A15): ${listOf(scope.outsideTask)}`,
    )
  }
  checks.push({ name: 'scope', result: 'passed' })
  progress(ctx, STEPS.scope, `passed for ${plural(paths.length, 'changed file')}`)

  // Step 4.
  const findings = await scanDiff(ctx.git, range, {
    extraPatterns: config.hackwin.gate?.secret_patterns ?? [],
  })
  if (findings.length > 0) {
    fail(
      ctx,
      STEPS.secrets,
      `${plural(findings.length, 'finding')} in the branch's added lines and files`,
      {
        objects: findings.map(formatFinding),
        resolve:
          'take the secret or env file out of every commit of the branch that is not pushed yet, not only out of the last one, and keep secrets in .env.local; revoke a secret that was pushed before',
      },
    )
  }
  checks.push({ name: 'secrets', result: 'passed' })
  progress(ctx, STEPS.secrets, 'passed')

  // Step 5: only the changed files that still exist (E14).
  const present = changed.filter((file) => file.status !== 'D').map((file) => file.path)
  const format = await formatCheck({ cwd, config, files: present })
  if (format.unformatted.length > 0) {
    const command = [config.hackwin.commands.format, ...format.unformatted.map(quoteShellArg)]
    const count = format.unformatted.length
    fail(ctx, STEPS.format, `${plural(count, 'changed file')} ${are(count)} not formatted`, {
      objects: format.unformatted,
      resolve: { command: command.join(' '), dir: cwd },
    })
  }
  if (format.run && !format.run.ok) {
    fail(ctx, STEPS.format, `the format command failed: ${describeRun(format.run)}`, {
      objects: [format.run.command],
      resolve: { command: format.run.command, dir: cwd },
      run: format.run,
    })
  }
  checks.push({ name: 'format', result: 'passed' })
  progress(
    ctx,
    STEPS.format,
    format.run
      ? `passed for ${plural(present.length, 'file')}`
      : 'passed, no changed file to format',
  )

  // Step 6.
  const generated = await generatedFileCheck({ cwd, config, git: ctx.git })
  if (generated.changed.length > 0) {
    const count = generated.changed.length
    fail(
      ctx,
      STEPS.generated,
      `${plural(count, 'generated file')} ${are(count)} stale on the branch: \`${config.hackwin.commands.generate}\` changes ${count === 1 ? 'it' : 'them'}`,
      {
        objects: generated.changed,
        resolve:
          "generated files come only from the Lead: undo the branch's change that makes them stale, or ask the Lead to regenerate them on main",
      },
    )
  }
  if (generated.run && !generated.run.ok) {
    fail(ctx, STEPS.generated, `the generate command failed: ${describeRun(generated.run)}`, {
      objects: [generated.run.command],
      resolve: { command: generated.run.command, dir: cwd },
      run: generated.run,
    })
  }
  checks.push({ name: 'generated', result: generated.run ? 'passed' : 'skipped' })
  progress(
    ctx,
    STEPS.generated,
    generated.run ? 'passed' : 'skipped, hackwin.yml sets no commands.generate',
  )

  // Step 7.
  const check = await runCheck({ cwd, config, logFile: logFile(ctx, task.number, 'check') })
  if (!check.ok) {
    fail(ctx, STEPS.check, describeRun(check), {
      objects: [],
      resolve: { command: check.command, dir: cwd },
      run: check,
    })
  }
  checks.push({ name: 'check', result: 'passed', duration_ms: check.durationMs })
  progress(ctx, STEPS.check, `passed in ${seconds(check.durationMs)}`)

  // Step 8: every entry is a file path, and one that is not an existing file fails (T5).
  const tests = task.block.acceptance_tests
  const acceptance = await runAcceptanceTests({
    cwd,
    config,
    files: tests,
    logFile: logFile(ctx, task.number, 'acceptance'),
  })
  if (acceptance.missing.length > 0) {
    fail(
      ctx,
      STEPS.acceptance,
      `${plural(acceptance.missing.length, 'acceptance test')} of issue #${task.number} ${acceptance.missing.length === 1 ? 'is not an existing file' : 'are not existing files'} on the branch`,
      {
        objects: acceptance.missing,
        resolve: `add these test files on the branch, or ask the Lead to correct acceptance_tests in issue #${task.number}`,
      },
    )
  }
  if (acceptance.run && !acceptance.ok) {
    fail(ctx, STEPS.acceptance, describeRun(acceptance.run), {
      objects: tests,
      resolve: { command: acceptance.run.command, dir: cwd },
      run: acceptance.run,
    })
  }
  const ran = acceptance.run
  checks.push(
    ran
      ? { name: 'acceptance', result: 'passed', duration_ms: ran.durationMs }
      : { name: 'acceptance', result: 'passed' },
  )
  progress(
    ctx,
    STEPS.acceptance,
    ran
      ? `${plural(tests.length, 'file')} passed in ${seconds(ran.durationMs)}`
      : 'passed, the task names none',
  )

  // Step 9: the record is for the commit the checks ran on.
  const now = await ctx.git.revParse('HEAD')
  if (now !== head) {
    fail(ctx, STEPS.record, `HEAD moved from ${head} to ${now} while the checks ran`, {
      objects: [worktree.branch],
      resolve: { command: 'hackwin ship', dir: cwd },
    })
  }
  const recordedAt = ctx.clock.now().toISOString()
  await writeCheckRecord(ctx.gitCommonDir, {
    sha: head,
    branch: worktree.branch,
    issue: task.number,
    created_at: recordedAt,
    cli_version: ctx.version,
    checks,
  })
  const record = join(statePaths(ctx.gitCommonDir).checks, `${head}.json`)
  progress(ctx, STEPS.record, `written for ${head}`)

  return { checks, outsideTask: scope.outsideTask, record, recordedAt, reused: false }
}

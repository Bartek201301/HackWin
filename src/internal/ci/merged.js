// Steps 6 to 9 of `hackwin internal ci` (10.2), in a scratch worktree outside the checkout that is
// removed afterwards: the generated files of the head commit (E19); the head merged with the
// current base branch, installed and regenerated without a change to any tracked file (E10, E13);
// the format check of the pull request's own changed files (E14); `commands.check` and the task's
// acceptance tests on the merged tree (E13, T5).

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  formatCheck,
  generatedFileCheck,
  runAcceptanceTests,
  runCheck,
  runInstall,
} from '../../core/project/index.js'
import { quoteShellArg } from '../../core/runtime/exec.js'
import { staleGeneratedFiles } from '../../generate/index.js'
import { RULES, STEPS, describeRun, fail, plural, report, seconds } from './steps.js'

/** @import { CommandContext } from '../../cli/context.js' */
/** @import { Config } from '../../core/config/index.js' */
/** @import { ChangedFile, Git } from '../../core/git/index.js' */
/** @import { PullRequest } from '../../core/github/index.js' */
/** @import { TaskBlock } from '../../core/tasks/index.js' */
/** @import { StaleFile } from '../../generate/index.js' */
/** @import { StepResult } from './steps.js' */

/** The author of the merge commit, which never leaves the scratch worktree. */
const MERGE_IDENTITY = Object.freeze({
  GIT_AUTHOR_NAME: 'hackwin ci',
  GIT_AUTHOR_EMAIL: 'hackwin-ci@users.noreply.invalid',
  GIT_COMMITTER_NAME: 'hackwin ci',
  GIT_COMMITTER_EMAIL: 'hackwin-ci@users.noreply.invalid',
})

/**
 * @typedef {object} MergedInput
 * @property {PullRequest} pull
 * @property {Config} config The configuration of the base branch.
 * @property {string} head The head commit of the pull request.
 * @property {string} baseRef `origin/<base branch>`, just fetched.
 * @property {ChangedFile[]} changed The pull request's own changes, the three-dot diff.
 * @property {TaskBlock & { number: number }} block The block of the task the pull request closes.
 */

/**
 * Steps 6 to 9.
 * @param {CommandContext} ctx
 * @param {StepResult[]} results
 * @param {MergedInput} input
 * @returns {Promise<void>}
 */
export async function checkMergedTree(ctx, results, input) {
  const base = ctx.env.TMPDIR || tmpdir()
  await mkdir(base, { recursive: true })
  const scratch = await mkdtemp(join(base, 'hackwin-ci-'))
  const tree = join(scratch, 'tree')
  // No hook of the clone runs for the scratch worktree or its merge.
  const quiet = ctx.git.with({ hooksOff: true })
  try {
    await quiet.worktreeAdd(tree, { detach: true, startPoint: input.head })
    const git = quiet.with({ cwd: tree, env: { ...ctx.env, ...MERGE_IDENTITY } })
    await checkGenerated(ctx, results, tree)
    await mergeAndRegenerate(ctx, results, { ...input, git, tree, logs: join(scratch, 'logs') })
    await checkFormat(ctx, results, { ...input, tree })
    await checkProject(ctx, results, { ...input, tree, logs: join(scratch, 'logs') })
  } finally {
    await quiet.worktreeRemove(tree, { force: true }).catch(() => {})
    await rm(scratch, { recursive: true, force: true })
    await quiet.run(['worktree', 'prune'], { allowFailure: true })
  }
}

/**
 * Step 6: every file of the manifest in the head commit equals the output of the running CLI,
 * which step 1 made sure is the version the pull request is checked with (E19, A48).
 * @param {CommandContext} ctx
 * @param {StepResult[]} results
 * @param {string} tree The scratch worktree, at the head commit.
 */
async function checkGenerated(ctx, results, tree) {
  const stale = await staleGeneratedFiles(tree, { version: ctx.version })
  if (stale.length > 0) {
    await fail(
      ctx,
      STEPS.generated,
      `${plural(stale.length, 'generated file')} of the branch ${stale.length === 1 ? 'differs' : 'differ'} from the output of hackwin ${ctx.version}`,
      {
        rule: RULES.E19,
        objects: stale.map((file) => `${file.path}: ${problemOf(file, ctx.version)}`),
        resolve:
          "undo the branch's changes to these files; generated files change only when the Lead regenerates them with the pinned CLI version",
      },
    )
  }
  report(ctx, results, STEPS.generated, `equal to the output of hackwin ${ctx.version}`)
}

/**
 * @param {StaleFile} file
 * @param {string} version
 * @returns {string}
 */
function problemOf(file, version) {
  if (file.problem === 'missing') return 'missing'
  if (file.problem === 'mode') return 'its executable bit differs'
  return `its content differs from what hackwin ${version} generates`
}

/**
 * Step 7: merge the current base branch into the head, install, and run `commands.generate`;
 * neither may change a tracked file (E10, E13).
 * @param {CommandContext} ctx
 * @param {StepResult[]} results
 * @param {MergedInput & { git: Git, tree: string, logs: string }} input
 */
async function mergeAndRegenerate(ctx, results, { pull, config, baseRef, git, tree, logs }) {
  const merged = await git.merge(baseRef, {
    message: `Merge ${baseRef} into pull request #${pull.number}`,
  })
  if (merged.status === 'conflict') {
    await fail(ctx, STEPS.merge, `pull request #${pull.number} conflicts with ${baseRef}`, {
      rule: RULES.E13,
      objects: merged.conflicts,
      resolve: `merge ${baseRef} into the branch, resolve the conflicts in the task worktree, commit and push`,
    })
  }

  const install = await runInstall({ cwd: tree, config, logFile: join(logs, 'install.log') })
  if (!('skipped' in install) && !install.ok) {
    await fail(ctx, STEPS.merge, `the install failed: ${describeRun(install)}`, {
      rule: RULES.E13,
      objects: [install.command],
      resolve: `make \`${install.command}\` pass on the branch merged with ${baseRef}, then push`,
      run: install,
    })
  }
  const installed = (await git.changedFiles({ base: 'HEAD' })).map((file) => file.path)
  if (installed.length > 0) {
    await fail(
      ctx,
      STEPS.merge,
      `\`${config.hackwin.commands.install}\` changed ${plural(installed.length, 'tracked file')} of the merged tree`,
      {
        rule: RULES.E10,
        objects: installed,
        resolve:
          "the files that the install rewrites are stale on the branch merged with the base branch; ask the Lead to update them, and undo the branch's changes to them",
      },
    )
  }

  const generated = await generatedFileCheck({ cwd: tree, config, git: ctx.git })
  if (generated.changed.length > 0) {
    await fail(
      ctx,
      STEPS.merge,
      `\`${config.hackwin.commands.generate}\` changes ${plural(generated.changed.length, 'tracked file')} of the merged tree: generated files are stale`,
      {
        rule: RULES.E10,
        objects: generated.changed,
        resolve:
          "generated files come only from the Lead: undo the branch's change that makes them stale, or ask the Lead to regenerate them on the base branch",
      },
    )
  }
  if (generated.run && !generated.run.ok) {
    await fail(ctx, STEPS.merge, `the generate command failed: ${describeRun(generated.run)}`, {
      rule: RULES.E10,
      objects: [generated.run.command],
      resolve: `make \`${generated.run.command}\` pass on the branch merged with ${baseRef}, then push`,
      run: generated.run,
    })
  }

  const how =
    merged.status === 'up-to-date' ? `already contains ${baseRef}` : `merges with ${baseRef}`
  const installText = 'skipped' in install ? install.notice : 'installs'
  const generateText = generated.run
    ? 'regenerates without a change'
    : 'hackwin.yml sets no commands.generate'
  report(ctx, results, STEPS.merge, `${how}; ${installText}; ${generateText}`)
}

/**
 * Step 8: the pull request's own changed files that still exist are formatted in the merged
 * tree (E14).
 * @param {CommandContext} ctx
 * @param {StepResult[]} results
 * @param {MergedInput & { tree: string }} input
 */
async function checkFormat(ctx, results, { config, changed, block, tree }) {
  const files = changed.filter((file) => file.status !== 'D').map((file) => file.path)
  const format = await formatCheck({ cwd: tree, config, files })
  if (format.unformatted.length > 0) {
    const command = [config.hackwin.commands.format, ...format.unformatted.map(quoteShellArg)]
    await fail(
      ctx,
      STEPS.format,
      `${plural(format.unformatted.length, 'changed file')} ${format.unformatted.length === 1 ? 'is' : 'are'} not formatted`,
      {
        rule: RULES.E14,
        objects: format.unformatted,
        resolve: `run \`${command.join(' ')}\` in the worktree of task #${block.number}, commit and push`,
      },
    )
  }
  if (format.run && !format.run.ok) {
    await fail(ctx, STEPS.format, `the format command failed: ${describeRun(format.run)}`, {
      rule: RULES.E14,
      objects: [format.run.command],
      resolve: `make \`${format.run.command}\` pass in the worktree of task #${block.number}, then push`,
      run: format.run,
    })
  }
  if (format.run)
    report(ctx, results, STEPS.format, `${plural(files.length, 'changed file')} formatted`)
  else report(ctx, results, STEPS.format, 'no changed file to format', 'skipped')
}

/**
 * Step 9: `commands.check` and the task's acceptance tests on the merged tree (E13). Every entry
 * of `acceptance_tests` is a file, and one that does not exist fails (T5).
 * @param {CommandContext} ctx
 * @param {StepResult[]} results
 * @param {MergedInput & { tree: string, logs: string }} input
 */
async function checkProject(ctx, results, { config, baseRef, block, tree, logs }) {
  const check = await runCheck({ cwd: tree, config, logFile: join(logs, 'check.log') })
  if (!check.ok) {
    await fail(ctx, STEPS.check, `the check failed on the merged tree: ${describeRun(check)}`, {
      rule: RULES.E13,
      objects: [check.command],
      resolve: `make \`${check.command}\` pass on the branch merged with ${baseRef}, then push`,
      run: check,
    })
  }

  const tests = block.acceptance_tests
  const acceptance = await runAcceptanceTests({
    cwd: tree,
    config,
    files: tests,
    logFile: join(logs, 'acceptance.log'),
  })
  if (acceptance.missing.length > 0) {
    await fail(
      ctx,
      STEPS.check,
      `${plural(acceptance.missing.length, 'acceptance test')} of task #${block.number} ${acceptance.missing.length === 1 ? 'is not an existing file' : 'are not existing files'} in the merged tree`,
      {
        rule: RULES.T5,
        objects: acceptance.missing,
        resolve: `add these test files on the branch, or ask the Lead to correct acceptance_tests in issue #${block.number}`,
      },
    )
  }
  if (acceptance.run && !acceptance.ok) {
    await fail(
      ctx,
      STEPS.check,
      `the acceptance tests failed on the merged tree: ${describeRun(acceptance.run)}`,
      {
        rule: RULES.E13,
        objects: tests,
        resolve: `make the acceptance tests of task #${block.number} pass on the branch merged with ${baseRef}, then push`,
        run: acceptance.run,
      },
    )
  }
  const ran = acceptance.run
  report(
    ctx,
    results,
    STEPS.check,
    `\`${check.command}\` passed in ${seconds(check.durationMs)}; ${ran ? `${plural(tests.length, 'acceptance test')} passed in ${seconds(ran.durationMs)}` : `task #${block.number} names no acceptance test`}`,
  )
}

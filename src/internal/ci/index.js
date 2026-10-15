// `hackwin internal ci` (10.2): the checks of the hackwin workflow for one pull request, in order,
// stopping at the first failure:
//
// 1. hackwin.yml and owners.yml from the base branch (A17); a proposed copy in the pull request
//    is validated, with a `cli_version` of the same phase [D10]; the running CLI is the version
//    the pull request is checked with (A60);
// 2. the task link and the branch name (E11, E16);
// 3. the scope of the pull request's own changes against the roles of its author (E1, 8.4);
// 4. the secret scan (E6);
// 6. to 9. in a scratch worktree (merged.js): the generated files (E19), the merge with the
//    current base branch with install and `commands.generate` (E10, E13), the format check
//    (E14), `commands.check` and the task's acceptance tests (E13, T5).
//
// Step 5, the contract paths (E9), arrives with Phase 2. The scope check uses the roles of the
// pull request's author, never the role of the task it names.
//
// The pull request is its head commit: every step reads commits, never the working tree of the
// checkout, which the workflow checks out at that commit. Its own changes are therefore the
// three-dot diff against the base branch. The diff against MERGE_HEAD of 10.2 is the form for
// uncommitted work during a merge (the pre-commit hook); a pushed head commit has none.
//
// The GitHub token reaches only the gh calls of internal ci and its fetch of the base branch,
// never another process it starts, such as the project's commands, which run code from the pull
// request (token.js).

import semver from 'semver'
import { REPOSITORY_URL } from '../../cli/context.js'
import {
  HACKWIN_FILE,
  OWNERS_FILE,
  installCommand,
  loadConfig,
  loadProposedConfig,
  pinnedVersionOf,
  rolesOf,
  scopeCheck,
} from '../../core/config/index.js'
import { PreconditionError } from '../../core/runtime/errors.js'
import { formatFinding, scanDiff } from '../../core/secrets/index.js'
import { checkTaskLink, parseTaskBlock, parseTaskLink } from '../../core/tasks/index.js'
import { readPullEvent } from './event.js'
import { checkMergedTree } from './merged.js'
import { RULES, STEPS, fail, plural, report } from './steps.js'
import { fetchAuth, githubWithToken, takeToken, withoutTokenInProcess } from './token.js'

/** @import { CommandContext, CommandResult } from '../../cli/context.js' */
/** @import { Config } from '../../core/config/index.js' */
/** @import { GitHub, PullRequest } from '../../core/github/index.js' */
/** @import { TaskBlock } from '../../core/tasks/index.js' */
/** @import { StepResult } from './steps.js' */

/**
 * @param {CommandContext} withToken The context of the runner, whose environment may hold the
 *   token.
 * @returns {Promise<CommandResult>}
 */
export async function run(withToken) {
  // Before anything runs: the token reaches only the gh calls and the fetch of checkPullRequest.
  // The steps go on with a context whose environment, and whose git, holds no token, and while
  // they run the environment of the process holds none either.
  const { token, ctx } = takeToken(withToken)
  return withoutTokenInProcess(() => checkPullRequest(ctx, token))
}

/**
 * The steps for the pull request of the event.
 * @param {CommandContext} ctx Its environment holds no token.
 * @param {string | null} token
 * @returns {Promise<CommandResult>}
 */
async function checkPullRequest(ctx, token) {
  const github = githubWithToken(ctx.github, token)
  const event = await readPullEvent(ctx.env)
  const pull = await github.getPullRequest(event.number)
  if (pull === null) {
    throw new PreconditionError(`pull request #${event.number} does not exist`, {
      resolve: 'run the check again on an open pull request',
    })
  }
  const head = await ctx.git.revParse('HEAD')
  const expected = event.headSha ?? pull.headSha
  if (head !== expected) {
    throw new PreconditionError(
      `the checkout is at ${head}, not at ${expected}, the head commit of pull request #${pull.number}`,
      { resolve: 'check out the head commit of the pull request, as the generated workflow does' },
    )
  }
  if (!pull.author) {
    throw new PreconditionError(`GitHub names no author of pull request #${pull.number}`, {
      resolve: 'run the check again',
    })
  }

  /** @type {StepResult[]} */
  const results = []
  const base = pull.baseRef
  const baseRef = `origin/${base}`
  const auth = fetchAuth(await ctx.git.remoteUrl('origin'), token)
  await ctx.git.with({ env: { ...ctx.env, ...auth } }).fetch({
    remote: 'origin',
    refspecs: [`+refs/heads/${base}:refs/remotes/${baseRef}`],
  })
  // The pull request's own changes: the three-dot diff, so that files from the base branch never
  // count (10.2).
  const changed = await ctx.git.changedFiles({ base: baseRef, head, threeDot: true })
  const paths = [...new Set(changed.flatMap((file) => [file.oldPath ?? file.path, file.path]))]

  const config = await checkConfiguration(ctx, results, { pull, head, baseRef, paths })
  const block = await checkTaskLinkStep(ctx, results, { github, pull, config })
  await checkScope(ctx, results, { pull, config, paths, baseRef })
  await checkSecrets(ctx, results, { config, head, baseRef })
  await checkMergedTree(ctx, results, { pull, config, head, baseRef, changed, block })

  return {
    lines: [`hackwin CI passed for pull request #${pull.number} at ${head}`],
    data: {
      pullRequest: pull.number,
      head,
      base,
      author: pull.author,
      task: block.number,
      version: ctx.version,
      steps: results,
    },
  }
}

/**
 * Step 1: the configuration of the base branch, the proposed copy when the pull request changes
 * hackwin.yml or owners.yml, and the CLI version the pull request is checked with.
 * @param {CommandContext} ctx
 * @param {StepResult[]} results
 * @param {{ pull: PullRequest, head: string, baseRef: string, paths: string[] }} input
 * @returns {Promise<Config>} The configuration of the base branch, which every later step applies.
 */
async function checkConfiguration(ctx, results, { pull, head, baseRef, paths }) {
  const config = await loadConfig(ctx.git, { ref: baseRef, fetch: false })
  const proposes = paths.includes(HACKWIN_FILE) || paths.includes(OWNERS_FILE)
  const proposed = proposes ? await loadProposedConfig(ctx.git, { ref: head, base: baseRef }) : null

  // The pull request changes cli_version when its head differs from the commit it started from
  // (A60), as the install step of the workflow decides.
  const pinned = config.hackwin.cli_version
  const named = proposed?.hackwin.cli_version ?? null
  const fork = await ctx.git.mergeBase(baseRef, head)
  const started =
    fork === null ? pinned : pinnedVersionOf((await ctx.git.showFile(fork, HACKWIN_FILE)) ?? '')
  const changesVersion = named !== null && named !== started
  const wanted = changesVersion ? /** @type {string} */ (named) : pinned
  if (!semver.eq(ctx.version, wanted)) {
    const source = changesVersion
      ? `the version it sets as cli_version`
      : `the version hackwin.yml pins on ${baseRef}`
    throw new PreconditionError(
      `hackwin ${ctx.version} runs this check, but pull request #${pull.number} is checked with hackwin ${wanted}, ${source}`,
      { resolve: { command: installCommand(wanted, REPOSITORY_URL), dir: 'any directory' } },
    )
  }

  const changes = [HACKWIN_FILE, OWNERS_FILE].filter((file) => paths.includes(file))
  report(
    ctx,
    results,
    STEPS.config,
    `hackwin.yml and owners.yml of ${baseRef} apply${proposed ? `; the proposed ${changes.join(' and ')} ${changes.length === 1 ? 'is' : 'are'} valid` : ''}; checked with hackwin ${ctx.version}${changesVersion ? ', the version this pull request sets' : ''}`,
  )
  return config
}

/**
 * Step 2: the pull request comes from a task branch and names one open task with a valid data
 * block (E11), and never from a `spike/` branch (E16).
 * @param {CommandContext} ctx
 * @param {StepResult[]} results
 * @param {{ github: GitHub, pull: PullRequest, config: Config }} input
 * @returns {Promise<TaskBlock & { number: number }>} The block of the task.
 */
async function checkTaskLinkStep(ctx, results, { github, pull, config }) {
  const link = await checkTaskLink(github, config, pull)
  const branch = `branch ${pull.headRef}`
  if (!link.ok) {
    switch (link.reason) {
      case 'spike-branch':
        return fail(ctx, STEPS.link, `${pull.headRef} is a spike/ branch, which is never merged`, {
          rule: RULES.E16,
          objects: [branch, `pull request #${pull.number}`],
          resolve:
            'close this pull request; work that should reach the base branch is a task on a task/<N>-<slug> branch',
        })
      case 'no-task-branch':
        return failLink(ctx, pull, `${pull.headRef} is not a task branch task/<N>-<slug>`, [branch])
      case 'no-closes-line':
        return failLink(ctx, pull, 'the body has no line `Closes #<N>` that names the task', [
          `pull request #${pull.number}`,
        ])
      case 'several-closing-references':
        return failLink(ctx, pull, 'the body names more than one issue to close', [
          `pull request #${pull.number}`,
        ])
      case 'branch-issue-mismatch':
        return failLink(
          ctx,
          pull,
          `the body closes another issue than the task of ${pull.headRef}`,
          [branch, `pull request #${pull.number}`],
        )
      case 'issue-not-open': {
        const number = /** @type {number} */ (linkedIssue(pull))
        return failLink(ctx, pull, `issue #${number} is not an open issue`, [`issue #${number}`])
      }
      case 'invalid-task-block': {
        const number = /** @type {number} */ (linkedIssue(pull))
        const issue = await github.getIssue(number)
        const parsed = issue ? parseTaskBlock(issue.body, config) : null
        const errors = parsed?.isTask && !parsed.valid ? parsed.errors : ['no # hackwin:task block']
        return failLink(
          ctx,
          pull,
          `issue #${number} is not a task with a valid data block`,
          errors.map((error) => `issue #${number}: ${error}`),
        )
      }
    }
  }
  const issue = await github.getIssue(link.issue)
  const parsed = issue && parseTaskBlock(issue.body, config)
  if (!parsed?.isTask || !parsed.valid) {
    // The issue changed between the two reads.
    return failLink(ctx, pull, `issue #${link.issue} is not a task with a valid data block`, [
      `issue #${link.issue}`,
    ])
  }
  report(
    ctx,
    results,
    STEPS.link,
    `${pull.headRef} closes task #${link.issue}, an open task with a valid data block`,
  )
  return { ...parsed.block, number: link.issue }
}

/**
 * @param {CommandContext} ctx
 * @param {PullRequest} pull
 * @param {string} message
 * @param {string[]} objects
 * @returns {Promise<never>}
 */
function failLink(ctx, pull, message, objects) {
  return fail(ctx, STEPS.link, message, {
    rule: RULES.E11,
    objects,
    resolve: `the pull request of a task comes from its branch task/<N>-<slug> and its body holds exactly one line \`Closes #<N>\` for that open task; correct the body or the task, then run the hackwin check of pull request #${pull.number} again`,
  })
}

/**
 * The issue of a pull request whose branch and body link a task (5.5), or null.
 * @param {PullRequest} pull
 * @returns {number | null}
 */
function linkedIssue(pull) {
  const link = parseTaskLink({ branch: pull.headRef, body: pull.body })
  return link.ok ? link.issue : null
}

/**
 * Step 3: every file of the pull request's own changes lies in a role its author holds, or on the
 * `open` list (E1). The author is the login that opened the pull request (8.4).
 * @param {CommandContext} ctx
 * @param {StepResult[]} results
 * @param {{ pull: PullRequest, config: Config, paths: string[], baseRef: string }} input
 */
async function checkScope(ctx, results, { pull, config, paths, baseRef }) {
  const login = /** @type {string} */ (pull.author)
  const { violations } = scopeCheck(config, { login, files: paths })
  if (violations.length > 0) {
    const roles = rolesOf(config, login)
    const holds =
      roles.length === 0
        ? `holds no role in hackwin.yml on ${baseRef}`
        : `holds ${roles.join(', ')}`
    await fail(
      ctx,
      STEPS.scope,
      `${plural(violations.length, 'changed file')} of pull request #${pull.number} ${violations.length === 1 ? 'lies' : 'lie'} outside the roles of its author ${login}, who ${holds}`,
      {
        rule: RULES.E1,
        objects: violations.map(
          ({ path, role, holder }) => `${path}: role ${role}, held by ${holder ?? 'nobody'}`,
        ),
        resolve: `undo the branch's changes to these files against ${baseRef} and push; the holder of each role makes its change in a task of that role`,
      },
    )
  }
  report(
    ctx,
    results,
    STEPS.scope,
    `${plural(paths.length, 'changed file')} inside the roles of ${login}`,
  )
}

/**
 * Step 4: no added line matches a secret pattern and no env file other than `.env.example` is
 * added (E6). A finding names the file, the line and the pattern, never the matched text.
 * @param {CommandContext} ctx
 * @param {StepResult[]} results
 * @param {{ config: Config, head: string, baseRef: string }} input
 */
async function checkSecrets(ctx, results, { config, head, baseRef }) {
  const findings = await scanDiff(
    ctx.git,
    { base: baseRef, head, threeDot: true },
    { extraPatterns: config.hackwin.gate.secret_patterns },
  )
  if (findings.length > 0) {
    await fail(
      ctx,
      STEPS.secrets,
      `${plural(findings.length, 'finding')} in the added lines and files of the branch`,
      {
        rule: RULES.E6,
        objects: findings.map(formatFinding),
        resolve:
          'take the secret or env file out of every commit of the branch, keep secrets in .env.local, and revoke a secret that was pushed',
      },
    )
  }
  report(ctx, results, STEPS.secrets, 'no secret and no env file added')
}

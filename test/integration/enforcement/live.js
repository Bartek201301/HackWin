// Helpers of the enforcement scenarios on a fixture repository (enforcement.fixture.test.js): the
// members' clones with the scenario's programs on PATH, commands run as a member through the
// harness's guarded executor, the check run `hackwin` of GitHub Actions and its log, and reads of
// GitHub's protection and push protection that wait until GitHub's reads agree with its writes.
//
// Every gh call goes through the harness's guard: a client of `repo.github(account)` names the
// fixture repository as GH_REPO, and so does every command whose origin is the fixture
// repository. The git hooks run the CLI in a child process and make no gh call.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readPushProtection } from '../../../src/commands/setup/push-protection.js'
import { settledRead } from '../../../src/commands/setup/settle.js'
import {
  ACTIONS_APP_ID,
  ADMIN_ROLE_ID,
  REQUIRED_CHECK,
  readProtection,
} from '../../../src/core/protection/index.js'
import { RemoteError, systemClock } from '../../../src/core/runtime/index.js'
import { yaml } from '../../harness/index.js'
import { git, onPath, runCli, until } from './scene.js'

/** @typedef {import('../../harness/index.js').FixtureRepoContext} FixtureRepoContext */
/** @typedef {import('../../../src/core/github/index.js').GitHub} GitHub */
/** @typedef {import('./scene.js').RunResult} RunResult */

/** How long a scenario waits for the check run `hackwin` of one head commit. */
export const CHECK_PATIENCE_MS = 30 * 60_000

/** The name of the rule set that lets the Lead's account bypass a rule besides the update restriction. */
export const BYPASSABLE_RULESET = 'hackwin-test-bypassable'

/**
 * A rule set that the Lead's account can bypass, beside the two of setup: one approval required,
 * which `gh pr merge --admin` would skip (docs/verification.md row 6, question 3; the scope change
 * on #27 of the Lead's review of #20 and #23).
 */
export function bypassableRuleset() {
  return {
    name: BYPASSABLE_RULESET,
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    bypass_actors: [
      { actor_id: ADMIN_ROLE_ID, actor_type: 'RepositoryRole', bypass_mode: 'always' },
    ],
    rules: [
      {
        type: 'pull_request',
        parameters: {
          required_approving_review_count: 1,
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_review_thread_resolution: false,
        },
      },
    ],
  }
}

/**
 * Delete every rule set named BYPASSABLE_RULESET as the Lead, by name, so that also a rule set
 * whose creation answered nothing readable goes. A failed deletion is logged and given back.
 * @param {FixtureRepoContext} repo
 * @returns {Promise<{ deleted: number[], failed: Array<{ id: number, error: unknown }> }>}
 */
export async function removeBypassable(repo) {
  const lead = repo.github('lead')
  /** @type {{ deleted: number[], failed: Array<{ id: number, error: unknown }> }} */
  const result = { deleted: [], failed: [] }
  const rulesets = await patiently(repo, 'the rule sets', () =>
    lead.apiPages('repos/{owner}/{repo}/rulesets'),
  )
  for (const ruleset of rulesets.filter((entry) => entry.name === BYPASSABLE_RULESET)) {
    try {
      await patiently(repo, `the deletion of rule set ${ruleset.id}`, () =>
        lead.api(`repos/{owner}/{repo}/rulesets/${ruleset.id}`, { method: 'DELETE' }),
      )
      result.deleted.push(ruleset.id)
    } catch (error) {
      repo.log(`the rule set ${BYPASSABLE_RULESET} (${ruleset.id}) could not be deleted: ${error}`)
      result.failed.push({ id: ruleset.id, error })
    }
  }
  repo.log(
    `rule sets ${BYPASSABLE_RULESET}: deleted ${JSON.stringify(result.deleted)}, failed ${JSON.stringify(result.failed.map((entry) => entry.id))}`,
  )
  return result
}

/**
 * @typedef {object} Member
 * @property {string} account `lead` or `builder1`.
 * @property {string} path The main checkout of the member's clone.
 * @property {Record<string, string | undefined>} env The member's environment with the tools.
 * @property {GitHub} github The member's client of the fixture repository.
 * @property {(argv: string[], options?: { cwd?: string }) => Promise<RunResult>} run Runs
 *   `hackwin <argv>` as the member, in the main checkout by default, and logs it.
 * @property {(args: string[], options?: { cwd?: string }) => Promise<RunResult>} git Runs git as
 *   the member, in the main checkout by default, and logs it.
 */

/**
 * A member's clone of the fixture repository, with the tools first on PATH.
 * @param {FixtureRepoContext} repo
 * @param {'lead' | 'builder1'} account
 * @param {string} bin The tools directory (scene.js, toolsDir).
 * @returns {Promise<Member>}
 */
export async function memberClone(repo, account, bin) {
  const clone = await repo.clone(account, { name: account })
  const env = onPath(clone.env, bin)
  const executor = repo.executor(account)
  return {
    account,
    path: clone.path,
    env,
    github: repo.github(account),
    async run(argv, { cwd = clone.path } = {}) {
      const result = await runCli(argv, { cwd, env, executor })
      repo.log(
        `${account}: hackwin ${argv.join(' ')} in ${cwd} exited ${result.code}\n${result.stdout}${result.stderr}`,
      )
      return result
    },
    async git(args, { cwd = clone.path } = {}) {
      const result = await git(cwd, args, env)
      repo.log(
        `${account}: git ${args.join(' ')} in ${cwd} exited ${result.code}\n${result.stdout}${result.stderr}`,
      )
      return result
    },
  }
}

/**
 * Write an answers file of `setup` or `join` into the scenario's directory.
 * @param {FixtureRepoContext} repo
 * @param {string} name
 * @param {unknown} answers
 */
export function answersFile(repo, name, answers) {
  const file = join(repo.tempDir, name)
  writeFileSync(file, yaml(answers))
  return file
}

/**
 * Make a GitHub call again while it fails without an HTTP status or with a 5xx, as on a flaky
 * network: up to 5 tries, 2, 4, 8 and 16 seconds apart.
 * @template T
 * @param {FixtureRepoContext} repo
 * @param {string} what
 * @param {() => Promise<T>} call
 * @returns {Promise<T>}
 */
export async function patiently(repo, what, call) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call()
    } catch (error) {
      const status = /** @type {any} */ (error)?.status
      const transient =
        error instanceof RemoteError && (status === undefined || status === null || status >= 500)
      if (!transient || attempt === 5) throw error
      repo.log(`${what} failed, try ${attempt} of 5: ${error.message}`)
      await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** (attempt - 1)))
    }
  }
}

/**
 * The completed check runs `hackwin` of GitHub Actions on a commit, once at least one completed.
 * @param {FixtureRepoContext} repo
 * @param {string} sha
 * @returns {Promise<Array<{ id: number, status: string, conclusion: string | null, details_url: string }>>}
 */
export async function finishedChecks(repo, sha) {
  const lead = repo.github('lead')
  return until(
    async () => {
      const answer = await patiently(repo, `the check runs of ${sha}`, () =>
        lead.api(`repos/{owner}/{repo}/commits/${sha}/check-runs`, {
          query: { check_name: REQUIRED_CHECK },
        }),
      )
      const runs = (answer?.check_runs ?? []).filter(
        (/** @type {any} */ run) =>
          run.name === REQUIRED_CHECK &&
          run.app?.id === ACTIONS_APP_ID &&
          run.status === 'completed',
      )
      if (runs.length > 0) {
        repo.log(
          `check runs ${REQUIRED_CHECK} of ${sha}: ${runs.map((/** @type {any} */ run) => `${run.id} ${run.conclusion}`).join(', ')}`,
        )
      }
      return runs.length > 0 ? runs : null
    },
    `the check run ${REQUIRED_CHECK} of ${sha}`,
    { timeoutMs: CHECK_PATIENCE_MS, everyMs: 15_000 },
  )
}

/**
 * Run gh as an account on the fixture repository, through the harness's guard, and return its
 * exit code and output: a refusal of GitHub is a result here, where the client's `run` throws it.
 * @param {FixtureRepoContext} repo
 * @param {'lead' | 'builder1'} account
 * @param {string[]} args
 * @returns {Promise<RunResult>}
 */
export async function ghAs(repo, account, args) {
  return repo.executor(account)(args, { env: { GH_REPO: repo.repo } })
}

/**
 * The log of the workflow run of a check run, as `gh run view <id> --log` prints it. gh prints a
 * log only once the whole run is complete, which can be a little after its check run, so a failed
 * call is made again for up to five minutes.
 * @param {FixtureRepoContext} repo
 * @param {{ details_url: string }} check
 * @returns {Promise<string>}
 */
export async function checkLog(repo, check) {
  const id = /\/actions\/runs\/(\d+)/.exec(check.details_url)?.[1]
  if (!id) throw new Error(`the check run names no workflow run: ${check.details_url}`)
  const deadline = Date.now() + 5 * 60_000
  for (;;) {
    const result = await ghAs(repo, 'lead', ['run', 'view', id, '--log'])
    if (result.code === 0) return result.stdout
    if (Date.now() > deadline) {
      throw new Error(`gh run view ${id} --log exited ${result.code}: ${result.stderr}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 15_000))
  }
}

/**
 * The push protection setting, read until GitHub's reads agree (src/commands/setup/settle.js).
 * @param {FixtureRepoContext} repo
 * @returns {Promise<string | null>}
 */
export async function settledPushProtection(repo) {
  const lead = repo.github('lead')
  const read = await settledRead(systemClock, () => readPushProtection(lead), {
    since: Date.now(),
    what: 'the push protection setting',
  })
  return read.value
}

/**
 * Set the push protection setting as the Lead, and read it until GitHub's reads agree.
 * @param {FixtureRepoContext} repo
 * @param {string} status `enabled` or `disabled`.
 */
export async function setPushProtection(repo, status) {
  await repo.github('lead').api('repos/{owner}/{repo}', {
    method: 'PATCH',
    body: { security_and_analysis: { secret_scanning_push_protection: { status } } },
  })
  return settledPushProtection(repo)
}

/**
 * Read the protection as the Lead until `holds` is true for three reads in a row, two seconds
 * apart: GitHub's reads of rule sets can lag its writes.
 * @param {FixtureRepoContext} repo
 * @param {(protection: Awaited<ReturnType<typeof readProtection>>) => boolean} holds
 * @param {string} what
 */
export async function protectionWhen(repo, holds, what) {
  const lead = repo.github('lead')
  let agreed = 0
  return until(
    async () => {
      const read = await patiently(repo, 'the protection read', () => readProtection(lead))
      agreed = holds(read) ? agreed + 1 : 0
      return agreed >= 3 ? read : null
    },
    what,
    { timeoutMs: 3 * 60_000, everyMs: 2000 },
  )
}

/**
 * A pull request as GitHub's REST API returns it, for `merged_by` and the labels.
 * @param {FixtureRepoContext} repo
 * @param {number} number
 */
export async function pullState(repo, number) {
  const lead = repo.github('lead')
  const pull = await patiently(repo, `pull request #${number}`, () =>
    lead.api(`repos/{owner}/{repo}/pulls/${number}`),
  )
  const comments = await patiently(repo, `the comments of #${number}`, () =>
    lead.listComments(number),
  )
  return {
    state: pull.state,
    merged: pull.merged,
    mergedBy: pull.merged_by?.login ?? null,
    mergeCommit: pull.merge_commit_sha ?? null,
    labels: (pull.labels ?? []).map((/** @type {any} */ label) => label.name).sort(),
    comments: comments.map((comment) => ({ author: comment.author, body: comment.body })),
  }
}

/**
 * The head of a branch on the fixture repository, by `git ls-remote` from a member's clone.
 * @param {Member} member
 * @param {string} branch
 */
export async function remoteHead(member, branch) {
  const result = await member.git(['ls-remote', 'origin', `refs/heads/${branch}`])
  return result.stdout.split(/\s+/)[0] || null
}

/**
 * The commit of HEAD in a checkout.
 * @param {Member} member
 * @param {string} [cwd]
 */
export async function headOf(member, cwd) {
  return (await member.git(['rev-parse', 'HEAD'], { cwd })).stdout.trim()
}

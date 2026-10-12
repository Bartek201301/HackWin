// Tests on real fixture repositories. They run only through `npm run test:ac`, and fail when a
// fixture repository, the gh login or HACKWIN_TEST_BUILDER_TOKEN is missing.

import { describe, expect, test } from 'vitest'
import { RemoteError } from '../../src/core/runtime/errors.js'
import { FIXTURE_OWNER, SANDBOX, accounts, withFixtureRepo } from './index.js'

/** @import { FixtureRepoContext } from './index.js' */
/** @import { GitHub } from '../../src/core/github/index.js' */

/** The name of everything this test creates, so that it can find and remove it. */
const CHECK = 'hackwin-harness-check'
const TIMEOUT_MS = 30 * 60_000

/** @param {string} text */
const base64 = (text) => Buffer.from(text).toString('base64')

/**
 * The state a reset leaves: nothing open, no label, no rule set, `main` at the reset commit.
 * @param {FixtureRepoContext} repo
 */
async function expectClean(repo) {
  const lead = repo.github('lead')
  expect(await lead.apiPages('repos/{owner}/{repo}/issues', { query: { state: 'open' } })).toEqual(
    [],
  )
  expect(await lead.listLabels()).toEqual([])
  expect((await lead.api('repos/{owner}/{repo}/git/ref/heads/main')).object.sha).toBe(repo.resetSha)
  if (repo.visibility === 'public') {
    expect(await lead.apiPages('repos/{owner}/{repo}/rulesets')).toEqual([])
    await expect(lead.api('repos/{owner}/{repo}/branches/main/protection')).rejects.toMatchObject({
      status: 404,
    })
  }
}

/**
 * Delete a branch this test made; a branch that does not exist is no error.
 * @param {GitHub} github
 * @param {string} branch
 */
async function deleteBranch(github, branch) {
  try {
    await github.api(`repos/{owner}/{repo}/git/refs/heads/${branch}`, { method: 'DELETE' })
  } catch (error) {
    if (!(error instanceof RemoteError) || ![404, 422].includes(error.status ?? 0)) throw error
  }
}

describe('1.3d/fixture-repo: scenarios on the fixture repositories', () => {
  test(
    'under the lock a lane fixture repository is reset, the Lead creates and deletes a label that the machine account reads, and no call reaches hackwin-sandbox',
    async () => {
      await withFixtureRepo('hackwin-fixture-a', async (repo) => {
        const lead = repo.github('lead')
        const builder = repo.github('builder1')
        expect(repo.logins.builder1).toBe(accounts.builder1.login)
        await expectClean(repo)
        await deleteBranch(lead, CHECK)

        // Leave the repository dirty in every way the reset undoes.
        await lead.api(`repos/{owner}/{repo}/contents/${CHECK}.txt`, {
          method: 'PUT',
          body: {
            message: 'Move main (test harness check)',
            content: base64('moved\n'),
            branch: 'main',
          },
        })
        await lead.api('repos/{owner}/{repo}/git/refs', {
          method: 'POST',
          body: { ref: `refs/heads/${CHECK}`, sha: repo.resetSha },
        })
        await builder.api(`repos/{owner}/{repo}/contents/${CHECK}-branch.txt`, {
          method: 'PUT',
          body: {
            message: 'Change on a branch (test harness check)',
            content: base64('x\n'),
            branch: CHECK,
          },
        })
        const pull = await builder.createPullRequest({
          title: 'Test harness check',
          head: CHECK,
          base: 'main',
          body: 'Opened by the test harness of HackWin; its reset closes it.',
        })
        const issue = await builder.createIssue({
          title: 'Test harness check',
          body: 'Opened by the test harness of HackWin; its reset closes it.',
        })
        await lead.createLabel({ name: CHECK, color: 'ededed', description: 'Test harness check' })
        await lead.addLabels(issue.number, [CHECK])
        await lead.api('repos/{owner}/{repo}/rulesets', {
          method: 'POST',
          body: {
            name: CHECK,
            target: 'branch',
            enforcement: 'active',
            conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
            rules: [{ type: 'non_fast_forward' }],
          },
        })
        await lead.api('repos/{owner}/{repo}/branches/main/protection', {
          method: 'PUT',
          body: {
            required_status_checks: null,
            enforce_admins: true,
            required_pull_request_reviews: null,
            restrictions: null,
            allow_force_pushes: false,
          },
        })

        const report = await repo.reset()
        expect(report.closedPullRequests).toContain(pull.number)
        expect(report.closedIssues).toContain(issue.number)
        expect(report.deletedLabels).toContain(CHECK)
        expect(report.deletedRulesets.map((ruleset) => ruleset.name)).toContain(CHECK)
        expect(report.deletedBranchRules).toContain('main')
        expect(report.main.before).not.toBe(repo.resetSha)
        await expectClean(repo)
        expect((await builder.getPullRequest(pull.number))?.state).toBe('closed')
        await deleteBranch(lead, CHECK)

        // A label made by the Lead, read by the machine account.
        const label = {
          name: 'hackwin-harness-label',
          color: '0e8a16',
          description: 'Made by the Lead',
        }
        expect(await lead.createLabel(label)).toEqual(label)
        expect(await builder.listLabels()).toContainEqual(label)
        expect(await lead.deleteLabel(label.name)).toBe(true)
        expect((await builder.listLabels()).map((own) => own.name)).not.toContain(label.name)

        // hackwin-sandbox is out of reach; every call that ran named the fixture repository.
        await expect(lead.api(`repos/${FIXTURE_OWNER}/${SANDBOX}`)).rejects.toThrow(
          /refused by the test harness/,
        )
        const ran = repo.calls.filter((call) => call.refused === null)
        expect(new Set(ran.map((call) => call.account))).toEqual(new Set(['lead', 'builder1']))
        expect(
          ran.filter(
            (call) =>
              call.args.join(' ').includes(SANDBOX) ||
              (call.repo !== null && call.repo !== repo.repo),
          ),
        ).toEqual([])
        expect(
          repo.calls.filter((call) => call.refused !== null).map((call) => call.args.join(' ')),
        ).toEqual([`api --method GET repos/${FIXTURE_OWNER}/${SANDBOX}`])
      })
    },
    TIMEOUT_MS,
  )

  test(
    'the reset of hackwin-fixture-private accepts the HTTP 403 of its rule set endpoints',
    async () => {
      await withFixtureRepo('hackwin-fixture-private', async (repo) => {
        expect(repo.report.accepted).toEqual(['rule sets: HTTP 403'])
        await expectClean(repo)
        await expect(
          repo.github('lead').api('repos/{owner}/{repo}/branches/main/protection'),
        ).rejects.toMatchObject({ status: 403 })
        expect((await repo.github('builder1').repository()).visibility).toBe('private')
      })
    },
    TIMEOUT_MS,
  )
})

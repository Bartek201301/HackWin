// The enforcement scenarios on the fixture repositories (task 1.7b, #27): each criterion passes one
// rule through every layer it has, with the merged lanes, on real GitHub. These tests run only
// through `npm run test:ac`; they act as the Lead and as builder1, so they need the Lead's gh login
// and HACKWIN_TEST_BUILDER_TOKEN, and they fail when either is missing.
//
// - public.js runs on PUBLIC_REPO, where GitHub accepts the rules for everyone, the update
//   restriction and push protection: AC47, AC54, AC63 and the offered case of AC80.
// - private.js runs on hackwin-fixture-private, where GitHub refuses rule sets and push
//   protection (docs/verification.md section 5): the refusing case of AC80 and an outsider's task
//   issue (the scope change on #27).
// - AC70 has no real repository (docs/verification.md section 5) and runs against the fake GitHub
//   in enforcement.test.js, beside the offline check of the deny part of AC63.
//
// Each scenario runs once, under the lock of its repository and after its reset, when the first
// test that needs it starts; every test then asserts its criterion on what the scenario observed.
// The run log of a repository (test/harness/fixture-repo.js) records every gh call, every command
// and the Gate's terminal.

import { describe, expect, test } from 'vitest'
import { accounts, withFixtureRepo } from '../../harness/index.js'
import { BYPASSABLE_RULESET } from './live.js'
import { PRIVATE_REPO, privateScenario } from './private.js'
import { PUBLIC_REPO, publicScenario } from './public.js'
import { GENERATED_FILE, TEST_SECRET } from './scene.js'

/** A scenario waits for CI and for the Gate; the first test of a scenario runs all of it. */
const TIMEOUT_MS = 150 * 60_000

/** How long a scenario waits for another session's lock of its repository. */
const LOCK_TIMEOUT_MS = 120 * 60_000

const LEAD = accounts.lead.login
const BUILDER1 = accounts.builder1.login

/**
 * A scenario that runs once, when it is first needed.
 * @template T
 * @param {() => Promise<T>} run
 * @returns {() => Promise<T>}
 */
function once(run) {
  /** @type {Promise<T> | null} */
  let result = null
  return () => (result ??= run())
}

const publicWorld = once(() =>
  withFixtureRepo(PUBLIC_REPO, publicScenario, { lockTimeoutMs: LOCK_TIMEOUT_MS }),
)
const privateWorld = once(() =>
  withFixtureRepo(PRIVATE_REPO, privateScenario, { lockTimeoutMs: LOCK_TIMEOUT_MS }),
)

/**
 * The Gate's comment on a pull request for a head commit (contracts 5.7): by the Lead, starting
 * with the marker.
 * @param {{ comments: Array<{ author: string, body: string }> }} pull
 * @param {number} pr
 * @param {string} sha
 */
function gateComment(pull, pr, sha) {
  const marker = `<!-- hackwin:gate-comment pr=${pr} sha=${sha} `
  const comment = pull.comments.find(
    (entry) => entry.author.toLowerCase() === LEAD.toLowerCase() && entry.body.startsWith(marker),
  )
  if (!comment) throw new Error(`no Gate comment on #${pr} for ${sha}`)
  return comment.body
}

/**
 * The conclusions of the check runs `hackwin` of a commit.
 * @param {Array<{ conclusion: string | null }>} checks
 */
const conclusions = (checks) => [...new Set(checks.map((check) => check.conclusion))]

describe('AC47: an edit outside scope without the Claude Code hooks', () => {
  test(
    'AC47: with no Claude Code hook (a Codex member), an edit outside scope is blocked at commit; committed with --no-verify and pushed, it fails CI and the Gate and is not merged',
    async () => {
      const o = await publicWorld()
      // builder1 works with Codex: take prints the Codex command, and no Claude Code hook runs.
      expect(o.outsideTake.code).toBe(0)
      expect(o.outsideTake.stdout).toContain(`start Codex for #${o.tasks.outside}`)

      expect(o.outsideCommit.code).toBe(1)
      expect(o.outsideCommit.stderr).toContain(
        "rule: E1: edits stay inside the author's ownership scope",
      )
      expect(o.outsideCommit.stderr).toContain(
        `- src/shared/feature.ts: role shared, held by ${LEAD}`,
      )
      expect(o.outsideCommit.stderr).not.toContain('src/features/todos/filter.ts')
      expect(o.outsideNoVerify.code).toBe(0)
      // Without --no-verify the push needs a green check record too (E4).
      expect(o.outsidePush.code).not.toBe(0)
      expect(o.outsidePush.stderr).toContain(
        'rule: E4: no push without green checks on the pushed commit',
      )
      expect(o.outsidePushNoVerify.code).toBe(0)

      expect(conclusions(o.outsideChecks)).toEqual(['failure'])
      expect(o.outsideLog).toContain('step 3, scope check: ')
      expect(o.outsideLog).toContain(`outside the roles of its author ${BUILDER1}, who holds`)
      expect(o.outsideLog).toContain(`src/shared/feature.ts: role shared, held by ${LEAD}`)

      expect(o.outsideDigest).toMatchObject({ result: 'scope-violation', stage: 'scope' })
      expect(o.gateOut).toContain(`ATTENTION scope-violation #${o.outsidePull}: `)
      const comment = gateComment(o.outsideState, o.outsidePull, o.outsideSha)
      expect(comment).toContain('`src/shared/feature.ts`: role `shared`, held by')
      expect(o.outsideState.labels).toEqual(
        expect.arrayContaining(['gate:failed', 'scope-violation']),
      )
      expect(o.outsideState).toMatchObject({ state: 'open', merged: false })
    },
    TIMEOUT_MS,
  )
})

describe('AC54: generated files, rewritten history, commits on main and core.hooksPath', () => {
  test(
    'AC54: a pull request whose generated files are stale fails CI',
    async () => {
      const o = await publicWorld()
      expect(o.staleCommit.code).toBe(0)
      // ship refuses it first (E10); pushed past the hooks, CI fails it.
      expect(o.staleShip.code).toBe(1)
      expect(o.staleShip.stderr).toContain('step 6, generated file check')
      expect(o.stalePush.code).toBe(0)
      expect(conclusions(o.staleChecks)).toEqual(['failure'])
      expect(o.staleLog).toContain('step 7, ')
      expect(o.staleLog).toContain('generated files are stale')
      expect(o.staleLog).toContain(
        'rule: E10: generated files are produced only by the Lead and are current',
      )
      expect(o.staleLog).toContain(GENERATED_FILE)
      expect(o.staleDigest).toMatchObject({ result: 'failed', stage: 'ci' })
      expect(o.staleState.merged).toBe(false)
    },
    TIMEOUT_MS,
  )

  test(
    'AC54: a push that rewrites the history of a pushed task branch is blocked by the pre-push hook',
    async () => {
      const o = await publicWorld()
      expect(o.rewriteAmend.code).toBe(0)
      expect(o.rewritePush.code).not.toBe(0)
      expect(o.rewritePush.stderr).toContain(
        'rule: E12: main is merged in, never rebased or force pushed',
      )
      expect(o.rewritePush.stderr).toContain(`${o.greenSha} on origin is not in the history of`)
      expect(o.greenRemoteAfterRewrite).toBe(o.greenSha)
    },
    TIMEOUT_MS,
  )

  test(
    'AC54: a commit on the default branch is blocked by the pre-commit hook',
    async () => {
      const o = await publicWorld()
      expect(o.mainCommit.code).toBe(1)
      expect(o.mainCommit.stderr).toContain('rule: E18: no fix is committed directly on main')
      expect(o.mainMoved).toBe(false)
    },
    TIMEOUT_MS,
  )

  test(
    'AC54: with core.hooksPath unset in a joined clone, take and ship set it again (E20)',
    async () => {
      const o = await publicWorld()
      const repaired =
        'warning: core.hooksPath was not set, so the git hooks were off; set it to .githooks (E20)'
      expect(o.join.code).toBe(0)
      expect(o.hooksBeforeTake).toMatchObject({ code: 1, stdout: '' })
      expect(o.greenTake.code).toBe(0)
      expect(o.greenTake.stderr).toContain(repaired)
      expect(o.hooksAfterTake.stdout.trim()).toBe('.githooks')
      expect(o.greenCommit.code).toBe(0)
      expect(o.hooksBeforeShip).toMatchObject({ code: 1, stdout: '' })
      expect(o.greenShip.code).toBe(0)
      expect(o.greenShip.stderr).toContain(repaired)
      expect(o.hooksAfterShip.stdout.trim()).toBe('.githooks')
    },
    TIMEOUT_MS,
  )
})

describe('AC63: merges under the update restriction', () => {
  test(
    "AC63: with the update restriction active, gh pr merge of a green pull request under builder1's account is refused by GitHub, and the Gate merges the same pull request under the Lead's account",
    async () => {
      const o = await publicWorld()
      expect(o.protection.state).toBe('full-restricted')
      expect(o.protection.rules).toMatchObject({ updateRestricted: true, bypassable: [] })
      expect(conclusions(o.greenChecks)).toEqual(['success'])
      // gh refuses before it merges, because GitHub reports the pull request as blocked by the
      // branch policy; with --admin, and through the REST API, GitHub itself refuses the update
      // of main (docs/verification.md rows 6 and 14).
      expect(o.builderMerge.code).not.toBe(0)
      expect(o.builderMerge.stderr).toContain('the base branch policy prohibits the merge')
      for (const refused of [o.builderAdminMerge, o.builderRestMerge]) {
        expect(refused.code).not.toBe(0)
        expect(refused.stderr).toContain('Cannot update this protected ref.')
      }
      expect(o.builderRestMerge.stderr).toContain('(HTTP 405)')
      expect(o.greenAfterBuilder).toMatchObject({ state: 'open', merged: false })

      expect(o.greenMergedDigest).toMatchObject({ result: 'merged', author: BUILDER1 })
      expect(o.gateOut).toContain(
        `#${o.greenPull} merged head ${o.greenSha} as ${o.greenState.mergeCommit} (with --admin: the update restriction is active)`,
      )
      expect(o.greenState).toMatchObject({ state: 'closed', merged: true })
      expect(o.greenState.mergedBy.toLowerCase()).toBe(LEAD.toLowerCase())
      expect(o.mainAfter).toBe(o.greenState.mergeCommit)
    },
    TIMEOUT_MS,
  )

  test(
    'AC63: --admin of the Lead lifts no rule for everyone: GitHub refuses it for a pull request whose required check failed',
    async () => {
      const o = await publicWorld()
      expect(conclusions(o.outsideChecks)).toEqual(['failure'])
      expect(o.leadAdminMerge.code).not.toBe(0)
      expect(o.leadAdminMerge.stderr).toContain('Required status check "hackwin" is failing.')
      expect(o.outsideAfterAdmin.merged).toBe(false)
    },
    TIMEOUT_MS,
  )

  test(
    "AC63: the Gate refuses to start while the Lead's account can bypass a rule besides the update restriction",
    async () => {
      const o = await publicWorld()
      expect(o.bypassableAtStart).toMatchObject({
        updateRestricted: true,
        bypassable: [{ type: 'pull_request', ruleset: BYPASSABLE_RULESET }],
      })
      expect(o.gateRefusal).toEqual({
        refusal: {
          code: 2,
          message: `the update restriction is active, so the Gate merges with --admin, which would also skip these rules that the Lead's account can bypass: pull_request (rule set ${BYPASSABLE_RULESET})`,
        },
      })
    },
    TIMEOUT_MS,
  )

  test(
    "AC63: a rule the Lead's account can bypass that comes after the start stops the merge, with an attention line that names it",
    async () => {
      const o = await publicWorld()
      expect(o.greenRefusedDigest).toMatchObject({
        result: 'failed',
        stage: 'merge',
        note: 'merge-refused: rules the Lead can bypass',
      })
      expect(o.greenRefusedPull.merged).toBe(false)
      expect(o.gateOut).toContain(
        `ATTENTION repeated-failure #${o.greenPull}: the Gate merges nothing while the Lead's account can bypass \`pull_request\` of the rule set \`${BYPASSABLE_RULESET}\``,
      )
      expect(gateComment(o.greenRefusedPull, o.greenPull, o.greenSha)).toContain(
        `\`pull_request\` of the rule set \`${BYPASSABLE_RULESET}\``,
      )
      // The rule set is gone at the end of the scenario: no rule left that the Lead can bypass.
      expect(o.protectionAfter).toMatchObject({
        state: 'full-restricted',
        rules: { updateRestricted: true, bypassable: [] },
      })
    },
    TIMEOUT_MS,
  )

  test(
    'AC63: in a Claude Code session of the Lead, gh pr merge is refused by the deny rule and the PreToolUse hook of the settings that setup generated',
    async () => {
      const o = await publicWorld()
      const session = o.leadSession
      expect(session.deny).toContain('Bash(gh pr merge *)')
      expect(session.hookLines).toEqual(['hackwin internal hook pre-tool-use'])
      for (const result of session.results) {
        expect(result.rules.length, result.command).toBeGreaterThan(0)
        expect(result.decisions.map((entry) => entry.mode)).toEqual([
          'default',
          'bypassPermissions',
        ])
        for (const decision of result.decisions) {
          expect(decision.code, decision.stderr).toBe(0)
          expect(decision.decision, result.command).toBe('deny')
          expect(decision.reason).toContain('rule: E3: no agent session merges; only the Gate does')
        }
      }
    },
    TIMEOUT_MS,
  )
})

describe('AC80: push protection and HackWin own secret scans', () => {
  test(
    'AC80: on a public fixture repository, where GitHub offers push protection, setup enables it and the setting read back is on, and a test secret that matches a HackWin pattern but no pattern GitHub recognizes is blocked at commit, in CI and by the Gate',
    async () => {
      const o = await publicWorld()
      expect(o.pushProtectionOff).toBe('disabled')
      expect(o.setup.stdout).toContain(
        "push protection: on: GitHub blocks a push that holds a secret it recognizes, and HackWin's own secret scans run as well",
      )
      expect(o.pushProtection).toBe('enabled')
      expectSecretBlocked(o, 'src/features/counter/config/token.ts')
      // GitHub's push protection knows no team pattern: the push reached GitHub.
      expect(o.secretPush.code).toBe(0)
      expect(o.secretRemote).toBe(o.secretSha)
      expect(o.pushProtectionAfter).toBe(o.pushProtectionBefore)
    },
    TIMEOUT_MS,
  )

  test(
    'AC80: on the private fixture repository, where GitHub refuses push protection, setup exits 0 and its summary reports push protection as off, and the test secret is blocked at commit, in CI and by the Gate',
    async () => {
      const o = await privateWorld()
      expect(o.setup.code).toBe(0)
      expect(o.setup.stdout).toContain(
        `push protection: off: GitHub does not offer it for ${o.repo}, so HackWin's own secret scans (E6) run alone`,
      )
      expect(o.pushProtection).not.toBe('enabled')
      expect(o.protection.state).toBe('soft')
      expectSecretBlocked(o, 'src/features/counter/token/token.ts')
      expect(o.secretPush.code).toBe(0)
      expect(o.secretRemote).toBe(o.secretSha)
      expect(o.statusIssue).toMatchObject({ protection: 'soft' })
    },
    TIMEOUT_MS,
  )
})

/**
 * The test secret of a scenario is blocked at commit, fails CI and the Gate, is not merged, and
 * no layer prints it.
 * @param {Record<string, any>} o
 * @param {string} path
 */
function expectSecretBlocked(o, path) {
  expect(o.secretCommit.code).toBe(1)
  expect(o.secretCommit.stderr).toContain(
    'rule: E6: no env file other than .env.example and no secret is committed',
  )
  expect(o.secretCommit.stderr).toContain(`- ${path}:1: gate.secret_patterns[0]`)
  expect(o.secretNoVerify.code).toBe(0)

  expect(conclusions(o.secretChecks)).toEqual(['failure'])
  expect(o.secretLog).toContain('step 4, secret scan: ')
  expect(o.secretLog).toContain(`${path}:1: gate.secret_patterns[0]`)

  expect(o.secretDigest).toMatchObject({ result: 'failed', stage: 'secrets' })
  expect(o.gateOut).toContain(`ATTENTION secret #${o.secretPull}: rotate the secret in ${path}:1`)
  expect(o.notifications.map((entry) => entry.title)).toContain(
    `HackWin Gate: secret in #${o.secretPull}`,
  )
  const comment = gateComment(o.secretState, o.secretPull, o.secretSha)
  expect(comment).toContain(`${path}:1: gate.secret_patterns[0]`)
  expect(o.secretState.labels).toContain('gate:failed')
  expect(o.secretState).toMatchObject({ state: 'open', merged: false })
  expect(o.statusIssue.attention).toEqual(
    expect.arrayContaining([expect.objectContaining({ type: 'secret', pr: o.secretPull })]),
  )

  for (const text of [o.secretCommit.stderr, o.secretLog, o.gateOut, comment]) {
    expect(text).not.toContain(TEST_SECRET)
  }
}

describe('1.7b/outsider: a task issue written by an account outside the team', () => {
  test(
    "1.7b/outsider: status does not list the outsider's task issue, take and ship refuse it and name the author, and a pull request that names it fails the task link of CI and the Gate's stage 2",
    async () => {
      const o = await privateWorld()
      expect(o.outsiderAuthor?.toLowerCase()).toBe(BUILDER1.toLowerCase())

      // status counts and lists the Lead's task, not the outsider's issue.
      expect(o.status.code).toBe(0)
      expect(o.status.stdout).toMatch(new RegExp(`#${o.secretTask}(?!\\d)`))
      expect(o.status.stdout).not.toMatch(new RegExp(`#${o.outsiderTask}(?!\\d)`))
      expect(o.status.stdout).toContain('wave 1: 1 open task')
      expect(JSON.parse(o.statusJson.stdout).data.wave).toMatchObject({ open_tasks: 1 })

      const notMember = `it was written by ${BUILDER1}, who is not a member of the team in hackwin.yml`
      expect(o.outsiderTake.code).toBe(2)
      expect(o.outsiderTake.stderr).toContain(
        `#${o.outsiderTask} is not a task issue: ${notMember}`,
      )
      expect(o.outsiderCommit.code).toBe(0)
      expect(o.outsiderShip.code).toBe(2)
      expect(o.outsiderShip.stderr).toContain(notMember)
      expect(o.outsiderPush.code).toBe(0)

      expect(conclusions(o.outsiderChecks)).toEqual(['failure'])
      expect(o.outsiderLog).toContain('step 2, task link: ')
      expect(o.outsiderLog).toContain(
        `issue #${o.outsiderTask} was written by ${BUILDER1}, who is not a member of the team in hackwin.yml`,
      )

      expect(o.outsiderDigest).toMatchObject({ result: 'failed', stage: 'task-link' })
      expect(gateComment(o.outsiderState, o.outsiderPull, o.outsiderSha)).toContain(
        `issue #${o.outsiderTask} was written by ${BUILDER1}, who is not a member of the team in hackwin.yml`,
      )
      expect(o.outsiderState).toMatchObject({ state: 'open', merged: false })
    },
    TIMEOUT_MS,
  )
})

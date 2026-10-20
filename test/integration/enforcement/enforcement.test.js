// The enforcement scenarios that run offline, in `npm test` (task 1.7b, #27):
//
// - AC70 against the fake GitHub only: no real repository accepts the rules for everyone and
//   refuses the update restriction (docs/verification.md section 5). `setup`, the Gate and `status`
//   run on one fake GitHub and one origin, so each layer reads the state the one before it left.
// - The deny part of AC63 with the settings that this `setup` generated and recorded hook events
//   (plan section 9, decision 9). A real session of the Lead is the manual check per release
//   (plan section 6). enforcement.fixture.test.js runs the same check on a fixture repository.

import { describe, expect, test } from 'vitest'
import { parseStatusBody, STATUS_LABEL } from '../../../src/commands/gate/status-issue.js'
import { createGitHub } from '../../../src/core/github/index.js'
import { readProtection } from '../../../src/core/protection/index.js'
import { DEFAULT_FAKE_REPO, accounts } from '../../harness/index.js'
import { RESTRICTION_REFUSAL, createOfflineWorld, offlineSetup } from './offline.js'
import {
  denyRuleMatches,
  gateStart,
  leadSessionMerges,
  mergeCommands,
  runCli,
  startLeadGate,
} from './scene.js'

const LEAD = accounts.lead.login

describe('AC70: where GitHub accepts the rules for everyone but not the update restriction', () => {
  test('AC70: setup exits 0 and reports full protection without the update restriction, and the Gate header, the status issue and status show the same state', async () => {
    const world = await createOfflineWorld({ refuseUpdateRestriction: true })
    const setup = await offlineSetup(world)
    expect(setup.stderr).not.toContain('hackwin setup:')
    expect(setup.code).toBe(0)
    expect(setup.stdout).toContain(
      `protection: full, without the update restriction: changes to main only through a pull request whose check hackwin passed, no force push and no deletion, for every account, the owner included; GitHub does not restrict updates of main to ${LEAD} (GitHub answered: gh: ${RESTRICTION_REFUSAL} (HTTP 422)), so merges by agent sessions are blocked only softly (10.6)`,
    )
    const lead = createGitHub({ executor: world.lead, repo: DEFAULT_FAKE_REPO })
    const read = await readProtection(lead)
    expect(read.state).toBe('full')
    expect(read.rules).toMatchObject({ updateRestricted: false, bypassable: [] })

    const gate = await startLeadGate({
      cwd: world.fixture.main,
      env: world.env,
      executor: world.lead,
    })
    try {
      expect(await gateStart(gate, 60_000)).toEqual({ started: true })
    } finally {
      await gate.quit()
    }
    const header = gate.out.split('\n')
    expect(header).toContain('protection: full')
    expect(gate.out).not.toContain('the update restriction is active')

    const issues = world.fake.state.items.filter((item) =>
      item.labels.some((label) => (label.name ?? label) === STATUS_LABEL),
    )
    expect(issues).toHaveLength(1)
    const published = parseStatusBody(issues[0].body)
    expect(published).toMatchObject({ protection: 'full', update_restricted: false })

    const status = await runCli(['status'], {
      cwd: world.fixture.main,
      env: world.env,
      executor: world.lead,
    })
    expect(status.stderr).not.toContain('hackwin status:')
    expect(status.stdout.split('\n')).toContain('protection: full')
  }, 120_000)
})

describe('AC63: the deny rule in a Claude Code session of the Lead', () => {
  test('AC63: the settings that setup generated deny gh pr merge and the merge through gh api, and their PreToolUse hook refuses each with default and with bypass permissions', async () => {
    const world = await createOfflineWorld({ refuseUpdateRestriction: false })
    const setup = await offlineSetup(world)
    expect(setup.code).toBe(0)
    const commands = mergeCommands({ repo: DEFAULT_FAKE_REPO, pr: 7, sha: 'a'.repeat(40) })
    const session = await leadSessionMerges({
      checkout: world.fixture.main,
      env: world.env,
      commands: [...commands, 'gh pr view 7', 'git push origin task/7-counter-step'],
    })
    expect(session.hookLines).toEqual(['hackwin internal hook pre-tool-use'])
    expect(session.deny).toContain('Bash(gh pr merge *)')
    for (const result of session.results) {
      const merge = commands.includes(result.command)
      // A merge matches a deny rule, and the hook denies it in both permission modes; the two
      // other commands are neither, so the model and the hook do not deny every call.
      expect(result.rules.length > 0, result.command).toBe(merge)
      expect(result.decisions).toHaveLength(2)
      for (const decision of result.decisions) {
        expect(decision.code, `${result.command} ${decision.stderr}`).toBe(0)
        expect(decision.decision === 'deny', result.command).toBe(merge)
        if (merge) expect(decision.reason).toContain('rule: E3: no agent session merges')
      }
    }
  }, 120_000)

  test('AC63: the model of the deny rules reads `*` as one character or more', () => {
    expect(denyRuleMatches('Bash(gh pr merge *)', 'gh pr merge 7 --merge')).toBe(true)
    expect(denyRuleMatches('Bash(gh pr merge *)', 'gh pr merge')).toBe(false)
    expect(
      denyRuleMatches('Bash(gh api *pulls/*/merge)', 'gh api -X PUT repos/o/r/pulls/7/merge'),
    ).toBe(true)
    expect(denyRuleMatches('Bash(gh api *pulls/*/merge)', 'gh api repos/o/r/pulls/7/files')).toBe(
      false,
    )
    expect(denyRuleMatches('Read(./.env)', 'gh pr merge 7')).toBe(false)
  })
})

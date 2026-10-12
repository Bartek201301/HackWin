import { describe, expect, test } from 'vitest'
import { createGitHub } from '../../../src/core/github/index.js'
import { PROTECTION_STATES, readProtection } from '../../../src/core/protection/index.js'
import { RemoteError } from '../../../src/core/runtime/errors.js'
import { accounts, createFakeGitHub, httpError } from '../../harness/index.js'
import {
  ADMIN_BYPASS,
  FULL_RULES,
  NO_RULES,
  ONE_APPROVAL,
  PINNED_CHECK,
  branchRulesBody,
  serveRulesets,
  updateRestrictionBody,
} from './rulesets.js'

/**
 * A fake GitHub with these rule sets, and the Lead's client for it.
 * @param {any[]} rulesets
 * @param {{ offered?: boolean, defaultBranch?: string }} [options]
 */
function leadWith(rulesets, { offered, defaultBranch } = {}) {
  const fake = createFakeGitHub({ defaultBranch })
  const served = serveRulesets(fake, rulesets, { offered })
  const github = createGitHub({ executor: fake.as(accounts.lead.login), repo: fake.state.repo })
  return { fake, github, ...served }
}

/**
 * The rules for everyone without one of their rules.
 * @param {string} type
 */
function branchRulesWithout(type) {
  const body = branchRulesBody()
  return { ...body, rules: body.rules.filter((rule) => rule.type !== type) }
}

/**
 * The four rules of the rules for everyone as entries of `bypassable`.
 * @param {string} ruleset
 */
function rulesForEveryoneIn(ruleset) {
  return ['pull_request', 'required_status_checks', 'non_fast_forward', 'deletion'].map((type) => ({
    type,
    ruleset,
  }))
}

describe('1.3e/protection: the protection state read from GitHub', () => {
  test('a branch without rules reads soft, after one request for its rules', async () => {
    const { fake, github } = leadWith([])
    expect(await readProtection(github, { branch: 'main' })).toEqual({
      state: 'soft',
      rules: NO_RULES,
    })
    expect(fake.calls.map((call) => `${call.method} ${call.endpoint}`)).toEqual([
      'GET repos/{owner}/{repo}/rules/branches/main',
    ])
    expect(PROTECTION_STATES).toEqual(['full-restricted', 'full', 'soft'])
  })

  test('where GitHub offers no rule sets (a private repository without GitHub Pro) it reads soft', async () => {
    const { github } = leadWith([], { offered: false })
    expect(await readProtection(github, { branch: 'main' })).toEqual({
      state: 'soft',
      rules: NO_RULES,
    })
  })

  test('any other failure of GitHub is a RemoteError, never a soft state', async () => {
    const { fake, github } = leadWith([])
    fake.on('GET repos/{owner}/{repo}/rules/branches/:branch*', () => {
      throw httpError(403, 'You have exceeded a secondary rate limit.')
    })
    const error = await readProtection(github, { branch: 'main' }).catch((caught) => caught)
    expect(error).toBeInstanceOf(RemoteError)
    expect(error).toMatchObject({ status: 403, exitCode: 3 })
  })

  test('the rules for everyone as setup creates them read full, with the check pinned to GitHub Actions', async () => {
    const { fake, github } = leadWith([branchRulesBody()])
    expect(await readProtection(github, { branch: 'main' })).toEqual({
      state: 'full',
      rules: FULL_RULES,
    })
    expect(fake.calls.map((call) => call.endpoint)).toEqual([
      'repos/{owner}/{repo}/rules/branches/main',
      'repos/{owner}/{repo}/rulesets/24000001',
    ])
  })

  test('the rules for everyone and the update restriction read full-restricted, with no other rule the Lead can bypass', async () => {
    const { github } = leadWith([branchRulesBody(), updateRestrictionBody()])
    expect(await readProtection(github, { branch: 'main' })).toEqual({
      state: 'full-restricted',
      rules: { ...FULL_RULES, updateRestricted: true },
    })
  })

  test('without the branch it reads the default branch of the repository', async () => {
    const { github, fake } = leadWith([branchRulesBody(), updateRestrictionBody()], {
      defaultBranch: 'trunk',
    })
    expect((await readProtection(github)).state).toBe('full-restricted')
    expect(fake.calls.map((call) => call.endpoint)).toContain(
      'repos/{owner}/{repo}/rules/branches/trunk',
    )
    expect((await readProtection(github, { branch: 'main' })).state).toBe('soft')
  })

  test('a required check that names only its context is reported unpinned and still reads full', async () => {
    const { github } = leadWith([
      branchRulesBody({ checks: [{ context: 'hackwin' }, { context: 'lint' }] }),
    ])
    expect(await readProtection(github, { branch: 'main' })).toEqual({
      state: 'full',
      rules: {
        ...FULL_RULES,
        requiredChecks: [
          { context: 'hackwin', integrationId: null },
          { context: 'lint', integrationId: null },
        ],
        checkPinned: false,
      },
    })
  })

  test.each([
    ['pull_request', 'pullRequestRequired'],
    ['non_fast_forward', 'forcePushBlocked'],
    ['deletion', 'deletionBlocked'],
  ])(
    'without the rule %s the rules for everyone are incomplete: soft, with %s false',
    async (type, detail) => {
      const { github } = leadWith([branchRulesWithout(type), updateRestrictionBody()])
      expect(await readProtection(github, { branch: 'main' })).toEqual({
        state: 'soft',
        rules: { ...FULL_RULES, [detail]: false, updateRestricted: true },
      })
    },
  )

  test('a required check other than hackwin does not make the rules for everyone', async () => {
    const { github } = leadWith([branchRulesBody({ checks: [{ context: 'check' }] })])
    expect(await readProtection(github, { branch: 'main' })).toEqual({
      state: 'soft',
      rules: {
        ...FULL_RULES,
        requiredChecks: [{ context: 'check', integrationId: null }],
        checkRequired: false,
        checkPinned: false,
      },
    })
  })

  test('the rules for everyone in a rule set with a bypass actor do not bind the owner: soft', async () => {
    const withBypass = { ...branchRulesBody(), bypass_actors: [ADMIN_BYPASS] }
    const { github } = leadWith([withBypass])
    expect(await readProtection(github, { branch: 'main' })).toEqual({
      state: 'soft',
      rules: {
        ...FULL_RULES,
        appliesToAdmins: false,
        bypassable: rulesForEveryoneIn('hackwin-branch-rules'),
      },
    })
  })

  test('all rules in one rule set with the admin role as bypass actor: the update restriction without the rules for everyone, and every other rule bypassable', async () => {
    const body = branchRulesBody()
    const combined = {
      ...body,
      bypass_actors: [ADMIN_BYPASS],
      rules: [...body.rules, ...updateRestrictionBody().rules],
    }
    const { github } = leadWith([combined])
    expect(await readProtection(github, { branch: 'main' })).toEqual({
      state: 'soft',
      rules: {
        ...FULL_RULES,
        appliesToAdmins: false,
        updateRestricted: true,
        bypassable: rulesForEveryoneIn('hackwin-branch-rules'),
      },
    })
  })

  test('one rule of the rules for everyone that only a rule set with bypass actors applies makes them not bind the owner', async () => {
    const checkWithBypass = {
      ...branchRulesBody({ name: 'checks' }),
      bypass_actors: [ADMIN_BYPASS],
      rules: branchRulesBody().rules.filter((rule) => rule.type === 'required_status_checks'),
    }
    const { github } = leadWith([branchRulesWithout('required_status_checks'), checkWithBypass])
    expect(await readProtection(github, { branch: 'main' })).toEqual({
      state: 'soft',
      rules: {
        ...FULL_RULES,
        appliesToAdmins: false,
        bypassable: [{ type: 'required_status_checks', ruleset: 'checks' }],
      },
    })
  })

  test('the rules for everyone spread over several rule sets without bypass actors read full; a further rule set with a bypass actor is listed as bypassable', async () => {
    const checks = {
      ...branchRulesBody({ name: 'checks' }),
      rules: branchRulesBody().rules.filter((rule) => rule.type === 'required_status_checks'),
    }
    const { github } = leadWith([
      branchRulesWithout('required_status_checks'),
      checks,
      { ...branchRulesBody({ name: 'duplicate' }), bypass_actors: [ADMIN_BYPASS] },
    ])
    expect(await readProtection(github, { branch: 'main' })).toEqual({
      state: 'full',
      rules: { ...FULL_RULES, bypassable: rulesForEveryoneIn('duplicate') },
    })
  })

  test('a second rule set with a bypass actor beside the update restriction: full-restricted, with its rule listed as bypassable', async () => {
    const extra = { ...updateRestrictionBody({ name: 'extra-approval' }), rules: [ONE_APPROVAL] }
    const { github } = leadWith([branchRulesBody(), updateRestrictionBody(), extra])
    expect(await readProtection(github, { branch: 'main' })).toEqual({
      state: 'full-restricted',
      rules: {
        ...FULL_RULES,
        updateRestricted: true,
        bypassable: [{ type: 'pull_request', ruleset: 'extra-approval' }],
      },
    })
  })

  test('a rule beside update in the update restriction rule set is listed as bypassable', async () => {
    const restriction = updateRestrictionBody()
    const { github } = leadWith([
      branchRulesBody(),
      { ...restriction, rules: [...restriction.rules, ONE_APPROVAL] },
    ])
    expect(await readProtection(github, { branch: 'main' })).toEqual({
      state: 'full-restricted',
      rules: {
        ...FULL_RULES,
        updateRestricted: true,
        bypassable: [{ type: 'pull_request', ruleset: 'hackwin-update-restriction' }],
      },
    })
  })

  test('rule sets that are disabled or target another branch do not count', async () => {
    const { github } = leadWith([
      { ...branchRulesBody(), enforcement: 'disabled' },
      {
        ...updateRestrictionBody(),
        conditions: { ref_name: { include: ['refs/heads/release'], exclude: [] } },
      },
    ])
    expect(await readProtection(github, { branch: 'main' })).toEqual({
      state: 'soft',
      rules: NO_RULES,
    })
  })

  const UPDATE_BYPASSABLE = [{ type: 'update', ruleset: 'hackwin-update-restriction' }]

  test.each([
    [
      'the write role is a bypass actor too',
      {
        bypass_actors: [
          ADMIN_BYPASS,
          { actor_id: 4, actor_type: 'RepositoryRole', bypass_mode: 'always' },
        ],
      },
      UPDATE_BYPASSABLE,
    ],
    [
      'the rule set has no bypass actor, so nobody may update the branch',
      { bypass_actors: [] },
      [],
    ],
    ['the reading account cannot bypass it', { current_user_can_bypass: 'never' }, []],
    ['GitHub does not return its bypass actors', { bypass_actors: undefined }, []],
    [
      'GitHub does not return whether the reading account can bypass it',
      { current_user_can_bypass: undefined },
      UPDATE_BYPASSABLE,
    ],
  ])(
    'an update rule is not the update restriction when %s: full',
    async (_, change, bypassable) => {
      const { github } = leadWith([branchRulesBody(), { ...updateRestrictionBody(), ...change }])
      expect(await readProtection(github, { branch: 'main' })).toEqual({
        state: 'full',
        rules: { ...FULL_RULES, bypassable },
      })
    },
  )

  test('the update restriction with bypass through pull requests only still restricts updates to the Lead', async () => {
    const { github } = leadWith([
      branchRulesBody(),
      {
        ...updateRestrictionBody(),
        bypass_actors: [{ ...ADMIN_BYPASS, bypass_mode: 'pull_request' }],
        current_user_can_bypass: 'pull_requests_only',
      },
    ])
    expect((await readProtection(github, { branch: 'main' })).state).toBe('full-restricted')
  })

  test('rules for everyone whose bypass actors GitHub does not return count as not binding the owner', async () => {
    const { github } = leadWith([{ ...branchRulesBody(), bypass_actors: undefined }])
    expect(await readProtection(github, { branch: 'main' })).toEqual({
      state: 'soft',
      rules: { ...FULL_RULES, appliesToAdmins: false },
    })
  })

  test('a rule set deleted between the two reads no longer counts', async () => {
    const { github, fake, rulesets } = leadWith([branchRulesBody(), updateRestrictionBody()])
    fake.on('GET repos/{owner}/{repo}/rulesets/:id', ({ params }) => {
      if (Number(params.id) === rulesets[1].id) throw httpError(404, 'Not Found')
      return { ...rulesets[0], current_user_can_bypass: 'never' }
    })
    expect(await readProtection(github, { branch: 'main' })).toEqual({
      state: 'full',
      rules: FULL_RULES,
    })
  })

  test('a branch name with a slash is sent as its path', async () => {
    const { github, fake } = leadWith([])
    await readProtection(github, { branch: 'release/1.0' })
    expect(fake.calls[0].endpoint).toBe('repos/{owner}/{repo}/rules/branches/release/1.0')
  })

  test('the pinned check of setup is the one of docs/verification.md row 5', () => {
    expect(PINNED_CHECK).toEqual({ context: 'hackwin', integration_id: 15368 })
    expect(ADMIN_BYPASS).toEqual({
      actor_id: 5,
      actor_type: 'RepositoryRole',
      bypass_mode: 'always',
    })
  })
})

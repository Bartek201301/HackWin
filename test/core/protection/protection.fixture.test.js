// The protection reader on real fixture repositories. These tests run only through
// `npm run test:ac -- 1.3e/protection`, and fail when a fixture repository or the gh login is
// missing. They act only as the Lead, so they need no HACKWIN_TEST_BUILDER_TOKEN. The reset after
// the scenario deletes the rule sets.

import { describe, expect, test } from 'vitest'
import { readProtection } from '../../../src/core/protection/index.js'
import { withFixtureRepo } from '../../harness/index.js'
import {
  FULL_RULES,
  NO_RULES,
  ONE_APPROVAL,
  branchRulesBody,
  updateRestrictionBody,
} from './rulesets.js'

const TIMEOUT_MS = 30 * 60_000

/** The scenarios act only as the Lead, the account that reads the protection state. */
const AS_LEAD = { accounts: ['lead'] }

/** A rule set the test adds beside the two of setup; the reset deletes it. */
const EXTRA = 'hackwin-reader-extra'

describe('1.3e/protection: the protection state of a fixture repository', () => {
  test(
    'a public fixture repository reads soft, then full with the rules for everyone, then full-restricted with the update restriction, and lists the other rules the Lead can bypass',
    async () => {
      await withFixtureRepo(
        'hackwin-fixture-b',
        async (repo) => {
          const lead = repo.github('lead')
          try {
            expect(await readProtection(lead)).toEqual({ state: 'soft', rules: NO_RULES })

            await lead.api('repos/{owner}/{repo}/rulesets', {
              method: 'POST',
              body: branchRulesBody(),
            })
            expect(await readProtection(lead)).toEqual({ state: 'full', rules: FULL_RULES })

            const restriction = await lead.api('repos/{owner}/{repo}/rulesets', {
              method: 'POST',
              body: updateRestrictionBody(),
            })
            expect(await readProtection(lead, { branch: 'main' })).toEqual({
              state: 'full-restricted',
              rules: { ...FULL_RULES, updateRestricted: true },
            })

            // A second rule set with the admin role as bypass actor: the Lead can bypass its rule.
            await lead.api('repos/{owner}/{repo}/rulesets', {
              method: 'POST',
              body: { ...updateRestrictionBody({ name: EXTRA }), rules: [ONE_APPROVAL] },
            })
            expect(await readProtection(lead)).toEqual({
              state: 'full-restricted',
              rules: {
                ...FULL_RULES,
                updateRestricted: true,
                bypassable: [{ type: 'pull_request', ruleset: EXTRA }],
              },
            })

            // A rule beside update in the update restriction's own rule set.
            const body = updateRestrictionBody()
            await lead.api(`repos/{owner}/{repo}/rulesets/${restriction.id}`, {
              method: 'PUT',
              body: { ...body, rules: [...body.rules, ONE_APPROVAL] },
            })
            const { state, rules } = await readProtection(lead)
            expect(state).toBe('full-restricted')
            expect(rules.updateRestricted).toBe(true)
            expect(rules.bypassable).toHaveLength(2)
            expect(rules.bypassable).toEqual(
              expect.arrayContaining([
                { type: 'pull_request', ruleset: EXTRA },
                { type: 'pull_request', ruleset: 'hackwin-update-restriction' },
              ]),
            )
          } finally {
            await repo.reset()
          }
          expect(await readProtection(lead)).toEqual({ state: 'soft', rules: NO_RULES })
        },
        AS_LEAD,
      )
    },
    TIMEOUT_MS,
  )

  test(
    'the private fixture repository, where GitHub offers no rule sets, reads soft',
    async () => {
      await withFixtureRepo(
        'hackwin-fixture-private',
        async (repo) => {
          expect(await readProtection(repo.github('lead'))).toEqual({
            state: 'soft',
            rules: NO_RULES,
          })
        },
        AS_LEAD,
      )
    },
    TIMEOUT_MS,
  )
})

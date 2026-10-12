// The protection reader on real fixture repositories. These tests run only through
// `npm run test:ac -- 1.3e/protection`, and fail when a fixture repository, the gh login or
// HACKWIN_TEST_BUILDER_TOKEN is missing. The reset after the scenario deletes the rule sets.

import { describe, expect, test } from 'vitest'
import { readProtection } from '../../../src/core/protection/index.js'
import { withFixtureRepo } from '../../harness/index.js'
import { FULL_RULES, NO_RULES, branchRulesBody, updateRestrictionBody } from './rulesets.js'

const TIMEOUT_MS = 30 * 60_000

describe('1.3e/protection: the protection state of a fixture repository', () => {
  test(
    'a public fixture repository reads soft, then full with the rules for everyone, then full-restricted with the update restriction',
    async () => {
      await withFixtureRepo('hackwin-fixture-b', async (repo) => {
        const lead = repo.github('lead')
        try {
          expect(await readProtection(lead)).toEqual({ state: 'soft', rules: NO_RULES })

          await lead.api('repos/{owner}/{repo}/rulesets', {
            method: 'POST',
            body: branchRulesBody(),
          })
          expect(await readProtection(lead)).toEqual({ state: 'full', rules: FULL_RULES })

          await lead.api('repos/{owner}/{repo}/rulesets', {
            method: 'POST',
            body: updateRestrictionBody(),
          })
          expect(await readProtection(lead, { branch: 'main' })).toEqual({
            state: 'full-restricted',
            rules: { ...FULL_RULES, updateRestricted: true },
          })
        } finally {
          await repo.reset()
        }
        expect(await readProtection(lead)).toEqual({ state: 'soft', rules: NO_RULES })
      })
    },
    TIMEOUT_MS,
  )

  test(
    'the private fixture repository, where GitHub offers no rule sets, reads soft',
    async () => {
      await withFixtureRepo('hackwin-fixture-private', async (repo) => {
        expect(await readProtection(repo.github('lead'))).toEqual({
          state: 'soft',
          rules: NO_RULES,
        })
      })
    },
    TIMEOUT_MS,
  )
})

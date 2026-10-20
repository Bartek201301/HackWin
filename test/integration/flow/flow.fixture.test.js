// 1.7a (#26) on the fixture repository `hackwin-fixture-a`: the flow of flow.test.js against real
// GitHub, with real GitHub Actions running the generated workflow, which installs the pre-release
// that setup pinned by URL (plan section 9, decision 5). These tests run only through
// `npm run test:ac`; they need the Lead's gh login, HACKWIN_TEST_BUILDER_TOKEN for builder1
// (`test-bot-builder`), and the pre-release of the running version, and fail at once without it.
//
// The team is the team of 2 of setupAnswers (world.js): no name-only login is in it, and setup
// invites nobody. Push protection is put back as the scenario found it. The harness resets the
// fixture before the scenario, not after.

import { beforeAll, test } from 'vitest'
import { withFixtureRepo } from '../../harness/index.js'
import {
  expectAfterMerge,
  expectInvalidRefused,
  expectNextTakeRemoves,
  expectOnlyMerges,
  expectTakenAndMerged,
} from './expectations.js'
import { takeToMerge } from './flows.js'
import { createLiveWorld, requirePrerelease } from './world-live.js'

const TIMEOUT_MS = 90 * 60_000

/** @type {Record<string, any>} */
let seen

beforeAll(async () => {
  await requirePrerelease()
  seen = await withFixtureRepo(
    'hackwin-fixture-a',
    async (repo) => {
      const world = await createLiveWorld(repo)
      try {
        return await takeToMerge(world)
      } finally {
        await world.restore()
      }
    },
    { accounts: ['lead', 'builder1'] },
  )
}, TIMEOUT_MS)

test('AC65: on a fixture repository, a task issue written by hand from the template is taken by take, shipped by ship, passes CI and is merged by the Gate', () => {
  expectTakenAndMerged(seen)
})

test('AC65: on a fixture repository, take refuses an issue with an invalid data block with the reason, and status lists it as invalid', () => {
  expectInvalidRefused(seen)
})

test('AC32: on a fixture repository, after the merge the remote branch is deleted, the issue is closed, the dependent labeled blocked by hand is ready and takeable, and the scratch worktree is gone', () => {
  expectAfterMerge(seen)
})

test("AC32: on a fixture repository, the next take on the builder's machine removes the worktree of the merged task", () => {
  expectNextTakeRemoves(seen)
})

test('AC33: on a fixture repository in full protection mode, GitHub refuses a push to main, also with the hooks skipped, and every commit on the first parent history of main after the bootstrap commit is the merge commit of a pull request', () => {
  expectOnlyMerges(seen, { live: true })
})

// 1.7a (#26) on the fixture repository `hackwin-fixture-a`: the pull requests of task-link.test.js
// (AC71) against real GitHub, where the hackwin workflow on GitHub Actions is the CI that fails
// them. These tests run only through `npm run test:ac`; they need the Lead's gh login,
// HACKWIN_TEST_BUILDER_TOKEN for builder1 (`test-bot-builder`), and the pre-release of the
// running version, and fail at once without it. The team and the clean up are those of
// flow.fixture.test.js.

import { beforeAll, test } from 'vitest'
import { withFixtureRepo } from '../../harness/index.js'
import { expectTaskLinkFailure, expectWrapperEditFails } from './expectations.js'
import { taskLinkFailures } from './flows.js'
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
        return await taskLinkFailures(world)
      } finally {
        await world.restore()
      }
    },
    { accounts: ['lead', 'builder1'] },
  )
}, TIMEOUT_MS)

test('AC71: on a fixture repository, a pull request whose task issue has an invalid data block fails CI and stage 2 of the Gate', () => {
  expectTaskLinkFailure(seen, 'invalid')
})

test('AC71: on a fixture repository, a pull request that names a closed task fails CI and stage 2 of the Gate', () => {
  expectTaskLinkFailure(seen, 'closed')
})

test('AC71: on a fixture repository, a pull request without a closing line, which names no task, fails CI and stage 2 of the Gate', () => {
  expectTaskLinkFailure(seen, 'none')
})

test('AC71: on a fixture repository, a pull request that names an issue without a task block fails CI and stage 2 of the Gate', () => {
  expectTaskLinkFailure(seen, 'notTask')
})

test('AC71: on a fixture repository, a pull request opened by hand from a spike/ branch fails CI and stage 2 of the Gate', () => {
  expectTaskLinkFailure(seen, 'spike')
})

test('AC71: on a fixture repository, a pull request of the Lead that changes a generated wrapper by hand fails CI (E19)', () => {
  expectWrapperEditFails(seen)
})

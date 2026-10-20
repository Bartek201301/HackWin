// 1.7a (#26) offline: pull requests that name no open task with a valid data block, or come from a
// `spike/` branch, and a pull request of the Lead that edits a generated wrapper by hand (AC71),
// on the fake GitHub linked to a bare origin (world-offline.js). The flow runs once (flows.js,
// taskLinkFailures); each test checks one pull request on its record. The same flow runs on a
// fixture repository in flow.fixture.test.js.

import { afterAll, beforeAll, test } from 'vitest'
import { expectTaskLinkFailure, expectWrapperEditFails } from './expectations.js'
import { taskLinkFailures } from './flows.js'
import { createOfflineWorld } from './world-offline.js'

/** @type {Awaited<ReturnType<typeof createOfflineWorld>>} */
let world
/** @type {Record<string, any>} */
let seen
const log = /** @type {string[]} */ ([])

beforeAll(async () => {
  world = await createOfflineWorld({ log: (line) => log.push(line) })
  try {
    seen = await taskLinkFailures(world)
  } catch (error) {
    error.message = `${error.message}\n\nthe flow's log:\n${log.join('\n')}`
    throw error
  }
}, 300_000)

afterAll(() => world?.cleanup())

test('AC71: a pull request whose task issue has an invalid data block fails CI and stage 2 of the Gate', () => {
  expectTaskLinkFailure(seen, 'invalid')
})

test('AC71: a pull request that names a closed task fails CI and stage 2 of the Gate', () => {
  expectTaskLinkFailure(seen, 'closed')
})

test('AC71: a pull request without a closing line, which names no task, fails CI and stage 2 of the Gate', () => {
  expectTaskLinkFailure(seen, 'none')
})

test('AC71: a pull request that names an issue without a task block fails CI and stage 2 of the Gate', () => {
  expectTaskLinkFailure(seen, 'notTask')
})

test('AC71: a pull request opened by hand from a spike/ branch fails CI and stage 2 of the Gate', () => {
  expectTaskLinkFailure(seen, 'spike')
})

test('AC71: a pull request of the Lead that changes a generated wrapper by hand fails CI (E19)', () => {
  expectWrapperEditFails(seen)
})

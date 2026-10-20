// 1.7a (#26) offline: a task written by hand from `take` to the merge, on the fake GitHub linked
// to a bare origin (world-offline.js), with the commands of this checkout as the members run them.
// The flow runs once (flows.js, takeToMerge); each test checks one criterion on its record. The
// same flow runs on a fixture repository in flow.fixture.test.js.

import { afterAll, beforeAll, test } from 'vitest'
import {
  expectAfterMerge,
  expectInvalidRefused,
  expectNextTakeRemoves,
  expectOnlyMerges,
  expectTakenAndMerged,
} from './expectations.js'
import { takeToMerge } from './flows.js'
import { createOfflineWorld } from './world-offline.js'

/** @type {Awaited<ReturnType<typeof createOfflineWorld>>} */
let world
/** @type {Record<string, any>} */
let seen
const log = /** @type {string[]} */ ([])

beforeAll(async () => {
  world = await createOfflineWorld({ log: (line) => log.push(line) })
  try {
    seen = await takeToMerge(world)
  } catch (error) {
    error.message = `${error.message}\n\nthe flow's log:\n${log.join('\n')}`
    throw error
  }
}, 300_000)

afterAll(() => world?.cleanup())

test('AC65: a task issue written by hand from the template is taken by take, shipped by ship and merged by the Gate', () => {
  expectTakenAndMerged(seen)
})

test('AC65: take refuses an issue with an invalid data block with the reason, and status lists it as invalid', () => {
  expectInvalidRefused(seen)
})

test('AC32: after the merge the remote branch is deleted, the issue is closed, the dependent labeled blocked by hand is ready and takeable, and the scratch worktree is gone', () => {
  expectAfterMerge(seen)
})

test("AC32: on the builder's machine the next take removes the worktree of the merged task", () => {
  expectNextTakeRemoves(seen)
})

test('AC33: in full protection mode every commit on the first parent history of main after the bootstrap commit is the merge commit of a pull request', () => {
  expectOnlyMerges(seen, world)
})

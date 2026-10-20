// Solo mode in Phase 1 (AC66), offline: one member, who is the Lead, runs `setup`, writes a task
// by hand from the task issue template, takes it from a terminal, ships it, and the Gate merges
// it; then `status` shows the merge. GitHub is the fake GitHub linked to the fixture's bare
// origin, and a successful check run `hackwin` on the head stands for the CI run of GitHub
// Actions. The same flow on a fixture repository, with the real CI, is in
// parity.fixture.test.js.

import { afterEach, describe, expect, test } from 'vitest'
import { expectSolo, runSolo } from './flows.js'
import { createOfflineWorld } from './world-offline.js'

/** @type {Array<() => Promise<void>>} */
const cleanups = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

describe('AC66: solo mode', () => {
  test('AC66: with one member, setup, a task written by hand, take, ship, a Gate merge and status complete', async () => {
    const scene = await createOfflineWorld()
    cleanups.push(scene.cleanup)
    const { world, fake } = scene
    const setup = await scene.setup()
    expect(setup.code, setup.stderr).toBe(0)
    expect(setup.stdout).toContain('setup of hackwin-test/app is complete')
    expect(scene.team.members).toHaveLength(1)

    const run = await runSolo(world, {
      beforeGate: async ({ headSha }) => {
        fake.addCheckRun(headSha, { name: 'hackwin', conclusion: 'success' })
      },
      mergeTimeoutMs: 120_000,
    })

    await expectSolo(world, run)
  }, 180_000)
})

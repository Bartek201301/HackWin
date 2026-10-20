// The world of the parity scenarios on a fixture repository reaches no other repository: every
// call must name the fixture repository as GH_REPO, in-process and from a wrapper's child
// process, before the executor runs it. A call without GH_REPO would make gh take the repository
// of its working directory; on 20 October 2026 that created the issues #102 to #105 in
// Bartek201301/HackWin (world.js).

import { afterEach, describe, expect, test } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exec } from '../../../src/core/runtime/index.js'
import { isolatedEnv } from '../../harness/index.js'
import { createWorld, repositoryRefusal } from './world.js'

const FIXTURE = 'Bartek201301/hackwin-fixture-b'

/** @type {Array<() => Promise<void>>} */
const cleanups = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

/** A world on the fixture repository whose executor only records the calls that reach it. */
async function recordingWorld() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hackwin-parity-world-')))
  /** @type {Array<{ args: string[], env: Record<string, string> | undefined }>} */
  const reached = []
  const world = await createWorld({
    main: dir,
    dir,
    env: isolatedEnv(join(dir, 'home')),
    executor: async (args, call = {}) => {
      reached.push({ args, env: call.env })
      return { code: 0, stdout: '{"number":1}', stderr: '' }
    },
    repo: FIXTURE,
    login: 'lead',
  })
  cleanups.push(async () => {
    await world.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { world, reached }
}

describe('1.7c/repository: the world on a fixture repository calls only that repository', () => {
  test('1.7c/repository: a call without GH_REPO, with another GH_REPO or with an endpoint of another repository is refused before the executor runs it; the world client names the fixture repository', async () => {
    const { world, reached } = await recordingWorld()
    const issues = ['api', '--method', 'POST', 'repos/{owner}/{repo}/issues', '--input', '-']

    for (const [args, env, reason] of /** @type {const} */ ([
      [issues, {}, 'the call names no repository (no GH_REPO)'],
      [issues, { GH_REPO: 'Bartek201301/HackWin' }, 'the call names Bartek201301/HackWin'],
      [
        ['api', 'repos/Bartek201301/HackWin/issues'],
        { GH_REPO: FIXTURE },
        'the endpoint repos/Bartek201301/HackWin/issues names Bartek201301/HackWin',
      ],
    ])) {
      const result = await world.executor([...args], { input: '{}', env: { ...env } })
      expect(result.code).toBe(1)
      expect(result.stderr).toContain(`refused by the parity scenario: ${reason}`)
    }
    expect(reached).toEqual([])
    expect(world.refused).toHaveLength(3)

    // The fixture repository passes, in any case, and the world's own client names it.
    const allowed = await world.executor(issues, {
      input: '{}',
      env: { GH_REPO: FIXTURE.toUpperCase() },
    })
    expect(allowed.code).toBe(0)
    expect(await world.github.api('repos/{owner}/{repo}/issues/1')).toEqual({ number: 1 })
    expect(reached.map((call) => call.env?.GH_REPO)).toEqual([FIXTURE.toUpperCase(), FIXTURE])
  })

  test("1.7c/repository: a wrapper's child process that calls gh without GH_REPO is refused through the bridge, and one that names the fixture repository passes", async () => {
    const { world, reached } = await recordingWorld()

    const without = await exec('gh', ['api', '--method', 'GET', 'repos/{owner}/{repo}/issues/1'], {
      env: world.wrapperEnv,
    })
    expect(without.code).toBe(1)
    expect(without.stderr).toContain('refused by the parity scenario: the call names no repository')
    expect(reached).toEqual([])

    const named = await exec('gh', ['api', '--method', 'GET', 'repos/{owner}/{repo}/issues/1'], {
      env: { ...world.wrapperEnv, GH_REPO: FIXTURE },
    })
    expect(named.code).toBe(0)
    expect(named.stdout).toBe('{"number":1}')
    expect(reached.map((call) => call.env?.GH_REPO)).toEqual([FIXTURE])
    expect(world.bridgeCalls.map((call) => call.code)).toEqual([1, 0])
  })

  test('1.7c/repository: repositoryRefusal names why a call is refused, and lets a call of the fixture repository through', () => {
    expect(repositoryRefusal(['api', 'user'], { env: { GH_REPO: FIXTURE } }, FIXTURE)).toBeNull()
    expect(
      repositoryRefusal(
        ['api', '/repos/Bartek201301/hackwin-fixture-b/pulls'],
        { env: { GH_REPO: FIXTURE } },
        FIXTURE,
      ),
    ).toBeNull()
    expect(repositoryRefusal(['api', 'user'], {}, FIXTURE)).toContain('no GH_REPO')
    expect(
      repositoryRefusal(
        ['api', '/repos/Bartek201301/HackWin/pulls'],
        { env: { GH_REPO: FIXTURE } },
        FIXTURE,
      ),
    ).toContain('names Bartek201301/HackWin')
  })
})

// AC14 and AC66 on the fixture repository `hackwin-fixture-b`, with the merged lanes and real
// GitHub. These tests run only through `npm run test:ac`. They act only as the Lead, whose account
// is also `solo`, the only member of a solo team, so they need no HACKWIN_TEST_BUILDER_TOKEN and
// invite nobody. The reset before each scenario closes the issues and pull requests of the last
// run, deletes its branches, labels and rule sets and resets main.
//
// Every gh call goes through the harness's guarded executor, also those of a wrapper's child
// process, and must name hackwin-fixture-b as GH_REPO (world.js, repositoryRefusal). The child's git still needs the real gh as its credential helper, so its
// global git config names gh by its absolute path, as the gh on PATH is the bridge.
//
// The Gate's merge of AC66 waits for the CI check `hackwin`, whose workflow installs the CLI
// version that hackwin.yml pins: the version of this checkout, which `setup` pins. Before the
// first pre-release of HackWin exists (plan section 9, decision 5), that install fails, so the
// scenario checks the release asset before it starts the Gate and fails there, naming the
// version and the URL.

import { describe, expect, test } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPOSITORY_URL, VERSION } from '../../../src/cli/context.js'
import { installCommand } from '../../../src/core/config/index.js'
import { exec, quoteShellArg } from '../../../src/core/runtime/index.js'
import { teamConfig, withFixtureRepo } from '../../harness/index.js'
import { expectParity, expectSolo, runParity, runSolo } from './flows.js'
import { LIVE_SETTLE, createWorld, runSetup, soloAnswers } from './world.js'

/** @import { FixtureRepoContext } from '../../harness/index.js' */

const REPOSITORY = 'hackwin-fixture-b'

/** The scenarios act only as the Lead, the solo member. */
const AS_SOLO = { accounts: ['solo'] }

/**
 * A world on the fixture repository: the Lead's clone, the Lead's guarded executor, and an
 * environment whose git calls the real gh for credentials.
 * @param {FixtureRepoContext} repo
 */
async function liveWorld(repo) {
  const clone = await repo.clone('solo')
  const dir = join(repo.tempDir, 'world')
  mkdirSync(dir, { recursive: true })
  const env = await withRealGhHelper(clone.env, dir)
  return createWorld({
    main: clone.path,
    dir,
    env,
    executor: repo.executor('solo'),
    repo: repo.repo,
    login: repo.logins.solo,
    settle: LIVE_SETTLE,
    log: repo.log,
  })
}

/**
 * The environment with a copy of its global git config whose credential helper runs the real gh
 * by its absolute path.
 * @param {Record<string, string | undefined>} env
 * @param {string} dir
 */
async function withRealGhHelper(env, dir) {
  const found = await exec('/bin/sh', ['-c', 'command -v gh'], { env })
  const gh = found.stdout.trim()
  if (found.code !== 0 || gh === '') throw new Error('gh is not on the PATH of the Lead')
  const config = readFileSync(/** @type {string} */ (env.GIT_CONFIG_GLOBAL), 'utf8')
  const helper = JSON.stringify('!gh auth git-credential')
  if (!config.includes(helper)) throw new Error(`the Lead's git config has no ${helper} helper`)
  const file = join(dir, 'lead.gitconfig')
  writeFileSync(
    file,
    config.replace(helper, JSON.stringify(`!${quoteShellArg(gh)} auth git-credential`)),
  )
  return { ...env, GIT_CONFIG_GLOBAL: file }
}

/**
 * `setup` of the solo team on the fixture repository, as the Lead.
 * @param {Awaited<ReturnType<typeof liveWorld>>} world
 */
async function liveSetup(world) {
  const setup = await runSetup(world, soloAnswers(teamConfig(1)))
  expect(setup.stderr).not.toContain('hackwin setup:')
  expect(setup.code).toBe(0)
  return setup
}

/**
 * Where the CI workflow installs the pinned version from: the `.tgz` of a GitHub pre-release, or
 * the npm registry for a release (contracts 6.3).
 * @param {string} version
 */
function installSource(version) {
  const target = installCommand(version, REPOSITORY_URL).replace(/^npm install -g /, '')
  return target.startsWith('https://') ? target : `https://registry.npmjs.org/hackwin/${version}`
}

/**
 * Fail unless the CLI version that hackwin.yml pins can be installed, as the CI workflow installs
 * it, without credentials. A request that fails without an HTTP status or with a 5xx is made
 * again, up to 4 times, after waits of 1, 2 and 4 seconds.
 * @param {string} version
 * @param {(line: string) => void} log
 */
async function requireInstallable(version, log) {
  const url = installSource(version)
  /** @type {string} */
  let answer = ''
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, { method: 'HEAD', redirect: 'follow' })
      log(`HEAD ${url} -> HTTP ${response.status}`)
      if (response.ok) return
      answer = `HTTP ${response.status}`
      if (response.status < 500) break
    } catch (error) {
      answer = `no answer (${error instanceof Error ? error.message : error})`
      log(`HEAD ${url} -> ${answer}`)
    }
    if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1)))
  }
  throw new Error(
    `the Gate's merge waits for the CI check hackwin, whose workflow installs hackwin ${version}, the version hackwin.yml pins, from ${url}, which gave ${answer}: create the pre-release v${version} with the asset hackwin-${version}.tgz (plan section 9, decision 5; contracts 6.2), then run this test again`,
  )
}

describe('AC14: terminal and Claude Code parity on a fixture repository', () => {
  test(
    'AC14: on hackwin-fixture-b, take, ship and status from a terminal and through the Claude Code wrappers give the same labels, branch, pull request body and exit code',
    async () => {
      await withFixtureRepo(
        REPOSITORY,
        async (repo) => {
          const world = await liveWorld(repo)
          try {
            await liveSetup(world)
            const run = await runParity(world)
            expectParity(world, run)
            expect(world.bridgeCalls.length).toBeGreaterThan(0)
            expect(world.bridgeCalls.filter((call) => call.code !== 0)).toEqual([])
            expect(world.refused).toEqual([])
          } finally {
            await world.close()
          }
        },
        AS_SOLO,
      )
    },
    30 * 60_000,
  )
})

describe('AC66: solo mode on a fixture repository', () => {
  test(
    'AC66: on hackwin-fixture-b, with one member, setup, a task written by hand, take, ship, a Gate merge after the CI check of GitHub Actions and status complete',
    async () => {
      await withFixtureRepo(
        REPOSITORY,
        async (repo) => {
          const world = await liveWorld(repo)
          try {
            await liveSetup(world)
            const run = await runSolo(world, {
              beforeGate: () => requireInstallable(VERSION, repo.log),
              mergeTimeoutMs: 25 * 60_000,
            })
            await expectSolo(world, run)
            expect(world.refused).toEqual([])
          } finally {
            await world.close()
          }
        },
        AS_SOLO,
      )
    },
    45 * 60_000,
  )
})

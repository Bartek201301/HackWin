// The version rule and a bug fix release of the same phase on the fixture repository
// hackwin-fixture-c (20.6, CM12, 10.2, 7.1 --regenerate). These scenarios run only through
// `npm run test:ac` and act only as the Lead, in a team of one, so they need no
// HACKWIN_TEST_BUILDER_TOKEN and name no builder.
//
// - The AC76 scenarios run with the CLI of this checkout.
// - The AC77 scenarios install the GitHub pre-releases of this repository by URL, as a member
//   does with the install command of CM12: `<phase>.0-pre.<n>`, its bug fix `<phase>.1-pre.<n>`
//   and `<next phase>.0-pre.<n>` (docs/build/contracts.md 6.2), with `n` from
//   HACKWIN_TEST_PRERELEASE. They fail, and name the versions to create, while it is not set.
//   GitHub Actions runs the generated workflow, which installs the pinned version by the same
//   URL, so the check passes only when the pre-releases exist.
//
// setup enables push protection (step 13), a setting that the reset leaves alone, so every
// scenario that runs setup puts it back as it found it.

import { describe, expect, test } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WORKFLOW_PATH, generatedBy } from '../../../src/generate/index.js'
import { withFixtureRepo } from '../../harness/index.js'
import { checkoutCli, installCli, installOf, releasesOf } from './clis.js'
import {
  checkLog,
  finishedCheck,
  joinLive,
  keepingPushProtection,
  leadClone,
  leadExecutor,
  leadGitHub,
  prereleaseBuild,
  remoteMain,
  runLive,
  setupLive,
  soloAnswers,
  writeCalls,
} from './live.js'
import { RELEASE_PATHS, startGate, taskBody } from './scene.js'

/** @typedef {import('./clis.js').Cli} Cli */
/** @typedef {import('../../harness/index.js').FixtureRepoContext} FixtureRepoContext */
/** @typedef {import('./live.js').LeadClone} LeadClone */

const FIXTURE = 'hackwin-fixture-c'

/** The scenarios act only as the Lead. */
const AS_LEAD = { accounts: ['lead'] }

const TIMEOUT_MS = 30 * 60_000

/** The procedure waits for CI twice and for the Gate's polls. */
const PROCEDURE_TIMEOUT_MS = 90 * 60_000

/** An acceptance test file of the Node fixture; the stand-in test command `ls` passes for it. */
const ACCEPTANCE = 'src/features/counter/counter.test.ts'

/**
 * setup's one warning on the Node fixture, whose check workflow is the project's own, not the
 * template's placeholder (6.5).
 */
const CHECK_WORKFLOW_KEPT =
  "warning: .github/workflows/check.yml was changed by the team, so it stays; the hackwin job of .github/workflows/hackwin.yml now runs the project's check as well\n"

/** The six commands of Phase 1. */
const COMMANDS = Object.freeze(['setup', 'join', 'take', 'ship', 'status', 'gate'])

/**
 * The Lead writes a task of the shared role by hand (I2), ready to take; its number.
 * @param {FixtureRepoContext} repo
 * @param {string} title
 * @param {readonly string[]} paths
 */
async function writeTask(repo, title, paths) {
  const issue = await leadGitHub(repo).createIssue({
    title,
    body: taskBody({ role: 'shared', paths, acceptance: [ACCEPTANCE] }),
    labels: ['ready', 'role:shared'],
  })
  repo.log(`the Lead wrote task #${issue.number}: ${title}`)
  return issue.number
}

/**
 * The worktree of a task in the Lead's clone, as take created it.
 * @param {LeadClone} clone
 * @param {number} issue
 */
async function worktreeOf(clone, issue) {
  const found = (await clone.git.worktreeList()).find((entry) =>
    entry.branch?.replace(/^refs\/heads\//, '').startsWith(`task/${issue}-`),
  )
  if (!found) throw new Error(`no task worktree of #${issue} in ${clone.path}`)
  return { path: found.path, git: clone.git.with({ cwd: found.path }) }
}

/**
 * The versions of the pre-releases, before the scenario takes the lock: a scenario without them
 * fails at once and names the versions to create.
 */
function prereleases() {
  return releasesOf(prereleaseBuild(releasesOf))
}

/**
 * The three pre-releases, installed by URL into the scenario's directory.
 * @param {FixtureRepoContext} repo
 * @param {LeadClone} clone
 * @param {{ old: string, fix: string, other: string }} versions
 */
async function installReleases(repo, clone, versions) {
  const dir = join(repo.tempDir, 'npm')
  mkdirSync(dir, { recursive: true })
  /** @type {Record<string, Cli>} */
  const installed = {}
  for (const [name, version] of Object.entries(versions)) {
    const cli = await installCli(dir, version, clone.env)
    repo.log(`installed hackwin ${cli.version} with ${cli.command}`)
    installed[name] = cli
  }
  return { old: installed.old, fix: installed.fix, other: installed.other }
}

/**
 * Type `quit` into a Gate that still runs and wait for it to stop, at most two minutes.
 * @param {ReturnType<typeof startGate>} gate
 */
async function stopGate(gate) {
  const stopped = await Promise.race([
    gate.done.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 0)),
  ])
  if (stopped) return
  gate.io.type('quit')
  await Promise.race([gate.done, new Promise((resolve) => setTimeout(resolve, 120_000))])
}

/**
 * The procedure of 20.6 on a repository that setup has not configured yet.
 * @param {object} scenario
 * @param {FixtureRepoContext} scenario.repo
 * @param {LeadClone} scenario.clone
 * @param {{ old: string, fix: string, other: string }} scenario.versions
 * @param {Cli} scenario.old
 * @param {Cli} scenario.fix
 * @param {(cli: Cli) => ReturnType<typeof startGate>} scenario.gateOf Starts a Gate.
 */
async function procedure({ repo, clone, versions, old, fix, gateOf }) {
  const setup = await setupLive(repo, clone, old, soloAnswers(repo))
  expect(setup.stderr).toBe(CHECK_WORKFLOW_KEPT)
  expect(setup.code).toBe(0)
  await clone.git.fetch()
  expect(await clone.git.showFile('origin/main', 'hackwin.yml')).toContain(
    `cli_version: ${versions.old}`,
  )
  expect(await clone.git.showFile('origin/main', WORKFLOW_PATH)).toContain(
    generatedBy(versions.old),
  )
  const first = gateOf(old)
  await first.started()

  // 1. The Lead installs the bug fix release; until its pull request is merged, it works with a
  // one-line warning.
  const warning = `warning: hackwin ${versions.fix} is newer than ${versions.old}, the version pinned in hackwin.yml; continuing\n`
  const status = await runLive(repo, clone, fix, ['status'])
  expect(status.code).toBe(0)
  expect(status.stderr).toBe(warning)

  // 2. The Lead stops the Gate with `quit` and starts it again with the new version.
  expect(await first.quit()).toBe(0)
  const gate = gateOf(fix)
  await gate.started()
  expect(gate.io.err).toBe(warning)

  // 3. A task of the shared role; take, setup --regenerate and ship in its worktree.
  const issue = await writeTask(repo, 'Install the bug fix release', RELEASE_PATHS)
  const take = await runLive(repo, clone, fix, ['take', String(issue)])
  expect(take.code).toBe(0)
  const task = await worktreeOf(clone, issue)
  const regenerate = await runLive(repo, clone, fix, ['setup', '--regenerate'], {
    cwd: task.path,
  })
  expect(regenerate.code).toBe(0)
  expect(regenerate.stdout).toContain(`cli_version ${versions.old} -> ${versions.fix}`)
  const ship = await runLive(repo, clone, fix, ['ship'], { cwd: task.path })
  expect(ship.stderr).toBe(warning)
  expect(ship.code).toBe(0)
  const head = await task.git.revParse('HEAD')
  const [pull] = await leadGitHub(repo).listPullRequests({ state: 'open' })
  expect(pull.headSha).toBe(head)

  // 4. CI checks the pull request with the version it names, and the Gate merges it.
  const check = await finishedCheck(repo, head)
  const log = await checkLog(repo, check)
  expect(log).toContain(
    `this pull request sets cli_version to ${versions.fix}; installing hackwin ${versions.fix}`,
  )
  expect(log).toContain(`checked with hackwin ${versions.fix}, the version this pull request sets`)
  expect(check.conclusion).toBe('success')
  await gate.advanceUntil(
    async () => (await leadGitHub(repo).getPullRequest(pull.number))?.merged,
    `the Gate's merge of #${pull.number}`,
  )
  expect(await gate.quit()).toBe(0)
  expect(gate.io.out).toContain(`#${pull.number} merged head ${head}`)
  await clone.git.fetch()
  expect(await clone.git.showFile('origin/main', 'hackwin.yml')).toContain(
    `cli_version: ${versions.fix}`,
  )

  // 5. From that merge on, the older CLI exits 2 from every command and prints the
  // install command; the Lead installs the new version and runs join again.
  for (const command of COMMANDS) {
    const result = await runLive(repo, clone, old, [command])
    expect(result.code, command).toBe(2)
    expect(result.stderr).toBe(
      [
        `hackwin ${command}: hackwin ${versions.old} is older than ${versions.fix}, the version pinned in hackwin.yml on origin/main`,
        `  to resolve: run \`${installOf(versions.fix)}\` in any directory`,
        '',
      ].join('\n'),
    )
  }
  const joined = await joinLive(repo, clone, fix)
  expect(joined.code).toBe(0)
  expect(joined.stderr).toBe('')
}

describe('AC76: the identity and agent of the Lead, and the install before a manifest, on a fixture repository', () => {
  test(
    'AC76: setup run under an account other than the one named as the Lead exits 2 and changes nothing on GitHub',
    async () => {
      await withFixtureRepo(
        FIXTURE,
        async (repo) => {
          const clone = await leadClone(repo)
          const cli = await checkoutCli(repo.tempDir)
          // The answers name builder1 as the Lead, while gh is logged in as the Lead.
          const other = 'test-bot-builder'
          const answers = soloAnswers(repo, (a) => {
            a.team.lead = other
            a.team.members[0].github = other
          })
          // Should setup get past the check, its step 13 would change push protection.
          await keepingPushProtection(repo, async () => {
            const from = repo.calls.length
            const result = await setupLive(repo, clone, cli, answers)
            expect(result.code).toBe(2)
            expect(result.stderr).toContain(
              `the Lead is ${other}, but gh is logged in as ${repo.logins.lead}: setup must be run by the Lead`,
            )
            expect(writeCalls(repo, from)).toEqual([])
            expect(await remoteMain(clone)).toBe(repo.resetSha)
            expect(await clone.git.isClean()).toBe(true)
          })
        },
        AS_LEAD,
      )
    },
    TIMEOUT_MS,
  )

  test(
    'AC76: setup with answers that give the Lead the agent codex exits 2, names the reason and changes nothing on GitHub',
    async () => {
      await withFixtureRepo(
        FIXTURE,
        async (repo) => {
          const clone = await leadClone(repo)
          const cli = await checkoutCli(repo.tempDir)
          const answers = soloAnswers(repo, (a) => {
            a.team.members[0].agent = 'codex'
          })
          await keepingPushProtection(repo, async () => {
            const from = repo.calls.length
            const result = await setupLive(repo, clone, cli, answers)
            expect(result.code).toBe(2)
            expect(result.stderr).toContain('team.members[0].agent is codex')
            expect(result.stderr).toContain(
              "the Claude Code deny rule is the only block against a merge by the Lead's own sessions",
            )
            expect(result.stderr).toContain('key: team.members[0].agent')
            expect(writeCalls(repo, from)).toEqual([])
            expect(await remoteMain(clone)).toBe(repo.resetSha)
          })
        },
        AS_LEAD,
      )
    },
    TIMEOUT_MS,
  )

  test(
    "AC76: in a repository whose manifest does not exist yet, setup's join and take skip the install with a notice",
    async () => {
      await withFixtureRepo(
        FIXTURE,
        async (repo) => {
          const clone = await leadClone(repo)
          const cli = await checkoutCli(repo.tempDir)
          // main before the foundation: no file matches paths.manifests (A62). The reset left
          // no branch rule, so the Lead pushes it directly; the next reset puts main back.
          for (const file of ['package.json', 'package-lock.json']) {
            rmSync(join(clone.path, file))
          }
          await clone.git.run(['commit', '--quiet', '-am', 'Before the foundation'])
          await clone.git.push({ refspecs: ['HEAD:refs/heads/main'] })
          await keepingPushProtection(repo, async () => {
            const setup = await setupLive(repo, clone, cli, soloAnswers(repo))
            expect(setup.stderr).toBe(CHECK_WORKFLOW_KEPT)
            expect(setup.code).toBe(0)
            expect(setup.stdout).toContain(
              'skip  install: no file matches paths.manifests (package.json)',
            )
            const issue = await writeTask(repo, 'A first task', ['docs/**'])
            const take = await runLive(repo, clone, cli, ['take', String(issue)])
            expect(take.code).toBe(0)
            expect(take.stdout).toContain(
              'install skipped: no file matches paths.manifests (package.json)',
            )
          })
        },
        AS_LEAD,
      )
    },
    TIMEOUT_MS,
  )
})

describe('AC77: a bug fix release of the same phase on a fixture repository, with the GitHub pre-releases', () => {
  test(
    'AC77: the procedure of 20.6: the newer release installed by URL, the Gate restarted, setup --regenerate in a task of the shared role, ship, CI with the version the pull request names, the Gate merge, and afterwards the older CLI exits 2 from every command',
    async () => {
      const versions = prereleases()
      await withFixtureRepo(
        FIXTURE,
        async (repo) => {
          const clone = await leadClone(repo)
          const clis = await installReleases(repo, clone, versions)
          await keepingPushProtection(repo, async () => {
            /** @type {Array<ReturnType<typeof startGate>>} */
            const gates = []
            const gateOf = (/** @type {Cli} */ cli) => {
              const gate = startGate(cli, {
                cwd: clone.path,
                env: clone.envOf(cli),
                ghExecutor: leadExecutor(repo),
                patienceMs: PROCEDURE_TIMEOUT_MS,
              })
              gates.push(gate)
              return gate
            }
            try {
              await procedure({ repo, clone, versions, ...clis, gateOf })
            } finally {
              // A Gate that a failed step left running stops before the lock is released.
              await Promise.all(gates.map((gate) => stopGate(gate)))
            }
          })
        },
        AS_LEAD,
      )
    },
    PROCEDURE_TIMEOUT_MS,
  )

  test(
    'AC77: a pull request that sets cli_version to a release of another phase fails CI, and setup --regenerate run with a CLI of another phase exits 2',
    async () => {
      const versions = prereleases()
      await withFixtureRepo(
        FIXTURE,
        async (repo) => {
          const clone = await leadClone(repo)
          const { old, other } = await installReleases(repo, clone, versions)
          await keepingPushProtection(repo, async () => {
            const setup = await setupLive(repo, clone, old, soloAnswers(repo))
            expect(setup.code).toBe(0)
            const issue = await writeTask(repo, 'Move to the next phase', RELEASE_PATHS)
            expect((await runLive(repo, clone, old, ['take', String(issue)])).code).toBe(0)
            const task = await worktreeOf(clone, issue)

            // setup --regenerate with a CLI of another phase exits 2 and changes nothing [D10].
            const before = await task.git.revParse('HEAD')
            const regenerate = await runLive(repo, clone, other, ['setup', '--regenerate'], {
              cwd: task.path,
            })
            expect(regenerate.code).toBe(2)
            expect(regenerate.stderr).toContain(`hackwin ${versions.other} is a release of phase`)
            expect(regenerate.stderr).toContain(installOf(versions.old))
            expect(await task.git.revParse('HEAD')).toBe(before)
            expect(await task.git.isClean()).toBe(true)

            // A pull request that sets cli_version to a release of another phase fails CI.
            const hackwin = /** @type {string} */ (await task.git.showFile('HEAD', 'hackwin.yml'))
            writeFileSync(
              join(task.path, 'hackwin.yml'),
              hackwin.replace(`cli_version: ${versions.old}`, `cli_version: ${versions.other}`),
            )
            await task.git
              .with({ env: clone.envOf(old) })
              .run(['commit', '--quiet', '-am', `Set cli_version to ${versions.other}`])
            const ship = await runLive(repo, clone, old, ['ship'], { cwd: task.path })
            expect(ship.code).toBe(0)
            const head = await task.git.revParse('HEAD')
            const check = await finishedCheck(repo, head)
            const log = await checkLog(repo, check)
            expect(log).toContain(
              `hackwin.yml on main pins ${versions.old}; installing hackwin ${versions.old}`,
            )
            expect(log).toContain(`cli_version (${versions.other}) is of phase`)
            expect(check.conclusion).toBe('failure')
          })
        },
        AS_LEAD,
      )
    },
    TIMEOUT_MS,
  )
})

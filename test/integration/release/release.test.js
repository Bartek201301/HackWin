// The version rule and a bug fix release of the same phase across the lanes (20.6, CM12, 10.2,
// 7.1 --regenerate), offline: CLIs of three versions built from this checkout (clis.js) run
// against the Lead's fake GitHub on a repository with a bare origin (scene.js). The versions are
// build 1 of the scheme of docs/build/contracts.md 6.2: `old` the release the project starts
// with, `fix` its bug fix release of the same phase, `other` a release of the next phase. The
// same procedure on a fixture repository, with the GitHub pre-releases installed by URL and the
// real CI, is in release.fixture.test.js.

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readLocal } from '../../../src/core/state/index.js'
import { WORKFLOW_PATH, generatedBy } from '../../../src/generate/index.js'
import { installOf } from './clis.js'
import { OFF_FIXTURE, fixtureOnly, offFixture } from './live.js'
import {
  BUILDER1,
  LEAD,
  PROJECT,
  RELEASES,
  RELEASE_PATHS,
  buildClis,
  createScene,
  setupAnswers,
  until,
} from './scene.js'

/** @typedef {import('./clis.js').Cli} Cli */
/** @typedef {import('./scene.js').Scene} Scene */

/** Each scenario runs several commands; a loaded machine must not fail it on time. */
const TIMEOUT_MS = 120_000

/** The six commands of Phase 1, each as a member would run it (7.0). */
const COMMANDS = Object.freeze([['setup'], ['join'], ['take'], ['ship'], ['status'], ['gate']])

/** @type {string} */
let dir
/** @type {{ old: Cli, fix: Cli, other: Cli }} */
let clis

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'hackwin-release-')))
  clis = await buildClis(dir)
})

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

/**
 * The error that CM12 prints for an older CLI: exit 2 and the install command of the pinned
 * version, in any directory.
 * @param {string} command
 * @param {string} running
 * @param {string} pinned
 */
function olderError(command, running, pinned) {
  return [
    `hackwin ${command}: hackwin ${running} is older than ${pinned}, the version pinned in hackwin.yml on origin/main`,
    `  to resolve: run \`${installOf(pinned)}\` in any directory`,
  ].join('\n')
}

/**
 * The error that CM12 prints for a CLI of another phase.
 * @param {string} command
 * @param {string} running
 * @param {string} pinned
 */
function otherPhaseError(command, running, pinned) {
  return [
    `hackwin ${command}: hackwin ${running} is a release of phase ${phaseOf(running)}, but this project is on phase ${phaseOf(pinned)}: hackwin.yml on origin/main pins ${pinned}`,
    `  to resolve: run \`${installOf(pinned)}\` in any directory`,
  ].join('\n')
}

/** The phase of a version: its major and minor numbers (A60). */
function phaseOf(/** @type {string} */ version) {
  return version.split('.').slice(0, 2).join('.')
}

/** The one-line warning of a newer bug fix release of the same phase (CM12). */
function newerWarning(/** @type {string} */ running, /** @type {string} */ pinned) {
  return `warning: hackwin ${running} is newer than ${pinned}, the version pinned in hackwin.yml; continuing\n`
}

/**
 * A project that `setup` of a CLI configured, with the Lead's clone joined.
 * @param {Cli} cli
 * @returns {Promise<Scene>}
 */
async function configured(cli) {
  const scene = await createScene(clis)
  const setup = await scene.setup(cli)
  expect(setup.stderr).toBe('')
  expect(setup.code).toBe(0)
  expect(await scene.pinned()).toBe(cli.version)
  return scene
}

/**
 * The Lead writes a task of the shared role that installs a bug fix release, and takes it with a
 * CLI; the task and its worktree.
 * @param {Scene} scene
 * @param {Cli} cli
 */
async function takeReleaseTask(scene, cli) {
  const issue = await scene.task({
    title: 'Install the bug fix release',
    role: 'shared',
    paths: RELEASE_PATHS,
  })
  const take = await scene.run(cli, ['take', String(issue)])
  expect(take.code).toBe(0)
  return { issue, ...(await scene.worktree(issue)) }
}

describe('1.7d/clis: the CLIs of the scenarios are this checkout with another version', () => {
  test('1.7d/clis: each CLI reports its own version and runs its own copy of the code', async () => {
    for (const [name, version] of Object.entries(RELEASES)) {
      const cli = clis[/** @type {'old' | 'fix' | 'other'} */ (name)]
      let out = ''
      const code = await cli.main(['--version'], {
        stdout: { write: (/** @type {string} */ chunk) => (out += chunk) },
      })
      expect(code).toBe(0)
      expect(out).toBe(`${version}\n`)
      const context = await import(pathToFileURL(join(cli.root, 'src/cli/context.js')).href)
      expect(context.VERSION).toBe(version)
    }
  })
})

describe('1.7d/live-guard: every gh call of the live scenarios names the fixture repository', () => {
  const FIXTURE = 'Bartek201301/hackwin-fixture-c'
  const ON_FIXTURE = { env: { GH_REPO: FIXTURE } }

  test('1.7d/live-guard: a call on {owner}/{repo} without GH_REPO is refused, as gh would pick the repository from its working directory', () => {
    for (const args of [
      ['api', '--method', 'POST', 'repos/{owner}/{repo}/issues', '--input', '-'],
      ['api', '--method', 'GET', 'repos/{owner}/{repo}/pulls?state=open&per_page=100&page=1'],
      ['pr', 'merge', '12', '--merge', '--match-head-commit', 'a'.repeat(40)],
      ['run', 'view', '7', '--log'],
    ]) {
      expect(offFixture(args, {}, FIXTURE), args.join(' ')).toContain('names no GH_REPO')
      expect(offFixture(args, ON_FIXTURE, FIXTURE), args.join(' ')).toBeNull()
    }
  })

  test('1.7d/live-guard: another repository is refused, by GH_REPO, by the endpoint or by --repo', () => {
    const other = { env: { GH_REPO: 'Bartek201301/HackWin' } }
    expect(offFixture(['api', 'repos/{owner}/{repo}/labels'], other, FIXTURE)).toBe(
      `GH_REPO Bartek201301/HackWin is not ${FIXTURE}`,
    )
    expect(offFixture(['api', 'repos/Bartek201301/HackWin/issues'], ON_FIXTURE, FIXTURE)).toBe(
      `Bartek201301/HackWin is not ${FIXTURE}`,
    )
    expect(
      offFixture(['issue', 'list', '--repo', 'Bartek201301/HackWin'], ON_FIXTURE, FIXTURE),
    ).toBe(`Bartek201301/HackWin is not ${FIXTURE}`)
    expect(offFixture(['api', 'graphql', '-f', 'query=x'], ON_FIXTURE, FIXTURE)).toBe(
      'gh api graphql names no repository',
    )
    expect(offFixture(['api', `repos/${FIXTURE}/issues`], {}, FIXTURE)).toBeNull()
  })

  test('1.7d/live-guard: only the reads that need no repository pass without it', () => {
    for (const args of [['version'], ['api', 'user'], ['api', '-i', 'user'], ['api', 'users/x']]) {
      expect(offFixture(args, {}, FIXTURE), args.join(' ')).toBeNull()
    }
    expect(offFixture(['api', '--method', 'PATCH', 'user'], {}, FIXTURE)).toBe(
      'gh api user names no repository',
    )
  })

  test('1.7d/live-guard: a refused call throws before gh runs', async () => {
    /** @type {string[][]} */
    const ran = []
    /** @type {string[]} */
    const logged = []
    const executor = fixtureOnly(
      FIXTURE,
      async (args) => {
        ran.push(args)
        return { code: 0, stdout: '', stderr: '' }
      },
      (line) => logged.push(line),
    )
    await expect(executor(['api', 'repos/{owner}/{repo}/issues'], {})).rejects.toThrow(
      `${OFF_FIXTURE}gh api repos/{owner}/{repo}/issues: the call names no GH_REPO`,
    )
    expect(ran).toEqual([])
    expect(logged).toHaveLength(1)
    await executor(['api', 'repos/{owner}/{repo}/issues'], ON_FIXTURE)
    expect(ran).toEqual([['api', 'repos/{owner}/{repo}/issues']])
  })
})

describe('AC77: a bug fix release of the same phase, installed in the steps of 20.6', () => {
  test('AC77: the pull request of setup --regenerate with the raised cli_version passes CI, which installs the version it names, the Gate merges it, and after the merge an older CLI exits 2', async () => {
    const scene = await configured(clis.old)
    const { fixture } = scene
    expect(await fixture.git.showFile('origin/main', WORKFLOW_PATH)).toContain(
      generatedBy(RELEASES.old),
    )
    const builder = await fixture.clone('builder1')
    expect((await scene.join(clis.old, { cwd: builder.path, login: BUILDER1 })).code).toBe(0)
    const before = scene.gate(clis.old)
    await before.started()
    expect(before.io.err).toBe('')

    // 1. The Lead installs the bug fix release. Until its pull request is merged, it works
    // with a one-line warning; a member's older release works without one.
    const status = await scene.run(clis.fix, ['status'])
    expect(status.code).toBe(0)
    expect(status.stderr).toBe(newerWarning(RELEASES.fix, RELEASES.old))
    const builderStatus = await scene.run(clis.old, ['status'], {
      cwd: builder.path,
      login: BUILDER1,
    })
    expect(builderStatus.code).toBe(0)
    expect(builderStatus.stderr).toBe('')

    // 2. The Lead stops the Gate with `quit` and starts it again with the new version.
    expect(await before.quit()).toBe(0)
    const gate = scene.gate(clis.fix)
    await gate.started()
    expect(gate.io.err).toBe(newerWarning(RELEASES.fix, RELEASES.old))
    expect(gate.io.out).toContain('Gate started: start 2, restart 1')

    // 3. A task of the shared role, written by hand; take, setup --regenerate and ship in its
    // worktree, all with the new version.
    const task = await takeReleaseTask(scene, clis.fix)
    const regenerate = await scene.run(clis.fix, ['setup', '--regenerate'], { cwd: task.path })
    expect(regenerate.stderr).toBe(newerWarning(RELEASES.fix, RELEASES.old))
    expect(regenerate.code).toBe(0)
    expect(regenerate.stdout).toContain(`cli_version ${RELEASES.old} -> ${RELEASES.fix}`)
    expect(await task.git.showFile('HEAD', 'hackwin.yml')).toContain(`cli_version: ${RELEASES.fix}`)
    expect(await task.git.showFile('HEAD', WORKFLOW_PATH)).toContain(generatedBy(RELEASES.fix))
    expect(await task.git.isClean()).toBe(true)
    const ship = await scene.run(clis.fix, ['ship'], { cwd: task.path })
    expect(ship.stderr).toBe(newerWarning(RELEASES.fix, RELEASES.old))
    expect(ship.code).toBe(0)
    const [pull] = await scene.github().listPullRequests({ state: 'open' })
    expect(pull.headRef).toBe((await task.git.currentBranch()) ?? '')
    expect(pull.headSha).toBe(await task.git.revParse('HEAD'))
    expect(ship.stdout).toContain(`opened PR #${pull.number} into main`)

    // 4. CI checks the pull request with the version it names, and the Gate merges it.
    const ci = await scene.ci(pull.number)
    expect(ci.install.code).toBe(0)
    expect(ci.install.stdout).toContain(
      `this pull request sets cli_version to ${RELEASES.fix}; installing hackwin ${RELEASES.fix}`,
    )
    expect(ci.npm).toEqual([installOf(RELEASES.fix)])
    expect(ci.installed?.version).toBe(RELEASES.fix)
    expect(ci.check?.stdout).toContain(
      `checked with hackwin ${RELEASES.fix}, the version this pull request sets`,
    )
    expect(ci.check?.code).toBe(0)
    expect(ci.passed).toBe(true)
    expect(await scene.pinned()).toBe(RELEASES.old)
    await gate.advanceUntil(
      () => scene.fake.find(pull.number)?.pull?.merged,
      `the Gate's merge of #${pull.number}`,
    )
    const merged = /** @type {any} */ (scene.fake.find(pull.number)).pull.mergeCommitSha
    expect(await scene.pinned()).toBe(RELEASES.fix)
    expect(await fixture.git.revParse('origin/main')).toBe(merged)
    expect(await gate.quit()).toBe(0)
    expect(gate.io.out).toContain(`#${pull.number} merged head ${pull.headSha} as ${merged}`)

    // 5. From that merge on, an older CLI exits 2 and prints the install command. Every
    // member installs the new version and runs join again.
    for (const [cwd, login] of [
      [fixture.main, LEAD],
      [builder.path, BUILDER1],
    ]) {
      const older = await scene.run(clis.old, ['status'], { cwd, login })
      expect(older.code).toBe(2)
      expect(older.stdout).toBe('')
      expect(older.stderr).toBe(`${olderError('status', RELEASES.old, RELEASES.fix)}\n`)
      const joined = await scene.join(clis.fix, { cwd, login })
      expect(joined.stderr).toBe('')
      expect(joined.code).toBe(0)
      const record = await readLocal(join(cwd, '.git'))
      expect(record?.join?.cli_version).toBe(RELEASES.fix)
      const now = await scene.run(clis.fix, ['status'], { cwd, login })
      expect(now.code).toBe(0)
      expect(now.stderr).toBe('')
    }
  }, 300_000)

  test(
    'AC77: a pull request that sets cli_version to a release of another phase fails CI',
    async () => {
      const scene = await configured(clis.old)
      const task = await takeReleaseTask(scene, clis.old)
      const hackwin = /** @type {string} */ (await task.git.showFile('HEAD', 'hackwin.yml'))
      writeFileSync(
        join(task.path, 'hackwin.yml'),
        hackwin.replace(`cli_version: ${RELEASES.old}`, `cli_version: ${RELEASES.other}`),
      )
      const commit = await task.git
        .with({ env: scene.env(clis.old) })
        .run(['commit', '--quiet', '-am', 'Set another phase'], { allowFailure: true })
      // Only CI validates a proposed hackwin.yml (10.2 step 1); the pre-commit hook and ship
      // check scope, secrets, format and the project's commands, which this change passes.
      expect(commit.code).toBe(0)
      const ship = await scene.run(clis.old, ['ship'], { cwd: task.path })
      expect(ship.code).toBe(0)
      const [pull] = await scene.github().listPullRequests({ state: 'open' })
      expect(pull.headSha).toBe(await task.git.revParse('HEAD'))

      const ci = await scene.ci(pull.number)
      // The install step keeps the base branch's version for a version of another phase ...
      expect(ci.install.code).toBe(0)
      expect(ci.install.stdout).toContain(
        `hackwin.yml on main pins ${RELEASES.old}; installing hackwin ${RELEASES.old}`,
      )
      expect(ci.npm).toEqual([installOf(RELEASES.old)])
      // ... whose check fails the pull request in step 1, on the key cli_version [D10].
      expect(ci.check?.code).toBe(2)
      expect(ci.check?.stdout).toBe('')
      expect(ci.check?.stderr).toBe(
        [
          `hackwin internal ci: hackwin.yml: cli_version (${RELEASES.other}) is of phase ${phaseOf(RELEASES.other)}, but origin/main pins ${RELEASES.old} of phase ${phaseOf(RELEASES.old)}; a project stays on the phase it started with [D10]`,
          '  key: cli_version',
          '',
        ].join('\n'),
      )
      expect(ci.passed).toBe(false)
      const checks = scene.fake.state.checks[pull.headSha]
      expect(checks.map((/** @type {any} */ run) => [run.name, run.conclusion])).toEqual([
        ['hackwin', 'failure'],
      ])
    },
    TIMEOUT_MS,
  )

  test(
    'AC77: setup --regenerate run with a CLI of another phase exits 2 and changes nothing',
    async () => {
      const scene = await configured(clis.old)
      const task = await takeReleaseTask(scene, clis.old)
      const head = await task.git.revParse('HEAD')

      const result = await scene.run(clis.other, ['setup', '--regenerate'], { cwd: task.path })

      expect(result.code).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe(`${otherPhaseError('setup', RELEASES.other, RELEASES.old)}\n`)
      expect(await task.git.revParse('HEAD')).toBe(head)
      expect(await task.git.isClean()).toBe(true)
    },
    TIMEOUT_MS,
  )
})

describe('AC76: the version rule of every command, and the install before a manifest', () => {
  test(
    'AC76: a CLI older than cli_version on main exits 2 from every command and prints the install command',
    async () => {
      const scene = await configured(clis.fix)
      const { fixture } = scene
      for (const argv of COMMANDS) {
        const result = await scene.run(clis.old, argv)
        expect(result.code, argv.join(' ')).toBe(2)
        expect(result.stdout, argv.join(' ')).toBe('')
        expect(result.stderr).toBe(`${olderError(argv[0], RELEASES.old, RELEASES.fix)}\n`)
      }
      // The git hooks of the clone run the CLI on PATH, and refuse a commit with the same error.
      const head = await fixture.git.revParse('HEAD')
      writeFileSync(join(fixture.main, 'README.md'), '# Changed\n')
      const commit = await fixture
        .gitAt(fixture.main)
        .with({ env: scene.env(clis.old) })
        .run(['commit', '--quiet', '-am', 'Change the README'], { allowFailure: true })
      expect(commit.code).not.toBe(0)
      expect(commit.stderr).toContain(
        olderError('internal hook pre-commit', RELEASES.old, RELEASES.fix),
      )
      expect(await fixture.git.revParse('HEAD')).toBe(head)
    },
    TIMEOUT_MS,
  )

  test(
    'AC76: a CLI of another phase exits 2 from every command and prints the install command',
    async () => {
      const scene = await configured(clis.old)
      for (const argv of COMMANDS) {
        const result = await scene.run(clis.other, argv)
        expect(result.code, argv.join(' ')).toBe(2)
        expect(result.stdout, argv.join(' ')).toBe('')
        expect(result.stderr).toBe(`${otherPhaseError(argv[0], RELEASES.other, RELEASES.old)}\n`)
      }
    },
    TIMEOUT_MS,
  )

  test(
    'AC76: a newer bug fix release of the same phase prints a one-line warning and continues',
    async () => {
      const scene = await configured(clis.old)
      const status = await scene.run(clis.fix, ['status'])
      const joined = await scene.join(clis.fix)
      for (const result of [status, joined]) {
        expect(result.code).toBe(0)
        expect(result.stdout).not.toBe('')
        expect(result.stderr).toBe(newerWarning(RELEASES.fix, RELEASES.old))
      }
    },
    TIMEOUT_MS,
  )

  test(
    'AC76: in a repository whose manifest does not exist yet, join and take skip the install with a notice',
    async () => {
      const { 'package.json': manifest, ...files } = PROJECT
      expect(manifest).toBeDefined()
      const scene = await createScene(clis)
      // main without the manifest that paths.manifests names, as before the foundation (A62).
      await scene.fixture.git.run(['rm', '--quiet', 'package.json'])
      await scene.fixture.commit('Before the foundation', { files, push: true })
      const setup = await scene.setup(clis.old, setupAnswers())
      expect(setup.code).toBe(0)
      const joinNotice = 'skip  install: no file matches paths.manifests (package.json)'
      expect(setup.stdout).toContain(joinNotice)
      const joined = await scene.join(clis.old)
      expect(joined.code).toBe(0)
      expect(joined.stdout).toContain(joinNotice)
      const issue = await scene.task({ title: 'A first task', role: 'shared', paths: ['docs/**'] })
      const take = await scene.run(clis.old, ['take', String(issue)])
      expect(take.code).toBe(0)
      expect(take.stdout).toContain(
        'install skipped: no file matches paths.manifests (package.json)',
      )
    },
    TIMEOUT_MS,
  )
})

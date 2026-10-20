// The offline scene of a bug fix release (20.6): a team repository with a bare origin, the
// Lead's fake GitHub linked to it, and the CLIs of three versions (clis.js), which run in-process
// against the fake. Nothing in it reaches real GitHub.
//
// The project's commands are stand-ins that need no package, so that the scenarios install
// nothing: the install, the check and the format succeed, and the test command `ls` passes for
// an acceptance test file that exists. CI is the generated workflow, run as GitHub runs its two
// steps on a pull request: the install step in bash, with an `npm` that only notes what it was
// asked to install, and then `hackwin internal ci` of the version that step installed.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { parse } from 'yaml'
import { pinnedVersionOf } from '../../../src/core/config/index.js'
import { createGitHub } from '../../../src/core/github/index.js'
import { createFakeClock, exec } from '../../../src/core/runtime/index.js'
import { WORKFLOW_PATH } from '../../../src/generate/index.js'
import {
  accounts,
  createFakeGitHub,
  createFixture,
  rawResult,
  teamConfig,
  yaml,
} from '../../harness/index.js'
import { buildCli, installOf, releasesOf, runCli, withCli } from './clis.js'

/** @typedef {import('./clis.js').Cli} Cli */

export const LEAD = accounts.lead.login
export const BUILDER1 = accounts.builder1.login

/** The versions of the offline scenarios: build 1 of the scheme. */
export const RELEASES = releasesOf(1)

/** The acceptance test that every task of the scenarios names; it is on main. */
export const SMOKE = 'checks/smoke.txt'

/** The project's commands: stand-ins that need no package (see the top of this file). */
export const QUICK_COMMANDS = Object.freeze({
  install: 'true',
  check: 'true',
  test: 'ls',
  format: 'true',
  generate: null,
  lockfile_regen: 'true',
  smoke: null,
})

/** The files of main before setup: a manifest, so that the install runs (A62), and the test. */
export const PROJECT = Object.freeze({
  'README.md': '# Release scenario\n',
  'package.json': '{ "name": "release-scenario", "private": true }\n',
  [SMOKE]: 'the acceptance test of every task\n',
})

/** The paths of the shared role's task that installs a bug fix release. */
export const RELEASE_PATHS = Object.freeze([
  'hackwin.yml',
  '.githooks/**',
  '.github/**',
  '.claude/**',
  'AGENTS.md',
  'CLAUDE.md',
])

/**
 * The answers of `setup --answers` (CM11) for a team of 3 on the stand-in commands.
 * @param {(answers: any) => void} [change]
 */
export function setupAnswers(change) {
  const answers = structuredClone(teamConfig(3).answers)
  answers.commands = { ...QUICK_COMMANDS }
  Object.assign(answers, { language: 'English', explanation_style: 'concise' })
  change?.(answers)
  return answers
}

/**
 * The body of a task issue written by hand from the template (8.1, I2).
 * @param {{ role: string, paths: readonly string[], acceptance?: string[] }} block
 */
export function taskBody({ role, paths, acceptance = [SMOKE] }) {
  const data = {
    kind: 'task',
    role,
    wave: 1,
    paths: [...paths],
    depends_on: [],
    acceptance_tests: acceptance,
    deadline: '2026-10-25T12:00:00+02:00',
  }
  return `\`\`\`yaml\n# hackwin:task\n${yaml(data)}\`\`\`\n\n## Problem\nA task of the release scenarios.\n`
}

/**
 * The CLIs of the scenarios' three versions, built once into `dir`.
 * @param {string} dir
 * @returns {Promise<{ old: Cli, fix: Cli, other: Cli }>}
 */
export async function buildClis(dir) {
  const [old, fix, other] = await Promise.all(
    [RELEASES.old, RELEASES.fix, RELEASES.other].map((version) => buildCli(dir, version)),
  )
  return { old, fix, other }
}

/**
 * A scene on an unconfigured repository whose main holds PROJECT and `files`.
 * @param {{ old: Cli, fix: Cli, other: Cli }} clis
 * @param {{ files?: Record<string, string> }} [options]
 */
export async function createScene(clis, { files = {} } = {}) {
  const fixture = await createFixture({ files: { ...PROJECT, ...files } })
  const fake = createFakeGitHub({ origin: fixture.origin, nextNumber: 10 })
  // gh's version for setup's step 1; the members of the team exist on GitHub (step 3); GitHub
  // takes the call that enables push protection and returns no setting, as where it is off.
  fake.on('version', () => rawResult({ stdout: 'gh version 2.88.1 (2026-01-01)\n' }))
  fake.on('GET users/:login', ({ params }) => ({ login: params.login, type: 'User' }))
  fake.on('PATCH repos/{owner}/{repo}', () => ({}))
  const tools = join(fixture.dir, 'tools')
  mkdirSync(tools)
  // join's step 3 looks for the member's agent; take, without a terminal, starts none.
  writeScript(join(tools, 'claude'), '#!/bin/sh\nexit 0\n')
  // The npm of the CI runner: it only notes what the install step asks for.
  const npmLog = join(fixture.dir, 'npm.log')
  const runner = join(fixture.dir, 'runner')
  mkdirSync(runner)
  writeScript(join(runner, 'npm'), `#!/bin/sh\necho "npm $*" >> '${npmLog}'\n`)
  const all = [clis.old, clis.fix, clis.other]
  let runs = 0

  const scene = {
    fixture,
    fake,
    clis,

    /**
     * The environment of a command of this CLI, as a member's shell has it: the CLI and the
     * agent on PATH.
     * @param {Cli} cli
     */
    env(cli) {
      return withCli(cli, { ...fixture.env, PATH: `${tools}:${fixture.env.PATH}` })
    },

    /** @param {string} [login] */
    github(login = LEAD) {
      return createGitHub({ executor: fake.as(login) })
    },

    /**
     * Run `hackwin <argv>` of a CLI as a login, in the main checkout by default.
     * @param {Cli} cli
     * @param {string[]} argv
     * @param {{ cwd?: string, login?: string }} [options]
     */
    run(cli, argv, { cwd = fixture.main, login = LEAD } = {}) {
      return runCli(cli, argv, {
        cwd,
        env: scene.env(cli),
        ghExecutor: fake.as(login),
        // setup waits until GitHub's reads settle; no wait takes time here.
        clock: createFakeClock(new Date()),
      })
    },

    /**
     * `hackwin setup --answers` of a CLI in the main checkout, as the Lead.
     * @param {Cli} cli
     * @param {unknown} [answers]
     * @param {{ login?: string }} [options]
     */
    setup(cli, answers = setupAnswers(), { login = LEAD } = {}) {
      const file = join(fixture.dir, 'answers.yml')
      writeFileSync(file, yaml(answers))
      return scene.run(cli, ['setup', '--answers', file], { login })
    },

    /**
     * `hackwin join --answers` of a CLI in a clone, as a member.
     * @param {Cli} cli
     * @param {{ cwd?: string, login?: string }} [options]
     */
    join(cli, { cwd = fixture.main, login = LEAD } = {}) {
      const file = join(fixture.dir, 'join-answers.yml')
      writeFileSync(file, yaml({ language: 'English', explanation_style: 'concise' }))
      return scene.run(cli, ['join', '--answers', file], { cwd, login })
    },

    /**
     * `cli_version` of hackwin.yml at a ref of the main checkout, after a fetch.
     * @param {string} [ref]
     */
    async pinned(ref = 'origin/main') {
      await fixture.git.fetch()
      return pinnedVersionOf((await fixture.git.showFile(ref, 'hackwin.yml')) ?? '')
    },

    /**
     * The Lead writes a task issue by hand (I2), ready to take.
     * @param {{ title: string, role: string, paths: readonly string[], acceptance?: string[] }} task
     * @returns {Promise<number>}
     */
    async task({ title, role, paths, acceptance }) {
      const issue = await scene.github().createIssue({
        title,
        body: taskBody({ role, paths, acceptance }),
        labels: ['ready', `role:${role}`],
      })
      return issue.number
    },

    /**
     * The task worktree of an issue in the main checkout's clone, as take creates it.
     * @param {number} issue
     */
    async worktree(issue) {
      const list = await fixture.git.worktreeList()
      const found = list.find((entry) =>
        entry.branch?.replace(/^refs\/heads\//, '').startsWith(`task/${issue}-`),
      )
      if (!found) throw new Error(`no task worktree of #${issue}`)
      return { path: found.path, git: fixture.gitAt(found.path) }
    },

    /**
     * CI on a pull request, as the generated workflow runs: a fresh clone checked out at the head
     * commit, the workflow's install step in bash, then `hackwin internal ci` of the version that
     * step installed. The step comes from the head's copy of the workflow. The result is
     * reported as the check run `hackwin`, as GitHub Actions reports the job.
     * @param {number} number
     */
    async ci(number) {
      const pull = await scene.github().getPullRequest(number)
      if (pull === null) throw new Error(`pull request #${number} does not exist`)
      runs += 1
      const checkout = await fixture.clone(`ci-${runs}`)
      await checkout.git.run(['checkout', '--quiet', '--detach', pull.headSha])
      const script = installStep(readFileSync(join(checkout.path, WORKFLOW_PATH), 'utf8'))
      writeFileSync(npmLog, '')
      const env = { ...fixture.env, BASE_REF: pull.baseRef, PATH: `${runner}:${fixture.env.PATH}` }
      const install = await exec(
        'bash',
        ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script],
        { cwd: checkout.path, env },
      )
      const npm = readFileSync(npmLog, 'utf8').split('\n').filter(Boolean)
      const installed = all.find((cli) => npm.includes(installOf(cli.version))) ?? null
      const event = join(fixture.dir, `event-${runs}.json`)
      writeFileSync(
        event,
        JSON.stringify({
          action: 'synchronize',
          number,
          pull_request: {
            number,
            head: { ref: pull.headRef, sha: pull.headSha },
            base: { ref: pull.baseRef },
            user: { login: pull.author },
          },
        }),
      )
      const check =
        install.code !== 0 || installed === null
          ? null
          : await runCli(installed, ['internal', 'ci'], {
              cwd: checkout.path,
              env: { ...fixture.env, GITHUB_EVENT_PATH: event, TMPDIR: fixture.dir },
              ghExecutor: fake.executor,
            })
      const passed = check?.code === 0
      fake.addCheckRun(pull.headSha, {
        name: 'hackwin',
        conclusion: passed ? 'success' : 'failure',
      })
      return { pull, install, npm, installed, check, passed }
    },

    /**
     * `hackwin gate` of a CLI in the main checkout, in a terminal, with a clock that moves only
     * when the scene moves it.
     * @param {Cli} cli
     */
    gate(cli) {
      const clock = manualClock()
      return startGate(cli, {
        cwd: fixture.main,
        env: scene.env(cli),
        ghExecutor: fake.as(LEAD),
        clock,
        advance: () => clock.advance(30_000),
      })
    },
  }
  return scene
}

/** @typedef {Awaited<ReturnType<typeof createScene>>} Scene */

/**
 * `hackwin gate` of a CLI in a terminal, as the Lead starts it (7.5).
 * @param {Cli} cli
 * @param {object} options
 * @param {string} options.cwd The main checkout.
 * @param {Record<string, string | undefined>} options.env
 * @param {import('../../../src/core/github/index.js').GhExecutor} options.ghExecutor
 * @param {import('../../../src/core/runtime/index.js').Clock} [options.clock] The system clock
 *   by default.
 * @param {() => void} [options.advance] Moves the clock on while advanceUntil waits; nothing
 *   with the system clock.
 * @param {number} [options.patienceMs] How long advanceUntil waits.
 */
export function startGate(cli, { cwd, env, ghExecutor, clock, advance = () => {}, patienceMs }) {
  const io = terminal()
  const done = cli.main(['gate'], {
    cwd,
    env,
    stdin: io.stdin,
    stdout: io.stdout,
    stderr: io.stderr,
    ghExecutor,
    ...(clock ? { clock } : {}),
  })
  /** @type {number | null} */
  let exitCode = null
  void done.then((code) => (exitCode = code))
  return {
    io,
    done,
    /** Wait for the header, which names `quit`; a Gate that stopped before it throws. */
    async started() {
      await until(() => io.out.includes('`quit`') || exitCode !== null, 'the Gate header', io)
      if (exitCode !== null) {
        throw new Error(`the Gate exited ${exitCode} before its header:\n${io.out}${io.err}`)
      }
    },
    /**
     * Wait until `check` holds, moving the clock on between two looks.
     * @param {() => unknown} check
     * @param {string} what
     */
    async advanceUntil(check, what) {
      await until(
        async () => {
          const value = await check()
          if (!value) advance()
          return value
        },
        what,
        io,
        patienceMs,
      )
    },
    /** Type `quit` and wait until the Gate stopped; its exit code. */
    async quit() {
      io.type('quit')
      return done
    },
  }
}

/**
 * The script of the workflow's install step.
 * @param {string} workflow The text of `.github/workflows/hackwin.yml`.
 * @returns {string}
 */
export function installStep(workflow) {
  const steps = parse(workflow).jobs.hackwin.steps
  const step = steps.find((/** @type {any} */ entry) => entry.name === 'Install the hackwin CLI')
  if (!step) throw new Error(`${WORKFLOW_PATH} has no step "Install the hackwin CLI"`)
  return step.run
}

/**
 * Stand-ins for the commands that keep the laptop awake (src/commands/gate/awake.js), for the
 * front of PATH while a Gate runs in this process. Each notes its arguments in `started` and runs
 * while the process it watches lives, as the real command does, or until it is killed, and then
 * exits 0. It holds no sleep lock and never fails. With the real command, `systemd-inhibit` on a
 * GitHub runner exits with "Access denied", and the Gate's warning about it races the exact
 * comparisons of its stderr (#116).
 * @param {string} dir A directory that does not exist yet.
 * @returns {{ bin: string, started: string }} `bin` for PATH; `started` the file of the notes.
 */
export function stubKeepAwake(dir) {
  mkdirSync(dir)
  const started = join(dir, 'started')
  const note = (/** @type {string} */ name) =>
    `#!/bin/sh\necho "${name} $*" >> '${started}'\ntrap 'exit 0' TERM\n`
  // caffeinate -i -w <pid>
  writeScript(
    join(dir, 'caffeinate'),
    `${note('caffeinate')}while [ $# -gt 0 ]; do\n  if [ "$1" = -w ]; then pid=$2; fi\n  shift\ndone\nwhile kill -0 "$pid" 2>/dev/null; do sleep 1; done\n`,
  )
  // systemd-inhibit --what=... --who=... --why=... --mode=block <command that watches the pid>
  writeScript(
    join(dir, 'systemd-inhibit'),
    `${note('systemd-inhibit')}while [ $# -gt 0 ] && [ "\${1#--}" != "$1" ]; do shift; done\n"$@"\n`,
  )
  return { bin: dir, started }
}

/**
 * @param {string} file
 * @param {string} text
 */
function writeScript(file, text) {
  writeFileSync(file, text)
  chmodSync(file, 0o755)
}

/**
 * The streams of an interactive terminal: stdin and stdout are TTYs, so the caller kind is
 * `terminal` (contracts 3.5).
 */
function terminal() {
  const stdin = Object.assign(new PassThrough(), { isTTY: true })
  let out = ''
  let err = ''
  return {
    stdin,
    stdout: { isTTY: true, write: (/** @type {string} */ chunk) => ((out += chunk), true) },
    stderr: { write: (/** @type {string} */ chunk) => ((err += chunk), true) },
    get out() {
      return out
    },
    get err() {
      return err
    },
    /** @param {string} line */
    type: (line) => stdin.write(`${line}\n`),
  }
}

/**
 * A clock whose time moves only through advance(): a sleep ends when the time reaches its end.
 */
function manualClock() {
  let time = Date.parse('2026-10-24T10:00:00.000Z')
  /** @type {Array<{ at: number, resolve: () => void }>} */
  let sleepers = []
  return {
    now: () => new Date(time),
    sleep: (/** @type {number} */ ms) =>
      ms <= 0
        ? Promise.resolve()
        : new Promise((resolve) => sleepers.push({ at: time + ms, resolve: () => resolve() })),
    /** @param {number} ms */
    advance(ms) {
      time += ms
      const due = sleepers.filter((sleeper) => sleeper.at <= time)
      sleepers = sleepers.filter((sleeper) => sleeper.at > time)
      for (const sleeper of due) sleeper.resolve()
    },
  }
}

/**
 * Wait until `check` returns a truthy value, looking every 10 ms, or every 5 s when the wait is
 * longer than the default. The default wait is long, so that a loaded machine does not fail a
 * scenario; a timeout prints what the Gate printed.
 * @template T
 * @param {() => T | Promise<T>} check
 * @param {string} what
 * @param {{ out: string, err: string }} [io]
 * @param {number} [patienceMs]
 * @returns {Promise<T>}
 */
export async function until(check, what, io, patienceMs = 120_000) {
  const deadline = Date.now() + patienceMs
  const pause = patienceMs > 120_000 ? 5_000 : 10
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}${io ? `:\n${io.out}${io.err}` : ''}`)
    }
    await new Promise((resolve) => setTimeout(resolve, pause))
  }
}

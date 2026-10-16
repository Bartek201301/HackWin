// A scene for the tests of intake and the stages: a fixture with a team of three, the Lead's fake
// GitHub linked to its bare origin, task issues, task branches pushed from an author's clone, pull
// requests opened as their authors, and a Gate with the real pipeline whose notifier is a stub
// that records every notification. The project's commands are quick ones of node: the check and
// the acceptance test pass, and main holds the acceptance test that every task names. No check
// run exists until a test adds one, so a run that passes stage 7 waits at stage 8.
//
// A scene can also cut the Gate off from GitHub and origin (`reachable`), and run a Gate in a
// process of its own (`fork`, gate-process.js), which a test can kill.

import { fork } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDigestLine } from '../../../src/commands/gate/digest.js'
import { createPipeline } from '../../../src/commands/gate/pipeline.js'
import { gateFiles } from '../../../src/commands/gate/state.js'
import { STATUS_LABEL, parseStatusBody } from '../../../src/commands/gate/status-issue.js'
import { createGitHub } from '../../../src/core/github/index.js'
import { accounts, createFixture, rawResult, teamConfig, yaml } from '../../harness/index.js'
import { leadGitHub, manualClock, noKeepAwake, readJson, startDirect } from './helpers.js'

/** @typedef {import('../../harness/index.js').FakeGitHub} FakeGitHub */
/** @typedef {import('../../../src/commands/gate/notify.js').Notification} Notification */

export const LEAD = accounts.lead.login
/** Holds `counter` and `todos`. */
export const BUILDER1 = accounts.builder1.login
/** Holds `greeting`; a name only, so every scene runs against the fake GitHub. */
export const BUILDER2 = accounts.builder2.login
export const POLL_MS = 60_000

/** The acceptance test that every task of `taskBody` names. */
export const ACCEPTANCE_TEST = 'test/features.test.js'

/** Commands of hackwin.yml that need no package: the check passes, `node` runs the test file. */
export const QUICK_COMMANDS = Object.freeze({
  install: 'node -e 0',
  check: 'node -e 0',
  test: 'node',
})
/** `gate.status_issue_seconds` of the team configuration, in milliseconds. */
export const STATUS_MS = 120_000

/** The GitHub Actions app, which produces the required check `hackwin`. */
export const ACTIONS_APP_ID = 15368

/**
 * The body of a task issue written by hand from the template (8.1).
 * @param {{ role: string, paths: string[], dependsOn?: number[], acceptance?: string[] }} block
 * @returns {string}
 */
export function taskBody({ role, paths, dependsOn = [], acceptance = [ACCEPTANCE_TEST] }) {
  const data = {
    kind: 'task',
    role,
    wave: 1,
    paths,
    depends_on: dependsOn,
    acceptance_tests: acceptance,
    deadline: '2026-10-25T12:00:00+02:00',
  }
  return [
    '```yaml',
    '# hackwin:task',
    yaml(data).trimEnd(),
    '```',
    '',
    '## Problem',
    'Something is missing.',
  ].join('\n')
}

/**
 * A task issue in review, for the fake GitHub's initial state.
 * @param {number} number
 * @param {string} role
 * @param {string[]} [paths] The role's directory by default.
 * @param {{ dependsOn?: number[], status?: string, acceptance?: string[] }} [options] Its
 *   dependencies; its status label, `in-review` by default; its acceptance tests.
 */
export function task(number, role, paths = [`src/features/${role}/**`], options = {}) {
  const { dependsOn = [], status = 'in-review', acceptance } = options
  return {
    number,
    title: `Task ${number}`,
    body: taskBody({ role, paths, dependsOn, acceptance }),
    labels: [status, `role:${role}`],
  }
}

/**
 * @param {object} [options]
 * @param {(hackwin: any, owners: any) => void} [options.configure] Changes hackwin.yml and
 *   owners.yml before the fixture commits them to main.
 * @param {any[]} [options.issues] Task issues; pull requests and the status issue get numbers
 *   from 100 on.
 * @param {Record<string, string>} [options.files] More files of the first commit on main.
 * @param {number} [options.patience] How long `until` waits, in milliseconds of real time: long,
 *   so that a loaded machine does not fail a test; it only delays the report of a real failure.
 * @param {number} [options.stepTimeoutMs] How long a command of the merge test or the smoke test
 *   may run, in place of `gate.step_timeout_minutes`.
 * @param {Record<string, string>} [options.env] More variables of the Gate's environment.
 */
export async function createScene({
  configure,
  issues = [],
  files: mainFiles = {},
  patience = 60_000,
  stepTimeoutMs,
  env,
} = {}) {
  const config = teamConfig(3)
  Object.assign(config.hackwin.commands, QUICK_COMMANDS)
  configure?.(config.hackwin, config.owners)
  const fixture = await createFixture({
    files: {
      'README.md': '# Fixture\n',
      [ACCEPTANCE_TEST]: "console.log('the acceptance test passes')\n",
      ...mainFiles,
    },
    config: { hackwin: config.hackwin, owners: config.owners },
  })
  const files = gateFiles(await fixture.git.commonDir())
  const fake = leadGitHub(undefined, { origin: fixture.origin, issues, nextNumber: 100 })
  const author = await fixture.clone('author')
  /** @type {Notification[]} */
  const notifications = []
  /** @type {{ shown: boolean, reason: string | null }} */
  let notifyAnswer = { shown: true, reason: null }
  /** @type {Awaited<ReturnType<typeof startDirect>> | null} */
  let gate = null
  /** @type {Awaited<ReturnType<typeof startDirect>> | null} */
  let stopped = null
  // What the scene sees of the Gate's polls, through its intake: the Gate object, how many
  // intakes ended, and the poll time (`last_poll_at`, set when a poll starts) of the last one.
  /** @type {any} */
  let running = null
  let intakes = 0
  /** @type {string | null} */
  let lastIntakeOf = null
  /** @type {string[]} */
  const extra = []
  /** @type {Array<import('node:child_process').ChildProcess>} */
  const children = []
  let reachable = true
  /**
   * The Gate's view of the fake GitHub: while the scene is not reachable, every gh call fails as
   * when the network is down, without an HTTP status.
   */
  const gateGitHub = {
    ...fake,
    as: (/** @type {string} */ login) => {
      const executor = fake.as(login)
      return (/** @type {string[]} */ args, /** @type {any} */ call) =>
        reachable
          ? executor(args, call)
          : Promise.resolve({
              code: 1,
              stdout: '',
              stderr: 'error connecting to api.github.com\ncheck your internet connection\n',
            })
    },
  }
  /** True when the poll that started last has finished its intake. */
  const pollDone = () => running !== null && lastIntakeOf === running.state.last_poll_at

  /**
   * The pipeline, with an intake that records when it ended and for which poll.
   * @param {import('../../../src/commands/gate/gate.js').Pipeline} pipeline
   * @returns {import('../../../src/commands/gate/gate.js').Pipeline}
   */
  const observed = (pipeline) => ({
    ...pipeline,
    intake: async (/** @type {any} */ own) => {
      running = own
      try {
        await pipeline.intake?.(own)
      } finally {
        lastIntakeOf = own.state.last_poll_at
        intakes += 1
      }
    },
  })

  const scene = {
    fixture,
    files,
    fake,
    notifications,
    /** @param {{ shown: boolean, reason: string | null }} answer */
    answerNotifications(answer) {
      notifyAnswer = answer
    },

    /**
     * Push a commit to a branch of the origin from the author's clone: write `files`, delete
     * `remove`. A new branch starts from `from`.
     * @param {string} branch
     * @param {{ files?: Record<string, string>, remove?: string[], from?: string, message?: string }} [change]
     * @returns {Promise<string>} The new commit.
     */
    async push(branch, { files: written = {}, remove = [], from = 'main', message } = {}) {
      const { git, path } = author
      await git.fetch({ prune: true })
      const exists = (await git.tryRevParse(`refs/remotes/origin/${branch}`)) !== null
      await git.run(['checkout', '--quiet', '-B', branch, `origin/${exists ? branch : from}`])
      fixture.write(written, path)
      for (const file of remove) await git.run(['rm', '--quiet', '--', file])
      await git.run(['add', '--all'])
      await git.run(['commit', '--quiet', '--allow-empty', '-m', message ?? `change on ${branch}`])
      await git.push({ refspecs: [`HEAD:refs/heads/${branch}`] })
      return git.revParse('HEAD')
    },

    /**
     * Open a pull request as its author, as `ship` does; into main by default.
     * @param {{ branch: string, author: string, task?: number, body?: string, draft?: boolean, base?: string }} pull
     * @returns {Promise<number>}
     */
    async openPull({ branch, author: login, task: issue, body, draft = false, base = 'main' }) {
      const github = createGitHub({ executor: fake.as(login) })
      const created = await github.createPullRequest({
        title: `Work on ${branch}`,
        head: branch,
        base,
        body: body ?? `Closes #${issue}`,
      })
      if (draft) /** @type {any} */ (fake.find(created.number)).pull.draft = true
      return created.number
    },

    /**
     * The GitHub client of a login, for the calls of a member.
     * @param {string} login
     */
    as(login) {
      return createGitHub({ executor: fake.as(login) })
    },

    /** Start the Gate of the Lead with the real pipeline and wait for its header. */
    async start() {
      gate = await startDirect(fixture, {
        fake: /** @type {FakeGitHub} */ (gateGitHub),
        login: LEAD,
        clock: manualClock(),
        env: { ...fixture.env, ...env },
        options: {
          pipeline: observed(
            createPipeline({
              notifier: async (notification) => {
                notifications.push(notification)
                return notifyAnswer
              },
              ...(stepTimeoutMs === undefined ? {} : { stepTimeoutMs: () => stepTimeoutMs }),
            }),
          ),
          keepAwake: noKeepAwake,
        },
      })
      await scene.until(() => gate?.io.out.includes('`quit`'), 'the header')
      return gate
    },

    get gate() {
      if (gate === null) throw new Error('the Gate of this scene has not started')
      return gate
    },

    /** The terminal output of the Gate, also after it stopped. */
    get out() {
      return (gate ?? stopped ?? scene.gate).io.out
    },

    /**
     * Start the next poll and wait until its intake ended. The Gate starts no poll while one is
     * under way: a poll that comes due then is left out (gate.js, runLoop). So the clock moves
     * only once the poll under way has finished its intake, after which the Gate has nothing
     * left of that poll but the write of the state file, which the next poll's heartbeat waits
     * for. No wait depends on how fast the machine is, only on what the Gate did.
     */
    async poll() {
      await scene.until(pollDone, 'the end of the poll under way')
      const before = intakes
      scene.gate.clock.advance(POLL_MS)
      await scene.until(() => intakes > before && pollDone(), 'the next poll')
    },

    /** @param {string} line */
    type(line) {
      scene.gate.io.type(line)
    },

    /** Type `quit` and wait until the Gate stopped. */
    async quit() {
      if (gate === null) return
      stopped = gate
      gate = null
      stopped.io.type('quit')
      await stopped.done
    },

    /**
     * Wait until `check` returns a truthy value; on a timeout the error holds the terminal.
     * @template T
     * @param {() => T | Promise<T>} check
     * @param {string} what
     * @returns {Promise<T>}
     */
    async until(check, what) {
      const deadline = Date.now() + patience
      for (;;) {
        const value = await check()
        if (value) return value
        if (Date.now() > deadline) {
          throw new Error(
            `timed out waiting for ${what}; the Gate printed:\n${gate?.io.out ?? ''}${gate?.io.err ?? ''}`,
          )
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    },

    /**
     * Wait until the `count`th run of the pull request ended with `result`: its digest line is
     * written and the state file holds the result, both after the labels and the comment.
     * @param {number} pr
     * @param {string} result
     * @param {number} [count]
     */
    async ended(pr, result, count = 1) {
      await scene.until(
        () =>
          scene
            .digest()
            .map(parseDigestLine)
            .filter((entry) => entry?.pr === pr && entry.result === result).length >= count &&
          scene.state().prs[String(pr)]?.result === result,
        `run ${count} of #${pr} to end ${result}`,
      )
    },

    /**
     * Move the Gate's clock on by `stepMs` at a time until `check` holds: for a run that waits
     * on the clock, as stage 8 does between two looks at the checks. Each step waits for the
     * event loop, so the Gate acts on one step before the next.
     * @template T
     * @param {() => T | Promise<T>} check
     * @param {string} what
     * @param {number} [stepMs]
     * @returns {Promise<T>}
     */
    async advanceUntil(check, what, stepMs = 30_000) {
      return scene.until(async () => {
        const value = await check()
        if (!value) scene.gate.clock.advance(stepMs)
        return value
      }, what)
    },

    /**
     * A finished check run `hackwin` of GitHub Actions on a commit.
     * @param {string} sha
     * @param {{ conclusion?: string, workflowRun?: number, appId?: number }} [options] `success`
     *   by default; the id of its workflow run, its own id by default; the app that reports it,
     *   GitHub Actions by default, which only `actions()` answers with.
     */
    check(sha, { conclusion = 'success', workflowRun, appId } = {}) {
      const run = /** @type {any} */ (fake.addCheckRun(sha, { name: 'hackwin', conclusion }))
      if (workflowRun !== undefined) run.workflowRun = workflowRun
      if (appId !== undefined) run.appId = appId
      return run
    },

    /**
     * Answer the calls of stage 8 as GitHub Actions does: each check run links its workflow run
     * (`details_url`), `gh run rerun <id> --failed` calls `rerun`, and
     * `gh run view <id> --log-failed` prints `log(id)`.
     * @param {{ rerun?: (id: number) => void, log?: (id: number) => string }} [answers]
     * @returns {{ reruns: string[][], views: string[][] }} The arguments of each call.
     */
    actions({ rerun = () => {}, log = () => '' } = {}) {
      /** @type {{ reruns: string[][], views: string[][] }} */
      const seen = { reruns: [], views: [] }
      fake.on('GET repos/{owner}/{repo}/commits/:ref/check-runs', ({ params }) => {
        const runs = /** @type {any[]} */ (fake.state.checks[params.ref] ?? [])
        return {
          total_count: runs.length,
          check_runs: runs.map((run) => {
            const url = `https://github.com/${fake.state.repo}/actions/runs/${run.workflowRun ?? run.id}/job/${run.id}`
            return {
              id: run.id,
              name: run.name,
              head_sha: params.ref,
              status: run.status,
              conclusion: run.conclusion,
              app:
                run.appId === undefined
                  ? { id: ACTIONS_APP_ID, slug: 'github-actions' }
                  : { id: run.appId, slug: `app-${run.appId}` },
              details_url: url,
              html_url: url,
            }
          }),
        }
      })
      fake.on('run rerun', ({ args }) => {
        seen.reruns.push(args)
        rerun(Number(args[2]))
        return rawResult({ stdout: '' })
      })
      fake.on('run view', ({ args }) => {
        seen.views.push(args)
        return rawResult({ stdout: log(Number(args[2])) })
      })
      return seen
    },

    /** Every `gh pr merge` call: the pull request, the SHA it was pinned to, `--admin` and gh's exit code. */
    merges() {
      return fake.calls
        .filter((call) => call.args[0] === 'pr' && call.args[1] === 'merge')
        .map((call) => ({
          pr: Number(call.args[2]),
          sha: call.args[call.args.indexOf('--match-head-commit') + 1],
          admin: call.args.includes('--admin'),
          code: call.code,
        }))
    },

    /** @param {number} n */
    labels(n) {
      return [.../** @type {any} */ (fake.find(n)).labels]
    },

    /**
     * The comments on a pull request, oldest first.
     * @param {number} n
     * @returns {Array<{ body: string, author: string }>}
     */
    comments(n) {
      return /** @type {any} */ (fake.find(n)).comments
    },

    /** The state file. */
    state() {
      return readJson(files.state)
    },

    /** The lines of `digest.log`. */
    digest() {
      try {
        return readFileSync(files.digest, 'utf8').split('\n').filter(Boolean)
      } catch {
        return []
      }
    },

    /** The status issue's content, or null. */
    status() {
      const issue = fake.state.items.find((item) => item.labels.includes(STATUS_LABEL))
      return issue ? parseStatusBody(issue.body) : null
    },

    /**
     * A directory of the test that goes with the fixture.
     * @param {string} dir
     */
    cleanupAlso(dir) {
      extra.push(dir)
    },

    /**
     * Cut the Gate off from GitHub and from origin, or connect it again: gh fails without an HTTP
     * status, and the Lead's clone points origin at a path that does not exist.
     * @param {boolean} up
     */
    async reachable(up) {
      reachable = up
      const url = up ? fixture.origin : join(fixture.origin, 'unreachable')
      await fixture.git.run(['remote', 'set-url', 'origin', url])
    },

    /**
     * Run `hackwin gate` of the Lead in a process of its own (gate-process.js), with the real
     * pipeline and the system clock, whose gh calls the scene's fake GitHub answers. Its
     * notifier records nothing unless `notify` names a platform and the PATH of its command.
     * @param {{ notify?: { platform: string, release: string, env: Record<string, string> }, trace?: string }} [options]
     *   `trace` is a file that receives every write, process and connection of the Gate's
     *   process (trace.js).
     */
    fork(options = {}) {
      const child = fork(
        fileURLToPath(new URL('./gate-process.js', import.meta.url)),
        [
          JSON.stringify({
            cwd: fixture.main,
            env: { ...fixture.env, ...env },
            notify: options.notify,
          }),
        ],
        {
          cwd: fixture.main,
          env: {
            ...fixture.env,
            ...env,
            ...(options.trace ? { HACKWIN_TEST_TRACE: options.trace } : {}),
          },
          execArgv: options.trace ? ['--import', new URL('./trace.js', import.meta.url).href] : [],
          silent: true,
        },
      )
      children.push(child)
      let out = ''
      child.stdout?.setEncoding('utf8').on('data', (chunk) => (out += chunk))
      child.stderr?.setEncoding('utf8').on('data', (chunk) => (out += chunk))
      /** @type {Promise<number | null>} */
      const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)))
      /** @type {any} */
      let result = null
      child.on('message', async (/** @type {any} */ message) => {
        if (message.type === 'done' || message.type === 'error') {
          result = message
          return
        }
        if (message.type !== 'gh') return
        /** @type {{ code: number, stdout: string, stderr: string }} */
        let answer
        try {
          answer = await gateGitHub.as(LEAD)(message.args, {
            input: message.input,
            env: message.env,
          })
        } catch (error) {
          answer = { code: 1, stdout: '', stderr: `${error}\n` }
        }
        if (!child.connected) return
        try {
          child.send({ type: 'gh', id: message.id, answer }, () => {})
        } catch {
          // The process ended meanwhile.
        }
      })
      const handle = {
        child,
        get out() {
          return out
        },
        /** The message the process sent when the Gate stopped: `done` or `error`. */
        get result() {
          return result
        },
        exited,
        /** Kill the process at once, as a crash or a closed terminal does. */
        async kill() {
          child.kill('SIGKILL')
          await exited
        },
        /** Type `quit` and wait until the process ended. */
        async quit() {
          if (child.exitCode === null && child.signalCode === null && child.connected) {
            child.send({ type: 'quit' })
          }
          return exited
        },
      }
      return handle
    },

    /** Stop the Gate and remove the fixture. */
    async cleanup() {
      await scene.quit().catch(() => {})
      for (const child of children) child.kill('SIGKILL')
      fixture.cleanup()
      for (const dir of extra) rmSync(dir, { recursive: true, force: true })
    },
  }
  return scene
}

/** @typedef {Awaited<ReturnType<typeof createScene>>} Scene */

// The world of the flow scenarios on a fixture repository (flow.fixture.test.js,
// task-link.fixture.test.js), inside `withFixtureRepo`: the Lead's clone, builder1's clone as
// another machine, and every gh call through the harness's guarded executor of that account, so
// that no call reaches a repository other than the fixture repository.
//
// CI is the real hackwin workflow on GitHub Actions: it installs the pre-release that hackwin.yml
// pins by URL (plan section 9, decision 5) and runs its `hackwin internal ci`. `ci()` waits for
// the check run `hackwin` of GitHub Actions on the head commit and reads the log of its job. The
// Gate runs in-process in the Lead's clone on the system clock and polls every
// `gate.poll_seconds`.
//
// GitHub's reads can lag its writes (src/commands/setup/settle.js), so a read after a write goes
// through `eventually`, which reads again until the expected state shows or a minute passed.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { REPOSITORY_URL, VERSION } from '../../../src/cli/context.js'
import { readPushProtection } from '../../../src/commands/setup/push-protection.js'
import { settledRead } from '../../../src/commands/setup/settle.js'
import { installCommand } from '../../../src/core/config/index.js'
import { createGit } from '../../../src/core/git/index.js'
import { ACTIONS_APP_ID, REQUIRED_CHECK } from '../../../src/core/protection/index.js'
import { RemoteError, systemClock } from '../../../src/core/runtime/index.js'
import { accounts, yaml } from '../../harness/index.js'
import {
  TASK_TEMPLATE,
  joinAnswersFile,
  pushByHand,
  runHackwin,
  setupAnswers,
  startLeadGate,
  taskBodyFromTemplate,
  withTools,
  writeTools,
} from './world.js'

/** @typedef {import('../../harness/index.js').FixtureRepoContext} FixtureRepoContext */
/** @typedef {import('./flows.js').World} World */
/** @typedef {import('./flows.js').Machine} Machine */
/** @typedef {import('./flows.js').CiResult} CiResult */

/** How long a scenario waits for one CI run on GitHub Actions. */
const CI_TIMEOUT_MS = 20 * 60_000

/** How long a scenario waits for the Gate to end one run: a poll, CI and the merge. */
const GATE_TIMEOUT_MS = 25 * 60_000

/** How long `eventually` reads again. */
const EVENTUALLY_MS = 60_000

/**
 * The URL of the `.tgz` of the running CLI's version, from its install command (contracts 6.3).
 * @returns {string | null} Null for a version without a pre-release identifier.
 */
export function prereleaseUrl() {
  const match = /(https:\/\/\S+\.tgz)$/.exec(installCommand(VERSION, REPOSITORY_URL))
  return match ? match[1] : null
}

/**
 * Fail, before the lock and the reset, when the pre-release that the fixture's CI installs is not
 * published: `setup` pins the version of the running CLI, and the generated workflow installs that
 * version by URL (plan section 9, decision 5). A read of the public download URL, not through gh;
 * a network failure is tried again.
 */
export async function requirePrerelease() {
  const url = prereleaseUrl()
  if (url === null) {
    throw new Error(
      `hackwin ${VERSION} has no pre-release identifier; the flow scenarios on a fixture repository install a pre-release of this repository by URL`,
    )
  }
  /** @type {unknown} */
  let failure = null
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, { method: 'HEAD', redirect: 'follow' })
      if (response.ok) return url
      throw new Error(
        `the pre-release v${VERSION} is not published: ${url} answered HTTP ${response.status}. The CI of the fixture repository installs it by URL; the integrator creates it (plan section 9, decision 5)`,
      )
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('the pre-release')) throw error
      failure = error
      await sleep(2_000 * attempt)
    }
  }
  throw new Error(`the pre-release URL ${url} could not be read: ${failure}`)
}

/**
 * The world of a flow on the fixture repository of `repo`.
 * @param {FixtureRepoContext} repo
 * @returns {Promise<World & { restore: () => Promise<void> }>}
 */
export async function createLiveWorld(repo) {
  const log = repo.log
  const keyOf = (/** @type {string} */ login) =>
    login.toLowerCase() === accounts.builder1.login.toLowerCase() ? 'builder1' : 'lead'

  /**
   * @param {string} login
   * @param {{ path: string, env: Record<string, string | undefined> }} clone
   * @param {string} name
   * @returns {Machine}
   */
  const machine = (login, clone, name) => {
    const tools = writeTools(join(repo.tempDir, `${name}-tools`))
    const env = withTools(clone.env, tools.bin)
    const executor = repo.executor(keyOf(login))
    return {
      login,
      path: clone.path,
      agentLog: tools.agentLog,
      env,
      git: (cwd = clone.path) => createGit({ cwd, env }),
      run: (argv, { cwd = clone.path } = {}) =>
        runHackwin(argv, { cwd, env, executor, log: (line) => log(`${login}: ${line}`) }),
    }
  }

  const lead = machine(repo.logins.lead, await repo.clone('lead'), 'lead')
  const github = repo.github('lead')

  // setup enables push protection where it is off; the scenario puts it back as it found it.
  const pushProtection = async () =>
    (
      await settledRead(systemClock, () => readPushProtection(github), {
        since: Date.now(),
        what: 'the push protection setting',
      })
    ).value
  const found = await pushProtection()
  log(`push protection before the scenario: ${found}`)

  /** @type {World & { restore: () => Promise<void> }} */
  const world = {
    live: true,
    lead,
    github,
    log,

    setup() {
      const file = join(repo.tempDir, 'setup-answers.yml')
      writeFileSync(file, yaml(setupAnswers()))
      return lead.run(['setup', '--answers', file])
    },

    async joinedMachine(login, name) {
      const member = machine(login, await repo.clone(keyOf(login), { name }), name)
      const joined = await member.run(['join', '--answers', joinAnswersFile(repo.tempDir)])
      if (joined.code !== 0) {
        throw new Error(`join of ${login} exited ${joined.code}:\n${joined.stdout}${joined.stderr}`)
      }
      return member
    },

    async writeTask(task) {
      const git = lead.git()
      await git.fetch({ prune: true })
      const template = await git.showFile('refs/remotes/origin/main', TASK_TEMPLATE)
      if (template === null) throw new Error(`origin/main holds no ${TASK_TEMPLATE}`)
      const issue = await github.createIssue({
        title: task.title,
        body: taskBodyFromTemplate(template, task),
        labels: task.labels ?? [],
      })
      log(`the Lead wrote task #${issue.number} by hand: ${task.title}`)
      // As a person sees the new issue on GitHub before anyone takes it.
      await world.eventually(
        () => github.getIssue(issue.number),
        (read) => read?.number === issue.number,
        `the new issue #${issue.number}`,
      )
      return issue.number
    },

    async openByHand(member, pull) {
      const head = await pushByHand(member, pull)
      const opened = await repo.github(keyOf(member.login)).createPullRequest({
        title: `Work on ${pull.branch}`,
        head: pull.branch,
        base: 'main',
        body: pull.body,
      })
      log(`${member.login} opened #${opened.number} by hand from ${pull.branch} at ${head}`)
      return { number: opened.number, head }
    },

    async ci(number) {
      const pull = await world.eventually(
        () => github.getPullRequest(number),
        (read) => read !== null,
        `#${number}`,
      )
      if (pull === null) throw new Error(`#${number} does not exist`)
      const head = pull.headSha
      const run = await completedCheck(github, head, log)
      const text = await jobLog(github, run.id, log)
      log(`CI of #${number} at ${head}: ${run.conclusion}, job ${run.id}`)
      return { passed: run.conclusion === 'success', head, text }
    },

    startGate() {
      return startLeadGate({
        main: lead.path,
        env: lead.env,
        executor: repo.executor('lead'),
        clock: systemClock,
        timeoutMs: GATE_TIMEOUT_MS,
        log,
      })
    },

    async eventually(read, done, what) {
      const deadline = Date.now() + EVENTUALLY_MS
      for (;;) {
        /** @type {any} */
        let value
        try {
          value = await read()
          if (done(value)) return value
        } catch (error) {
          if (!transient(error) || Date.now() > deadline) throw error
        }
        if (Date.now() > deadline) {
          log(`${what}: not as expected after ${EVENTUALLY_MS} ms: ${JSON.stringify(value)}`)
          return value
        }
        await sleep(3_000)
      }
    },

    /** Put push protection back as the scenario found it. */
    async restore() {
      const now = await pushProtection()
      if (found === null || now === found) return
      await github.api('repos/{owner}/{repo}', {
        method: 'PATCH',
        body: { security_and_analysis: { secret_scanning_push_protection: { status: found } } },
      })
      log(`push protection was ${now} after the scenario; set back to ${found}`)
    },
  }
  return world
}

/**
 * A failure of a read that passes, as a network failure does: no HTTP status, 429 or a 5xx.
 * @param {unknown} error
 */
function transient(error) {
  if (!(error instanceof RemoteError)) return false
  const status = error.status
  return status === undefined || status === null || status === 429 || status >= 500
}

/**
 * The newest completed check run `hackwin` of GitHub Actions on a commit, once there is one.
 * @param {import('../../../src/core/github/index.js').GitHub} github
 * @param {string} sha
 * @param {(line: string) => void} log
 * @returns {Promise<{ id: number, conclusion: string }>}
 */
async function completedCheck(github, sha, log) {
  const deadline = Date.now() + CI_TIMEOUT_MS
  /** @type {string} */
  let last = 'no check run yet'
  for (;;) {
    try {
      const answer = await github.api(`repos/{owner}/{repo}/commits/${sha}/check-runs`, {
        query: { check_name: REQUIRED_CHECK, per_page: '100' },
      })
      const runs = (answer?.check_runs ?? [])
        .filter(
          (/** @type {any} */ run) => run.name === REQUIRED_CHECK && run.app?.id === ACTIONS_APP_ID,
        )
        .sort((/** @type {any} */ a, /** @type {any} */ b) => b.id - a.id)
      const newest = runs[0]
      if (newest) last = `${newest.status} ${newest.conclusion ?? ''}`.trim()
      if (newest?.status === 'completed') return { id: newest.id, conclusion: newest.conclusion }
    } catch (error) {
      if (!transient(error)) throw error
      last = `a read failed: ${error.message}`
    }
    if (Date.now() > deadline) {
      throw new Error(
        `the check run ${REQUIRED_CHECK} on ${sha} did not complete within ${CI_TIMEOUT_MS} ms: ${last}`,
      )
    }
    log(`waiting for the check run ${REQUIRED_CHECK} on ${sha}: ${last}`)
    await sleep(10_000)
  }
}

/**
 * The log of a job of GitHub Actions; the id of a check run of Actions is the id of its job.
 * @param {import('../../../src/core/github/index.js').GitHub} github
 * @param {number} job
 * @param {(line: string) => void} log
 * @returns {Promise<string>}
 */
async function jobLog(github, job, log) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const { stdout } = await github.run(['api', `repos/{owner}/{repo}/actions/jobs/${job}/logs`])
      return stdout
    } catch (error) {
      // GitHub can answer 404 for a log that is not stored yet.
      if (attempt >= 6) throw error
      log(`the log of job ${job} could not be read yet: ${error.message}`)
      await sleep(5_000 * attempt)
    }
  }
}

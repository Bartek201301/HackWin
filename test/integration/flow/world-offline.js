// The offline world of the flow scenarios: the Node fixture in a fixture with a bare origin, the
// Lead's main checkout as the clone `setup` runs in, a clone of builder1 as another machine, and a
// fake GitHub linked to the origin, so that pushes, pull requests and merges act on the same
// branches. Besides the requests of the typed helpers, the fake answers what `setup` asks for:
// `gh version`, the user lookups of step 3 and the push protection setting of step 13. `setup`
// creates its rule sets on the fake, so the protection state is the one of a public repository:
// the rules for everyone and the update restriction.
//
// CI is `hackwin internal ci` as the generated workflow runs it on a pull request: a fresh clone
// checked out at the head commit and the event payload. Its result becomes the check run `hackwin`
// of GitHub Actions on that commit, which stage 8 of the Gate waits for. The install step of the
// workflow is not run: the CLI of this checkout is the version that setup pinned.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createGit } from '../../../src/core/git/index.js'
import { createGitHub } from '../../../src/core/github/index.js'
import { createFakeClock } from '../../../src/core/runtime/index.js'
import {
  accounts,
  createFakeGitHub,
  createFixture,
  httpError,
  rawResult,
  yaml,
} from '../../harness/index.js'
import {
  TASK_TEMPLATE,
  joinAnswersFile,
  pushByHand,
  manualClock,
  runHackwin,
  setupAnswers,
  startLeadGate,
  taskBodyFromTemplate,
  withTools,
  writeTools,
} from './world.js'

/** @typedef {import('../../harness/index.js').FakeGitHub} FakeGitHub */
/** @typedef {import('../../harness/index.js').Fixture} Fixture */
/** @typedef {import('./world.js').TaskInput} TaskInput */
/** @typedef {import('./flows.js').World} World */
/** @typedef {import('./flows.js').Machine} Machine */
/** @typedef {import('./flows.js').CiResult} CiResult */

export const LEAD = accounts.lead.login
/** Holds `counter` and `todos`. */
export const BUILDER1 = accounts.builder1.login

/** The variables of a GitHub Actions runner, which no run of a test may read (fixture.js). */
const RUNNER_VARIABLE = /^(?:CI|GITHUB_.*|RUNNER_.*)$/

/**
 * An offline world of the team of the flows (setupAnswers) on an unconfigured repository. Call
 * `cleanup()` when done.
 * @param {{ log?: (line: string) => void }} [options]
 * @returns {Promise<World & { fixture: Fixture, fake: FakeGitHub, cleanup: () => void }>}
 */
export async function createOfflineWorld({ log = () => {} } = {}) {
  const fixture = await createFixture({ nodeProject: true })
  const fake = createFakeGitHub({
    origin: fixture.origin,
    nextNumber: 10,
    collaborators: { [LEAD]: 'admin', [BUILDER1]: 'write' },
  })
  serveSetupRequests(fake)

  /**
   * @param {string} login
   * @param {string} path
   * @param {string} name
   * @returns {Machine}
   */
  const machine = (login, path, name) => {
    const tools = writeTools(join(fixture.dir, `${name}-tools`))
    const env = withTools(fixture.env, tools.bin)
    return {
      login,
      path,
      agentLog: tools.agentLog,
      env,
      git: (cwd = path) => createGit({ cwd, env }),
      run: (argv, { cwd = path } = {}) =>
        runHackwin(argv, {
          cwd,
          env,
          executor: fake.as(login),
          // setup waits until GitHub's reads settle; no wait takes time offline.
          clock: createFakeClock(new Date()),
          log: (line) => log(`${login}: ${line}`),
        }),
    }
  }

  const lead = machine(LEAD, fixture.main, 'lead')
  let runs = 0

  const world = {
    live: false,
    fixture,
    fake,
    lead,
    /** The Lead's client, for what the scenario writes on GitHub by hand. */
    github: createGitHub({ executor: fake.as(LEAD) }),
    log,

    /**
     * `hackwin setup --answers` in the main checkout, as the Lead.
     * @returns {Promise<import('./world.js').RunResult>}
     */
    setup() {
      const file = join(fixture.dir, 'setup-answers.yml')
      writeFileSync(file, yaml(setupAnswers()))
      return lead.run(['setup', '--answers', file])
    },

    /**
     * A new clone of a member, on which `hackwin join --answers` ran.
     * @param {string} login
     * @param {string} name The clone's directory inside the fixture.
     */
    async joinedMachine(login, name) {
      const { path } = await fixture.clone(name)
      const member = machine(login, path, name)
      const joined = await member.run(['join', '--answers', joinAnswersFile(fixture.dir)])
      if (joined.code !== 0) {
        throw new Error(`join of ${login} exited ${joined.code}:\n${joined.stdout}${joined.stderr}`)
      }
      return member
    },

    /**
     * A task issue written by hand from the template on `origin/main` (I2), as the Lead, with
     * the labels the Lead sets by hand.
     * @param {TaskInput & { labels?: string[] }} task
     * @returns {Promise<number>}
     */
    async writeTask(task) {
      await fixture.git.fetch({ prune: true })
      const template = await fixture.git.showFile('origin/main', TASK_TEMPLATE)
      if (template === null) throw new Error(`origin/main holds no ${TASK_TEMPLATE}`)
      const issue = await world.github.createIssue({
        title: task.title,
        body: taskBodyFromTemplate(template, task),
        labels: task.labels ?? [],
      })
      log(`the Lead wrote task #${issue.number} by hand: ${task.title}`)
      return issue.number
    },

    /**
     * Push a branch from a member's clone, with the hooks skipped, and open a pull request by
     * hand as that member (byHand in world.js).
     * @param {Machine} member
     * @param {{ branch: string, files: Record<string, string>, body: string, title?: string }} pull
     */
    async openByHand(member, pull) {
      const head = await pushByHand(member, pull)
      const opened = await createGitHub({ executor: fake.as(member.login) }).createPullRequest({
        title: pull.title ?? `Work on ${pull.branch}`,
        head: pull.branch,
        base: 'main',
        body: pull.body,
      })
      log(`${member.login} opened #${opened.number} by hand from ${pull.branch} at ${head}`)
      return { number: opened.number, head }
    },

    /**
     * Run the hackwin workflow on a pull request, as GitHub Actions runs its last step: `hackwin
     * internal ci` in a fresh clone checked out at the head commit, with the event payload, and
     * what it prints is the log of the job. The result becomes the check run `hackwin` on the
     * head commit.
     * @param {number} number
     * @returns {Promise<CiResult>}
     */
    async ci(number) {
      const pull = await world.github.getPullRequest(number)
      if (pull === null) throw new Error(`#${number} does not exist`)
      runs += 1
      const checkout = await fixture.clone(`ci-${runs}`)
      await checkout.git.run(['checkout', '--quiet', '--detach', pull.headSha])
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
      const tmp = join(fixture.dir, `ci-${runs}-tmp`)
      mkdirSync(tmp)
      /** @type {Record<string, string | undefined>} */
      const env = Object.fromEntries(
        Object.entries(lead.env).filter(([key]) => !RUNNER_VARIABLE.test(key)),
      )
      const result = await runHackwin(['internal', 'ci'], {
        cwd: checkout.path,
        env: { ...env, GITHUB_EVENT_PATH: event, TMPDIR: tmp },
        executor: fake.executor,
        log: (line) => log(`CI of #${number}: ${line}`),
      })
      fake.addCheckRun(pull.headSha, {
        name: 'hackwin',
        conclusion: result.code === 0 ? 'success' : 'failure',
      })
      return {
        passed: result.code === 0,
        head: pull.headSha,
        text: `${result.stdout}${result.stderr}`,
      }
    },

    /**
     * A read of the fake GitHub, whose reads never lag its writes: one read.
     * @template T
     * @param {() => Promise<T>} read
     * @returns {Promise<T>}
     */
    eventually: (read) => read(),

    /** Start the Lead's Gate on a manual clock. */
    startGate() {
      return startLeadGate({
        main: fixture.main,
        env: lead.env,
        executor: fake.as(LEAD),
        clock: manualClock(),
        log,
      })
    },

    cleanup() {
      fixture.cleanup()
    },
  }
  return world
}

/** @typedef {Awaited<ReturnType<typeof createOfflineWorld>>} OfflineWorld */

/**
 * The requests of `setup` that the fake GitHub does not answer by itself: gh's version, the user
 * lookups of step 3, and the repository with its push protection setting, which step 13 enables.
 * @param {FakeGitHub} fake
 */
function serveSetupRequests(fake) {
  const { state } = fake
  let pushProtection = 'disabled'
  fake.on('version', () => rawResult({ stdout: 'gh version 2.88.1 (2026-01-01)\n' }))
  fake.on('GET users/:login', ({ params }) => {
    if (!(params.login in state.collaborators)) throw httpError(404, 'Not Found')
    return { login: params.login, type: 'User' }
  })
  /** @param {string} login */
  const repository = (login) => {
    const order = ['read', 'triage', 'write', 'maintain', 'admin']
    const level = state.collaborators[login] ?? (state.visibility === 'public' ? 'read' : null)
    const rank = level === null ? -1 : order.indexOf(level)
    return {
      full_name: state.repo,
      name: state.repo.split('/')[1],
      owner: { login: state.repo.split('/')[0], type: 'User' },
      default_branch: state.defaultBranch,
      visibility: state.visibility,
      private: state.visibility === 'private',
      html_url: `https://github.com/${state.repo}`,
      permissions: {
        admin: rank >= 4,
        maintain: rank >= 3,
        push: rank >= 2,
        triage: rank >= 1,
        pull: rank >= 0,
      },
      // GitHub returns the block only to admins.
      ...(rank >= 4
        ? {
            security_and_analysis: {
              secret_scanning: { status: 'enabled' },
              secret_scanning_push_protection: { status: pushProtection },
            },
          }
        : {}),
    }
  }
  fake.on('GET repos/{owner}/{repo}', ({ login }) => repository(login))
  fake.on('PATCH repos/{owner}/{repo}', ({ login, body }) => {
    const status = body?.security_and_analysis?.secret_scanning_push_protection?.status
    if (status !== undefined) pushProtection = status
    return repository(login)
  })
}

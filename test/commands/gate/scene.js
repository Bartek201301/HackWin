// A scene for the tests of intake and stages 1 to 6: a fixture with a team of three, the Lead's
// fake GitHub linked to its bare origin, task issues, task branches pushed from an author's clone,
// pull requests opened as their authors, and a Gate with the real pipeline whose notifier is a
// stub that records every notification.

import { readFileSync } from 'node:fs'
import { parseDigestLine } from '../../../src/commands/gate/digest.js'
import { createPipeline } from '../../../src/commands/gate/pipeline.js'
import { gateFiles } from '../../../src/commands/gate/state.js'
import { STATUS_LABEL, parseStatusBody } from '../../../src/commands/gate/status-issue.js'
import { createGitHub } from '../../../src/core/github/index.js'
import { accounts, createFixture, teamConfig, yaml } from '../../harness/index.js'
import { leadGitHub, manualClock, noKeepAwake, readJson, startDirect } from './helpers.js'

/** @typedef {import('../../harness/index.js').FakeGitHub} FakeGitHub */
/** @typedef {import('../../../src/commands/gate/notify.js').Notification} Notification */

export const LEAD = accounts.lead.login
/** Holds `counter` and `todos`. */
export const BUILDER1 = accounts.builder1.login
/** Holds `greeting`; a name only, so every scene runs against the fake GitHub. */
export const BUILDER2 = accounts.builder2.login
export const POLL_MS = 60_000
/** `gate.status_issue_seconds` of the team configuration, in milliseconds. */
export const STATUS_MS = 120_000

/**
 * The body of a task issue written by hand from the template (8.1).
 * @param {{ role: string, paths: string[] }} block
 * @returns {string}
 */
export function taskBody({ role, paths }) {
  const data = {
    kind: 'task',
    role,
    wave: 1,
    paths,
    depends_on: [],
    acceptance_tests: ['test/features.test.js'],
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
 */
export function task(number, role, paths = [`src/features/${role}/**`]) {
  return {
    number,
    title: `Task ${number}`,
    body: taskBody({ role, paths }),
    labels: ['in-review', `role:${role}`],
  }
}

/**
 * @param {object} [options]
 * @param {(hackwin: any, owners: any) => void} [options.configure] Changes hackwin.yml and
 *   owners.yml before the fixture commits them to main.
 * @param {any[]} [options.issues] Task issues; pull requests and the status issue get numbers
 *   from 100 on.
 * @param {Record<string, string>} [options.files] More files of the first commit on main.
 */
export async function createScene({ configure, issues = [], files: mainFiles = {} } = {}) {
  const config = teamConfig(3)
  configure?.(config.hackwin, config.owners)
  const fixture = await createFixture({
    files: { 'README.md': '# Fixture\n', ...mainFiles },
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
     * Open a pull request into main as its author, as `ship` does.
     * @param {{ branch: string, author: string, task?: number, body?: string, draft?: boolean }} pull
     * @returns {Promise<number>}
     */
    async openPull({ branch, author: login, task: issue, body, draft = false }) {
      const github = createGitHub({ executor: fake.as(login) })
      const created = await github.createPullRequest({
        title: `Work on ${branch}`,
        head: branch,
        base: 'main',
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
        fake,
        login: LEAD,
        clock: manualClock(),
        options: {
          pipeline: createPipeline({
            notifier: async (notification) => {
              notifications.push(notification)
              return notifyAnswer
            },
          }),
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

    /** Move the clock by one poll interval, which starts a poll. */
    poll() {
      scene.gate.clock.advance(POLL_MS)
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
      const deadline = Date.now() + 15_000
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

    /** Stop the Gate and remove the fixture. */
    async cleanup() {
      await scene.quit().catch(() => {})
      fixture.cleanup()
    },
  }
  return scene
}

/** @typedef {Awaited<ReturnType<typeof createScene>>} Scene */

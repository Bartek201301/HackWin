// A scene for the tests of `hackwin internal ci`: an offline team repository whose main holds
// the generated files of setup's bootstrap commit (the hook fixture), stand-ins for the project's
// commands, task issues on a fake GitHub, and a run of `hackwin internal ci` in a fresh clone
// checked out at the head commit of a pull request, as the generated workflow checks it out.

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import semver from 'semver'
import { VERSION } from '../../../src/cli/context.js'
import { main } from '../../../src/cli/main.js'
import { quoteShellArg } from '../../../src/core/runtime/exec.js'
import {
  accounts,
  createFakeGitHub,
  hackwinObject,
  ownersObject,
  yaml,
} from '../../harness/index.js'
import { createHookFixture } from '../hook/hook-fixture.js'

const NODE = quoteShellArg(process.execPath)

/** The steps of 10.2 that `internal ci` runs; step 5 arrives with Phase 2. */
export const ALL_STEPS = Object.freeze([1, 2, 3, 4, 6, 7, 8, 9])

const running = /** @type {semver.SemVer} */ (semver.parse(VERSION))

/** A lower version of the running CLI's phase, for a project that pins an older release. */
export const LOWER = `${running.major}.${running.minor}.0-0`

/** A version of the next phase. */
export const OTHER_PHASE = `${running.major}.${running.minor + 1}.0-pre.0`

/**
 * The steps a run passed, from its --json result.
 * @param {{ json: any }} result
 * @returns {number[]}
 */
export function stepsOf(result) {
  return result.json.data.steps.map((/** @type {any} */ step) => step.step)
}

/** The acceptance test of task 12, added by its pull request. */
export const TEST_FILE = 'src/features/counter/reset.test.mjs'

/** A test on main that every task of the shared role names. */
export const SHARED_TEST = 'tools/smoke.test.mjs'

// Stand-ins for the project's commands, committed on main under tools/ (a shared path).
const TOOLS = {
  // Fails when a file under src/ contains BROKEN.
  'tools/check.mjs': `
    import { readdirSync, readFileSync } from 'node:fs'
    const broken = readdirSync('src', { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.parentPath + '/' + entry.name)
      .filter((file) => readFileSync(file, 'utf8').includes('BROKEN'))
    for (const file of broken) console.log('broken: ' + file)
    console.log(broken.length === 0 ? 'check passed' : 'check failed')
    process.exit(broken.length === 0 ? 0 : 1)
  `,
  // Runs the named test files: a file that contains FAIL fails.
  'tools/test.mjs': `
    import { readFileSync } from 'node:fs'
    let failed = 0
    for (const file of process.argv.slice(2)) {
      const ok = !readFileSync(file, 'utf8').includes('FAIL')
      if (!ok) failed += 1
      console.log((ok ? 'PASS ' : 'FAIL ') + file)
    }
    console.log(failed + ' failed')
    process.exit(failed > 0 ? 1 : 0)
  `,
  // Formats the named files: removes trailing spaces.
  'tools/format.mjs': `
    import { readFileSync, writeFileSync } from 'node:fs'
    for (const file of process.argv.slice(2)) {
      writeFileSync(file, readFileSync(file, 'utf8').replace(/[ \\t]+$/gm, ''))
    }
  `,
  // Writes how many files src/features/counter holds into src/shared/counter-files.txt.
  'tools/generate.mjs': `
    import { readdirSync, writeFileSync } from 'node:fs'
    const count = readdirSync('src/features/counter').length
    writeFileSync('src/shared/counter-files.txt', count + '\\n')
  `,
  // Writes the environment it runs with into the file named by its first argument.
  'tools/record-env.mjs': `
    import { writeFileSync } from 'node:fs'
    writeFileSync(process.argv[2], JSON.stringify(process.env))
  `,
  [SHARED_TEST]: 'PASS\n',
}

const MAIN_FILES = {
  'README.md': '# Fixture\n',
  // The manifest of paths.manifests, so that the install runs (A62).
  'package.json': '{ "name": "fixture", "private": true }\n',
  ...TOOLS,
  'src/shared/index.js': 'export const shared = 1\n',
  'src/shared/counter-files.txt': '1\n',
  'src/features/counter/index.js': 'export const count = 0\n',
  'src/features/todos/index.js': 'export const todos = []\n',
  'src/features/greeting/index.js': "export const greeting = 'hello'\n",
}

/** The work of task 12: inside its paths, formatted, with a passing acceptance test. */
export const WORK = Object.freeze({
  'src/features/counter/reset.js': 'export const reset = () => 0\n',
  [TEST_FILE]: 'PASS\n',
})

/**
 * The body of a task issue, in the form of 8.1.
 * @param {object} block The fields of the data block.
 */
export function taskBody(block) {
  return `\`\`\`yaml\n# hackwin:task\n${yaml(block)}\`\`\`\n\n## Problem\nA task of the CI tests.\n`
}

/**
 * The task issues of the scene: 12 of the role `counter` (builder1), 20 of the shared role (the
 * Lead), 21 of the role `counter` whose acceptance test is on main.
 */
function defaultIssues() {
  const deadline = '2026-10-25T12:00:00+02:00'
  const block = (role, paths, acceptance_tests) => ({
    kind: 'task',
    role,
    wave: 2,
    paths,
    depends_on: [],
    acceptance_tests,
    deadline,
  })
  return [
    {
      number: 12,
      title: 'Counter reset',
      body: taskBody(block('counter', ['src/features/counter/**'], [TEST_FILE])),
      labels: ['in-review', 'role:counter'],
    },
    {
      number: 20,
      title: 'Shared change',
      body: taskBody(
        block(
          'shared',
          ['src/shared/**', 'hackwin.yml', 'owners.yml', '.githooks/**', '.github/**'],
          [SHARED_TEST],
        ),
      ),
      labels: ['in-review', 'role:shared'],
    },
    {
      number: 21,
      title: 'Counter docs',
      body: taskBody(block('counter', ['src/features/counter/**'], [SHARED_TEST])),
      labels: ['in-review', 'role:counter'],
    },
  ]
}

/**
 * hackwin.yml of the scene: a team of 3 on the stand-in commands. builder1 holds `counter` and
 * `todos`, builder2 `greeting`, the Lead `shared`.
 * @param {(hackwin: ReturnType<typeof hackwinObject>) => void} [change]
 */
export function sceneConfig(change) {
  const hackwin = hackwinObject(3)
  hackwin.commands = {
    ...hackwin.commands,
    install: 'true',
    check: `${NODE} tools/check.mjs`,
    test: `${NODE} tools/test.mjs`,
    format: `${NODE} tools/format.mjs`,
    generate: null,
    lockfile_regen: 'true',
  }
  change?.(hackwin)
  return { hackwin, owners: ownersObject() }
}

/** The generate command of the stand-in project. */
export const GENERATE = `${NODE} tools/generate.mjs`

/**
 * A command that first records its environment into a file, then runs `command`, which gets
 * the appended files.
 * @param {string} file An absolute path outside the repository.
 * @param {string} [command]
 */
export function recordingEnv(file, command) {
  const record = `${NODE} tools/record-env.mjs ${quoteShellArg(file)}`
  return command ? `${record} && ${command}` : record
}

/**
 * @typedef {object} PullInput
 * @property {string} branch The head branch.
 * @property {string} head The head commit, pushed to the branch on the origin.
 * @property {string} [author] The login that opened the pull request; builder1 by default.
 * @property {string} [body] `Closes #<N>` for the issue of a task branch by default.
 * @property {number} [number] 30 by default.
 * @property {string} [checkoutAt] The commit the clone checks out; the head by default.
 * @property {boolean} [event] False runs without GITHUB_EVENT_PATH.
 * @property {Record<string, string>} [env] More variables for the run, such as GH_TOKEN.
 */

/**
 * The environment of the process without the variables of a GitHub Actions runner: on the runner
 * that tests this repository, GITHUB_EVENT_PATH names the event of that run, which a test's own
 * run of internal ci must never read.
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string | undefined>}
 */
export function withoutRunnerEnv(env) {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => key !== 'CI' && !key.startsWith('GITHUB_') && !key.startsWith('RUNNER_'),
    ),
  )
}

/**
 * @param {object} [options]
 * @param {{ hackwin: unknown, owners: unknown }} [options.config] The configuration on main;
 *   sceneConfig() by default. Objects are written as YAML, text as it is.
 * @param {Array<object>} [options.issues] The issues on the fake GitHub.
 */
export async function createCiScene({ config = sceneConfig(), issues = defaultIssues() } = {}) {
  const hooks = await createHookFixture({ files: MAIN_FILES, config })
  const { fixture } = hooks
  const tmp = join(fixture.dir, 'tmp')
  mkdirSync(tmp)
  let clones = 0

  return {
    hooks,
    fixture,
    issues,
    /** The scratch directories that runs leave behind, which must be none. */
    leftovers: () => readdirSync(tmp),

    /**
     * Push a branch with one commit of `files` from `from` (main by default), as a member's
     * pushed task branch.
     * @param {string} branch
     * @param {Record<string, string>} files
     * @param {{ from?: string, message?: string }} [options]
     * @returns {Promise<string>} The head commit.
     */
    push(branch, files, { from = 'main', message = `Work on ${branch}` } = {}) {
      return fixture.publish(files, { branch, from, message })
    },

    /**
     * Run `hackwin internal ci` for a pull request, as the workflow does: a fresh clone checked
     * out at the head commit, the event payload, and the fake GitHub with the pull request.
     * @param {PullInput} pull
     */
    async runCi({
      branch,
      head,
      author = accounts.builder1.login,
      body,
      number = 30,
      checkoutAt = head,
      event = true,
      env = {},
    }) {
      const issue = /^task\/(\d+)/.exec(branch)?.[1]
      const prBody = body ?? (issue ? `Closes #${issue}\n` : '')
      const fake = createFakeGitHub({
        issues,
        pulls: [
          {
            number,
            title: `Pull request of ${branch}`,
            head: branch,
            headSha: head,
            body: prBody,
            author,
          },
        ],
      })
      const run = ++clones
      const checkout = await fixture.clone(`ci-${run}`)
      await checkout.git.run(['checkout', '--quiet', '--detach', checkoutAt])
      const eventFile = join(fixture.dir, `event-${run}.json`)
      writeFileSync(
        eventFile,
        JSON.stringify({
          action: 'synchronize',
          number,
          pull_request: {
            number,
            head: { ref: branch, sha: head },
            base: { ref: 'main' },
            user: { login: author },
          },
        }),
      )
      let stdout = ''
      let stderr = ''
      /** @type {Array<{ args: string[], env: Record<string, string> }>} */
      const ghCalls = []
      const runEnv = {
        ...withoutRunnerEnv(hooks.env),
        ...(event ? { GITHUB_EVENT_PATH: eventFile } : {}),
        TMPDIR: tmp,
        ...env,
      }
      const code = await main(['internal', 'ci', '--json'], {
        cwd: checkout.path,
        env: runEnv,
        ghExecutor: (args, call) => {
          ghCalls.push({ args, env: { ...call?.env } })
          return fake.executor(args, call)
        },
        stdin: Readable.from(['']),
        stdout: { write: (chunk) => (stdout += chunk) },
        stderr: { write: (chunk) => (stderr += chunk) },
      })
      return { code, json: JSON.parse(stdout), stderr, checkout, fake, ghCalls, env: runEnv }
    },
  }
}

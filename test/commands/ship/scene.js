// The scene of the ship tests: a team of 3 on a stand-in project, a joined main checkout, the
// task issue on a fake GitHub linked to the fixture's origin, and the worktree of the task.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { main } from '../../../src/cli/main.js'
import { quoteShellArg } from '../../../src/core/runtime/exec.js'
import {
  accounts,
  createFakeGitHub,
  createFixture,
  hackwinObject,
  ownersObject,
  yaml,
} from '../../harness/index.js'

export const ISSUE = 12
export const TITLE = 'Counter reset'
export const BRANCH = 'task/12-counter-reset'
export const TEST_FILE = 'src/features/counter/reset.test.mjs'
export const NODE = quoteShellArg(process.execPath)

/** The project's pull request template on main, with the line that ship fills. */
export const TEMPLATE = '## Task\n\nCloses #\n\n## Notes\n\nnone\n'

/** The pull request template that setup writes, with HackWin's block. */
export const HACKWIN_TEMPLATE = readFileSync(
  new URL('../../../src/generate/templates/pull-request-template.md', import.meta.url),
  'utf8',
)

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
}

const MAIN_FILES = {
  'README.md': '# Fixture\n',
  '.github/pull_request_template.md': TEMPLATE,
  ...TOOLS,
  'src/shared/index.js': 'export const shared = 1\n',
  'src/shared/counter-files.txt': '1\n',
  'src/features/counter/index.js': 'export const count = 0\n',
  'src/features/todos/index.js': 'export const todos = []\n',
  'src/features/greeting/index.js': "export const greeting = 'hello'\n",
}

/** The work of the task: inside its paths, formatted, with a passing acceptance test. */
export const WORK = {
  'src/features/counter/reset.js': 'export const reset = () => 0\n',
  [TEST_FILE]: 'PASS\n',
}

/**
 * The body of issue 12 with its task block, in the form of 8.1.
 * @param {{ paths?: string[], acceptance_tests?: string[] }} [block]
 */
export function taskBody({
  paths = ['src/features/counter/**'],
  acceptance_tests = [TEST_FILE],
} = {}) {
  const fields = {
    kind: 'task',
    role: 'counter',
    wave: 2,
    paths,
    depends_on: [],
    acceptance_tests,
    deadline: '2026-10-25T12:00:00+02:00',
  }
  return `\`\`\`yaml\n# hackwin:task\n${yaml(fields)}\`\`\`\n\n## Problem\nReset the counter.\n`
}

/**
 * A team of 3 on the stand-in project, a joined main checkout, the task issue on a fake GitHub
 * whose branches are those of the fixture's origin, and the worktree of the task with one commit
 * of `work`, pushed unless `push` is false. builder1 holds `counter` and `todos`, builder2 holds
 * `greeting`, the Lead `shared`.
 * @param {object} [options]
 * @param {Record<string, string>} [options.work]
 * @param {boolean} [options.push]
 * @param {Parameters<typeof taskBody>[0]} [options.block]
 * @param {string[]} [options.labels]
 * @param {string} [options.author] The author of the task issue; the Lead by default.
 * @param {string | null} [options.generate]
 * @param {Record<string, string | null>} [options.commands] Commands of hackwin.yml that replace
 *   the stand-ins.
 * @param {Parameters<typeof createFakeGitHub>[0]['pulls']} [options.pulls] Pull requests that
 *   exist before ship runs.
 * @param {string} [options.template] The project's pull request template on main.
 */
export async function scene({
  work = WORK,
  push = true,
  block,
  labels = ['in-progress', 'role:counter'],
  author,
  generate = null,
  commands = {},
  pulls = [],
  template = TEMPLATE,
} = {}) {
  const hackwin = hackwinObject(3)
  hackwin.commands = {
    ...hackwin.commands,
    install: 'true',
    check: `${NODE} tools/check.mjs`,
    test: `${NODE} tools/test.mjs`,
    format: `${NODE} tools/format.mjs`,
    generate: generate === null ? null : `${NODE} ${generate}`,
    lockfile_regen: 'true',
    ...commands,
  }
  const fixture = await createFixture({
    files: { ...MAIN_FILES, '.github/pull_request_template.md': template },
    config: { hackwin, owners: ownersObject() },
  })
  const joined = await fixture.join(fixture.main, { login: accounts.builder1.login })
  const worktree = await fixture.worktree({ issue: ISSUE, title: TITLE, files: work, push })
  const fake = createFakeGitHub({
    issues: [{ number: ISSUE, title: TITLE, body: taskBody(block), labels, author }],
    pulls,
    origin: fixture.origin,
  })
  const env = { ...fixture.env, TMPDIR: join(fixture.dir, 'tmp') }
  return { fixture, fake, worktree, env, commonDir: joined.commonDir }
}

/** @typedef {Awaited<ReturnType<typeof scene>>} Scene */

/**
 * Run `hackwin ship` in-process as builder1. With `tty`, stdin and stdout are terminals, so the
 * caller kind is `terminal` unless `env` sets HACKWIN_CALLER.
 * @param {Scene} s
 * @param {{ cwd?: string, json?: boolean, env?: Record<string, string>, tty?: boolean }} [options]
 */
export async function ship(s, { cwd = s.worktree.path, json = false, env = {}, tty = false } = {}) {
  let stdout = ''
  let stderr = ''
  const code = await main(json ? ['ship', '--json'] : ['ship'], {
    cwd,
    env: { ...s.env, ...env },
    stdin: Object.assign(Readable.from([]), { isTTY: tty }),
    stdout: { write: (text) => (stdout += text), isTTY: tty },
    stderr: { write: (text) => (stderr += text) },
    ghExecutor: s.fake.as(accounts.builder1.login),
  })
  return { code, stdout, stderr }
}

/**
 * The commit a branch of the origin points to, or null.
 * @param {Scene} s
 * @param {string} [branch]
 */
export function remoteBranch(s, branch = BRANCH) {
  return s.fixture.gitAt(s.fixture.origin).tryRevParse(`refs/heads/${branch}`)
}

/**
 * The step numbers of the progress lines, in order.
 * @param {string} stdout
 * @returns {number[]}
 */
export function stepsOf(stdout) {
  return [...stdout.matchAll(/^step (\d+), /gm)].map((match) => Number(match[1]))
}

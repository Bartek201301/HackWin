import { afterEach, describe, expect, test } from 'vitest'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseGateMarker } from '../../../src/commands/gate/comment.js'
import { parseDigestLine } from '../../../src/commands/gate/digest.js'
import { namedFlakyTests } from '../../../src/commands/gate/flaky.js'
import { stepTimeoutMs } from '../../../src/commands/gate/merge-test.js'
import { quoteShellArg } from '../../../src/core/runtime/index.js'
import { BUILDER1, LEAD, createScene, task } from './scene.js'

/** @typedef {import('./scene.js').Scene} Scene */

/** Long enough for several runs of the merge test on a busy machine. */
const SLOW = 120_000

/** @type {Scene[]} */
let scenes = []
/** @type {string[]} */
let dirs = []

afterEach(async () => {
  await Promise.all(scenes.map((scene) => scene.cleanup()))
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  scenes = []
  dirs = []
})

/** @param {Parameters<typeof createScene>[0]} [options] */
async function scene(options) {
  const created = await createScene({ patience: 60_000, ...options })
  scenes.push(created)
  return created
}

/** A directory of the test's own, outside the fixture. */
function ownDir() {
  const dir = mkdtempSync(join(tmpdir(), 'hackwin-merge-test-'))
  dirs.push(dir)
  return dir
}

/**
 * A pull request with green CI that changes files on a task branch.
 * @param {Scene} s
 * @param {{ issue: number, role: string, author: string, files: Record<string, string> }} pull
 */
async function shipped(s, { issue, role, author, files }) {
  const branch = `task/${issue}-${role}-work`
  const head = await s.push(branch, { files })
  const pr = await s.openPull({ branch, author, task: issue })
  s.check(head)
  return { branch, head, pr }
}

/**
 * A command that counts its calls in `file` and fails, naming a test of `test/clock/`, on the
 * calls in `failOn`.
 * @param {string} file
 * @param {number[]} failOn
 */
function countingCheck(file, failOn) {
  const at = JSON.stringify(file)
  const script = `const fs = require('node:fs'); const n = (fs.existsSync(${at}) ? Number(fs.readFileSync(${at}, 'utf8')) : 0) + 1; fs.writeFileSync(${at}, String(n)); if (${JSON.stringify(failOn)}.includes(n)) { console.log(' FAIL  test/clock/tick.test.js > ticks once a second'); process.exit(1) }`
  return `node -e ${quoteShellArg(script)}`
}

const INSTALL_SCRIPT = [
  "import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'",
  "mkdirSync('node_modules/.bin', { recursive: true })",
  "writeFileSync('node_modules/lock.txt', readFileSync('package-lock.json'))",
  "appendFileSync(process.argv[2], 'install\\n')",
  '',
].join('\n')

const CHECK_INSTALL_SCRIPT = [
  "import { readFileSync } from 'node:fs'",
  "if (readFileSync('node_modules/lock.txt', 'utf8') !== readFileSync('package-lock.json', 'utf8')) {",
  "  console.error('node_modules does not match the lockfile')",
  '  process.exit(1)',
  '}',
  '',
].join('\n')

describe('1.6d/merge-test: the merge test of stage 7', () => {
  test(
    "a merge with main's lockfiles and manifests gets a copy of main's install from the cache; any other merge installs on its own",
    async () => {
      const installs = join(ownDir(), 'installs.log')
      const s = await scene({
        issues: [
          task(300, 'counter'),
          task(302, 'todos'),
          task(304, 'shared', ['package-lock.json']),
          task(306, 'todos'),
        ],
        files: {
          'package.json': '{ "name": "fixture", "private": true }\n',
          'package-lock.json': '{ "lockfileVersion": 3, "version": 1 }\n',
          'install.mjs': INSTALL_SCRIPT,
          'check-install.mjs': CHECK_INSTALL_SCRIPT,
        },
        configure: (hackwin) => {
          hackwin.commands.install = `node install.mjs ${quoteShellArg(installs)}`
          hackwin.commands.check = 'node check-install.mjs'
        },
      })
      const count = () =>
        existsSync(installs) ? readFileSync(installs, 'utf8').split('\n').length - 1 : 0
      const start = (await s.fixture.git.revParse('HEAD')).trim()
      const first = await shipped(s, {
        issue: 300,
        role: 'counter',
        author: BUILDER1,
        files: { 'src/features/counter/i.js': 'export const i = 1\n' },
      })
      const second = await shipped(s, {
        issue: 302,
        role: 'todos',
        author: BUILDER1,
        files: { 'src/features/todos/i.js': 'export const i = 2\n' },
      })
      await s.start()
      await s.ended(first.pr, 'merged')
      await s.ended(second.pr, 'merged')
      // One install, on main alone; both merge tests got a copy of it.
      expect(count()).toBe(1)
      expect(s.out).toContain(
        `#${first.pr} stage 7, merge test: installed main ${start} for the install cache`,
      )
      for (const pr of [first.pr, second.pr]) {
        expect(s.out).toContain(`#${pr} stage 7, merge test: the install came from the cache`)
      }
      expect(readdirSync(s.files.cache)).toHaveLength(1)

      // A merge with another lockfile installs on its own, and its install is not kept.
      const lock = await shipped(s, {
        issue: 304,
        role: 'shared',
        author: LEAD,
        files: { 'package-lock.json': '{ "lockfileVersion": 3, "version": 2 }\n' },
      })
      await s.poll()
      await s.ended(lock.pr, 'merged')
      expect(count()).toBe(2)
      expect(s.out).not.toContain(
        `#${lock.pr} stage 7, merge test: the install came from the cache`,
      )
      expect(readdirSync(s.files.cache)).toHaveLength(1)

      // Main has the new lockfile now: the next merge test makes main's install for the cache.
      const fourth = await shipped(s, {
        issue: 306,
        role: 'todos',
        author: BUILDER1,
        files: { 'src/features/todos/j.js': 'export const j = 3\n' },
      })
      await s.poll()
      await s.ended(fourth.pr, 'merged')
      await s.quit()
      expect(count()).toBe(3)
      expect(s.out).toContain(`#${fourth.pr} stage 7, merge test: the install came from the cache`)
      const cached = readdirSync(s.files.cache)
      expect(cached).toHaveLength(2)
      for (const key of cached) {
        expect(
          JSON.parse(readFileSync(join(s.files.cache, key, 'entries.json'), 'utf8')),
        ).toMatchObject({ key, entries: ['node_modules'] })
        expect(existsSync(join(s.files.cache, key, 'files', 'node_modules', 'lock.txt'))).toBe(true)
      }
      expect(existsSync(join(s.files.worktrees, 'scratch'))).toBe(false)
      const worktrees = await s.fixture.git.worktreeList()
      expect(worktrees.map((worktree) => worktree.path)).toEqual([worktrees[0].path])
    },
    SLOW,
  )

  test(
    'no run starts from files that the commands of a pull request changed, after a failed run or a merged one',
    async () => {
      const installs = join(ownDir(), 'installs.log')
      const s = await scene({
        issues: [task(330, 'counter'), task(332, 'counter'), task(334, 'todos')],
        files: {
          'package.json': '{ "name": "fixture", "private": true }\n',
          'package-lock.json': '{ "lockfileVersion": 3, "version": 1 }\n',
          'install.mjs': INSTALL_SCRIPT,
          'check-poison.mjs': [
            "import { existsSync, writeFileSync } from 'node:fs'",
            "if (existsSync('node_modules/poison.txt')) {",
            "  console.error('node_modules holds a file that the commands of a pull request wrote')",
            '  process.exit(1)',
            '}',
            "if (existsSync('src/features/counter/poison.js')) {",
            "  writeFileSync('node_modules/poison.txt', 'written by the check of a pull request')",
            '}',
            "if (existsSync('src/features/counter/fail.js')) process.exit(1)",
            '',
          ].join('\n'),
        },
        configure: (hackwin) => {
          hackwin.commands.install = `node install.mjs ${quoteShellArg(installs)}`
          hackwin.commands.check = 'node check-poison.mjs'
        },
      })
      const failing = await shipped(s, {
        issue: 330,
        role: 'counter',
        author: BUILDER1,
        files: {
          'src/features/counter/poison.js': 'export const poison = 1\n',
          'src/features/counter/fail.js': 'export const fail = 1\n',
        },
      })
      const merging = await shipped(s, {
        issue: 332,
        role: 'counter',
        author: BUILDER1,
        files: { 'src/features/counter/poison.js': 'export const poison = 2\n' },
      })
      const later = await shipped(s, {
        issue: 334,
        role: 'todos',
        author: BUILDER1,
        files: { 'src/features/todos/k.js': 'export const k = 1\n' },
      })
      await s.start()
      await s.ended(failing.pr, 'failed')
      await s.ended(merging.pr, 'merged')
      await s.ended(later.pr, 'merged')
      await s.quit()
      const [key] = readdirSync(s.files.cache)
      expect(existsSync(join(s.files.cache, key, 'files', 'node_modules', 'poison.txt'))).toBe(
        false,
      )
      expect(s.comments(later.pr)).toEqual([])
    },
    SLOW,
  )

  test(
    'the comment hides every log line that matches a secret pattern, built-in or of the team',
    async () => {
      const token = ['ghp', 'a1B2c3D4'.repeat(5)].join('_')
      const teamSecret = ['hwtest', 'q7w3e9r1t5y2u8i4o6p0a1s3'].join('_')
      // The secrets are built while the check runs, so that neither is in its command line.
      const script = [
        "console.log('before the secrets')",
        "console.log('token ' + ['ghp', 'a1B2c3D4'.repeat(5)].join('_'))",
        "console.log('team ' + ['hwtest', 'q7w3e9r1t5y2u8i4o6p0a1s3'].join('_'))",
        "console.log('after the secrets')",
        'process.exit(1)',
      ].join('; ')
      const s = await scene({
        issues: [task(340, 'counter')],
        configure: (hackwin) => {
          hackwin.commands.check = `node -e ${quoteShellArg(script)}`
          hackwin.gate.secret_patterns = ['hwtest_[a-z0-9]{24}']
        },
      })
      const pull = await shipped(s, {
        issue: 340,
        role: 'counter',
        author: BUILDER1,
        files: { 'src/features/counter/t.js': 'export const t = 1\n' },
      })
      await s.start()
      await s.ended(pull.pr, 'failed')
      await s.quit()
      const [comment] = s.comments(pull.pr)
      expect(comment.body).not.toContain(token)
      expect(comment.body).not.toContain(teamSecret)
      expect(comment.body).toContain(
        [
          'before the secrets',
          '[the Gate hides this line: it matches the secret pattern github-token]',
          '[the Gate hides this line: it matches the secret pattern gate.secret_patterns[0]]',
          'after the secrets',
        ].join('\n'),
      )
      for (const text of [...s.digest(), JSON.stringify(s.state().attention), s.out]) {
        expect(text).not.toContain(token)
        expect(text).not.toContain(teamSecret)
      }
    },
    SLOW,
  )

  test(
    "the project's commands run without the Lead's tokens, SSH agent, gh login or git credential helper",
    async () => {
      const out = join(ownDir(), 'env.json')
      const s = await scene({
        issues: [task(350, 'counter')],
        env: {
          GH_TOKEN: 'gh-token-of-the-lead',
          NPM_TOKEN: 'npm-token-of-the-lead',
          SSH_AUTH_SOCK: '/tmp/agent-of-the-lead.sock',
          LC_ALL: 'C',
        },
        files: {
          'check-env.mjs': [
            "import { execFileSync } from 'node:child_process'",
            "import { writeFileSync } from 'node:fs'",
            'const git = (args) => {',
            "  try { return execFileSync('git', args, { encoding: 'utf8' }).trim() } catch { return '' }",
            '}',
            'writeFileSync(process.argv[2], JSON.stringify({',
            '  env: process.env,',
            "  helpers: git(['config', '--get-all', 'credential.helper']),",
            "  name: git(['config', 'user.name']),",
            '}))',
            '',
          ].join('\n'),
        },
        configure: (hackwin) => {
          hackwin.commands.check = `node check-env.mjs ${quoteShellArg(out)}`
        },
      })
      // The Lead's own git configuration has a credential helper.
      appendFileSync(
        /** @type {string} */ (s.fixture.env.GIT_CONFIG_GLOBAL),
        '[credential]\n\thelper = store\n',
      )
      const pull = await shipped(s, {
        issue: 350,
        role: 'counter',
        author: BUILDER1,
        files: { 'src/features/counter/e.js': 'export const e = 1\n' },
      })
      await s.start()
      await s.ended(pull.pr, 'merged')
      await s.quit()
      const seen = JSON.parse(readFileSync(out, 'utf8'))
      const home = join(s.files.root, 'home')
      for (const name of ['GH_TOKEN', 'NPM_TOKEN', 'SSH_AUTH_SOCK', 'GH_REPO']) {
        expect(seen.env[name]).toBeUndefined()
      }
      expect(seen.env).toMatchObject({
        HOME: home,
        GH_CONFIG_DIR: join(home, '.config', 'gh'),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
        GIT_SSH_COMMAND: 'false',
        GIT_TERMINAL_PROMPT: '0',
        LC_ALL: 'C',
        PATH: s.fixture.env.PATH,
      })
      expect(readdirSync(join(home, '.config', 'gh'))).toEqual([])
      expect(seen.helpers).toBe('')
      expect(seen.name).toBe('HackWin Gate')
    },
    SLOW,
  )

  test(
    'a check whose log names a known flaky test runs again, and the pull request merges when it passes',
    async () => {
      const calls = join(ownDir(), 'calls')
      const s = await scene({
        issues: [task(310, 'counter')],
        configure: (hackwin) => {
          hackwin.commands.check = countingCheck(calls, [1])
          hackwin.gate.known_flaky_tests = ['test/clock/**']
        },
      })
      const pull = await shipped(s, {
        issue: 310,
        role: 'counter',
        author: BUILDER1,
        files: { 'src/features/counter/f.js': 'export const f = 1\n' },
      })
      await s.start()
      await s.ended(pull.pr, 'merged')
      await s.quit()
      expect(s.out).toContain(
        `#${pull.pr} stage 7, merge test: \`${countingCheck(calls, [1])}\` failed and its log names the known flaky test test/clock/**, so it runs again`,
      )
      expect(parseDigestLine(s.digest()[0])?.note).toMatch(/; 1 merge test rerun$/)
      expect(s.comments(pull.pr)).toEqual([])
    },
    SLOW,
  )

  test(
    'a check that fails again with a known flaky test in its log ends the run as flaky, and the pull request is not blamed',
    async () => {
      const calls = join(ownDir(), 'calls')
      const s = await scene({
        issues: [task(312, 'counter')],
        configure: (hackwin) => {
          hackwin.commands.check = countingCheck(calls, [1, 2])
          hackwin.gate.known_flaky_tests = ['test/clock/**']
        },
      })
      const pull = await shipped(s, {
        issue: 312,
        role: 'counter',
        author: BUILDER1,
        files: { 'src/features/counter/g.js': 'export const g = 1\n' },
      })
      await s.start()
      await s.ended(pull.pr, 'flaky')
      await s.quit()
      const [comment] = s.comments(pull.pr)
      expect(parseGateMarker(comment.body)).toMatchObject({ stage: 'merge-test', result: 'flaky' })
      expect(comment.body).toContain('The pull request is not blamed (G14).')
      expect(comment.body).toContain(' FAIL  test/clock/tick.test.js > ticks once a second')
      expect(s.out).toContain(
        `ATTENTION repeated-failure #${pull.pr}: the known flaky test test/clock/**`,
      )
      expect(s.merges()).toEqual([])
    },
    SLOW,
  )

  test(
    'an acceptance test that the merge does not hold fails the run before anything runs',
    async () => {
      const s = await scene({
        issues: [task(314, 'counter', undefined, { acceptance: ['test/counter/missing.test.js'] })],
      })
      const pull = await shipped(s, {
        issue: 314,
        role: 'counter',
        author: BUILDER1,
        files: { 'src/features/counter/h.js': 'export const h = 1\n' },
      })
      await s.start()
      await s.ended(pull.pr, 'failed')
      await s.quit()
      const [comment] = s.comments(pull.pr)
      expect(comment.body).toContain(
        'the task #314 names 1 acceptance test that is no file of the merge of the head with main',
      )
      expect(comment.body).toContain('- `test/counter/missing.test.js`')
      expect(parseDigestLine(s.digest()[0])).toMatchObject({
        stage: 'merge-test',
        note: 'merge test: acceptance tests missing',
      })
    },
    SLOW,
  )
})

describe('1.6d/step-timeout: a command of the merge test that runs too long', () => {
  test(
    'is stopped after the step timeout and fails the run with step-timeout',
    async () => {
      // The pipeline's step timeout of five seconds stands in for `gate.step_timeout_minutes`. The
      // shell prints the line before node starts, so the line is in the log also when a loaded
      // machine starts node slowly; without the timeout the check would run for ten minutes.
      const s = await scene({
        issues: [task(320, 'counter')],
        stepTimeoutMs: 5000,
        configure: (hackwin) => {
          hackwin.commands.check = `echo waiting && node -e ${quoteShellArg('setTimeout(() => {}, 600000)')}`
        },
      })
      const pull = await shipped(s, {
        issue: 320,
        role: 'counter',
        author: BUILDER1,
        files: { 'src/features/counter/s.js': 'export const s = 1\n' },
      })
      await s.start()
      await s.ended(pull.pr, 'failed')
      await s.quit()
      const [comment] = s.comments(pull.pr)
      expect(comment.body).toContain(
        'the check ran longer than `gate.step_timeout_minutes`, 20 min, on the merge of the head with main',
      )
      expect(comment.body).toContain('(`step-timeout`)')
      expect(comment.body).toContain(', stopped after 20 min. The last line of its log:')
      expect(comment.body).toContain('\nwaiting\n')
      expect(parseDigestLine(s.digest()[0])).toMatchObject({
        stage: 'merge-test',
        note: 'step-timeout: check',
      })
    },
    SLOW,
  )

  test('gate.step_timeout_minutes is the step timeout in minutes', () => {
    const config = (/** @type {number} */ minutes) =>
      /** @type {any} */ ({ hackwin: { gate: { step_timeout_minutes: minutes } } })
    expect(stepTimeoutMs(config(1))).toBe(60_000)
    expect(stepTimeoutMs(config(20))).toBe(1_200_000)
  })
})

describe('1.6d/flaky: the known flaky tests a log names', () => {
  test('an entry counts only in a failure line, as written or as a glob that matches a path', () => {
    const log = [
      ' FAIL  ./test/clock/tick.test.js:12:5 > ticks once a second',
      '  ✓ test/clock/tock.test.js > tocks (3 ms)',
      '  × counter > counts 12ms',
      'not ok 3 - slow network (retry)',
      '  ✓ test/todos/list.test.js',
    ].join('\n')
    expect(
      namedFlakyTests(log, [
        'test/clock/**',
        'counter > counts',
        'slow network (retry)',
        'test/todos/**',
        'test/clock/tock.test.js',
        '',
      ]),
    ).toEqual(['test/clock/**', 'counter > counts', 'slow network (retry)'])
  })

  test('a passing line of a known flaky test does not make another failure flaky', () => {
    const log = [
      '  ✓ test/clock/tick.test.js (2 tests)',
      ' FAIL  test/counter.test.js > counts',
    ].join('\n')
    expect(namedFlakyTests(log, ['test/clock/**', 'test/clock/tick.test.js'])).toEqual([])
  })
})

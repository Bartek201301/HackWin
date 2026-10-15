import { afterEach, describe, expect, test } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseGateMarker } from '../../../src/commands/gate/comment.js'
import { parseDigestLine } from '../../../src/commands/gate/digest.js'
import { namedFlakyTests } from '../../../src/commands/gate/flaky.js'
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
    'the install comes from the cache while the lockfile hash is the same, and runs again when it changes',
    async () => {
      const installs = join(ownDir(), 'installs.log')
      const s = await scene({
        issues: [
          task(300, 'counter'),
          task(302, 'todos'),
          task(304, 'shared', ['package-lock.json']),
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
      expect(count()).toBe(1)
      expect(s.out).toContain(`#${second.pr} stage 7, merge test: the install came from the cache`)

      const lock = await shipped(s, {
        issue: 304,
        role: 'shared',
        author: LEAD,
        files: { 'package-lock.json': '{ "lockfileVersion": 3, "version": 2 }\n' },
      })
      await s.poll()
      await s.ended(lock.pr, 'merged')
      await s.quit()
      expect(count()).toBe(2)
      expect(s.out).not.toContain(
        `#${lock.pr} stage 7, merge test: the install came from the cache`,
      )
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
  // `gate.step_timeout_minutes` takes whole minutes, so this test waits one minute for the
  // timeout. The command only sleeps meanwhile.
  test('is stopped after gate.step_timeout_minutes and fails the run with step-timeout', async () => {
    const s = await scene({
      issues: [task(320, 'counter')],
      patience: 150_000,
      configure: (hackwin) => {
        hackwin.gate.step_timeout_minutes = 1
        hackwin.commands.check = `node -e ${quoteShellArg("console.log('waiting'); setTimeout(() => {}, 600000)")}`
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
      'the check ran longer than `gate.step_timeout_minutes`, 1 min, on the merge of the head with main',
    )
    expect(comment.body).toContain('(`step-timeout`)')
    expect(comment.body).toContain(', stopped after 1 min. The last line of its log:')
    expect(comment.body).toContain('\nwaiting\n')
    expect(parseDigestLine(s.digest()[0])).toMatchObject({
      stage: 'merge-test',
      note: 'step-timeout: check',
    })
  }, 240_000)
})

describe('1.6d/flaky: the known flaky tests a log names', () => {
  test('an entry counts as written, or as a glob that matches a path of the log', () => {
    const log = [
      ' FAIL  ./test/clock/tick.test.js:12:5 > ticks once a second',
      '  ✓ counter > counts (3 ms)',
      'Error in "slow network (retry)"',
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
})

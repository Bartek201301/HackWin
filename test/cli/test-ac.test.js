import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createScratch } from '../core/git/temp-repo.js'

const root = fileURLToPath(new URL('../../', import.meta.url))

// Every case starts nested test runs. On a machine loaded by several test suites at once, a case
// can take longer than the 30 s test timeout of vitest.config.js. So the nested runs work on a few
// sample tests, not on this repository; each one may take up to RUN_TIMEOUT, and a run that takes
// longer is killed, so that a hanging run fails its case instead of holding the suite.
const RUN_TIMEOUT = 180_000

/**
 * The environment of a nested test run, without the variables of the run around it. Whether Vitest
 * colours its output depends on the environment (CI, a coding agent, FORCE_COLOR), so a nested run
 * prints no colours, on a developer's machine as on a CI runner.
 */
function childEnv(extra = {}) {
  /** @type {Record<string, string | undefined>} */
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('VITEST') || key === 'HACKWIN_TEST_IDS' || key === 'FORCE_COLOR') continue
    env[key] = value
  }
  return /** @type {NodeJS.ProcessEnv} */ ({ ...env, NO_COLOR: '1', ...extra })
}

/**
 * `npm run test:ac` with the script of this repository's package.json, on the sample tests.
 * @param {string[]} ids
 */
function npmTestAc(ids) {
  return spawnSync('npm', ['run', 'test:ac', '--', ...ids], {
    cwd: scratch.dir,
    env: childEnv(),
    encoding: 'utf8',
    timeout: RUN_TIMEOUT,
  })
}

// An id with characters a shell would interpret. A shell that ran it would create ran-by-a-shell.
const shellId = `X6 'a' "b" $HOME $(touch ran-by-a-shell); *`

// Sample tests in a scratch directory, run with the configurations of this repository.
const sampleTests = `
import { describe, test } from 'vitest'
test('X1: the whole criterion', () => {})
test('X1/part: one part of it', () => {})
test('X10: a different id', () => {})
describe('X2: an id on the describe block', () => {
  test('applies to every test inside', () => {})
})
test('X3: a failing test', () => { throw new Error('fails') })
test.skip('X4: a skipped test', () => {})
test('no id in this name', () => {})
test(${JSON.stringify(`${shellId}: an id with shell characters`)}, () => {})
`
const sampleFixtureTest = `
import { test } from 'vitest'
test('X5: a test on a fixture repository', () => {})
`

/** @type {ReturnType<typeof createScratch>} */
let scratch

beforeAll(() => {
  scratch = createScratch()
  scratch.write(join(scratch.dir, 'test', 'sample.test.js'), sampleTests)
  scratch.write(join(scratch.dir, 'test', 'sample.fixture.test.js'), sampleFixtureTest)
  const { scripts } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const samplePackage = { type: 'module', scripts: { 'test:ac': scripts['test:ac'] } }
  scratch.write(join(scratch.dir, 'package.json'), `${JSON.stringify(samplePackage)}\n`)
  symlinkSync(join(root, 'node_modules'), join(scratch.dir, 'node_modules'))
  symlinkSync(join(root, 'scripts'), join(scratch.dir, 'scripts'))
})

afterAll(() => scratch.cleanup())

/**
 * @param {string} config
 * @param {string[]} ids
 * @param {string[]} [args] further arguments of Vitest
 */
function vitestOnSamples(config, ids, args = []) {
  return spawnSync(
    process.execPath,
    [
      join(root, 'node_modules', 'vitest', 'vitest.mjs'),
      'run',
      '--config',
      join(root, config),
      '--root',
      scratch.dir,
      ...args,
    ],
    {
      cwd: scratch.dir,
      env: childEnv({ HACKWIN_TEST_IDS: JSON.stringify(ids) }),
      encoding: 'utf8',
      timeout: RUN_TIMEOUT,
    },
  )
}

// A case starts at most two nested runs.
const caseTimeout = { timeout: 2 * RUN_TIMEOUT + 30_000 }

describe('1.3a/test-ac: npm run test:ac runs the tests of the named ids', caseTimeout, () => {
  test('npm run test:ac -- <id> runs the tests with that id', () => {
    const result = npmTestAc(['X1'])
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain('X1: 2 passed, 0 failed')
    expect(result.stdout).toMatch(/Tests +2 passed \| \d+ skipped/)
  })

  test('npm run test:ac fails for an id that matches no test', () => {
    const result = npmTestAc(['X1', 'X9'])
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('X9: no test with this id ran')
  })

  test('npm run test:ac without an id fails', () => {
    const result = npmTestAc([])
    expect(result.status).not.toBe(0)
    expect(result.stdout + result.stderr).toContain('name at least one test id')
  })

  test('an id with characters a shell would interpret reaches the selection unchanged', () => {
    const result = npmTestAc([shellId])
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain(`${shellId}: 1 passed, 0 failed`)
    expect(existsSync(join(scratch.dir, 'ran-by-a-shell'))).toBe(false)
  })

  test('an id selects its parts and describe blocks, and includes the fixture tests', () => {
    const result = vitestOnSamples('vitest.ac.config.js', ['X1', 'X2', 'X5'])
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain('X1: 2 passed, 0 failed')
    expect(result.stdout).toContain('X2: 1 passed, 0 failed')
    expect(result.stdout).toContain('X5: 1 passed, 0 failed')
  })

  test('a failing test fails the run, and a skipped test does not count as run', () => {
    const failing = vitestOnSamples('vitest.ac.config.js', ['X3'])
    expect(failing.status).toBe(1)
    expect(failing.stdout).toContain('X3: 0 passed, 1 failed')
    const skipped = vitestOnSamples('vitest.ac.config.js', ['X4'])
    expect(skipped.status).toBe(1)
    expect(skipped.stdout).toContain('X4: no test with this id ran')
  })

  test('the offline suite of npm test leaves out the fixture tests', () => {
    // vitest.config.js names no reporter, and Vitest picks one by environment: `agent` under a
    // coding agent, `default` and `github-actions` on GitHub Actions. So the run names it.
    const result = vitestOnSamples('vitest.config.js', [], ['--reporter=default'])
    // X3 fails on purpose; what matters is which files ran.
    expect(result.stdout).toContain('sample.test.js')
    expect(result.stdout).not.toContain('sample.fixture.test.js')
  })
})

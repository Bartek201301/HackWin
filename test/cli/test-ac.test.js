import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { spawnSync } from 'node:child_process'
import { symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createScratch } from '../core/git/temp-repo.js'

const root = fileURLToPath(new URL('../../', import.meta.url))

/** The environment of a nested test run, without the variables of the run around it. */
function childEnv(extra = {}) {
  /** @type {Record<string, string | undefined>} */
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('VITEST') && key !== 'HACKWIN_TEST_IDS') env[key] = value
  }
  return /** @type {NodeJS.ProcessEnv} */ ({ ...env, ...extra })
}

/** @param {string[]} ids */
function npmTestAc(ids) {
  return spawnSync('npm', ['run', 'test:ac', '--', ...ids], {
    cwd: root,
    env: childEnv(),
    encoding: 'utf8',
  })
}

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
  scratch.write(join(scratch.dir, 'package.json'), '{ "type": "module" }\n')
  symlinkSync(join(root, 'node_modules'), join(scratch.dir, 'node_modules'))
})

afterAll(() => scratch.cleanup())

/**
 * @param {string} config
 * @param {string[]} ids
 */
function vitestOnSamples(config, ids) {
  return spawnSync(
    process.execPath,
    [
      join(root, 'node_modules', 'vitest', 'vitest.mjs'),
      'run',
      '--config',
      join(root, config),
      '--root',
      scratch.dir,
    ],
    { cwd: scratch.dir, env: childEnv({ HACKWIN_TEST_IDS: ids.join(' ') }), encoding: 'utf8' },
  )
}

describe('1.3a/test-ac: npm run test:ac runs the tests of the named ids', () => {
  test('npm run test:ac -- <id> runs the tests with that id', () => {
    const result = npmTestAc(['1.3a/registry'])
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toMatch(/1\.3a\/registry: [1-9]\d* passed, 0 failed/)
    expect(result.stdout).not.toMatch(/1\.3a\/git: /)
  })

  test('npm run test:ac fails for an id that matches no test', () => {
    const result = npmTestAc(['1.3a/registry', '1.3a/no-such-test'])
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('1.3a/no-such-test: no test with this id ran')
  })

  test('npm run test:ac without an id fails', () => {
    const result = npmTestAc([])
    expect(result.status).not.toBe(0)
    expect(result.stdout + result.stderr).toContain('name at least one test id')
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
    const result = vitestOnSamples('vitest.config.js', [])
    // X3 fails on purpose; what matters is which files ran.
    expect(result.stdout).toContain('sample.test.js')
    expect(result.stdout).not.toContain('sample.fixture.test.js')
  })
})

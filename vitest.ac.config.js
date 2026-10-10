import { defineConfig } from 'vitest/config'
import { testConfig } from './vitest.config.js'

// `npm run test:ac -- <id>...` runs the tests with those ids, the tests on fixture repositories
// included, and fails for an id that matches no test that ran. The id of a test is the text
// before the first colon of its full name (its describe blocks and its own name). An id also
// selects its parts: `AC54` runs `AC54: ...` and `AC54/hooks: ...`.
const ids = (process.env.HACKWIN_TEST_IDS ?? '').split(/\s+/).filter(Boolean)
if (ids.length === 0) {
  throw new Error('test:ac: name at least one test id: npm run test:ac -- <id>...')
}

/** @param {string} text */
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The test id of a full test name, or null when the name has no colon.
 * @param {string} fullName
 */
export function testIdOf(fullName) {
  const colon = fullName.indexOf(':')
  return colon === -1 ? null : fullName.slice(0, colon).trim()
}

/**
 * Whether a test with the id `testId` belongs to the requested id.
 * @param {string | null} testId
 * @param {string} requested
 */
export function matchesId(testId, requested) {
  return testId === requested || (testId?.startsWith(`${requested}/`) ?? false)
}

/** Reports how many tests ran per id and fails for an id without any. */
class TestIdReporter {
  /** @param {ReadonlyArray<import('vitest/node').TestModule>} testModules */
  onTestRunEnd(testModules) {
    /** @type {Map<string, { passed: number, failed: number }>} */
    const counts = new Map(ids.map((id) => [id, { passed: 0, failed: 0 }]))
    for (const testModule of testModules) {
      for (const testCase of testModule.children.allTests()) {
        const { state } = testCase.result()
        if (state !== 'passed' && state !== 'failed') continue
        const testId = testIdOf(testCase.fullName)
        for (const [id, count] of counts) {
          if (matchesId(testId, id)) count[state] += 1
        }
      }
    }
    const lines = ['', 'test:ac results by id:']
    let missing = false
    for (const [id, { passed, failed }] of counts) {
      if (passed + failed === 0) {
        missing = true
        lines.push(`  ${id}: no test with this id ran`)
      } else {
        lines.push(`  ${id}: ${passed} passed, ${failed} failed`)
      }
    }
    process.stdout.write(`${lines.join('\n')}\n`)
    if (missing) process.exitCode = 1
  }
}

export default defineConfig({
  test: {
    ...testConfig,
    exclude: ['**/node_modules/**'],
    testNamePattern: new RegExp(`^(?:${ids.map(escapeRegExp).join('|')})(?:/[^:]*)?:`),
    reporters: ['default', new TestIdReporter()],
  },
})

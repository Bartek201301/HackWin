import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Tests are found by glob, so a lane adds tests only under its own test directories.
// Tests on the fixture repositories (*.fixture.test.js) run only through `npm run test:ac`.
const harnessSetup = fileURLToPath(new URL('./test/harness/setup.js', import.meta.url))

/** @type {import('vitest/config').ViteUserConfig['test']} */
export const testConfig = {
  include: ['test/**/*.test.js'],
  exclude: ['**/node_modules/**', 'test/**/*.fixture.test.js'],
  // Owned by task 1.3d; loaded before every test file once it exists.
  setupFiles: existsSync(harnessSetup) ? [harnessSetup] : [],
  testTimeout: 30_000,
  hookTimeout: 30_000,
}

export default defineConfig({ test: testConfig })

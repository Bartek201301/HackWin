// `npm run test:ac -- <id>...`: runs Vitest with vitest.ac.config.js on the tests of these ids.
// Vitest starts without a shell, and the ids reach the configuration as a JSON array in
// HACKWIN_TEST_IDS, so each id arrives as it was written. The script exits with Vitest's exit code.

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const vitestPackage = require.resolve('vitest/package.json')
const vitest = join(dirname(vitestPackage), require(vitestPackage).bin.vitest)
const config = fileURLToPath(new URL('../vitest.ac.config.js', import.meta.url))

const child = spawn(process.execPath, [vitest, 'run', '--config', config], {
  stdio: 'inherit',
  env: { ...process.env, HACKWIN_TEST_IDS: JSON.stringify(process.argv.slice(2)) },
})
// Stop Vitest along with this script, as if Vitest had been started in its place.
for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP'])) {
  process.on(signal, () => child.kill(signal))
}
child.on('exit', (code) => {
  process.exitCode = code ?? 1
})

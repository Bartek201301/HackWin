// A test on a real fixture repository: it runs only through `npm run test:ac`, and fails when the
// repository, the gh login or HACKWIN_TEST_BUILDER_TOKEN is missing.

import { describe, expect, test } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exec } from '../../src/core/runtime/exec.js'
import { TOKEN_VARIABLE, accounts, redact, requireBuilderToken } from './accounts.js'

const RUN = fileURLToPath(new URL('./credential-run.js', import.meta.url))

/**
 * Whether the text holds the token, also as the Basic authorization git would send. Only a
 * boolean leaves this function, so a failing assertion never prints the token.
 * @param {string} text
 * @param {string} token
 */
function holdsToken(text, token) {
  const forms = [token, Buffer.from(`x-access-token:${token}`).toString('base64')]
  return forms.some((form) => text.includes(form))
}

describe('1.3d/no-credential-output: a fixture repository run', () => {
  test(
    'its output and its run log contain no credential',
    async () => {
      const token = requireBuilderToken()
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hackwin-credential-')))
      try {
        const logFile = join(dir, 'run.log')
        /** @type {Record<string, string | undefined>} */
        const env = {}
        for (const [key, value] of Object.entries(process.env)) {
          if (!key.startsWith('GIT_')) env[key] = value
        }
        // The token reaches the run only through its environment.
        env[TOKEN_VARIABLE] = token
        const result = await exec(process.execPath, [RUN, logFile], { env, timeoutMs: 25 * 60_000 })
        const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''

        // First the search for the token, so that no later failure message can print it.
        expect(holdsToken(result.stdout, token)).toBe(false)
        expect(holdsToken(result.stderr, token)).toBe(false)
        expect(holdsToken(log, token)).toBe(false)
        expect(result.code, redact(`${result.stdout}\n${result.stderr}`, token)).toBe(0)

        const summary = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}')
        // The run really used the token: as builder1, through gh and through git.
        expect(summary.builder1).toBe(accounts.builder1.login)
        expect(summary.pushed).toBe(true)
        expect(summary.failure).toMatch(/HTTP 404/)
        expect(summary.filesChecked).toBeGreaterThan(0)
        expect(summary.filesWithToken).toEqual([])
        expect(existsSync(summary.tempDir)).toBe(false)

        expect(log).toMatch(
          /builder1 gh api --method GET repos\/\{owner\}\/\{repo\}\/issues\/999999999 -> exit 1/,
        )
        expect(log).toMatch(/builder1 cloned/)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    30 * 60_000,
  )
})

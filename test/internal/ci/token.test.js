import { afterEach, describe, expect, test, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchAuth } from '../../../src/internal/ci/token.js'
import { createFixture } from '../../harness/index.js'
import { ALL_STEPS, WORK, createCiScene, recordingEnv, sceneConfig, stepsOf } from './ci-fixture.js'

/** @type {string[]} */
const dirs = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** The project's commands, each of which runs code from the pull request. */
const PROJECT_COMMANDS = /** @type {const} */ (['install', 'check', 'test', 'format', 'generate'])

describe("1.4b/token: the token reaches only internal ci's own GitHub calls", () => {
  test("every gh call gets the token, and none of the project's commands sees it", async () => {
    const records = mkdtempSync(join(tmpdir(), 'hackwin-ci-env-'))
    dirs.push(records)
    /** @param {string} name */
    const record = (name) => join(records, `${name}.json`)
    const config = sceneConfig((hackwin) => {
      const { commands } = hackwin
      commands.install = recordingEnv(record('install'), commands.install)
      commands.check = recordingEnv(record('check'), commands.check)
      commands.test = recordingEnv(record('test'), commands.test)
      commands.format = recordingEnv(record('format'), commands.format)
      commands.generate = recordingEnv(record('generate'))
    })
    const scene = await createCiScene({ config })
    const branch = 'task/12-counter-reset'
    const head = await scene.push(branch, WORK)

    // As in the workflow's step: the token is in the environment of the process, which the
    // project's commands inherit, and in the environment of the command.
    const token = `hackwin-test-token-${randomBytes(12).toString('hex')}`
    vi.stubEnv('GH_TOKEN', token)
    vi.stubEnv('GITHUB_TOKEN', token)
    const result = await scene.runCi({ branch, head, env: { GH_TOKEN: token } })

    expect(result.code).toBe(0)
    expect(stepsOf(result)).toEqual(ALL_STEPS)
    for (const name of PROJECT_COMMANDS) {
      expect(existsSync(record(name)), name).toBe(true)
      const env = JSON.parse(readFileSync(record(name), 'utf8'))
      expect(env.GH_TOKEN, name).toBeUndefined()
      expect(env.GITHUB_TOKEN, name).toBeUndefined()
      expect(JSON.stringify(env), name).not.toContain(token)
    }
    expect(result.ghCalls.length).toBeGreaterThanOrEqual(2)
    for (const call of result.ghCalls) expect(call.env.GH_TOKEN, call.args.join(' ')).toBe(token)
    expect(process.env.GH_TOKEN).toBeUndefined()
    expect(process.env.GITHUB_TOKEN).toBeUndefined()
    expect(result.stderr).not.toContain(token)
  })

  test('the fetch of the base branch sends the token to the host of an https remote, and git reads it', async () => {
    const token = 'hackwin-test-token'
    const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
    expect(fetchAuth('https://github.com/acme/app', token)).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: header,
    })
    expect(
      fetchAuth('https://x-access-token@github.example.com/acme/app.git', token),
    ).toMatchObject({
      GIT_CONFIG_KEY_0: 'http.https://github.example.com/.extraheader',
    })
    expect(fetchAuth('git@github.com:acme/app.git', token)).toEqual({})
    expect(fetchAuth('/tmp/origin.git', token)).toEqual({})
    expect(fetchAuth(null, token)).toEqual({})
    expect(fetchAuth('https://github.com/acme/app', null)).toEqual({})

    const fixture = await createFixture()
    const git = fixture.git.with({
      env: { ...fixture.env, ...fetchAuth('https://github.com/acme/app', token) },
    })
    expect(await git.configGet('http.https://github.com/.extraheader')).toBe(header)
    expect(await fixture.git.configGet('http.https://github.com/.extraheader')).toBeNull()
  })
})

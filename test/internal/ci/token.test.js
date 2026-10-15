import { afterEach, describe, expect, test, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { exec, quoteShellArg } from '../../../src/core/runtime/exec.js'
import { fetchAuth } from '../../../src/internal/ci/token.js'
import { createFixture } from '../../harness/index.js'
import { ALL_STEPS, WORK, createCiScene, recordingEnv, sceneConfig, stepsOf } from './ci-fixture.js'

// takeToken as it is, except that it first writes START to the log of the git processes, if a
// test names one: the processes after that line are the ones internal ci starts; those before it
// are the runner's own.
const START = 'internal ci starts'
const gitLog = vi.hoisted(() => ({ file: /** @type {string | null} */ (null) }))
vi.mock('../../../src/internal/ci/token.js', async (importOriginal) => {
  /** @type {typeof import('../../../src/internal/ci/token.js')} */
  const actual = await importOriginal()
  return {
    ...actual,
    /** @type {typeof actual.takeToken} */
    takeToken: (ctx) => {
      if (gitLog.file) appendFileSync(gitLog.file, `${START}\n`)
      return actual.takeToken(ctx)
    },
  }
})

/** @type {string[]} */
const dirs = []
afterEach(() => {
  vi.unstubAllEnvs()
  gitLog.file = null
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** The project's commands, each of which runs code from the pull request. */
const PROJECT_COMMANDS = /** @type {const} */ (['install', 'check', 'test', 'format', 'generate'])

/**
 * A `git` for the front of PATH that writes one line per process to a log, `token` or `clean`
 * with its arguments, and then runs the real git.
 * @param {string} dir
 * @param {string} token
 */
async function recordingGit(dir, token) {
  const real = (await exec('sh', ['-c', 'command -v git'])).stdout.trim()
  const bin = join(dir, 'bin')
  const log = join(dir, 'git.log')
  mkdirSync(bin)
  writeFileSync(log, '')
  writeFileSync(
    join(bin, 'git'),
    [
      '#!/bin/sh',
      `case "$(env)" in *${token}*) seen=token ;; *) seen=clean ;; esac`,
      `printf '%s git %s\\n' "$seen" "$*" >> ${quoteShellArg(log)}`,
      `exec ${quoteShellArg(real)} "$@"`,
      '',
    ].join('\n'),
  )
  chmodSync(join(bin, 'git'), 0o755)
  return { bin, log, lines: () => readFileSync(log, 'utf8').split('\n').filter(Boolean) }
}

describe("1.4b/token: the token reaches only internal ci's own GitHub calls", () => {
  test('every gh call gets the token, and no process internal ci starts sees it, the project commands and the git of shared code included', async () => {
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

    const token = `hackwin-test-token-${randomBytes(12).toString('hex')}`
    const git = await recordingGit(records, token)
    gitLog.file = git.log
    // As in the workflow's step: the token is in the environment of the process, which main
    // reads and every process inherits that gets no environment of its own; GITHUB_TOKEN too,
    // which gh reads as well.
    const result = await scene.runCi({
      branch,
      head,
      processEnv: true,
      env: {
        GH_TOKEN: token,
        GITHUB_TOKEN: token,
        PATH: `${git.bin}${delimiter}${scene.hooks.env.PATH}`,
      },
    })

    expect(result.code).toBe(0)
    expect(stepsOf(result)).toEqual(ALL_STEPS)
    for (const name of PROJECT_COMMANDS) {
      expect(existsSync(record(name)), name).toBe(true)
      const env = JSON.parse(readFileSync(record(name), 'utf8'))
      expect(env.GH_TOKEN, name).toBeUndefined()
      expect(env.GITHUB_TOKEN, name).toBeUndefined()
      expect(JSON.stringify(env), name).not.toContain(token)
    }
    // Every git process that internal ci starts, the one of src/core/project's hasManifest
    // (`git ls-files`, which runs with process.env) included.
    const lines = git.lines()
    const start = lines.indexOf(START)
    expect(start).toBeGreaterThanOrEqual(0)
    const started = lines.slice(start + 1)
    expect(started.some((line) => line.includes(' ls-files '))).toBe(true)
    expect(started.filter((line) => !line.startsWith('clean '))).toEqual([])
    expect(result.ghCalls.length).toBeGreaterThanOrEqual(2)
    for (const call of result.ghCalls) expect(call.env.GH_TOKEN, call.args.join(' ')).toBe(token)
    // After the run the environment of the process, which is the one main got, holds the token
    // variables again.
    expect(result.env).toBe(process.env)
    expect(process.env.GH_TOKEN).toBe(token)
    expect(process.env.GITHUB_TOKEN).toBe(token)
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

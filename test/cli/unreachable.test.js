import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { Readable } from 'node:stream'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { main } from '../../src/cli/main.js'
import { createScratch } from '../core/git/temp-repo.js'
import { createConfiguredRepo, fakeGh } from '../core/config/fixtures.js'

const runtime = pathToFileURL(
  new URL('../../src/core/runtime/index.js', import.meta.url).pathname,
).href

// A stand-in for status: `unreachable` reports what the runner gave it; `run` must not run.
const statusModule = `
export async function run() {
  throw new Error('run must not be called when GitHub is unreachable')
}

export async function unreachable(ctx, error) {
  return {
    lines: ['local heartbeat: 12s ago', 'GitHub is unreachable'],
    data: {
      config: 'config' in ctx,
      identity: 'identity' in ctx,
      command: ctx.command,
      repoRoot: ctx.repoRoot,
      github: typeof ctx.github.login,
      error: { name: error.name, kind: error.kind },
    },
  }
}
`

// A command without the hook.
const takeModule = `
export async function run() {
  return { lines: ['ran'] }
}
`

// A hook that returns nothing.
const gateModule = `
export async function run() {
  return { lines: ['ran'] }
}

export async function unreachable() {}
`

// A hook with a bug.
const shipModule = `
export async function run() {
  return { lines: ['ran'] }
}

export async function unreachable() {
  throw new Error('broken hook')
}
`

// A plumbing command and a user command whose run fails with a RemoteError after the
// preparation succeeded: neither reaches the hook.
const remoteInRunModule = `
import { RemoteError } from '${runtime}'

export async function run() {
  throw new RemoteError('GitHub call failed', { status: 502 })
}

export async function unreachable() {
  return { lines: ['the hook ran'] }
}
`

/** @type {ReturnType<typeof createConfiguredRepo>} */
let repo
/** @type {ReturnType<typeof createScratch>} */
let modules
/** A clone whose origin is gone, so the fetch of the preparation fails. */
let offline = ''

beforeAll(() => {
  repo = createConfiguredRepo()
  offline = join(repo.dir, 'offline')
  repo.git(repo.dir, 'clone', '--quiet', repo.origin, offline)
  repo.git(offline, 'remote', 'set-url', 'origin', join(repo.dir, 'gone.git'))
  modules = createScratch()
  const write = (/** @type {string} */ path, /** @type {string} */ text) =>
    modules.write(join(modules.dir, path), text)
  write('src/commands/status/index.js', statusModule)
  write('src/commands/take/index.js', takeModule)
  write('src/commands/gate/index.js', gateModule)
  write('src/commands/ship/index.js', shipModule)
  write('src/commands/setup/index.js', remoteInRunModule)
  write('src/internal/hook/pre-commit.js', remoteInRunModule)
})

afterAll(() => {
  repo.cleanup()
  modules.cleanup()
})

/** A gh that cannot reach GitHub. */
const offlineGh = async () => ({
  code: 1,
  stdout: '',
  stderr: 'error connecting to api.github.com',
})

/**
 * Run hackwin in-process and record stdout and stderr in the order they were written.
 * @param {string[]} argv
 * @param {Partial<import('../../src/cli/main.js').MainOptions>} [options]
 */
async function run(argv, options = {}) {
  /** @type {['stdout' | 'stderr', string][]} */
  const log = []
  const writer = (/** @type {'stdout' | 'stderr'} */ name) => ({
    write: (/** @type {string} */ chunk) => log.push([name, chunk]),
  })
  const code = await main(argv, {
    cwd: repo.clone,
    env: repo.env,
    stdin: Readable.from([]),
    stdout: writer('stdout'),
    stderr: writer('stderr'),
    moduleRoot: modules.dir,
    ghExecutor: fakeGh('lead'),
    ...options,
  })
  const text = (/** @type {string} */ name) =>
    log
      .filter(([stream]) => stream === name)
      .map(([, chunk]) => chunk)
      .join('')
  return { code, log, stdout: text('stdout'), stderr: text('stderr') }
}

describe('1.3a/unreachable: a user command prints what it knows locally when GitHub is unreachable', () => {
  test('a failed fetch calls unreachable without config and identity, prints its lines before the error and exits 3', async () => {
    const result = await run(['status'], { cwd: offline })
    expect(result.code).toBe(3)
    expect(result.stdout).toBe('local heartbeat: 12s ago\nGitHub is unreachable\n')
    expect(result.stderr).toMatch(/^hackwin status: git fetch origin failed/)
    // Every line of the hook is written before the first line of the error.
    const streams = result.log.map(([stream]) => stream)
    expect(streams.lastIndexOf('stdout')).toBeLessThan(streams.indexOf('stderr'))
  })

  test('a failed `gh api user` calls unreachable as well, with the config the runner had loaded removed', async () => {
    const result = await run(['status', '--json'], { ghExecutor: offlineGh })
    expect(result.code).toBe(3)
    const json = JSON.parse(result.stdout)
    expect(json.data).toEqual({
      config: false,
      identity: false,
      command: 'status',
      repoRoot: repo.clone,
      github: 'function',
      error: { name: 'RemoteError', kind: 'remote' },
    })
  })

  test('under --json the lines and data are in the one JSON document of the error', async () => {
    const result = await run(['status', '--json'], { cwd: offline })
    expect(result.code).toBe(3)
    expect(result.stderr).toBe('')
    const json = JSON.parse(result.stdout)
    expect(json).toEqual({
      command: 'status',
      ok: false,
      exitCode: 3,
      lines: ['local heartbeat: 12s ago', 'GitHub is unreachable'],
      data: {
        config: false,
        identity: false,
        command: 'status',
        repoRoot: offline,
        github: 'function',
        error: { name: 'RemoteError', kind: 'remote' },
      },
      error: expect.objectContaining({
        kind: 'remote',
        message: expect.stringMatching(/^git fetch origin failed/),
      }),
      warnings: [],
    })
    // A hook that returns nothing gives empty lines and no data.
    const empty = JSON.parse((await run(['gate', '--json'], { cwd: offline })).stdout)
    expect(empty).toMatchObject({ exitCode: 3, lines: [], data: null, error: { kind: 'remote' } })
    expect((await run(['gate'], { cwd: offline })).stdout).toBe('')
  })

  test('a module without unreachable, or without a module, prints the error alone as before', async () => {
    const take = await run(['take'], { cwd: offline })
    expect(take.code).toBe(3)
    expect(take.stdout).toBe('')
    expect(take.stderr).toMatch(/^hackwin take: git fetch origin failed/)
    const json = JSON.parse((await run(['take', '--json'], { cwd: offline })).stdout)
    expect(Object.keys(json)).toEqual(['command', 'ok', 'exitCode', 'error', 'warnings'])
    expect(json).toMatchObject({
      command: 'take',
      ok: false,
      exitCode: 3,
      error: { kind: 'remote' },
    })
    const gh = await run(['take'], { ghExecutor: offlineGh })
    expect(gh.code).toBe(3)
    expect(gh.stdout).toBe('')
    // join has no module here: the fetch's error is reported, not `not built yet`.
    const missing = await run(['join'], { cwd: offline })
    expect(missing.code).toBe(3)
    expect(missing.stderr).toMatch(/^hackwin join: git fetch origin failed/)
  })

  test('a plumbing command never reaches the hook', async () => {
    // The runner does not prepare a plumbing command, so it runs even where origin is gone,
    // and a RemoteError of its own run does not call the hook.
    for (const cwd of [offline, repo.clone]) {
      const result = await run(['internal', 'hook', 'pre-commit'], { cwd })
      expect(result.code).toBe(3)
      expect(result.stdout).toBe('')
      expect(result.stderr).toMatch(/^hackwin internal hook pre-commit: GitHub call failed/)
    }
    const json = JSON.parse(
      (await run(['internal', 'hook', 'pre-commit', '--json'], { cwd: offline })).stdout,
    )
    expect(Object.keys(json)).toEqual(['command', 'ok', 'exitCode', 'error', 'warnings'])
  })

  test('only a RemoteError of the preparation calls the hook', async () => {
    // A RemoteError of run, after the preparation succeeded.
    const inRun = await run(['setup'])
    expect(inRun.code).toBe(3)
    expect(inRun.stdout).toBe('')
    expect(inRun.stderr).toMatch(/^hackwin setup: GitHub call failed/)
    // A caller who is no team member: exit 2, no hook.
    const stranger = await run(['status'], { ghExecutor: fakeGh('stranger') })
    expect(stranger.code).toBe(2)
    expect(stranger.stdout).toBe('')
  })

  test('an error that the hook throws is reported in place of the RemoteError', async () => {
    const result = await run(['ship'], { cwd: offline })
    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('hackwin ship: internal error: broken hook')
  })
})

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { Readable } from 'node:stream'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { main } from '../../src/cli/main.js'
import { createRepoWithOrigin, createScratch } from '../core/git/temp-repo.js'

const runtime = pathToFileURL(
  new URL('../../src/core/runtime/index.js', import.meta.url).pathname,
).href

// A stand-in for the take module: its first argument picks the behavior.
const takeModule = `
import {
  BlockedError, ConfigError, GitError, NotBuiltError, PreconditionError, RemoteError, UsageError,
} from '${runtime}'

export async function run(ctx) {
  const resolve = { command: 'hackwin take 4', dir: ctx.repoRoot }
  switch (ctx.args[0]) {
    case 'ok':
      ctx.out.line('progress line')
      return { lines: ['short line'], data: { full: true, items: [1, 2, 3] } }
    case 'nothing':
      return undefined
    case 'context':
      return {
        data: {
          command: ctx.command, args: ctx.args, flags: ctx.flags, json: ctx.json,
          repoRoot: ctx.repoRoot, gitCommonDir: ctx.gitCommonDir, caller: ctx.caller,
          version: ctx.version, now: ctx.clock.now().toISOString(), stdin: await ctx.readStdin(),
          repo: ctx.github.repo,
        },
      }
    case 'warn':
      ctx.out.warn('the main checkout is behind origin/main')
      return { lines: ['done'] }
    case 'checks-failed':
      return { exitCode: 1, lines: ['fail: .env.local is missing'] }
    case 'bad-exit':
      return { exitCode: 3 }
    case 'blocked':
      throw new BlockedError('a file outside your roles', { rule: 'E1 scope', objects: ['src/x.js: role shared, held by lead'], resolve })
    case 'config':
      throw new ConfigError('must have 1 to 4 entries', { key: 'team.members' })
    case 'precondition':
      throw new PreconditionError('join has not completed', { resolve: { command: 'hackwin join', dir: ctx.repoRoot } })
    case 'usage':
      throw new UsageError('issue number expected')
    case 'not-built':
      throw new NotBuiltError('take', 'src/commands/take/index.js')
    case 'git':
      throw new GitError('git status failed', { args: ['status'], code: 128, tail: [] })
    case 'remote':
      throw new RemoteError('GitHub call failed', { status: 502 })
    case 'gh':
      return { lines: [await ctx.github.login()] }
    default:
      throw new Error('unexpected bug')
  }
}
`

/** @type {ReturnType<typeof createRepoWithOrigin>} */
let repo
/** @type {ReturnType<typeof createScratch>} */
let modules

beforeAll(() => {
  repo = createRepoWithOrigin()
  modules = createScratch()
  modules.write(join(modules.dir, 'src/commands/take/index.js'), takeModule)
})

afterAll(() => {
  repo.cleanup()
  modules.cleanup()
})

function sink() {
  return {
    text: '',
    /** @param {string} chunk */
    write(chunk) {
      this.text += chunk
    },
  }
}

/**
 * Run hackwin in-process in the temporary clone.
 * @param {string[]} argv
 * @param {Partial<import('../../src/cli/main.js').MainOptions>} [options]
 */
async function run(argv, options = {}) {
  const stdout = sink()
  const stderr = sink()
  const code = await main(argv, {
    cwd: repo.clone,
    env: repo.env,
    stdin: Readable.from([]),
    stdout,
    stderr,
    moduleRoot: modules.dir,
    ...options,
  })
  return { code, stdout: stdout.text, stderr: stderr.text }
}

describe('1.3a/runner: exit codes, short output and --json', () => {
  test('every error type maps to its exit code of CM2', async () => {
    const expected = {
      ok: 0,
      'checks-failed': 1,
      blocked: 1,
      config: 2,
      precondition: 2,
      usage: 2,
      'not-built': 2,
      git: 2,
      internal: 2,
      'bad-exit': 2,
      remote: 3,
    }
    for (const [behavior, code] of Object.entries(expected)) {
      expect((await run(['take', behavior])).code, behavior).toBe(code)
    }
  })

  test('short output is the default: only the lines, no data', async () => {
    const result = await run(['take', 'ok'])
    expect(result.stdout).toBe('progress line\nshort line\n')
    expect(result.stderr).toBe('')
    expect((await run(['take', 'nothing'])).stdout).toBe('')
  })

  test('--json prints the full result as one JSON document on stdout', async () => {
    const result = await run(['take', 'ok', '--json'])
    expect(JSON.parse(result.stdout)).toEqual({
      command: 'take',
      ok: true,
      exitCode: 0,
      lines: ['short line'],
      data: { full: true, items: [1, 2, 3] },
      warnings: [],
    })
    expect(result.stderr).toBe('progress line\n')
    // --json may stand anywhere.
    expect(JSON.parse((await run(['--json', 'take', 'ok'])).stdout).ok).toBe(true)
  })

  test('a block names the rule, the objects and the command with its directory (CM4, CM5)', async () => {
    const result = await run(['take', 'blocked'])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe(
      [
        'hackwin take: blocked: a file outside your roles',
        '  rule: E1 scope',
        '  - src/x.js: role shared, held by lead',
        `  to resolve: run \`hackwin take 4\` in ${repo.clone}`,
        '',
      ].join('\n'),
    )
    const json = JSON.parse((await run(['take', 'blocked', '--json'])).stdout)
    expect(json).toEqual({
      command: 'take',
      ok: false,
      exitCode: 1,
      error: {
        kind: 'blocked',
        message: 'a file outside your roles',
        rule: 'E1 scope',
        objects: ['src/x.js: role shared, held by lead'],
        resolve: { command: 'hackwin take 4', dir: repo.clone },
      },
      warnings: [],
    })
  })

  test('errors print short on stderr, or as JSON with their fields', async () => {
    expect((await run(['take', 'config'])).stderr).toBe(
      'hackwin take: must have 1 to 4 entries\n  key: team.members\n',
    )
    const config = JSON.parse((await run(['take', 'config', '--json'])).stdout)
    expect(config.error).toEqual({
      kind: 'config',
      message: 'must have 1 to 4 entries',
      key: 'team.members',
    })
    const remote = JSON.parse((await run(['take', 'remote', '--json'])).stdout)
    expect(remote).toMatchObject({
      exitCode: 3,
      error: { kind: 'remote', details: { status: 502 } },
    })
    const internal = await run(['take', 'internal'])
    expect(internal.stderr).toContain('hackwin take: internal error: unexpected bug')
    const debug = await run(['take', 'internal'], { env: { ...repo.env, HACKWIN_DEBUG: '1' } })
    expect(debug.stderr).toContain('at run')
  })

  test('a result with exit code 1 still prints its lines', async () => {
    const result = await run(['take', 'checks-failed'])
    expect(result).toEqual({ code: 1, stdout: 'fail: .env.local is missing\n', stderr: '' })
  })

  test('warnings go to stderr and into the JSON result', async () => {
    const short = await run(['take', 'warn'])
    expect(short.stdout).toBe('done\n')
    expect(short.stderr).toBe('warning: the main checkout is behind origin/main\n')
    const json = JSON.parse((await run(['take', 'warn', '--json'])).stdout)
    expect(json.warnings).toEqual(['the main checkout is behind origin/main'])
  })

  test('the context carries arguments, flags, repository root, common dir, caller kind and clock', async () => {
    const worktree = join(repo.dir, 'clone.worktrees', '4-context')
    repo.git(repo.clone, 'worktree', 'add', '--quiet', '-b', 'task/4-context', worktree)
    const clock = { now: () => new Date('2026-10-10T12:00:00.000Z'), sleep: async () => {} }
    const result = await run(['take', 'context', '--release', '--json'], {
      cwd: join(worktree),
      clock,
      stdin: Readable.from(['line one\n']),
    })
    expect(JSON.parse(result.stdout).data).toEqual({
      command: 'take',
      args: ['context'],
      flags: { release: true },
      json: true,
      repoRoot: worktree,
      gitCommonDir: join(repo.clone, '.git'),
      caller: 'non-interactive',
      version: expect.stringMatching(/^\d+\.\d+\.\d+/),
      now: '2026-10-10T12:00:00.000Z',
      stdin: 'line one\n',
      repo: null,
    })
    const wrapped = await run(['take', 'context', '--json'], {
      env: { ...repo.env, HACKWIN_CALLER: 'claude-code' },
    })
    expect(JSON.parse(wrapped.stdout).data.caller).toBe('claude-code')
  })

  test('the repository of a GitHub origin is passed to gh', async () => {
    const clone = join(repo.dir, 'github-clone')
    repo.git(repo.dir, 'clone', '--quiet', repo.origin, clone)
    repo.git(
      clone,
      'remote',
      'set-url',
      'origin',
      'https://github.com/Bartek201301/hackwin-fixture-a.git',
    )
    const result = await run(['take', 'context', '--json'], { cwd: clone })
    expect(JSON.parse(result.stdout).data.repo).toBe('Bartek201301/hackwin-fixture-a')
  })

  test('a failing gh call through the replaced executor seam exits 3', async () => {
    const ghExecutor = async () => ({
      code: 1,
      stdout: '',
      stderr: 'error connecting to api.github.com',
    })
    const result = await run(['take', 'gh'], { ghExecutor })
    expect(result.code).toBe(3)
    expect(result.stderr).toContain('GitHub call failed')
    const working = await run(['take', 'gh'], {
      ghExecutor: async () => ({ code: 0, stdout: '{"login":"test-bot-builder"}', stderr: '' }),
    })
    expect(working).toEqual({ code: 0, stdout: 'test-bot-builder\n', stderr: '' })
  })

  test('bad command lines and a directory outside a repository exit 2', async () => {
    expect((await run(['take', '--bogus'])).code).toBe(2)
    expect((await run(['take', '1', '2'])).code).toBe(2)
    expect((await run(['ship', 'extra'])).code).toBe(2)
    const outside = await run(['take', 'ok'], { cwd: repo.dir })
    expect(outside.code).toBe(2)
    expect(outside.stderr).toContain('not inside a git checkout')
    const usage = JSON.parse((await run(['nope', '--json'])).stdout)
    expect(usage).toMatchObject({ command: null, ok: false, exitCode: 2, error: { kind: 'usage' } })
  })
})

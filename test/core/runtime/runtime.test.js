import { afterEach, describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BlockedError,
  ConfigError,
  EXIT,
  GitError,
  NotBuiltError,
  PreconditionError,
  RemoteError,
  UsageError,
  createFakeClock,
  createOutput,
  detectCallerKind,
  exec,
  execShell,
  exitCodeOf,
  formatError,
  formatResolve,
  quoteShellArg,
  runIn,
} from '../../../src/core/runtime/index.js'
import { createScratch } from '../git/temp-repo.js'

/** A Writer that keeps what was written. */
function sink() {
  return {
    text: '',
    /** @param {string} chunk */
    write(chunk) {
      this.text += chunk
    },
  }
}

/** @type {Array<() => void>} */
const cleanups = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

describe('1.3a/runtime: exit codes and error types', () => {
  test('every error type carries its exit code of CM2', () => {
    const cases = [
      [new BlockedError('b', { rule: 'E1 scope', objects: ['a.js'], resolve: 'ask the Lead' }), 1],
      [new ConfigError('c', { key: 'team.members' }), 2],
      [new PreconditionError('p'), 2],
      [new UsageError('u'), 2],
      [new NotBuiltError('take', 'src/commands/take/index.js'), 2],
      [new GitError('g', { args: ['status'], code: 128, tail: [] }), 2],
      [new RemoteError('r', { status: 502 }), 3],
      [new Error('a bug'), 2],
    ]
    for (const [error, code] of cases) expect(exitCodeOf(error)).toBe(code)
    expect(EXIT).toEqual({ OK: 0, BLOCKED: 1, PRECONDITION: 2, REMOTE: 3 })
  })

  test('a block must name the rule, the objects and how to resolve it (CM5)', () => {
    const resolve = { command: 'hackwin take 4', dir: '/repo' }
    expect(() => new BlockedError('x', { rule: '', objects: ['a'], resolve })).toThrow(TypeError)
    expect(() => new BlockedError('x', { rule: 'E1', objects: [], resolve })).toThrow(TypeError)
    expect(
      () =>
        new BlockedError('x', { rule: 'E1', objects: ['a'], resolve: { command: 'x', dir: '' } }),
    ).toThrow(TypeError)
    const error = new BlockedError('2 files outside your roles', {
      rule: 'E1 scope',
      objects: ['a.js', 'b.js'],
      resolve,
    })
    expect(error.toJSON()).toEqual({
      kind: 'blocked',
      message: '2 files outside your roles',
      rule: 'E1 scope',
      objects: ['a.js', 'b.js'],
      resolve,
    })
    expect(formatError(error, { command: 'ship' })).toEqual([
      'hackwin ship: blocked: 2 files outside your roles',
      '  rule: E1 scope',
      '  - a.js',
      '  - b.js',
      '  to resolve: run `hackwin take 4` in /repo',
    ])
  })

  test('a configuration error names the key; a remote error keeps the status and the log tail', () => {
    expect(
      formatError(new ConfigError('must have 1 to 4 entries', { key: 'team.members' })),
    ).toEqual(['hackwin: must have 1 to 4 entries', '  key: team.members'])
    const remote = new RemoteError('GitHub call failed', {
      status: 503,
      tail: ['gh: Service Unavailable (HTTP 503)'],
    })
    expect(remote.status).toBe(503)
    expect(formatError(remote)).toEqual([
      'hackwin: GitHub call failed',
      '  gh: Service Unavailable (HTTP 503)',
    ])
    expect(formatError(new Error('boom'), { command: 'take' })[0]).toBe(
      'hackwin take: internal error: boom',
    )
  })
})

describe('1.3a/runtime: output helpers', () => {
  test('every "run this" message names its directory (CM4)', () => {
    expect(runIn('hackwin join', '/home/me/repo')).toBe('run `hackwin join` in /home/me/repo')
    expect(() => runIn('hackwin join', '')).toThrow(TypeError)
    expect(formatResolve({ command: 'gh auth login', dir: 'any directory' })).toBe(
      'run `gh auth login` in any directory',
    )
    expect(formatResolve('ask the Lead to add you to hackwin.yml')).toBe(
      'ask the Lead to add you to hackwin.yml',
    )
  })

  test('lines go to stdout, or to stderr with --json; warnings go to stderr and are kept', () => {
    const stdout = sink()
    const stderr = sink()
    const short = createOutput({ stdout, stderr })
    short.line('progress')
    short.warn('the checkout is behind origin/main')
    expect(stdout.text).toBe('progress\n')
    expect(stderr.text).toBe('warning: the checkout is behind origin/main\n')
    expect(short.warnings).toEqual(['the checkout is behind origin/main'])

    const jsonOut = sink()
    const jsonErr = sink()
    const json = createOutput({ stdout: jsonOut, stderr: jsonErr, json: true })
    json.line('progress')
    json.write('question? ')
    expect(jsonOut.text).toBe('')
    expect(jsonErr.text).toBe('progress\nquestion? ')
  })
})

describe('1.3a/runtime: process execution', () => {
  test('exec returns the exit code, the output and stdin is passed', async () => {
    const result = await exec('sh', ['-c', 'cat; echo err >&2; exit 3'], { input: 'hello\n' })
    expect(result).toMatchObject({
      code: 3,
      signal: null,
      stdout: 'hello\n',
      stderr: 'err\n',
      timedOut: false,
    })
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  test('the tail keeps the last lines of both streams in order', async () => {
    const script = 'for i in 1 2 3 4 5; do echo out$i; done; echo err6 >&2; printf last'
    const result = await exec('sh', ['-c', script], { tailLines: 3 })
    expect(result.tail).toEqual(['out5', 'err6', 'last'])
  })

  test('a timeout stops the whole process group', async () => {
    const scratch = createScratch()
    cleanups.push(scratch.cleanup)
    const marker = join(scratch.dir, 'child-survived')
    const started = Date.now()
    const result = await execShell(`(sleep 2; touch ${quoteShellArg(marker)}) & sleep 10`, {
      timeoutMs: 300,
    })
    expect(result.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(5000)
    await new Promise((resolve) => setTimeout(resolve, 2500))
    expect(() => readFileSync(marker)).toThrow()
  })

  test('the log file receives the whole output', async () => {
    const scratch = createScratch()
    cleanups.push(scratch.cleanup)
    const logFile = join(scratch.dir, 'run.log')
    await execShell('echo one; echo two >&2', { logFile })
    expect(readFileSync(logFile, 'utf8').split('\n').sort()).toEqual(['', 'one', 'two'])
  })

  test('a missing program or directory is a precondition error', async () => {
    await expect(exec('hackwin-no-such-program', [])).rejects.toBeInstanceOf(PreconditionError)
    await expect(exec('sh', ['-c', 'true'], { cwd: '/no/such/dir' })).rejects.toThrow(
      /does not exist/,
    )
  })

  test('quoteShellArg keeps every argument intact in a shell command line', async () => {
    const args = ['plain', 'with space', "it's", '$HOME', 'a;b', '']
    const result = await execShell(`printf '%s\\n' ${args.map(quoteShellArg).join(' ')}`)
    expect(result.stdout).toBe(`${args.join('\n')}\n`)
  })
})

describe('1.3a/runtime: clock and caller kind', () => {
  test('the fake clock moves forward on sleep without waiting', async () => {
    const clock = createFakeClock('2026-10-10T12:00:00.000Z')
    const before = Date.now()
    await clock.sleep(60 * 60 * 1000)
    expect(clock.now().toISOString()).toBe('2026-10-10T13:00:00.000Z')
    clock.advance(1000)
    expect(clock.now().toISOString()).toBe('2026-10-10T13:00:01.000Z')
    expect(Date.now() - before).toBeLessThan(1000)
  })

  test('the caller kind is claude-code, terminal or non-interactive', () => {
    const tty = { stdinIsTTY: true, stdoutIsTTY: true }
    expect(detectCallerKind({ env: { HACKWIN_CALLER: 'claude-code' }, ...tty })).toBe('claude-code')
    expect(
      detectCallerKind({
        env: { HACKWIN_CALLER: 'claude-code' },
        stdinIsTTY: false,
        stdoutIsTTY: false,
      }),
    ).toBe('claude-code')
    expect(detectCallerKind({ env: {}, ...tty })).toBe('terminal')
    expect(detectCallerKind({ env: {}, stdinIsTTY: true, stdoutIsTTY: false })).toBe(
      'non-interactive',
    )
    expect(detectCallerKind({ env: {}, stdinIsTTY: false, stdoutIsTTY: true })).toBe(
      'non-interactive',
    )
    expect(detectCallerKind({ env: { HACKWIN_CALLER: 'codex' }, ...tty })).toBe('terminal')
  })
})

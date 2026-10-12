import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { keepAwakeCommand, startKeepAwake } from '../../../src/commands/gate/awake.js'
import { parseCommand } from '../../../src/commands/gate/input.js'
import {
  acquireLock,
  isRunning,
  readLock,
  releaseLock,
  runningGate,
} from '../../../src/commands/gate/lock.js'
import { emptyState, loadState, pullRecord } from '../../../src/commands/gate/state.js'
import { readJson, until } from './helpers.js'

const NOW = new Date('2026-10-24T10:00:00.000Z')

/** @type {string} */
let dir

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'hackwin-gate-parts-')))
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A Node process that runs until it is killed. */
function otherProcess() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  return {
    pid: /** @type {number} */ (child.pid),
    stop: () =>
      new Promise((resolve) => {
        child.once('exit', resolve)
        child.kill()
      }),
  }
}

describe('1.6a/lock: one Gate holds the lock, and a lock of a dead process is replaced', () => {
  test('the lock of a running process is kept; once it ends, the lock is replaced', async () => {
    const file = join(dir, 'held', 'gate.lock')
    const other = otherProcess()
    const first = await acquireLock(file, { pid: other.pid, now: NOW })
    expect(first).toMatchObject({ acquired: true, replaced: null })
    expect(readJson(file)).toMatchObject({
      schema: 1,
      pid: other.pid,
      started_at: NOW.toISOString(),
    })

    const refused = await acquireLock(file, { pid: process.pid, now: NOW })
    expect(refused).toEqual({ acquired: false, holder: readJson(file) })
    expect(await runningGate(file)).toEqual(readJson(file))

    await other.stop()
    expect(isRunning(other.pid)).toBe(false)
    expect(await runningGate(file)).toBe(null)
    const taken = await acquireLock(file, { pid: process.pid, now: NOW })
    expect(taken).toMatchObject({ acquired: true, replaced: { pid: other.pid } })
    expect(readJson(file).pid).toBe(process.pid)
  })

  test('a file that holds no lock record is replaced', async () => {
    const file = join(dir, 'garbage', 'gate.lock')
    mkdirSync(join(dir, 'garbage'))
    writeFileSync(file, '')
    const taken = await acquireLock(file, { pid: process.pid, now: NOW })
    expect(taken).toMatchObject({ acquired: true, replaced: null })
    expect(await readLock(file)).toMatchObject({ pid: process.pid })
  })

  test('a Gate removes only its own lock', async () => {
    const file = join(dir, 'own', 'gate.lock')
    const taken = await acquireLock(file, { pid: process.pid, now: NOW })
    if (!taken.acquired) throw new Error('the lock was not taken')
    await releaseLock(file, { ...taken.record, token: 'another' })
    expect(await readLock(file)).toEqual(taken.record)
    await releaseLock(file, taken.record)
    expect(await readLock(file)).toBe(null)
  })
})

describe('1.6a/awake: the keep awake command per operating system', () => {
  const host = { pid: 4242, release: '25.6.0', env: {} }

  test('caffeinate on macOS, systemd-inhibit on Linux, none on WSL and elsewhere', () => {
    expect(keepAwakeCommand({ ...host, platform: 'darwin' })).toEqual({
      file: 'caffeinate',
      args: ['-i', '-w', '4242'],
    })
    const linux = keepAwakeCommand({ ...host, platform: 'linux', release: '6.8.0-45-generic' })
    expect(linux).toMatchObject({ file: 'systemd-inhibit' })
    expect('args' in linux && linux.args).toEqual([
      '--what=idle:sleep',
      '--who=HackWin Gate',
      '--why=The Gate tests and merges pull requests while it runs',
      '--mode=block',
      'sh',
      '-c',
      'while kill -0 4242 2>/dev/null; do sleep 5; done',
    ])
    const wsl = { unsupported: 'Windows through WSL offers no command that keeps the laptop awake' }
    expect(
      keepAwakeCommand({
        ...host,
        platform: 'linux',
        release: '5.15.153.1-microsoft-standard-WSL2',
      }),
    ).toEqual(wsl)
    expect(
      keepAwakeCommand({ ...host, platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' } }),
    ).toEqual(wsl)
    expect(keepAwakeCommand({ ...host, platform: 'win32' })).toEqual({
      unsupported: 'HackWin knows no command that keeps a win32 machine awake',
    })
  })

  test('a missing command is reported, and a command that fails calls onLost', async () => {
    const empty = join(dir, 'no-bin')
    mkdirSync(empty)
    /** @type {string[]} */
    const lost = []
    const missing = await startKeepAwake({
      pid: process.pid,
      platform: 'darwin',
      env: { PATH: empty },
      onLost: (reason) => lost.push(reason),
    })
    expect(missing).toMatchObject({
      active: false,
      command: null,
      reason: 'caffeinate is not installed',
    })

    const bin = join(dir, 'failing-bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'caffeinate'), '#!/bin/sh\necho "no power assertion" >&2\nexit 1\n')
    chmodSync(join(bin, 'caffeinate'), 0o755)
    const failing = await startKeepAwake({
      pid: process.pid,
      platform: 'darwin',
      env: { PATH: `${bin}:/usr/bin:/bin` },
      onLost: (reason) => lost.push(reason),
    })
    expect(failing.command).toBe(`caffeinate -i -w ${process.pid}`)
    await until(() => lost.length === 1, 'the end of the command')
    expect(lost).toEqual(['caffeinate exited with code 1: no power assertion'])
    expect(failing).toMatchObject({ active: false, reason: lost[0] })
    failing.stop()
  })
})

describe('1.6a/typed: the typed commands', () => {
  test('retry, ack and quit, with a pull request as 12 or #12', () => {
    expect(parseCommand('quit')).toEqual({ name: 'quit' })
    expect(parseCommand('  retry #12 ')).toEqual({ name: 'retry', pr: 12 })
    expect(parseCommand('ack 7')).toEqual({ name: 'ack', pr: 7 })
    expect(parseCommand('')).toBe(null)
    for (const text of ['retry', 'retry 0', 'retry 12 13', 'ack x', 'quit now', 'stop']) {
      expect(parseCommand(text)).toEqual({ name: 'unknown', text })
    }
  })
})

describe('1.6a/state: the state file of 9.6', () => {
  test('a missing file is an empty state whose Phase 3 keys are empty', async () => {
    const { state, kept } = await loadState(join(dir, 'none', 'state.json'), NOW)
    expect(kept).toBe(null)
    expect(state).toEqual(emptyState())
    expect(state.hotspots).toEqual([])
    expect(pullRecord('a'.repeat(40), NOW.toISOString())).toMatchObject({
      pushed_by_gate: [],
      script_fixes: [],
      resolver: [],
    })
  })

  test('a key of the wrong kind falls back to its default; the others are kept', async () => {
    const file = join(dir, 'mixed.json')
    writeFileSync(
      file,
      JSON.stringify({ schema: 1, starts: 3, queue: 'broken', prs: { 4: { head_sha: 'x' } } }),
    )
    const { state } = await loadState(file, NOW)
    expect(state.starts).toBe(3)
    expect(state.queue).toEqual([])
    expect(state.prs).toEqual({ 4: { head_sha: 'x' } })
  })
})

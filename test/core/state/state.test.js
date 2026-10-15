import { afterEach, describe, expect, test } from 'vitest'
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createGit } from '../../../src/core/git/index.js'
import {
  CHECK_NAMES,
  gateDir,
  isGreen,
  isJoinComplete,
  joinLogPath,
  latestMainSeen,
  parseJson,
  promptPath,
  readCheckRecord,
  readLastStatus,
  readLocal,
  readMainSeen,
  readText,
  shipLogPath,
  statePaths,
  writeAtomic,
  writeCheckRecord,
  writeLastStatus,
  writeLocal,
  writeMainSeen,
} from '../../../src/core/state/index.js'
import { createRepoWithOrigin, createScratch } from '../git/temp-repo.js'

/** @type {Array<() => void>} */
const cleanups = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

/** A scratch directory that stands for a git common directory. */
function commonDir() {
  const scratch = createScratch()
  cleanups.push(scratch.cleanup)
  return join(scratch.dir, 'clone', '.git')
}

/** @param {string} sha */
function checkRecord(sha) {
  return {
    sha,
    branch: 'task/5-foundation-state-worktrees',
    issue: 5,
    created_at: '2026-10-12T10:00:00+02:00',
    cli_version: '0.1.0-pre.0',
    checks: [
      { name: 'scope', result: 'passed' },
      { name: 'secrets', result: 'passed' },
      { name: 'format', result: 'passed' },
      { name: 'generated', result: 'skipped' },
      { name: 'check', result: 'passed', duration_ms: 1200 },
      { name: 'acceptance', result: 'passed', duration_ms: 800 },
    ],
  }
}

describe('1.3c/state: the records under <git-common-dir>/hackwin/', () => {
  test('statePaths names every local path under the git common directory', () => {
    const dir = '/repo/.git'
    expect(statePaths(dir)).toEqual({
      root: '/repo/.git/hackwin',
      local: '/repo/.git/hackwin/local.yml',
      checks: '/repo/.git/hackwin/checks',
      sessions: '/repo/.git/hackwin/sessions',
      prompts: '/repo/.git/hackwin/prompts',
      gate: '/repo/.git/hackwin/gate',
      logs: '/repo/.git/hackwin/logs',
    })
    expect(promptPath(dir, 12)).toBe('/repo/.git/hackwin/prompts/12.md')
    expect(gateDir(dir)).toBe('/repo/.git/hackwin/gate')
    expect(() => promptPath(dir, 0)).toThrow(TypeError)
  })

  test('the logs of ship lie under the git common directory, one directory per task', () => {
    const dir = '/repo/.git'
    expect(shipLogPath(dir, 12, 'check')).toBe('/repo/.git/hackwin/logs/ship/12/check.log')
    expect(shipLogPath(dir, 12, 'acceptance')).toBe(
      '/repo/.git/hackwin/logs/ship/12/acceptance.log',
    )
    expect(shipLogPath('/repo/.git/worktrees/../', 3, 'check')).toBe(
      '/repo/.git/hackwin/logs/ship/3/check.log',
    )
    expect(() => shipLogPath(dir, 0, 'check')).toThrow(TypeError)
    expect(() => shipLogPath(dir, 12, '../check')).toThrow(TypeError)
  })

  test('the install log of join lies under the git common directory', () => {
    expect(joinLogPath('/repo/.git')).toBe('/repo/.git/hackwin/logs/join/install.log')
    expect(joinLogPath('/repo/.git/worktrees/../')).toBe('/repo/.git/hackwin/logs/join/install.log')
  })

  test('local.yml round-trips, and join is complete only with the record and the same login', async () => {
    const dir = commonDir()
    expect(await readLocal(dir)).toBeNull()

    const before = { login: 'builder1', language: 'pl', explanation_style: 'short' }
    await writeLocal(dir, before)
    const written = await readLocal(dir)
    expect(written).toEqual({ schema: 1, ...before })
    expect(isJoinComplete(written, 'builder1')).toBe(false)
    expect(readFileSync(statePaths(dir).local, 'utf8')).toMatch(/^schema: 1\n/)

    const joined = {
      ...before,
      join: { completed_at: '2026-10-12T10:00:00+02:00', cli_version: '0.1.0-pre.0' },
    }
    await writeLocal(dir, joined)
    const record = await readLocal(dir)
    expect(record).toEqual({ schema: 1, ...joined })
    expect(isJoinComplete(record, 'builder1')).toBe(true)
    expect(isJoinComplete(record, 'Builder1')).toBe(true)
    expect(isJoinComplete(record, 'lead')).toBe(false)
    expect(isJoinComplete(null, 'builder1')).toBe(false)
  })

  test('the check record round-trips and is green only for its own SHA without a failed check (E4)', async () => {
    const dir = commonDir()
    expect(await readCheckRecord(dir, SHA_A)).toBeNull()

    await writeCheckRecord(dir, checkRecord(SHA_A))
    const record = await readCheckRecord(dir, SHA_A)
    expect(record).toEqual({ schema: 1, ...checkRecord(SHA_A) })
    expect(existsSync(join(statePaths(dir).checks, `${SHA_A}.json`))).toBe(true)
    expect(isGreen(record, SHA_A)).toBe(true)
    expect(isGreen(record, SHA_B)).toBe(false)
    expect(await readCheckRecord(dir, SHA_B)).toBeNull()
    expect(isGreen(null, SHA_A)).toBe(false)

    const failed = checkRecord(SHA_B)
    failed.checks[4] = { name: 'check', result: 'failed', duration_ms: 10 }
    await expect(writeCheckRecord(dir, failed)).rejects.toThrow(/never holds a failed check: check/)
    expect(await readCheckRecord(dir, SHA_B)).toBeNull()
    expect(isGreen({ schema: 1, ...failed }, SHA_B)).toBe(false)

    await expect(writeCheckRecord(dir, { ...checkRecord(SHA_A), sha: 'abc' })).rejects.toThrow(
      TypeError,
    )
    expect(await readCheckRecord(dir, '../../x')).toBeNull()
  })

  test('a green record holds every check that ship records, each passed, generated also skipped (E4)', () => {
    expect(CHECK_NAMES).toEqual(['scope', 'secrets', 'format', 'generated', 'check', 'acceptance'])
    const green = { schema: 1, ...checkRecord(SHA_A) }
    expect(isGreen(green, SHA_A)).toBe(true)
    const withChecks = (/** @type {any[]} */ checks) => ({ ...green, checks })

    // A record that lacks one of the six checks is not green, whichever is missing.
    for (const name of CHECK_NAMES) {
      const without = withChecks(green.checks.filter((check) => check.name !== name))
      expect(isGreen(without, SHA_A), name).toBe(false)
    }
    expect(isGreen(withChecks([{ name: 'scope', result: 'passed' }]), SHA_A)).toBe(false)
    expect(isGreen(withChecks([]), SHA_A)).toBe(false)

    // Only generated may be skipped.
    const passed = green.checks.map((check) => ({ ...check, result: 'passed' }))
    expect(isGreen(withChecks(passed), SHA_A)).toBe(true)
    for (const name of CHECK_NAMES.filter((own) => own !== 'generated')) {
      const skipped = passed.map((check) =>
        check.name === name ? { ...check, result: 'skipped' } : check,
      )
      expect(isGreen(withChecks(skipped), SHA_A), name).toBe(false)
    }

    // A failed or unknown result fails, also for a check outside the six.
    const extraFailed = [...passed, { name: 'smoke', result: 'failed' }]
    expect(isGreen(withChecks(extraFailed), SHA_A)).toBe(false)
    expect(isGreen(withChecks([...passed, { name: 'smoke', result: 'passed' }]), SHA_A)).toBe(true)
    expect(isGreen(withChecks([...passed.slice(1), null]), SHA_A)).toBe(false)
  })

  test('the file helpers: an atomic write, a read that is null for a missing file, and a lenient JSON parse', async () => {
    const dir = commonDir()
    const file = join(dir, 'hackwin', 'gate', 'state.json')
    expect(await readText(file)).toBeNull()
    expect(await readText(join(dir, 'missing', 'deeper'))).toBeNull()

    await writeAtomic(file, '{"schema": 1}\n')
    expect(await readText(file)).toBe('{"schema": 1}\n')
    expect(readdirSync(join(dir, 'hackwin', 'gate'))).toEqual(['state.json'])
    await writeAtomic(file, 'replaced\n')
    expect(await readText(file)).toBe('replaced\n')
    // A file on the path of another file, and a directory, read as missing.
    expect(await readText(join(file, 'inside'))).toBeNull()
    expect(await readText(join(dir, 'hackwin'))).toBeNull()

    expect(parseJson('{"a": [1, 2]}')).toEqual({ a: [1, 2] })
    expect(parseJson('not json')).toBeNull()
    expect(parseJson('')).toBeNull()
  })

  test('the last main commit is kept per worktree, and the latest one of the clone is found', async () => {
    const dir = commonDir()
    expect(await readMainSeen(dir, '/work/app')).toBeNull()
    expect(await latestMainSeen(dir)).toBeNull()

    await writeMainSeen(dir, '/work/app', SHA_A, new Date('2026-10-12T08:00:00Z'))
    await writeMainSeen(dir, '/work/app.worktrees/7-api', SHA_B, '2026-10-12T10:30:00+02:00')
    expect(await readMainSeen(dir, '/work/app')).toEqual({
      main_sha: SHA_A,
      recorded_at: '2026-10-12T08:00:00.000Z',
    })
    expect(await readMainSeen(dir, '/work/app.worktrees/7-api/')).toEqual({
      main_sha: SHA_B,
      recorded_at: '2026-10-12T10:30:00+02:00',
    })
    // 10:30 at +02:00 is 08:30 UTC, later than 08:00 UTC.
    expect((await latestMainSeen(dir))?.main_sha).toBe(SHA_B)

    await writeMainSeen(dir, '/work/app', SHA_A, '2026-10-12T09:00:00Z')
    expect((await latestMainSeen(dir))?.main_sha).toBe(SHA_A)

    const files = readdirSync(join(statePaths(dir).sessions, 'main-seen'))
    expect(files).toHaveLength(2)
    for (const file of files) expect(file).toMatch(/^[0-9a-f]{16}\.json$/)
    await expect(writeMainSeen(dir, 'relative/path', SHA_A, new Date())).rejects.toThrow(TypeError)
  })

  test('the time of the last status call round-trips', async () => {
    const dir = commonDir()
    expect(await readLastStatus(dir)).toBeNull()
    await writeLastStatus(dir, '2026-10-12T11:00:00+02:00')
    expect(await readLastStatus(dir)).toBe('2026-10-12T11:00:00+02:00')
    expect(JSON.parse(readFileSync(join(statePaths(dir).sessions, 'status.json'), 'utf8'))).toEqual(
      { schema: 1, last_status_at: '2026-10-12T11:00:00+02:00' },
    )
  })

  test('a broken or foreign record reads as null, so the command that writes it can run again', async () => {
    const dir = commonDir()
    const paths = statePaths(dir)
    mkdirSync(paths.checks, { recursive: true })
    mkdirSync(join(paths.sessions, 'main-seen'), { recursive: true })
    writeFileSync(paths.local, 'login: [unclosed\n')
    writeFileSync(join(paths.checks, `${SHA_A}.json`), '{ not json')
    writeFileSync(join(paths.sessions, 'status.json'), JSON.stringify({ schema: 2 }))
    writeFileSync(join(paths.sessions, 'main-seen', 'broken.json'), 'null')

    expect(await readLocal(dir)).toBeNull()
    expect(await readCheckRecord(dir, SHA_A)).toBeNull()
    expect(await readLastStatus(dir)).toBeNull()
    expect(await latestMainSeen(dir)).toBeNull()

    await writeLocal(dir, { login: 'lead' })
    expect((await readLocal(dir))?.login).toBe('lead')
    // Writes leave no temporary file behind.
    expect(readdirSync(paths.root).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  test('two worktrees of one clone see the same state', async () => {
    const repo = createRepoWithOrigin()
    cleanups.push(repo.cleanup)
    const worktree = join(repo.dir, 'clone.worktrees', '5-state')
    repo.git(repo.clone, 'worktree', 'add', '--quiet', '-b', 'task/5-state', worktree)

    const inMain = await createGit({ cwd: repo.clone, env: repo.env }).commonDir()
    const inWorktree = await createGit({ cwd: worktree, env: repo.env }).commonDir()
    expect(inWorktree).toBe(inMain)

    await writeLocal(inMain, { login: 'builder1', join: { completed_at: '2026-10-12T10:00:00Z' } })
    await writeCheckRecord(inWorktree, checkRecord(SHA_A))
    await writeMainSeen(inWorktree, worktree, SHA_B, '2026-10-12T10:00:00Z')
    await writeLastStatus(inMain, '2026-10-12T11:00:00Z')

    expect(isJoinComplete(await readLocal(inWorktree), 'builder1')).toBe(true)
    expect(isGreen(await readCheckRecord(inMain, SHA_A), SHA_A)).toBe(true)
    expect((await readMainSeen(inMain, worktree))?.main_sha).toBe(SHA_B)
    expect(await readMainSeen(inMain, repo.clone)).toBeNull()
    expect((await latestMainSeen(inMain))?.main_sha).toBe(SHA_B)
    expect(await readLastStatus(inWorktree)).toBe('2026-10-12T11:00:00Z')

    // Git never sees the local state as a change.
    expect(repo.git(repo.clone, 'status', '--porcelain')).toBe('')
    expect(repo.git(worktree, 'status', '--porcelain')).toBe('')
  })
})

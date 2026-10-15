import { beforeEach, describe, expect, test, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { REPOSITORY_URL, VERSION } from '../../../src/cli/context.js'
import { loadCheckedConfig } from '../../../src/core/config/index.js'
import { createFakeClock } from '../../../src/core/runtime/clock.js'
import { accounts, createFakeGitHub, teamConfig } from '../../harness/index.js'
import { afterEdit, editCall, runClaudeHook, sessionStart } from './claude-fixture.js'
import { createHookFixture, recordGreen, runHook, writeFiles } from './hook-fixture.js'

// loadCheckedConfig as it is, watched: every hook that loads the configuration calls it.
vi.mock('../../../src/core/config/index.js', async (importOriginal) => {
  /** @type {typeof import('../../../src/core/config/index.js')} */
  const actual = await importOriginal()
  return { ...actual, loadCheckedConfig: vi.fn(actual.loadCheckedConfig) }
})
const loader = vi.mocked(loadCheckedConfig)
beforeEach(() => {
  loader.mockClear()
})

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

/** The directories of lane A that hold code (owners.yml). */
const LANE_A_DIRS = [
  'src/commands/setup',
  'src/commands/join',
  'src/internal',
  'src/generate',
  'test/commands/setup',
  'test/commands/join',
  'test/internal',
  'test/generate',
]

/**
 * builder1's worktree of task 12, in a team whose formatter always passes.
 */
async function scene() {
  const config = teamConfig(3)
  config.hackwin.commands.format = 'true'
  const hooks = await createHookFixture({
    config: { hackwin: config.hackwin, owners: config.owners },
  })
  const clone = await hooks.joinedClone('builder1')
  const task = await hooks.taskWorktree(clone, 12, 'Counter step')
  return { hooks, clone, task }
}

/**
 * The one call of loadCheckedConfig since the last check: from the worktree's git, without a
 * fetch, against the running version.
 * @param {string} cwd
 */
function expectOfflineLoad(cwd) {
  expect(loader).toHaveBeenCalledTimes(1)
  const [git, options] = loader.mock.calls[0]
  expect(git.cwd).toBe(cwd)
  expect(options).toEqual({
    fetch: false,
    running: VERSION,
    repositoryUrl: REPOSITORY_URL,
    out: expect.anything(),
  })
  loader.mockClear()
}

/**
 * The module specifiers that a source file imports, JSDoc imports included.
 * @param {string} text
 * @returns {string[]}
 */
function specifiersOf(text) {
  return [...text.matchAll(/(?:\bfrom\s+|\bimport\(\s*)['"]([^'"]+)['"]/g)].map((match) => match[1])
}

describe('1.4h/hooks-config: the hooks load the configuration through loadCheckedConfig', () => {
  test('the git hooks load it offline from the local origin/main', async () => {
    const { hooks, task } = await scene()
    const file = 'src/features/counter/step.js'
    writeFiles(task.path, { [file]: 'export const step = 1\n' })
    await task.git.run(['add', file])

    const committed = await runHook('pre-commit', { cwd: task.path, env: hooks.env })
    expect(committed.code).toBe(0)
    expectOfflineLoad(task.path)

    await task.git.run(['commit', '--quiet', '--no-verify', '-m', 'Add the step'])
    const sha = await task.git.revParse('HEAD')
    await recordGreen(task, sha)
    const ref = `refs/heads/${task.branch}`
    const pushed = await runHook('pre-push', {
      cwd: task.path,
      env: hooks.env,
      args: ['origin', 'origin'],
      stdin: `${ref} ${sha} ${ref} ${'0'.repeat(40)}\n`,
    })
    expect(pushed.code).toBe(0)
    expectOfflineLoad(task.path)
  })

  test('the Claude Code hooks load it offline from the local origin/main, SessionStart after its own fetch', async () => {
    const { hooks, task } = await scene()
    const file = join(task.path, 'src/features/counter/step.js')
    writeFiles(task.path, { 'src/features/counter/step.js': 'export const step = 1\n' })
    const run = (/** @type {string} */ hook, /** @type {unknown} */ event) =>
      runClaudeHook(hook, { cwd: task.path, env: hooks.env, event })

    const before = await run('pre-tool-use', editCall(task.path, file))
    expect(before).toMatchObject({ code: 0, output: null })
    expectOfflineLoad(task.path)

    const after = await run('post-tool-use', afterEdit(task.path, 'Edit', file))
    expect(after).toMatchObject({ code: 0, stdout: '' })
    expectOfflineLoad(task.path)

    const started = await runClaudeHook('session-start', {
      cwd: task.path,
      env: hooks.env,
      event: sessionStart(task.path),
      fake: createFakeGitHub({
        issues: [{ number: 12, title: 'Counter step', labels: ['in-progress'] }],
      }),
      login: accounts.builder1.login,
      clock: createFakeClock('2026-10-20T10:00:00.000Z'),
    })
    expect(started.code).toBe(0)
    expectOfflineLoad(task.path)
  })

  test('every file of lane A imports src/core/config through its index only', () => {
    /** @type {string[]} */
    const imports = []
    for (const dir of LANE_A_DIRS) {
      /** @type {string[]} */
      let files
      try {
        files = readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' })
      } catch (error) {
        if (error.code === 'ENOENT') continue
        throw error
      }
      for (const file of files.filter((name) => name.endsWith('.js'))) {
        const path = join(dir, file)
        for (const specifier of specifiersOf(readFileSync(join(ROOT, path), 'utf8'))) {
          if (specifier.includes('/core/config/')) imports.push(`${path}: ${specifier}`)
        }
      }
    }

    expect(imports).toContain('src/internal/hook/config.js: ../../core/config/index.js')
    expect(imports.filter((entry) => !entry.endsWith('/core/config/index.js'))).toEqual([])
  })
})

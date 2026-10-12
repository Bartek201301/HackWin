import { describe, expect, test } from 'vitest'
import { chmodSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import semver from 'semver'
import { VERSION } from '../../../src/cli/context.js'
import { exec } from '../../../src/core/runtime/exec.js'
import { selfTestHooks } from '../../../src/internal/hook/self-test.js'
import { createHookFixture, pinnedConfig, runHook } from './hook-fixture.js'

/**
 * A PATH on which `git` and `sh` are found but no `hackwin`, even when one is installed on this
 * machine: the git of the tests, linked into an empty directory, then /bin and /usr/bin.
 * @param {string} dir
 */
async function pathWithoutHackwin(dir) {
  const which = await exec('sh', ['-c', 'command -v git'])
  const bin = join(dir, 'git-only')
  mkdirSync(bin)
  symlinkSync(which.stdout.trim(), join(bin, 'git'))
  return [bin, '/bin', '/usr/bin'].join(delimiter)
}

describe('1.4a/self-test: the self test of the active git hooks, for join', () => {
  test('in a joined clone every check passes and names the running version, also on the default branch', async () => {
    const hooks = await createHookFixture()
    const clone = await hooks.joinedClone('builder1')
    expect(await clone.git.currentBranch()).toBe('main')

    expect(await selfTestHooks(clone.git)).toEqual({
      ok: true,
      checks: [
        { name: 'core.hooksPath', ok: true, detail: 'core.hooksPath is .githooks' },
        { name: 'pre-commit', ok: true, detail: `.githooks/pre-commit runs hackwin ${VERSION}` },
        { name: 'pre-push', ok: true, detail: `.githooks/pre-push runs hackwin ${VERSION}` },
      ],
    })
  })

  test('in self test mode a hook names itself and still checks: on main the pre-commit hook blocks', async () => {
    const hooks = await createHookFixture()
    const clone = await hooks.joinedClone('builder1')
    const env = { ...hooks.env, HACKWIN_HOOK_SELF_TEST: '1' }

    const preCommit = await runHook('pre-commit', { cwd: clone.path, env })
    expect(preCommit.code).toBe(1)
    expect(preCommit.json.error.rule).toBe('E18: no fix is committed directly on main')
    expect(preCommit.stderr).toContain(
      `hackwin internal hook pre-commit: self test, hackwin ${VERSION}`,
    )

    const prePush = await runHook('pre-push', { cwd: clone.path, env })
    expect(prePush.code).toBe(0)
    expect(prePush.stderr).toContain(
      `hackwin internal hook pre-push: self test, hackwin ${VERSION}`,
    )
  })

  test('a hook that runs but cannot apply its rules, here a CLI older than the pin, fails the self test', async () => {
    const running = semver.parse(VERSION)
    const newer = `${running?.major}.${running?.minor}.${(running?.patch ?? 0) + 1}`
    const hooks = await createHookFixture({ config: pinnedConfig(newer) })
    const clone = await hooks.joinedClone('builder1')

    const result = await selfTestHooks(clone.git)

    expect(result.ok).toBe(false)
    expect(result.checks[1]).toEqual({
      name: 'pre-commit',
      ok: false,
      detail: `.githooks/pre-commit runs hackwin ${VERSION}, which exits 2: hackwin ${VERSION} is older than ${newer}, the version pinned in hackwin.yml on origin/main`,
      resolve: { command: 'git hook run pre-commit', dir: clone.path },
    })
  })

  test('without core.hooksPath the self test fails and names the setting', async () => {
    const hooks = await createHookFixture()
    const { path } = await hooks.fixture.clone('not-joined')

    const result = await selfTestHooks(hooks.gitAt(path))

    expect(result.ok).toBe(false)
    expect(result.checks[0]).toEqual({
      name: 'core.hooksPath',
      ok: false,
      detail: 'core.hooksPath is not set',
      resolve: { command: 'git config core.hooksPath .githooks', dir: path },
    })
    expect(result.checks[1]).toMatchObject({ name: 'pre-commit', ok: false })
  })

  test('a shim that cannot find hackwin on the PATH fails and says so', async () => {
    const hooks = await createHookFixture()
    const clone = await hooks.joinedClone('builder1')
    const env = { ...hooks.env, PATH: await pathWithoutHackwin(hooks.fixture.dir) }

    const result = await selfTestHooks(clone.git.with({ env }))

    expect(result.ok).toBe(false)
    expect(result.checks.slice(1)).toEqual(
      ['pre-commit', 'pre-push'].map((hook) => ({
        name: hook,
        ok: false,
        detail: `.githooks/${hook} cannot run hackwin: the command is not on the PATH`,
        resolve:
          'install hackwin so that the `hackwin` command is on the PATH of the shell that runs git',
      })),
    )
  })

  test('a missing or non-executable shim fails and names the file', async () => {
    const hooks = await createHookFixture()
    const clone = await hooks.joinedClone('builder1')
    chmodSync(join(clone.path, '.githooks/pre-commit'), 0o644)
    rmSync(join(clone.path, '.githooks/pre-push'))

    const result = await selfTestHooks(clone.git)

    expect(result.ok).toBe(false)
    expect(result.checks[1]).toEqual({
      name: 'pre-commit',
      ok: false,
      detail: '.githooks/pre-commit is not executable',
      resolve: { command: 'chmod +x .githooks/pre-commit', dir: clone.path },
    })
    expect(result.checks[2]).toMatchObject({
      name: 'pre-push',
      ok: false,
      detail: '.githooks/pre-push is missing',
    })
  })
})

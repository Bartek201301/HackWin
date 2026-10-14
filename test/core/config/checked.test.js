import { afterEach, describe, expect, test } from 'vitest'
import * as config from '../../../src/core/config/index.js'
import * as checked from '../../../src/core/config/checked.js'
import * as glob from '../../../src/core/config/glob.js'
import * as load from '../../../src/core/config/load.js'
import * as ownership from '../../../src/core/config/ownership.js'
import { createGit } from '../../../src/core/git/index.js'
import { createOutput } from '../../../src/core/runtime/output.js'
import { ConfigError, PreconditionError } from '../../../src/core/runtime/errors.js'
import { createConfiguredRepo, hackwinObject, ownersObject, yaml } from './fixtures.js'

const {
  HACKWIN_FILE,
  OWNERS_FILE,
  createMatcher,
  holderOf,
  loadCheckedConfig,
  mainRef,
  parseHackwinConfig,
  parseOwners,
  pinnedVersionOf,
  samplePath,
} = config

const REPOSITORY_URL = 'git+https://github.com/Bartek201301/HackWin.git'

/** @type {Array<() => void>} */
const cleanups = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

/**
 * A configured repository whose hackwin.yml pins `pinned`, and a Git for its main checkout.
 * @param {{ pinned?: string, hackwin?: Record<string, unknown> }} [options]
 */
function configuredRepo({ pinned = '0.1.2', hackwin = {} } = {}) {
  const repo = createConfiguredRepo({
    hackwin: { ...hackwinObject(), cli_version: pinned, ...hackwin },
  })
  cleanups.push(repo.cleanup)
  return { repo, git: createGit({ cwd: repo.clone, env: repo.env }) }
}

/** An Output that keeps what it prints. */
function output() {
  let err = ''
  const out = createOutput({
    stdout: { write: () => true },
    stderr: { write: (text) => ((err += text), true) },
  })
  return { out, stderr: () => err }
}

describe('1.3b/config-exports: what src/core/config/index.js exports for the runner, the hooks and the lanes', () => {
  test('the glob functions, holderOf, the checked loader, mainRef and the names of load.js are exported', () => {
    expect(config.createMatcher).toBe(glob.createMatcher)
    expect(config.samplePath).toBe(glob.samplePath)
    expect(config.holderOf).toBe(ownership.holderOf)
    expect(config.loadCheckedConfig).toBe(checked.loadCheckedConfig)
    expect(config.mainRef).toBe(checked.mainRef)
    expect(config.enforceVersion).toBe(checked.enforceVersion)
    expect(config.pinnedVersionOf).toBe(load.pinnedVersionOf)
    expect(HACKWIN_FILE).toBe('hackwin.yml')
    expect(OWNERS_FILE).toBe('owners.yml')
  })

  test('the exported functions behave as their modules define them', () => {
    const matches = createMatcher(['src/features/web/**', 'README.md'])
    expect(matches('src/features/web/form.js')).toBe(true)
    expect(matches('src/features/api/route.js')).toBe(false)
    expect(samplePath({ inside: ['src/**'], alsoInside: ['src/features/web/**'] })).toMatch(
      /^src\/features\/web/,
    )
    expect(samplePath({ inside: ['src/features/**'], outside: ['src/**'] })).toBeNull()

    const parsed = {
      hackwin: parseHackwinConfig(yaml(hackwinObject())),
      owners: parseOwners(yaml(ownersObject())),
    }
    expect(holderOf(parsed, 'web')).toBe('builder-one')
    expect(holderOf(parsed, 'shared')).toBe('lead')
    expect(holderOf(parsed, 'nobody')).toBeNull()

    expect(pinnedVersionOf('cli_version: 0.1.2\n')).toBe('0.1.2')
    expect(pinnedVersionOf('cli_version: [\n')).toBeNull()
  })

  test('mainRef is what origin/HEAD points to, or origin/main', async () => {
    const { repo, git } = configuredRepo()
    // A clone of an empty origin has no origin/HEAD.
    expect(await mainRef(git)).toBe('origin/main')
    repo.git(repo.clone, 'push', '--quiet', 'origin', 'main:trunk')
    repo.git(repo.clone, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk')
    expect(await mainRef(git)).toBe('origin/trunk')
    repo.git(repo.clone, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD')
    expect(await mainRef(git)).toBe('origin/main')
  })

  test('loadCheckedConfig loads the configuration of the default branch after the version check', async () => {
    const { repo, git } = configuredRepo({ pinned: '0.1.2' })

    const same = output()
    const loaded = await loadCheckedConfig(git, {
      running: '0.1.2',
      repositoryUrl: REPOSITORY_URL,
      out: same.out,
    })
    expect(loaded).toMatchObject({ ref: 'origin/main', hackwin: { cli_version: '0.1.2' } })
    expect(same.out.warnings).toEqual([])

    const newer = output()
    await loadCheckedConfig(git, {
      running: '0.1.3',
      repositoryUrl: REPOSITORY_URL,
      out: newer.out,
    })
    expect(newer.out.warnings).toEqual([
      'hackwin 0.1.3 is newer than 0.1.2, the version pinned in hackwin.yml; continuing',
    ])

    for (const [running, message] of [
      ['0.1.1', 'hackwin 0.1.1 is older than 0.1.2'],
      ['0.2.0', 'hackwin 0.2.0 is a release of phase 0.2, but this project is on phase 0.1'],
    ]) {
      const error = await loadCheckedConfig(git, {
        running,
        repositoryUrl: REPOSITORY_URL,
        out: null,
      }).catch((caught) => caught)
      expect(error).toBeInstanceOf(PreconditionError)
      expect(error.message).toContain(message)
      expect(error.resolve).toEqual({
        command: 'npm install -g hackwin@0.1.2',
        dir: 'any directory',
      })
    }

    // Without a fetch it reads the ref as the clone has it, as a hook does.
    repo.publish({ 'hackwin.yml': yaml({ ...hackwinObject(), cli_version: '0.1.4' }) })
    const offline = await loadCheckedConfig(git, {
      fetch: false,
      running: '0.1.2',
      repositoryUrl: REPOSITORY_URL,
      out: null,
    })
    expect(offline.hackwin.cli_version).toBe('0.1.2')
    const online = await loadCheckedConfig(git, {
      running: '0.1.4',
      repositoryUrl: REPOSITORY_URL,
      out: null,
    })
    expect(online.hackwin.cli_version).toBe('0.1.4')
  })

  test('an invalid configuration of another phase names the version to install, not the key', async () => {
    const { git } = configuredRepo({ pinned: '0.2.0', hackwin: { phase_two_key: true } })
    const error = await loadCheckedConfig(git, {
      running: '0.1.2',
      repositoryUrl: REPOSITORY_URL,
      out: null,
    }).catch((caught) => caught)
    expect(error).toBeInstanceOf(PreconditionError)
    expect(error.resolve.command).toBe('npm install -g hackwin@0.2.0')

    const samePhase = configuredRepo({ pinned: '0.1.0', hackwin: { phase_two_key: true } })
    const configError = await loadCheckedConfig(samePhase.git, {
      running: '0.1.2',
      repositoryUrl: REPOSITORY_URL,
      out: null,
    }).catch((caught) => caught)
    expect(configError).toBeInstanceOf(ConfigError)
    expect(configError.key).toBe('phase_two_key')
  })

  test('the fetch of the configuration prunes: a branch deleted on origin leaves no remote-tracking ref (CM9)', async () => {
    const { repo, git } = configuredRepo()
    repo.git(repo.publisher, 'push', '--quiet', 'origin', 'main:task/5-stale')
    await git.fetch({ remote: 'origin' })
    expect(await git.tryRevParse('refs/remotes/origin/task/5-stale')).not.toBeNull()
    repo.git(repo.publisher, 'push', '--quiet', 'origin', '--delete', 'task/5-stale')

    // Without a fetch the stale ref stays; the fetch of the loader removes it.
    await loadCheckedConfig(git, {
      fetch: false,
      running: '0.1.2',
      repositoryUrl: REPOSITORY_URL,
      out: null,
    })
    expect(await git.tryRevParse('refs/remotes/origin/task/5-stale')).not.toBeNull()
    await loadCheckedConfig(git, { running: '0.1.2', repositoryUrl: REPOSITORY_URL, out: null })
    expect(await git.tryRevParse('refs/remotes/origin/task/5-stale')).toBeNull()

    repo.git(repo.publisher, 'push', '--quiet', 'origin', 'main:task/6-stale')
    await git.fetch({ remote: 'origin' })
    repo.git(repo.publisher, 'push', '--quiet', 'origin', '--delete', 'task/6-stale')
    await config.loadConfig(git)
    expect(await git.tryRevParse('refs/remotes/origin/task/6-stale')).toBeNull()
  })
})

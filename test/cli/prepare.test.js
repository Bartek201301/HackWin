import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import semver from 'semver'
import { enforceVersion, main } from '../../src/cli/main.js'
import { VERSION } from '../../src/cli/context.js'
import { createOutput } from '../../src/core/runtime/output.js'
import { PreconditionError } from '../../src/core/runtime/errors.js'
import { createScratch } from '../core/git/temp-repo.js'
import {
  createConfiguredRepo,
  fakeGh,
  hackwinObject,
  ownersObject,
  sink,
  yaml,
} from '../core/config/fixtures.js'

// Stand-in command modules: each prints what the runner prepared.
const reportModule = `
export async function run(ctx) {
  return {
    lines: ['ran'],
    data: {
      configured: ctx.config !== undefined,
      sha: ctx.config?.sha ?? null,
      identity: ctx.identity ? { login: ctx.identity.login, roles: ctx.identity.roles, isLead: ctx.identity.isLead } : null,
    },
  }
}
`

/** @type {ReturnType<typeof createScratch>} */
let modules

beforeAll(() => {
  modules = createScratch()
  for (const command of ['status', 'setup', 'take']) {
    modules.write(join(modules.dir, `src/commands/${command}/index.js`), reportModule)
  }
  modules.write(join(modules.dir, 'src/internal/hook/pre-commit.js'), reportModule)
})

afterAll(() => {
  modules.cleanup()
})

/**
 * Run hackwin in-process.
 * @param {{ clone: string, env: Record<string, string | undefined> }} repo
 * @param {string[]} argv
 * @param {{ login?: string, cwd?: string }} [options]
 */
async function run(repo, argv, { login = 'lead', cwd = repo.clone } = {}) {
  const stdout = sink()
  const stderr = sink()
  const code = await main(argv, {
    cwd,
    env: repo.env,
    stdin: Readable.from([]),
    stdout,
    stderr,
    moduleRoot: modules.dir,
    ghExecutor: fakeGh(login),
  })
  return { code, stdout: stdout.text, stderr: stderr.text }
}

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
const clone = (value) => structuredClone(value)

describe('AC4/validation: a hackwin.yml that breaks a rule of 6.1 makes a command exit 2 and name the key', () => {
  /** @type {ReturnType<typeof createConfiguredRepo>} */
  let repo
  beforeAll(() => {
    repo = createConfiguredRepo()
  })
  afterAll(() => repo.cleanup())

  /** @type {Array<[string, string, (hackwin: any, owners: any) => void]>} */
  const fixtures = [
    [
      'team.members has 1 to 4 entries',
      'team.members',
      (hackwin) => {
        for (const n of [3, 4]) {
          hackwin.team.members.push({
            name: `Extra ${n}`,
            github: `extra-${n}`,
            roles: [],
            agent: 'claude',
            sessions: 1,
          })
        }
        hackwin.team.members[3].roles = ['web']
        hackwin.team.members[4].roles = ['api']
      },
    ],
    [
      'exactly one member equals team.lead',
      'team.lead',
      (hackwin) => {
        hackwin.team.lead = 'somebody-else'
      },
    ],
    [
      'every role of owners.yml is held by exactly one member',
      'team.members[2].roles',
      (hackwin) => {
        hackwin.team.members[2].roles = ['web']
      },
    ],
    [
      'every role a member lists exists',
      'team.members[1].roles',
      (hackwin) => {
        hackwin.team.members[1].roles = ['web', 'mobile']
      },
    ],
    [
      'the shared role is held by the Lead',
      'team.members[1].roles',
      (hackwin) => {
        hackwin.team.members[0].roles = ['web']
        hackwin.team.members[1].roles = ['shared']
      },
    ],
    [
      "the Lead's agent is claude",
      'team.members[0].agent',
      (hackwin) => {
        hackwin.team.members[0].agent = 'codex'
      },
    ],
    [
      'with one member, that member holds every role',
      'team.members[0].roles',
      (hackwin) => {
        hackwin.team.members = [hackwin.team.members[0]]
        hackwin.team.members[0].roles = ['shared', 'web']
      },
    ],
    [
      'sessions is 1, 2 or 3',
      'team.members[1].sessions',
      (hackwin) => {
        hackwin.team.members[1].sessions = 4
      },
    ],
    [
      'the required commands are non-empty',
      'commands.lockfile_regen',
      (hackwin) => {
        hackwin.commands.lockfile_regen = ''
      },
    ],
    [
      'every path group glob resolves to the shared role',
      'paths.manifests[1]',
      (hackwin) => {
        hackwin.paths.manifests.push('src/features/web/package.json')
      },
    ],
    [
      'paths.manifests is not empty',
      'paths.manifests',
      (hackwin) => {
        hackwin.paths.manifests = []
      },
    ],
    [
      'resolver.model is set when resolver.enabled is true',
      'resolver.model',
      (hackwin) => {
        hackwin.resolver.enabled = true
      },
    ],
    [
      'gate.status_issue_seconds is smaller than gate.heartbeat_stale_seconds',
      'gate.status_issue_seconds',
      (hackwin) => {
        hackwin.gate.status_issue_seconds = 300
      },
    ],
  ]

  for (const [rule, key, breakRule] of fixtures) {
    test(`${rule}: exit 2 naming ${key}`, async () => {
      const hackwin = clone(hackwinObject())
      const owners = clone(ownersObject())
      breakRule(hackwin, owners)
      repo.publish({ 'hackwin.yml': yaml(hackwin), 'owners.yml': yaml(owners) }, rule)
      const result = await run(repo, ['status'])
      expect(result.code).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr).toMatch(/^hackwin status: hackwin\.yml: /)
      expect(result.stderr).toContain(`\n  key: ${key}\n`)
      const json = JSON.parse((await run(repo, ['status', '--json'])).stdout)
      expect(json).toMatchObject({ ok: false, exitCode: 2, error: { kind: 'config', key } })
    })
  }

  test('an owners.yml with overlapping globs is rejected by the validator', async () => {
    const owners = clone(ownersObject())
    owners.roles.api.paths = ['src/features/**']
    repo.publish({ 'hackwin.yml': yaml(hackwinObject()), 'owners.yml': yaml(owners) })
    const result = await run(repo, ['status'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('overlaps roles.web.paths[0] (src/features/web/**)')
    expect(result.stderr).toContain('\n  key: roles.api.paths[0]\n')
  })

  test('a valid configuration lets the command run', async () => {
    repo.publish({ 'hackwin.yml': yaml(hackwinObject()), 'owners.yml': yaml(ownersObject()) })
    const result = await run(repo, ['status'])
    expect(result).toMatchObject({ code: 0, stdout: 'ran\n' })
  })
})

describe('1.3b/identity: the caller is matched to the team by the gh login', () => {
  /** @type {ReturnType<typeof createConfiguredRepo>} */
  let repo
  beforeAll(() => {
    repo = createConfiguredRepo()
  })
  afterAll(() => repo.cleanup())

  test('a login outside the team exits 2 with the message of 7.2', async () => {
    const result = await run(repo, ['status'], { login: 'stranger' })
    expect(result.code).toBe(2)
    expect(result.stderr).toBe(
      [
        'hackwin status: the gh login stranger is not a member of the team in hackwin.yml',
        '  to resolve: ask the Lead to add you to `hackwin.yml`',
        '',
      ].join('\n'),
    )
  })

  test('a member gets the configuration and the identity, case of the login aside', async () => {
    const result = await run(repo, ['status', '--json'], { login: 'Builder-One' })
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout).data).toEqual({
      configured: true,
      sha: repo.git(repo.origin, 'rev-parse', 'main').trim(),
      identity: { login: 'Builder-One', roles: ['web'], isLead: false },
    })
    const lead = JSON.parse((await run(repo, ['status', '--json'])).stdout).data
    expect(lead.identity).toEqual({ login: 'lead', roles: ['shared'], isLead: true })
  })

  test('plumbing commands run without the configuration and without gh', async () => {
    const result = await run(repo, ['internal', 'hook', 'pre-commit', '--json'], {
      login: 'stranger',
    })
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout).data).toEqual({ configured: false, sha: null, identity: null })
  })
})

describe('1.3b/version: the running CLI against cli_version on origin/main (CM12)', () => {
  const repoUrl = 'git+https://github.com/Bartek201301/HackWin.git'
  const out = () => createOutput({ stdout: sink(), stderr: sink() })

  /**
   * @param {string} running
   * @param {string} pinned
   */
  function versionError(running, pinned) {
    try {
      enforceVersion({ running, pinned, out: out(), repositoryUrl: repoUrl })
    } catch (error) {
      return error
    }
    return null
  }

  test('0.1.0-pre.2 against a pinned 0.1.1-pre.2 exits 2 with the URL install command of 0.1.1-pre.2', () => {
    const error = versionError('0.1.0-pre.2', '0.1.1-pre.2')
    expect(error).toBeInstanceOf(PreconditionError)
    expect(error.exitCode).toBe(2)
    expect(error.resolve).toEqual({
      command:
        'npm install -g https://github.com/Bartek201301/HackWin/releases/download/v0.1.1-pre.2/hackwin-0.1.1-pre.2.tgz',
      dir: 'any directory',
    })
  })

  test('0.2.0-pre.2 against a pinned 0.1.0-pre.2 exits 2: another phase', () => {
    const error = versionError('0.2.0-pre.2', '0.1.0-pre.2')
    expect(error).toBeInstanceOf(PreconditionError)
    expect(error.message).toContain('phase 0.2')
    expect(error.message).toContain('phase 0.1')
    expect(error.resolve.command).toBe(
      'npm install -g https://github.com/Bartek201301/HackWin/releases/download/v0.1.0-pre.2/hackwin-0.1.0-pre.2.tgz',
    )
  })

  test('an older release exits 2 with npm install -g hackwin@<pinned>', () => {
    const error = versionError('0.1.0', '0.1.2')
    expect(error.resolve.command).toBe('npm install -g hackwin@0.1.2')
    expect(versionError('0.1.9', '0.2.0').resolve.command).toBe('npm install -g hackwin@0.2.0')
  })

  test('a newer patch warns once and continues; the same version is silent', () => {
    const output = out()
    expect(enforceVersion({ running: '0.1.2', pinned: '0.1.1', out: output })).toBe('newer-patch')
    expect(output.warnings).toEqual([
      'hackwin 0.1.2 is newer than 0.1.1, the version pinned in hackwin.yml; continuing',
    ])
    const same = out()
    expect(enforceVersion({ running: '0.1.1', pinned: '0.1.1', out: same })).toBe('same')
    expect(same.warnings).toEqual([])
  })

  describe('through a command', () => {
    /** @type {ReturnType<typeof createConfiguredRepo>} */
    let repo
    beforeAll(() => {
      repo = createConfiguredRepo()
    })
    afterAll(() => repo.cleanup())

    /** @param {string} pinned */
    async function runPinned(pinned) {
      repo.publish({ 'hackwin.yml': yaml({ ...hackwinObject(), cli_version: pinned }) })
      return run(repo, ['status'])
    }

    test('a pinned version newer than the running CLI exits 2 with its install command', async () => {
      const pinned = /** @type {string} */ (semver.inc(VERSION, 'patch'))
      const result = await runPinned(pinned)
      expect(result.code).toBe(2)
      expect(result.stderr).toContain(`hackwin ${VERSION} is older than ${pinned}`)
      expect(result.stderr).toContain(`run \`npm install -g hackwin@${pinned}\` in any directory`)
    })

    test('a pinned version of another phase exits 2', async () => {
      const parsed = /** @type {semver.SemVer} */ (semver.parse(VERSION))
      const pinned = `${parsed.major}.${parsed.minor + 1}.0`
      const result = await runPinned(pinned)
      expect(result.code).toBe(2)
      expect(result.stderr).toContain(
        `but this project is on phase ${parsed.major}.${parsed.minor + 1}`,
      )
    })

    test('a pinned version older in the same phase warns and the command runs', async () => {
      const parsed = /** @type {semver.SemVer} */ (semver.parse(VERSION))
      const pinned = `${parsed.major}.${parsed.minor}.0-0`
      const result = await runPinned(pinned)
      expect(result.code).toBe(0)
      expect(result.stdout).toBe('ran\n')
      expect(result.stderr).toBe(
        `warning: hackwin ${VERSION} is newer than ${pinned}, the version pinned in hackwin.yml; continuing\n`,
      )
    })

    test('another phase is reported before keys this CLI does not know', async () => {
      const parsed = /** @type {semver.SemVer} */ (semver.parse(VERSION))
      const pinned = `${parsed.major}.${parsed.minor + 1}.0`
      repo.publish({
        'hackwin.yml': yaml({ ...hackwinObject(), cli_version: pinned, planner: { model: 'x' } }),
      })
      const result = await run(repo, ['status'])
      expect(result.code).toBe(2)
      expect(result.stderr).toContain(
        `but this project is on phase ${parsed.major}.${parsed.minor + 1}`,
      )
      expect(result.stderr).not.toContain('planner')
    })
  })
})

describe('1.3b/fast-forward: the main checkout follows origin/main (CM10)', () => {
  /** @type {ReturnType<typeof createConfiguredRepo>} */
  let repo
  beforeAll(() => {
    repo = createConfiguredRepo()
  })
  afterAll(() => repo.cleanup())

  const head = () => repo.git(repo.clone, 'rev-parse', 'HEAD').trim()

  test('a clean main checkout on the default branch is fast-forwarded', async () => {
    const published = repo.publish({ 'docs/notes.md': 'notes\n' })
    expect(head()).not.toBe(published)
    const result = await run(repo, ['status'])
    expect(result).toEqual({ code: 0, stdout: 'ran\n', stderr: '' })
    expect(head()).toBe(published)
    expect(readFileSync(join(repo.clone, 'docs/notes.md'), 'utf8')).toBe('notes\n')
  })

  test('a main checkout with local changes gets a warning and stays unchanged', async () => {
    const before = head()
    writeFileSync(join(repo.clone, 'README.md'), 'local change\n')
    repo.publish({ 'docs/more.md': 'more\n' })
    const result = await run(repo, ['status'])
    expect(result.code).toBe(0)
    expect(result.stderr).toBe(
      `warning: the main checkout is behind origin/main and was not fast-forwarded, because it has local changes or is not on main; to update it, run \`git merge --ff-only origin/main\` in ${repo.clone}\n`,
    )
    expect(head()).toBe(before)
    expect(readFileSync(join(repo.clone, 'README.md'), 'utf8')).toBe('local change\n')
    repo.git(repo.clone, 'checkout', '--', 'README.md')
  })

  test('a task worktree is never touched', async () => {
    const worktree = join(repo.dir, 'clone.worktrees', '7-some-task')
    repo.git(repo.clone, 'worktree', 'add', '--quiet', '-b', 'task/7-some-task', worktree, 'HEAD')
    const before = repo.git(worktree, 'rev-parse', 'HEAD').trim()
    repo.publish({ 'docs/third.md': 'third\n' })
    const result = await run(repo, ['take', '7'], { cwd: worktree })
    expect(result).toEqual({ code: 0, stdout: 'ran\n', stderr: '' })
    expect(repo.git(worktree, 'rev-parse', 'HEAD').trim()).toBe(before)
  })
})

describe('1.3b/setup: setup on an unconfigured repository skips the preparation', () => {
  test('without hackwin.yml on origin/main setup runs without configuration or identity', async () => {
    const repo = createConfiguredRepo()
    try {
      repo.git(repo.publisher, 'pull', '--quiet', '--ff-only', 'origin', 'main')
      repo.git(repo.publisher, 'rm', '--quiet', 'hackwin.yml', 'owners.yml')
      repo.git(repo.publisher, 'commit', '--quiet', '-m', 'unconfigure')
      repo.git(repo.publisher, 'push', '--quiet', 'origin', 'main')
      const setup = await run(repo, ['setup', '--json'], { login: 'stranger' })
      expect(setup.code).toBe(0)
      expect(JSON.parse(setup.stdout).data).toEqual({
        configured: false,
        sha: null,
        identity: null,
      })
      const status = await run(repo, ['status'])
      expect(status.code).toBe(2)
      expect(status.stderr).toBe(
        [
          'hackwin status: not configured: hackwin.yml is missing on origin/main',
          `  to resolve: run \`hackwin setup\` in ${repo.clone}`,
          '',
        ].join('\n'),
      )
    } finally {
      repo.cleanup()
    }
  })

  test('on a configured repository setup gets the configuration like every command', async () => {
    const repo = createConfiguredRepo()
    try {
      const setup = await run(repo, ['setup', '--json'])
      expect(JSON.parse(setup.stdout).data.configured).toBe(true)
    } finally {
      repo.cleanup()
    }
  })
})

import { afterEach, describe, expect, test } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import picomatch from 'picomatch'
import {
  checkVersion,
  fastForwardMainCheckout,
  installCommand,
  loadConfig,
  loadProposedConfig,
  ownerOf,
  parseHackwinConfig,
  parseOwners,
  resolveIdentity,
  rolesOf,
  scopeCheck,
  validateConfig,
} from '../../../src/core/config/index.js'
import { expandBraces, globError, samplePath } from '../../../src/core/config/glob.js'
import { createGit } from '../../../src/core/git/index.js'
import { ConfigError, PreconditionError } from '../../../src/core/runtime/errors.js'
import { createConfiguredRepo, hackwinObject, ownersObject, yaml } from './fixtures.js'

/** @type {Array<() => void>} */
const cleanups = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

const config = {
  hackwin: parseHackwinConfig(yaml(hackwinObject())),
  owners: parseOwners(yaml(ownersObject())),
}

/**
 * The ConfigError a function throws.
 * @param {() => unknown} fn
 * @returns {ConfigError}
 */
function configErrorOf(fn) {
  try {
    fn()
  } catch (error) {
    if (error instanceof ConfigError) return error
    throw error
  }
  throw new Error('no ConfigError was thrown')
}

describe('1.3b/owners: ownership and the scope check', () => {
  test('a path without a role belongs to the shared role and its holder', () => {
    expect(ownerOf(config, 'package.json')).toEqual({ role: 'shared', holder: 'lead', open: false })
    expect(ownerOf(config, 'src/other/x.js')).toEqual({
      role: 'shared',
      holder: 'lead',
      open: false,
    })
    expect(ownerOf(config, 'src/features/web/form.js')).toEqual({
      role: 'web',
      holder: 'builder-one',
      open: false,
    })
    expect(ownerOf(config, './src/features/api/.gitkeep')).toEqual({
      role: 'api',
      holder: 'builder-two',
      open: false,
    })
    expect(ownerOf(config, 'README.md')).toEqual({ role: 'shared', holder: 'lead', open: true })
  })

  test('the scope check lists each violation with its role and holder; open paths are in everyone scope', () => {
    const result = scopeCheck(config, {
      login: 'builder-one',
      files: ['src/features/web/form.js', 'README.md', 'src/features/api/route.js', 'package.json'],
    })
    expect(result).toEqual({
      violations: [
        { path: 'src/features/api/route.js', role: 'api', holder: 'builder-two' },
        { path: 'package.json', role: 'shared', holder: 'lead' },
      ],
      outsideTask: [],
    })
    expect(
      scopeCheck(config, { login: 'lead', files: ['README.md', 'docs/a.md'] }).violations,
    ).toEqual([])
    expect(scopeCheck(config, { login: 'BUILDER-TWO', files: ['src/features/api/a.js'] })).toEqual({
      violations: [],
      outsideTask: [],
    })
  })

  test('a login outside the team holds no role, so every owned path is a violation', () => {
    expect(rolesOf(config, 'stranger')).toEqual([])
    const result = scopeCheck(config, {
      login: 'stranger',
      files: ['src/features/web/a.js', 'README.md'],
    })
    expect(result.violations).toEqual([
      { path: 'src/features/web/a.js', role: 'web', holder: 'builder-one' },
    ])
  })

  test('files inside the role but outside the task paths are a warning only (A15)', () => {
    const result = scopeCheck(config, {
      login: 'builder-one',
      files: ['src/features/web/form.js', 'src/features/web/other.js', 'src/features/api/x.js'],
      taskPaths: ['src/features/web/form.js'],
    })
    expect(result).toEqual({
      violations: [{ path: 'src/features/api/x.js', role: 'api', holder: 'builder-two' }],
      outsideTask: ['src/features/web/other.js'],
    })
  })
})

describe('1.3b/config: owners.yml', () => {
  test('exactly one role is shared', () => {
    const none = ownersObject()
    none.roles.shared.shared = false
    expect(configErrorOf(() => parseOwners(yaml(none))).key).toBe('roles')
    const two = ownersObject()
    Object.assign(two.roles.web, { shared: true })
    expect(configErrorOf(() => parseOwners(yaml(two))).key).toBe('roles.web.shared')
  })

  test('overlapping globs of two roles are rejected with a path that both match', () => {
    const owners = ownersObject()
    owners.roles.api.paths = ['src/features/*/api/**']
    const error = configErrorOf(() => parseOwners(yaml(owners)))
    expect(error.key).toBe('roles.api.paths[0]')
    expect(error.message).toBe(
      'owners.yml: roles.api.paths[0] (src/features/*/api/**) overlaps roles.web.paths[0] (src/features/web/**): both match src/features/web/api, and a path matches at most one role',
    )
    const shared = ownersObject()
    shared.roles.shared.paths.push('**/*.md')
    shared.roles.web.paths.push('src/features/web/README.md')
    const error2 = configErrorOf(() => parseOwners(yaml(shared)))
    expect(error2.key).toBe('roles.web.paths[0]')
    expect(error2.message).toContain('overlaps roles.shared.paths[3] (**/*.md)')
  })

  test('globs of one role may overlap; the open list may name owned paths', () => {
    const owners = ownersObject()
    owners.roles.web.paths.push('src/features/web/**/*.ts')
    owners.open.push('docs/**')
    expect(parseOwners(yaml(owners)).roles.web.paths).toHaveLength(2)
  })

  test('shape errors name the key', () => {
    const cases = [
      ['schema: 2\nroles: {}\n', 'schema'],
      ['schema: 1\n', 'roles'],
      [
        'schema: 1\nroles:\n  shared:\n    shared: true\n    paths: [\"src/[a].js\"]\n',
        'roles.shared.paths[0]',
      ],
      ['schema: 1\nroles:\n  shared:\n    shared: true\n    owner: lead\n', 'roles.shared.owner'],
      ['schema: 1\nroles:\n  "bad name":\n    shared: true\n', 'roles.bad name'],
      ['schema: 1\nroles:\n  shared: {shared: true}\nopen: README.md\n', 'open'],
      ['schema: 1\nextra: 1\nroles:\n  shared: {shared: true}\n', 'extra'],
    ]
    for (const [text, key] of cases)
      expect(configErrorOf(() => parseOwners(text)).key, text).toBe(key)
    const broken = configErrorOf(() => parseOwners('schema: 1\nroles: [\n'))
    expect(broken.key).toBeUndefined()
    expect(broken.message).toMatch(/^owners\.yml: is not valid YAML: .* at line 3, column \d+$/)
  })
})

describe('1.3b/config: hackwin.yml', () => {
  test('the defaults of 6.3 fill what the file leaves out', () => {
    const minimal = hackwinObject()
    for (const key of ['tasks', 'gate', 'resolver']) delete /** @type {any} */ (minimal)[key]
    delete /** @type {any} */ (minimal.project).language
    const parsed = parseHackwinConfig(yaml(minimal))
    expect(parsed.tasks).toEqual({ max_files: 10 })
    expect(parsed.gate).toEqual({
      poll_seconds: 60,
      ci_rerun_limit: 1,
      repeated_failure_threshold: 2,
      heartbeat_stale_seconds: 300,
      status_issue_seconds: 120,
      ci_timeout_minutes: 20,
      step_timeout_minutes: 20,
      known_flaky_tests: [],
      secret_patterns: [],
    })
    expect(parsed.resolver).toEqual({ enabled: false, model: null, max_turns: 30 })
    expect(parsed.project.language).toBe('en')
  })

  test('missing, unknown and mistyped keys are errors that name the key', () => {
    /** @type {Array<[(h: any) => void, string]>} */
    const cases = [
      [(h) => delete h.cli_version, 'cli_version'],
      [(h) => (h.cli_version = 'latest'), 'cli_version'],
      [(h) => (h.schema = 2), 'schema'],
      [(h) => (h.comands = {}), 'comands'],
      [(h) => delete h.project.default_branch, 'project.default_branch'],
      [(h) => (h.project.event.start = '2026-10-24 09:00'), 'project.event.start'],
      [(h) => (h.team.members[1].agent = 'cursor'), 'team.members[1].agent'],
      [(h) => (h.team.members[2].roles = []), 'team.members[2].roles'],
      [(h) => (h.team.members[0].sessions = '2'), 'team.members[0].sessions'],
      [(h) => (h.commands.install = '  '), 'commands.install'],
      [(h) => (h.gate.poll_seconds = 0), 'gate.poll_seconds'],
      [(h) => (h.gate.secret_patterns = ['(unclosed']), 'gate.secret_patterns[0]'],
      [(h) => (h.paths.gated.migrations = ['/db/**']), 'paths.gated.migrations[0]'],
      [(h) => (h.team.members = 'lead'), 'team.members'],
    ]
    for (const [breakIt, key] of cases) {
      const hackwin = hackwinObject()
      breakIt(hackwin)
      const error = configErrorOf(() => parseHackwinConfig(yaml(hackwin)))
      expect(error.key, key).toBe(key)
      expect(error.message.startsWith(`hackwin.yml: ${key} `), error.message).toBe(true)
      expect(error.exitCode).toBe(2)
    }
  })

  test('validateConfig accepts the fixture and a solo team holding every role', () => {
    expect(() => validateConfig(config.hackwin, config.owners)).not.toThrow()
    const solo = hackwinObject()
    solo.team.members = [{ ...solo.team.members[0], roles: ['shared', 'web', 'api'] }]
    expect(() => validateConfig(parseHackwinConfig(yaml(solo)), config.owners)).not.toThrow()
  })

  test('a duplicate member is an error on its login', () => {
    const hackwin = hackwinObject()
    hackwin.team.members[2].github = 'Builder-One'
    const error = configErrorOf(() =>
      validateConfig(parseHackwinConfig(yaml(hackwin)), config.owners),
    )
    expect(error.key).toBe('team.members[2].github')
  })
})

describe('1.3b/config: loading from origin/main and a proposed copy', () => {
  test('loadConfig fetches and reads both files from origin/main', async () => {
    const repo = createConfiguredRepo()
    cleanups.push(repo.cleanup)
    const sha = repo.publish({ 'docs/a.md': 'a\n' })
    const git = createGit({ cwd: repo.clone, env: repo.env })
    const loaded = await loadConfig(git)
    expect(loaded.ref).toBe('origin/main')
    expect(loaded.sha).toBe(sha)
    expect(loaded.hackwin.team.lead).toBe('lead')
    expect(Object.keys(loaded.owners.roles)).toEqual(['shared', 'web', 'api'])
  })

  test('the branch under test never changes what loadConfig reads (A17)', async () => {
    const repo = createConfiguredRepo()
    cleanups.push(repo.cleanup)
    repo.git(repo.clone, 'checkout', '--quiet', '-b', 'task/3-x')
    writeFileSync(join(repo.clone, 'hackwin.yml'), 'broken: [\n')
    repo.git(repo.clone, 'commit', '--quiet', '-am', 'break it on the branch')
    const git = createGit({ cwd: repo.clone, env: repo.env })
    expect((await loadConfig(git)).hackwin.team.lead).toBe('lead')
    await expect(loadProposedConfig(git)).rejects.toThrow(/hackwin\.yml: is not valid YAML/)
  })

  test('a missing hackwin.yml is not configured; a missing owners.yml is a config error', async () => {
    const repo = createConfiguredRepo()
    cleanups.push(repo.cleanup)
    repo.git(repo.publisher, 'pull', '--quiet', '--ff-only', 'origin', 'main')
    repo.git(repo.publisher, 'rm', '--quiet', 'owners.yml')
    repo.git(repo.publisher, 'commit', '--quiet', '-m', 'drop owners')
    repo.git(repo.publisher, 'push', '--quiet', 'origin', 'main')
    const git = createGit({ cwd: repo.clone, env: repo.env })
    await expect(loadConfig(git)).rejects.toThrow('owners.yml: is missing on origin/main')
    repo.git(repo.publisher, 'rm', '--quiet', 'hackwin.yml')
    repo.git(repo.publisher, 'commit', '--quiet', '-m', 'drop hackwin')
    repo.git(repo.publisher, 'push', '--quiet', 'origin', 'main')
    const error = await loadConfig(git).catch((e) => e)
    expect(error).toBeInstanceOf(PreconditionError)
    expect(error.message).toBe('not configured: hackwin.yml is missing on origin/main')
    expect(error.resolve).toEqual({ command: 'hackwin setup', dir: repo.clone })
  })

  test('a proposed cli_version of another phase is a config error on cli_version', async () => {
    const repo = createConfiguredRepo({ hackwin: { ...hackwinObject(), cli_version: '0.1.0' } })
    cleanups.push(repo.cleanup)
    const git = createGit({ cwd: repo.clone, env: repo.env })
    repo.git(repo.clone, 'checkout', '--quiet', '-b', 'task/9-bump')
    writeFileSync(
      join(repo.clone, 'hackwin.yml'),
      yaml({ ...hackwinObject(), cli_version: '0.1.1' }),
    )
    repo.git(repo.clone, 'commit', '--quiet', '-am', 'bug fix release')
    expect((await loadProposedConfig(git)).hackwin.cli_version).toBe('0.1.1')
    writeFileSync(
      join(repo.clone, 'hackwin.yml'),
      yaml({ ...hackwinObject(), cli_version: '0.2.0' }),
    )
    repo.git(repo.clone, 'commit', '--quiet', '-am', 'next phase')
    const error = await loadProposedConfig(git).catch((e) => e)
    expect(error).toBeInstanceOf(ConfigError)
    expect(error.key).toBe('cli_version')
    expect(error.message).toContain('a project stays on the phase it started with [D10]')
  })
})

describe('1.3b/identity: matching the gh login', () => {
  test('a member gets their roles; the Lead is marked; a stranger is told to ask the Lead', () => {
    expect(resolveIdentity(config, 'lead')).toMatchObject({
      login: 'lead',
      roles: ['shared'],
      isLead: true,
    })
    expect(resolveIdentity(config, 'builder-two')).toMatchObject({ roles: ['api'], isLead: false })
    try {
      resolveIdentity(config, 'stranger')
      throw new Error('not thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(PreconditionError)
      expect(error.exitCode).toBe(2)
      expect(error.resolve).toBe('ask the Lead to add you to `hackwin.yml`')
    }
  })
})

describe('1.3b/version: phase and precedence (contracts 6.2)', () => {
  test('older, newer patch, same and other phase', () => {
    /** @type {Array<[string, string, string]>} */
    const cases = [
      ['0.1.0-pre.2', '0.1.1-pre.2', 'older'],
      ['0.1.0-pre.2', '0.1.0-pre.10', 'older'],
      ['0.1.1-pre.1', '0.1.1', 'older'],
      ['0.1.0', '0.1.0-pre.9', 'newer-patch'],
      ['0.1.2', '0.1.1', 'newer-patch'],
      ['0.1.1', '0.1.1', 'same'],
      ['0.2.0-pre.2', '0.1.0-pre.2', 'other-phase'],
      ['0.1.9', '0.2.0', 'other-phase'],
      ['1.1.0', '0.1.0', 'other-phase'],
    ]
    for (const [running, pinned, status] of cases) {
      expect(checkVersion({ running, pinned }), `${running} against ${pinned}`).toEqual({ status })
    }
  })

  test('the install command names the pinned version, by URL for a pre-release', () => {
    const url = 'git+https://github.com/Bartek201301/HackWin.git'
    expect(installCommand('0.1.0', url)).toBe('npm install -g hackwin@0.1.0')
    expect(installCommand('0.1.0-pre.3', url)).toBe(
      'npm install -g https://github.com/Bartek201301/HackWin/releases/download/v0.1.0-pre.3/hackwin-0.1.0-pre.3.tgz',
    )
    expect(installCommand('0.1.1-pre.2', 'git@github.com:o/r.git')).toBe(
      'npm install -g https://github.com/o/r/releases/download/v0.1.1-pre.2/hackwin-0.1.1-pre.2.tgz',
    )
  })
})

describe('1.3b/fast-forward: fastForwardMainCheckout', () => {
  test('fast-forwards a clean main checkout, leaves a dirty one and a task worktree alone', async () => {
    const repo = createConfiguredRepo()
    cleanups.push(repo.cleanup)
    const git = createGit({ cwd: repo.clone, env: repo.env })
    const head = () => repo.git(repo.clone, 'rev-parse', 'HEAD').trim()
    expect(await fastForwardMainCheckout(git, { defaultBranch: 'main' })).toEqual({
      status: 'up-to-date',
    })

    const first = repo.publish({ 'docs/1.md': '1\n' })
    await git.fetch()
    // An untracked file does not count as a local change.
    writeFileSync(join(repo.clone, 'notes.txt'), 'scratch\n')
    expect(await fastForwardMainCheckout(git, { defaultBranch: 'main' })).toEqual({
      status: 'fast-forwarded',
    })
    expect(head()).toBe(first)

    repo.publish({ 'docs/2.md': '2\n' })
    await git.fetch()
    writeFileSync(join(repo.clone, 'README.md'), 'changed\n')
    expect(await fastForwardMainCheckout(git, { defaultBranch: 'main' })).toEqual({
      status: 'behind',
    })
    expect(head()).toBe(first)
    repo.git(repo.clone, 'checkout', '--', 'README.md')

    repo.git(repo.clone, 'checkout', '--quiet', '-b', 'other')
    expect(await fastForwardMainCheckout(git, { defaultBranch: 'main' })).toEqual({
      status: 'behind',
    })
    repo.git(repo.clone, 'checkout', '--quiet', 'main')

    repo.git(repo.clone, 'commit', '--quiet', '--allow-empty', '-m', 'local commit on main')
    expect(await fastForwardMainCheckout(git, { defaultBranch: 'main' })).toEqual({
      status: 'behind',
    })

    const worktree = join(repo.dir, 'clone.worktrees', '3-x')
    repo.git(repo.clone, 'worktree', 'add', '--quiet', '-b', 'task/3-x', worktree, 'origin/main')
    expect(
      await fastForwardMainCheckout(git.with({ cwd: worktree }), { defaultBranch: 'main' }),
    ).toEqual({ status: 'not-main-checkout' })
  })
})

describe('1.3b/config: globs', () => {
  test('unsupported syntax is named', () => {
    expect(globError('src/**')).toBeNull()
    expect(globError('{src,lib}/**/*.{js,ts}')).toBeNull()
    expect(globError('app/\\(marketing\\)/**')).toBeNull()
    for (const glob of [
      '',
      '!src/**',
      'src/[ab].js',
      'app/(x)/**',
      'a/{b}',
      'a/{b',
      'a/',
      '/a',
      'a//b',
      './a',
      'a\\',
    ]) {
      expect(globError(glob), glob).not.toBeNull()
    }
  })

  test('the automata agree with picomatch on the supported syntax', () => {
    const globs = [
      'src/**',
      'src/*',
      'src/*.js',
      'src/**/*.js',
      '**/package.json',
      '**',
      '*',
      'a/**/b',
      '**/x/**',
      'a/b**c/d',
      'a/x?y',
      '{src,lib}/**',
      'a/{b,c/d}/e',
      'a/{,b}x',
      'a/\\*',
      'docs/*.md',
      '.github/**',
    ]
    const paths = [
      'src',
      'src/a.js',
      'src/.gitkeep',
      'src/a/b.js',
      'package.json',
      'x/package.json',
      'a/b',
      'a/x/b',
      'a/x/y/b',
      'x',
      'q/x',
      'x/y',
      'a/bxc/d',
      'a/bx/yc/d',
      'a/xzy',
      'a/x/y',
      'lib/z',
      'a/c/d/e',
      'a/x',
      'a/bx',
      'a/*',
      'a/q',
      'docs/a.md',
      'docs/sub/a.md',
      '.github/workflows/ci.yml',
      'README.md',
    ]
    for (const glob of globs) {
      const matches = picomatch(glob, { dot: true })
      for (const path of paths) {
        const literal = path.replace(/[*?{}\\[\]()!|]/g, (ch) => `\\${ch}`)
        const ours = samplePath({ inside: [glob], alsoInside: [literal] }) !== null
        expect(ours, `${glob} against ${path}`).toBe(matches(path))
      }
    }
  })

  test('braces expand; a sample path is a real path', () => {
    expect(expandBraces('a/{b,{c,d}}/{e,f}')).toEqual([
      'a/b/e',
      'a/b/f',
      'a/c/e',
      'a/c/f',
      'a/d/e',
      'a/d/f',
    ])
    expect(samplePath({ inside: ['src/**'], alsoInside: ['src/features/**'] })).toBe('src/features')
    expect(
      samplePath({ inside: ['src/features/a/**'], alsoInside: ['src/features/b/**'] }),
    ).toBeNull()
    expect(samplePath({ inside: ['a/?/b'], alsoInside: ['a/.*/b'] })).toBeNull()
    expect(samplePath({ inside: ['src/*.js'], alsoInside: ['src/a*'] })).toBe('src/a.js')
    expect(samplePath({ inside: ['src/features/x/**'], outside: ['src/features/**'] })).toBeNull()
    expect(samplePath({ inside: ['src/**'], outside: ['src/features/**'] })).toBe('src')
  })
})

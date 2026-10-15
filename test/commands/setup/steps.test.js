import { afterEach, describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../../../src/core/config/index.js'
import { ownersFromTree, proposeHolders } from '../../../src/commands/setup/ownership.js'
import { detectStack } from '../../../src/commands/setup/stack.js'
import { accounts, nodeProjectFiles } from '../../harness/index.js'
import {
  LEAD,
  createSetupFixture,
  runSetup,
  snapshot,
  teamAnswers,
  writes,
} from './setup-fixture.js'

/** @type {string[]} */
const dirs = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * A directory with these files, and the sets that detectStack and ownersFromTree read.
 * @param {Record<string, string>} files
 */
function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'hackwin-setup-'))
  dirs.push(root)
  for (const [path, content] of Object.entries(files)) {
    if (!path.includes('/')) writeFileSync(join(root, path), content)
  }
  const directories = new Set()
  for (const path of Object.keys(files)) {
    const parts = path.split('/')
    for (let depth = 1; depth < parts.length; depth += 1) {
      directories.add(parts.slice(0, depth).join('/'))
    }
  }
  return { root, files: new Set(Object.keys(files)), directories }
}

/**
 * @param {Record<string, string>} scripts
 * @param {Record<string, unknown>} [more]
 */
const packageJson = (scripts, more = {}) => JSON.stringify({ name: 'app', scripts, ...more })

describe('1.4d/detect: stack commands and path groups', () => {
  test('1.4d/detect: npm with a check script, from the Node fixture', async () => {
    const { root, ...sets } = tree(nodeProjectFiles())
    const detection = await detectStack(root, sets)
    expect(detection.stack).toBe('node')
    expect(detection.manager).toBe('npm')
    expect(detection.sources).toEqual(['package.json', 'package-lock.json'])
    expect(detection.paths).toEqual({
      manifests: ['package.json'],
      lockfiles: ['package-lock.json'],
      gated: { migrations: [], production_config: [] },
      ledger: null,
    })
  })

  test('1.4d/detect: pnpm without a check script chains lint, typecheck, test and build', async () => {
    const { root, ...sets } = tree({
      'package.json': packageJson({ lint: 'eslint .', test: 'vitest run', build: 'vite build' }),
      'pnpm-lock.yaml': '',
      'supabase/migrations/001.sql': '',
      'vercel.json': '{}',
    })
    const { commands, paths } = await detectStack(root, sets)
    expect(commands).toEqual({
      install: 'pnpm install --frozen-lockfile',
      check: 'pnpm run lint && pnpm run test && pnpm run build',
      test: 'pnpm run test',
      format: null,
      generate: null,
      lockfile_regen: 'pnpm install --lockfile-only',
    })
    expect(paths.lockfiles).toEqual(['pnpm-lock.yaml'])
    expect(paths.gated).toEqual({
      migrations: ['supabase/migrations/**'],
      production_config: ['vercel.json'],
    })
  })

  test('1.4d/detect: yarn berry, a generate script and prettier as the formatter', async () => {
    const { root, ...sets } = tree({
      'package.json': packageJson(
        { check: 'tsc', test: 'jest', generate: 'prisma generate' },
        { devDependencies: { prettier: '3.0.0' } },
      ),
      'yarn.lock': '',
      '.yarnrc.yml': '',
    })
    const { commands } = await detectStack(root, sets)
    expect(commands).toMatchObject({
      install: 'yarn install --immutable',
      check: 'yarn run check',
      test: 'yarn run test',
      format: 'npx prettier --write',
      generate: 'yarn run generate',
      lockfile_regen: 'yarn install --mode=update-lockfile',
    })
  })

  test('1.4d/detect: npm without a lockfile installs with npm install', async () => {
    const { root, ...sets } = tree({ 'package.json': packageJson({ format: 'prettier --write' }) })
    const { commands, paths } = await detectStack(root, sets)
    expect(commands.install).toBe('npm install')
    expect(commands.format).toBe('npm run format --')
    expect(commands.check).toBeNull()
    expect(paths.lockfiles).toEqual([])
  })

  test('1.4d/detect: another stack has no detected command and no manifest', async () => {
    const { root, ...sets } = tree({ 'pyproject.toml': '', 'migrations/0001.py': '' })
    const detection = await detectStack(root, sets)
    expect(detection).toMatchObject({ stack: null, commands: {}, sources: [] })
    expect(detection.paths.manifests).toEqual([])
    expect(detection.paths.gated.migrations).toEqual(['migrations/**'])
  })

  test('1.4d/detect: without detected commands, an answers file must name them', async () => {
    const { fixture, fake } = await createSetupFixture({
      nodeProject: false,
      files: { 'README.md': '# App\n' },
    })
    const answers = teamAnswers(1, (a) => {
      delete a.commands
      delete a.roles
      a.team.members[0].roles = ['shared']
    })
    const result = await runSetup(fixture, fake, { answers })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain(
      'has no commands.install: setup could not detect the install command',
    )
  })
})

describe('1.4d/ownership: the proposal of step 4', () => {
  test('1.4d/ownership: the directory tree of the Node fixture gives one role per feature', () => {
    const { directories } = tree(nodeProjectFiles())
    expect(ownersFromTree(directories)).toEqual({
      schema: 1,
      roles: {
        shared: {
          shared: true,
          paths: ['.agents/**', '.claude/**', '.github/**', 'docs/**', 'src/shared/**'],
        },
        counter: { shared: false, paths: ['src/features/counter/**'] },
        greeting: { shared: false, paths: ['src/features/greeting/**'] },
        todos: { shared: false, paths: ['src/features/todos/**'] },
      },
      open: ['README.md'],
    })
  })

  test('1.4d/ownership: without a features directory everything is shared', () => {
    const { directories } = tree({ 'lib/a.js': '', 'docs/x.md': '' })
    expect(ownersFromTree(directories).roles).toEqual({
      shared: { shared: true, paths: ['docs/**', 'lib/**'] },
    })
  })

  test('1.4d/ownership: a feature named like the shared role gets another name', () => {
    const { directories } = tree({ 'packages/shared/a.js': '', 'packages/ui/b.js': '' })
    expect(Object.keys(ownersFromTree(directories).roles)).toEqual(['shared', 'shared-2', 'ui'])
  })

  test('1.4d/ownership: the Lead holds the shared role; the features go round the builders', () => {
    const owners = {
      schema: /** @type {1} */ (1),
      roles: {
        shared: { shared: true, paths: [] },
        a: { shared: false, paths: [] },
        b: { shared: false, paths: [] },
        c: { shared: false, paths: [] },
      },
      open: [],
    }
    const member = (/** @type {string} */ github) => ({
      name: github,
      github,
      roles: null,
      agent: /** @type {'claude'} */ ('claude'),
      sessions: /** @type {2} */ (2),
    })
    expect(proposeHolders(owners, { lead: 'l', members: [member('l')] })).toEqual([
      ['shared', 'a', 'b', 'c'],
    ])
    expect(proposeHolders(owners, { lead: 'l', members: [member('l'), member('x')] })).toEqual([
      ['shared', 'c'],
      ['a', 'b'],
    ])
    expect(
      proposeHolders(owners, { lead: 'L', members: [member('x'), member('l'), member('y')] }),
    ).toEqual([['a', 'c'], ['shared'], ['b']])
  })

  test('1.4d/ownership: an answers file with only the team gets the roles of owners.yml', async () => {
    const { fixture, fake } = await createSetupFixture()
    const answers = teamAnswers(4, (a) => {
      delete a.roles
      delete a.open
      for (const member of a.team.members) delete member.roles
    })
    const result = await runSetup(fixture, fake, { answers })
    expect(result.code).toBe(0)
    const { hackwin } = await loadConfig(fixture.git)
    expect(hackwin.team.members.map((member) => member.roles)).toEqual([
      ['shared'],
      ['counter'],
      ['todos'],
      ['greeting'],
    ])
  })

  test('1.4d/ownership: in a terminal the Lead can type the roles and assign them', async () => {
    const { fixture, fake } = await createSetupFixture()
    const input = [
      '2',
      '',
      '',
      '',
      '',
      accounts.builder1.login,
      '',
      '',
      '',
      'edit', // the roles of owners.yml
      'core: src/**',
      'ui: src/**', // overlaps core: typed again
      '',
      'core: src/shared/**',
      'ui: src/features/**',
      '',
      'ui', // the Lead without the shared role: asked again
      'core',
      'core', // builder1 with the shared role: asked again
      'ui',
      '',
      '',
      '',
      '2026-10-24T09:00:00+02:00',
      '2026-10-25T15:00:00+02:00',
      '',
    ]
    const result = await runSetup(fixture, fake, { tty: true, input })
    expect(result.stderr).not.toContain('hackwin setup:')
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('overlaps roles.core.paths[0]')
    expect(result.stdout).toContain('the Lead holds the shared role core')
    expect(result.stdout).toContain("core is the Lead's role")
    const config = await loadConfig(fixture.git)
    expect(config.owners.roles).toEqual({
      core: { shared: true, paths: ['src/shared/**'] },
      ui: { shared: false, paths: ['src/features/**'] },
    })
    expect(config.hackwin.team.members.map((member) => member.roles)).toEqual([['core'], ['ui']])
  })
})

describe('1.4d/preconditions: step 1 and the questions', () => {
  test('1.4d/preconditions: without a terminal and without an answers file, setup exits 2', async () => {
    const { fixture, fake } = await createSetupFixture()
    const result = await runSetup(fixture, fake)
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('setup asks its questions in an interactive terminal')
    expect(result.stderr).toContain(`run \`hackwin setup --answers <file>\` in ${fixture.main}`)
  })

  test('1.4d/preconditions: a dirty tree, another branch, a worktree and a non-admin exit 2', async () => {
    const { fixture, fake } = await createSetupFixture()
    const answers = teamAnswers(3)

    writeFileSync(join(fixture.main, 'scratch.txt'), 'x\n')
    let result = await runSetup(fixture, fake, { answers })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('the working tree has changes or untracked files')
    rmSync(join(fixture.main, 'scratch.txt'))

    await fixture.git.run(['switch', '--quiet', '-c', 'other'])
    result = await runSetup(fixture, fake, { answers })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('setup runs on the default branch main')
    await fixture.git.run(['switch', '--quiet', 'main'])

    const task = await fixture.worktree({ issue: 7 })
    result = await runSetup(fixture, fake, { answers, cwd: task.path })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain(`run \`hackwin setup\` in ${fixture.main}`)

    fake.state.collaborators[LEAD] = 'write'
    result = await runSetup(fixture, fake, { answers })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain(`${LEAD} has no admin rights on hackwin-test/app`)
    expect(writes(fake)).toEqual([])
  })

  test('1.4d/preconditions: a main behind origin is fast-forwarded; a main ahead of origin is refused', async () => {
    const { fixture, fake } = await createSetupFixture()
    const ahead = await fixture.publish({ 'NOTES.md': 'from another clone\n' })
    let result = await runSetup(fixture, fake, { answers: teamAnswers(3) })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('fast-forwarded main to origin/main')
    expect(await fixture.git.revParse('HEAD~1')).toBe(ahead)

    const second = await createSetupFixture()
    await second.fixture.commit('Local only')
    const before = snapshot(second.fixture.main)
    result = await runSetup(second.fixture, second.fake, { answers: teamAnswers(3) })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('main has commits that origin/main lacks')
    expect(snapshot(second.fixture.main)).toEqual(before)
  })

  test('1.4d/preconditions: a login that GitHub does not know exits 2; one without write access is reported', async () => {
    const { fixture, fake } = await createSetupFixture()
    let answers = teamAnswers(3, (a) => {
      a.team.members[2].github = 'nobody-here-404'
    })
    let result = await runSetup(fixture, fake, { answers })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain(
      'GitHub has no account nobody-here-404 (team.members[2].github)',
    )

    delete fake.state.collaborators[accounts.builder2.login]
    answers = teamAnswers(3)
    result = await runSetup(fixture, fake, { answers })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(
      `${accounts.builder2.login}: no write access to hackwin-test/app yet`,
    )
    expect(result.stdout).toContain(`${accounts.builder1.login}: write access to hackwin-test/app`)
  })

  test('1.4d/preconditions: answers with a bad event, an unknown key or another default branch exit 2 naming the key', async () => {
    const { fixture, fake } = await createSetupFixture()
    const cases = [
      [(a) => delete a.project.event, 'has no project.event.start'],
      [
        (a) => (a.project.event.end = a.project.event.start),
        'project.event.end must be after the event start',
      ],
      [
        (a) => (a.project.event.start = '2026-10-24 09:00'),
        'project.event.start must be an ISO 8601 time',
      ],
      [
        (a) => (a.project.default_branch = 'trunk'),
        'project.default_branch (trunk) is not the default branch',
      ],
      [(a) => (a.extra = 1), 'extra is not a known key'],
      [(a) => (a.team.members[1].sessions = 4), 'team.members[1].sessions must be 1, 2 or 3'],
      [(a) => (a.gate = { poll_seconds: 'often' }), 'hackwin.yml: gate.poll_seconds'],
    ]
    for (const [change, message] of cases) {
      const result = await runSetup(fixture, fake, { answers: teamAnswers(3, change) })
      expect(result.code, message).toBe(2)
      expect(result.stderr).toContain(message)
    }
    expect(await fixture.git.isClean()).toBe(true)
  })

  test('1.4d/preconditions: setup --resume and --regenerate are not built yet', async () => {
    const { fixture, fake } = await createSetupFixture()
    for (const flag of ['--resume', '--regenerate']) {
      const result = await runSetup(fixture, fake, { args: [flag] })
      expect(result.code).toBe(2)
      expect(result.stderr).toContain(`setup ${flag} is not built yet`)
    }
  })

  test('1.4d/preconditions: a private repository is reported and left as it is', async () => {
    const { fixture, fake } = await createSetupFixture({ visibility: 'private' })
    const result = await runSetup(fixture, fake, { answers: teamAnswers(3), args: ['--json'] })
    expect(result.code).toBe(0)
    const json = JSON.parse(result.stdout)
    expect(json.data.visibility).toBe('private')
    expect(result.stderr).toContain('hackwin-test/app is private; setup does not change that')
    expect(writes(fake)).toEqual([])
  })
})

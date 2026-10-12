import { describe, expect, test } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VERSION } from '../../src/cli/context.js'
import {
  loadConfig,
  parseHackwinConfig,
  parseOwners,
  validateConfig,
} from '../../src/core/config/index.js'
import { createGit } from '../../src/core/git/index.js'
import { isJoinComplete, readLocal } from '../../src/core/state/index.js'
import { checkHooksPath, currentTask, taskWorktrees } from '../../src/core/worktrees/index.js'
import {
  BUILDER3_LOGIN,
  NODE_PROJECT_FILE,
  RESET_TREE,
  TEAM_SIZES,
  accounts,
  createFixture,
  nodeProjectFiles,
  packNodeProject,
  teamConfig,
  writeNodeProject,
} from './index.js'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/**
 * The environment without the GIT_* variables of a hook that may run the tests.
 * @param {Record<string, string | undefined>} env
 */
function withoutGitVariables(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_')))
}

/**
 * The size, time and inode of the user's own git and gh configuration files. Only stat: the gh
 * files may hold a credential, and nothing here reads them.
 */
function userConfigSnapshot() {
  const home = userInfo().homedir
  const xdg = process.env.XDG_CONFIG_HOME ?? join(home, '.config')
  const files = [
    join(home, '.gitconfig'),
    join(xdg, 'git', 'config'),
    join(xdg, 'git', 'ignore'),
    join(xdg, 'gh', 'config.yml'),
    join(xdg, 'gh', 'hosts.yml'),
  ]
  return files.map((file) => {
    try {
      const { size, mtimeMs, ino } = statSync(file)
      return { file, size, mtimeMs, ino }
    } catch {
      return { file, missing: true }
    }
  })
}

describe('1.3d/fixture: offline fixtures', () => {
  test('a fixture clone with a task worktree and a joined clone is created and removed without touching the user configuration', async () => {
    const before = userConfigSnapshot()
    const fixture = await createFixture({ team: 3 })
    const home = userInfo().homedir

    // Isolated: own HOME, own global config, no system config, no gh login, no global hook.
    expect(fixture.env.HOME).toBe(fixture.home)
    expect(fixture.env.HOME.startsWith(fixture.dir)).toBe(true)
    expect(fixture.env.GIT_CONFIG_GLOBAL).toBe(join(fixture.home, '.gitconfig'))
    expect(fixture.env.GIT_CONFIG_NOSYSTEM).toBe('1')
    expect(fixture.env.GH_CONFIG_DIR?.startsWith(fixture.dir)).toBe(true)
    expect(fixture.env.GH_TOKEN).toBeUndefined()
    expect(Object.keys(fixture.env).filter((key) => key.startsWith('GIT_'))).toEqual([
      'GIT_CONFIG_GLOBAL',
      'GIT_CONFIG_NOSYSTEM',
    ])
    expect(await fixture.git.configGet('user.email')).toBe('test@example.invalid')
    expect(await fixture.git.configGet('core.hooksPath')).toBeNull()
    // Every config file git reads is the fixture's own: absolute ones lie in the fixture, and the
    // relative one is the clone's .git/config.
    const origins = await fixture.git.run(['config', '--list', '--show-origin'])
    const files = origins.stdout
      .trim()
      .split('\n')
      .map((line) => /^file:(\S+)/.exec(line)?.[1])
      .filter((file) => file !== undefined)
    expect(files).toContain(join(fixture.home, '.gitconfig'))
    expect(files.filter((file) => file.startsWith('/') && !file.startsWith(fixture.dir))).toEqual(
      [],
    )
    expect(files.some((file) => file.startsWith(home) && !file.startsWith(fixture.dir))).toBe(false)

    // The team configuration is on origin/main and valid.
    const config = await loadConfig(fixture.git)
    expect(config.hackwin.team.members.map((member) => member.github)).toEqual([
      accounts.lead.login,
      accounts.builder1.login,
      accounts.builder2.login,
    ])

    // A task worktree at its path of A9, on its branch from origin/main.
    const task = await fixture.worktree({
      issue: 12,
      title: 'Add the counter reset',
      files: { 'src/features/counter/reset.ts': 'export const reset = 0\n' },
      push: true,
    })
    expect(task.branch).toBe('task/12-add-the-counter-reset')
    expect(task.path).toBe(join(fixture.dir, 'app.worktrees', '12-add-the-counter-reset'))
    expect(await currentTask(task.git)).toEqual({ issue: 12, branch: task.branch, path: task.path })
    expect(await taskWorktrees(fixture.git)).toEqual([
      { issue: 12, branch: task.branch, path: task.path },
    ])
    expect(await task.git.revParse('HEAD')).toBe(
      await fixture.git.revParse(`refs/remotes/origin/${task.branch}`),
    )
    expect(await task.git.revParse('HEAD~1')).toBe(await fixture.git.revParse('origin/main'))

    // A joined clone: the join record of a builder and the hooks path.
    const joined = await fixture.joinedClone({ login: accounts.builder1.login })
    const record = await readLocal(joined.commonDir)
    expect(record?.login).toBe(accounts.builder1.login)
    expect(record?.join?.cli_version).toBe(VERSION)
    expect(isJoinComplete(record, accounts.builder1.login)).toBe(true)
    expect(isJoinComplete(record, accounts.lead.login)).toBe(false)
    expect(await checkHooksPath(joined.git)).toEqual({ ok: true, value: '.githooks' })
    expect(await fixture.git.configGet('core.hooksPath')).toBeNull()

    fixture.cleanup()
    expect(existsSync(fixture.dir)).toBe(false)
    expect(userConfigSnapshot()).toEqual(before)
  })

  test('scripted states: commits, a branch and a commit on main from another clone', async () => {
    const fixture = await createFixture({ files: { 'README.md': 'readme\n', 'src/a.txt': 'a\n' } })
    const first = await fixture.git.revParse('HEAD')
    const local = await fixture.commit('Local change', { files: { 'src/a.txt': 'b\n' } })
    expect(await fixture.git.revParse('HEAD~1')).toBe(first)
    expect(await fixture.git.revParse('origin/main')).toBe(first)

    const branchSha = await fixture.branch('spike/try', { files: { 'spike.txt': 'x\n' } })
    const published = await fixture.publish(
      { 'docs/new.md': 'new\n' },
      { message: 'From another member' },
    )
    await fixture.git.fetch()
    expect(await fixture.git.revParse('origin/spike/try')).toBe(branchSha)
    expect(await fixture.git.revParse('origin/main')).toBe(published)
    expect(await fixture.git.isAncestor(first, published)).toBe(true)
    expect(await fixture.git.isAncestor(local, published)).toBe(false)
    expect(await fixture.git.showFile('origin/main', 'docs/new.md')).toBe('new\n')
    fixture.cleanup()
  })

  test('team configurations of 1, 3 and 4 members are valid and keep invitations off', () => {
    expect(TEAM_SIZES).toEqual([1, 3, 4])
    for (const size of TEAM_SIZES) {
      const team = teamConfig(size)
      const hackwin = parseHackwinConfig(team.files['hackwin.yml'])
      const owners = parseOwners(team.files['owners.yml'])
      expect(() => validateConfig(hackwin, owners)).not.toThrow()
      expect(hackwin.team.members).toHaveLength(size)
      expect(team.answers.invite).toBe(false)
      expect(hackwin.cli_version).toBe(VERSION)
    }
    expect(teamConfig(1).members.map((member) => member.github)).toEqual([accounts.solo.login])
    expect(teamConfig(4).members.map((member) => member.github)).toEqual([
      accounts.lead.login,
      accounts.builder1.login,
      accounts.builder2.login,
      BUILDER3_LOGIN,
    ])
    expect(() => teamConfig(2)).toThrow(/1, 3, 4 members/)
  })

  test('a fixture with its own configuration commits it as given', async () => {
    const team = teamConfig(1)
    const broken = { ...team.hackwin, team: { ...team.hackwin.team, lead: 'nobody' } }
    const fixture = await createFixture({ config: { hackwin: broken, owners: team.owners } })
    expect(fixture.team).toBeNull()
    await expect(loadConfig(fixture.git)).rejects.toMatchObject({
      kind: 'config',
      key: 'team.lead',
    })
    fixture.cleanup()
  })
})

describe('1.3d/node-project: the Node fixture', () => {
  test('is an exact copy of the tree of the fixture repositories reset commit', async () => {
    const fixture = await createFixture({ nodeProject: true })
    expect(await fixture.git.output(['rev-parse', 'HEAD^{tree}'])).toBe(RESET_TREE)
    const pkg = JSON.parse(readFileSync(join(fixture.main, 'package.json'), 'utf8'))
    expect(pkg.devDependencies).toHaveProperty('tailwindcss')
    expect(Object.keys(pkg.scripts)).toEqual(
      expect.arrayContaining(['test', 'format', 'check', 'build']),
    )
    expect(existsSync(join(fixture.main, 'package-lock.json'))).toBe(true)
    fixture.cleanup()
  })

  test('lives in this repository as one text file: no tracked file below test/harness is named as agent instructions, settings or skills', async () => {
    const repo = createGit({ cwd: REPO_ROOT, env: withoutGitVariables(process.env) })
    const tracked = (await repo.output(['ls-files', '-z', '--', 'test/harness']))
      .split('\0')
      .filter(Boolean)
    expect(tracked).toContain('test/harness/node-project.yml')
    // The names Claude Code loads from a subdirectory once it reads a file there (CLAUDE.md,
    // CLAUDE.local.md, AGENTS.md, .claude/ with its skills, rules and settings), and .agents/,
    // which the template uses for the skills of other agents.
    const agentNames = ['claude.md', 'claude.local.md', 'agents.md', '.claude', '.agents']
    const named = tracked.filter((path) =>
      path.split('/').some((part) => agentNames.includes(part.toLowerCase())),
    )
    expect(named).toEqual([])
  })

  test("is written with its CLAUDE.md, AGENTS.md, .claude/ and .agents/ into a test's own directory, and packs back to the same file", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hackwin-node-project-')))
    try {
      writeNodeProject(dir)
      const files = nodeProjectFiles()
      expect(Object.keys(files)).toHaveLength(35)
      for (const path of [
        'CLAUDE.md',
        'AGENTS.md',
        '.claude/settings.json',
        '.agents/skills/research/SKILL.md',
        '.env.example',
      ]) {
        expect(readFileSync(join(dir, path), 'utf8')).toBe(files[path])
      }
      expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toContain('@AGENTS.md')
      expect(packNodeProject(dir)).toBe(readFileSync(NODE_PROJECT_FILE, 'utf8'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('takes a team configuration on top, which matches its owners.yml roles', async () => {
    const fixture = await createFixture({ nodeProject: true, team: 4 })
    const config = await loadConfig(fixture.git)
    expect(Object.keys(config.owners.roles)).toEqual(['shared', 'counter', 'todos', 'greeting'])
    fixture.cleanup()
  })
})

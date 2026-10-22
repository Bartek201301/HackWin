import { describe, expect, test } from 'vitest'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import semver from 'semver'
import { VERSION } from '../../../src/cli/context.js'
import { accounts, teamConfig } from '../../harness/index.js'
import { commit, createHookFixture, pinnedConfig, runHook, writeFiles } from './hook-fixture.js'

// Secret-shaped strings, built at run time so that no scanner flags this file itself.
const githubToken = ['ghp', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('_')
/** Matches only TEAM_PATTERN, a pattern of the team's own hackwin.yml that GitHub does not know. */
const teamSecret = ['hwtest', 'q7w3e9r1t5y2u8i4o6p0a1s3'].join('_')
const TEAM_PATTERN = 'hwtest_[a-z0-9]{24}'

/**
 * Stage files in a checkout without committing, for the in-process runs of the hook.
 * @param {import('../../../src/core/git/index.js').Git} git
 * @param {Record<string, string>} files
 */
async function stage(git, files) {
  writeFiles(git.cwd, files)
  await git.run(['add', '--all'])
}

describe('AC54/hooks: the pre-commit hook on the default branch', () => {
  test('a commit on the default branch is blocked by the pre-commit hook', async () => {
    const hooks = await createHookFixture()
    const clone = await hooks.joinedClone('lead')
    const before = await clone.git.revParse('HEAD')

    const result = await commit(clone.git, { 'README.md': '# Fixed on main\n' })

    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain(
      'hackwin internal hook pre-commit: blocked: commits on main are blocked',
    )
    expect(result.stderr).toContain('rule: E18: no fix is committed directly on main')
    expect(result.stderr).toContain(`- branch main in ${clone.path}`)
    expect(result.stderr).toContain(`to resolve: run \`cd ${clone.path} && hackwin take\``)
    expect(await clone.git.revParse('HEAD')).toBe(before)
  })
})

describe('AC47/commit: the scope check at commit', () => {
  // The fixture holds no Claude Code settings or hooks, as for a member who works with Codex or a
  // plain editor: only the git hook stands between the edit and the commit.
  test("with the Claude Code hooks off, an edit outside the author's scope is blocked at commit", async () => {
    const hooks = await createHookFixture()
    const clone = await hooks.joinedClone('builder1')
    const task = await hooks.taskWorktree(clone, 12, 'Counter step')
    const before = await task.git.revParse('HEAD')

    const blocked = await commit(task.git, {
      'src/features/counter/step.js': 'export const step = 1\n',
      'src/features/greeting/hello.js': 'export const hello = 1\n',
    })

    expect(blocked.code).not.toBe(0)
    expect(blocked.stderr).toContain(
      `blocked: this commit changes files outside the roles of ${accounts.builder1.login} (counter, todos)`,
    )
    expect(blocked.stderr).toContain("rule: E1: edits stay inside the author's ownership scope")
    expect(blocked.stderr).toContain(
      `- src/features/greeting/hello.js: role greeting, held by ${accounts.builder2.login}`,
    )
    expect(blocked.stderr).not.toContain('- src/features/counter/step.js')
    expect(blocked.stderr).toContain(
      `to resolve: run \`cd ${task.path} && git restore --staged -- src/features/greeting/hello.js\``,
    )
    expect(await task.git.revParse('HEAD')).toBe(before)

    await task.git.run(['restore', '--staged', '--', 'src/features/greeting/hello.js'])
    const allowed = await task.git.run(['commit', '--quiet', '-m', 'Counter step'], {
      allowFailure: true,
    })
    expect(allowed.code).toBe(0)
    expect(await task.git.revParse('HEAD')).not.toBe(before)
  })
})

describe('AC80/commit: the secret scan at commit', () => {
  test('a test secret that matches a HackWin pattern but no pattern GitHub recognizes is blocked at commit', async () => {
    const config = teamConfig(3)
    config.hackwin.gate.secret_patterns = [TEAM_PATTERN]
    const hooks = await createHookFixture({
      config: { hackwin: config.hackwin, owners: config.owners },
    })
    const clone = await hooks.joinedClone('builder1')
    const task = await hooks.taskWorktree(clone, 14, 'Counter key')
    const before = await task.git.revParse('HEAD')

    const result = await commit(task.git, {
      'src/features/counter/key.js': `export const key = '${teamSecret}'\n`,
    })

    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain(
      'rule: E6: no env file other than .env.example and no secret is committed',
    )
    expect(result.stderr).toContain('- src/features/counter/key.js:1: gate.secret_patterns[0]')
    expect(result.stderr).toContain(
      `to resolve: run \`cd ${task.path} && git restore --staged -- src/features/counter/key.js\``,
    )
    expect(result.stderr).not.toContain(teamSecret)
    expect(await task.git.revParse('HEAD')).toBe(before)
  })
})

describe('1.4a/pre-commit: what the hook checks on which branch', () => {
  test('a built-in secret pattern is blocked and the finding never holds the matched text', async () => {
    const hooks = await createHookFixture()
    const clone = await hooks.joinedClone('builder1')
    const task = await hooks.taskWorktree(clone, 15, 'Counter token')
    await stage(task.git, { 'src/features/counter/token.js': `const t = '${githubToken}'\n` })

    const { code, json } = await runHook('pre-commit', { cwd: task.path, env: hooks.env })

    expect(code).toBe(1)
    expect(json.error).toMatchObject({
      kind: 'blocked',
      rule: 'E6: no env file other than .env.example and no secret is committed',
      objects: ['src/features/counter/token.js:1: github-token'],
      resolve: {
        command: 'git restore --staged -- src/features/counter/token.js',
        dir: task.path,
      },
    })
    expect(JSON.stringify(json)).not.toContain(githubToken)
  })

  test('an env file other than .env.example is blocked; .env.example is not', async () => {
    const hooks = await createHookFixture()
    const clone = await hooks.joinedClone('lead')
    const task = await hooks.taskWorktree(clone, 16, 'Shared env')

    await stage(task.git, { '.env.example': 'API_KEY=\n' })
    expect((await runHook('pre-commit', { cwd: task.path, env: hooks.env })).code).toBe(0)

    await stage(task.git, { '.env.local': 'API_KEY=value\n' })
    const { code, json } = await runHook('pre-commit', { cwd: task.path, env: hooks.env })
    expect(code).toBe(1)
    expect(json.error.objects).toEqual(['.env.local: env-file'])
  })

  test('a spike branch skips the scope check but not the secret scan', async () => {
    const hooks = await createHookFixture()
    const clone = await hooks.joinedClone('builder1')
    await clone.git.run(['switch', '--quiet', '-c', 'spike/greeting-idea', 'origin/main'])

    await stage(clone.git, { 'src/features/greeting/idea.js': 'export const idea = 1\n' })
    expect((await runHook('pre-commit', { cwd: clone.path, env: hooks.env })).code).toBe(0)

    await stage(clone.git, { 'src/features/greeting/key.js': `const t = '${githubToken}'\n` })
    const { code, json } = await runHook('pre-commit', { cwd: clone.path, env: hooks.env })
    expect(code).toBe(1)
    expect(json.error.rule).toMatch(/^E6:/)
  })

  test('other branches and a detached HEAD are not member work and pass unchecked', async () => {
    const hooks = await createHookFixture()
    const clone = await hooks.joinedClone('builder1')
    const files = {
      'src/features/greeting/hello.js': 'export const hello = 1\n',
      '.env.local': 'API_KEY=value\n',
    }

    await clone.git.run(['switch', '--quiet', '-c', 'experiment', 'origin/main'])
    await stage(clone.git, files)
    expect((await runHook('pre-commit', { cwd: clone.path, env: hooks.env })).code).toBe(0)

    await clone.git.run(['switch', '--quiet', '--detach'])
    expect((await runHook('pre-commit', { cwd: clone.path, env: hooks.env })).code).toBe(0)
  })

  test('the files that a merge of main brings in do not count against the scope', async () => {
    const hooks = await createHookFixture()
    const clone = await hooks.joinedClone('builder1')
    const task = await hooks.taskWorktree(clone, 17, 'Counter reset')
    expect((await commit(task.git, { 'src/features/counter/reset.js': 'export {}\n' })).code).toBe(
      0,
    )
    await hooks.fixture.publish({ 'src/features/greeting/hello.js': 'export const hello = 1\n' })
    await task.git.fetch()

    await task.git.run(['merge', '--quiet', '--no-ff', '--no-commit', 'origin/main'])
    const merged = await task.git.run(['commit', '--quiet', '--no-edit'], { allowFailure: true })

    expect(merged.stderr).toBe('')
    expect(merged.code).toBe(0)
    expect(await task.git.tryRevParse('HEAD^2')).toBe(await task.git.revParse('origin/main'))
  })

  test('a rename counts both paths, so moving a file out of another role is outside the scope', async () => {
    const hooks = await createHookFixture()
    await hooks.fixture.publish({ 'src/features/greeting/hello.js': 'export const hello = 1\n' })
    const clone = await hooks.joinedClone('builder1')
    const task = await hooks.taskWorktree(clone, 18, 'Move hello')
    mkdirSync(join(task.path, 'src/features/counter'), { recursive: true })
    await task.git.run(['mv', 'src/features/greeting/hello.js', 'src/features/counter/hello.js'])

    const { code, json } = await runHook('pre-commit', { cwd: task.path, env: hooks.env })

    expect(code).toBe(1)
    expect(json.error.objects).toEqual([
      `src/features/greeting/hello.js: role greeting, held by ${accounts.builder2.login}`,
    ])
  })
})

describe('1.4a/pre-commit: identity and version', () => {
  test('without the join record the hook exits 2 and names hackwin join', async () => {
    const hooks = await createHookFixture()
    const { path } = await hooks.fixture.clone('not-joined')
    const git = hooks.gitAt(path)
    await git.run(['switch', '--quiet', '-c', 'task/19-counter', 'origin/main'])
    await stage(git, { 'src/features/counter/a.js': 'export {}\n' })

    const { code, json } = await runHook('pre-commit', { cwd: path, env: hooks.env })

    expect(code).toBe(2)
    expect(json.error).toMatchObject({
      kind: 'precondition',
      resolve: { command: 'hackwin join', dir: path },
    })
  })

  test('a recorded login outside the team exits 2 and tells the member to ask the Lead', async () => {
    const hooks = await createHookFixture()
    const { path } = await hooks.fixture.joinedClone({ name: 'outsider', login: 'not-in-team' })
    const git = hooks.gitAt(path)
    await git.run(['switch', '--quiet', '-c', 'task/20-counter', 'origin/main'])
    await stage(git, { 'src/features/counter/a.js': 'export {}\n' })

    const { code, json } = await runHook('pre-commit', { cwd: path, env: hooks.env })

    expect(code).toBe(2)
    expect(json.error.message).toContain('not-in-team is not a member of the team')
    expect(json.error.resolve).toBe('ask the Lead to add you to `hackwin.yml`')
  })

  test('CM12 offline: a CLI older than the version pinned on the local origin/main exits 2 with the install command', async () => {
    const running = semver.parse(VERSION)
    const newer = `${running?.major}.${running?.minor}.${(running?.patch ?? 0) + 1}`
    const hooks = await createHookFixture({ config: pinnedConfig(newer) })
    const clone = await hooks.joinedClone('builder1')

    const { code, json } = await runHook('pre-commit', { cwd: clone.path, env: hooks.env })

    expect(code).toBe(2)
    expect(json.error.message).toContain(`is older than ${newer}`)
    expect(json.error.resolve.command).toBe(`npm install -g hackwin@${newer}`)
  })

  test('CM12 offline: a newer bug fix release of the same phase warns and continues', async () => {
    const running = semver.parse(VERSION)
    const older = `${running?.major}.${running?.minor}.0-0`
    const hooks = await createHookFixture({ config: pinnedConfig(older) })
    const clone = await hooks.joinedClone('builder1')
    const task = await hooks.taskWorktree(clone, 21, 'Counter')
    await stage(task.git, { 'src/features/counter/a.js': 'export {}\n' })

    const { code, json } = await runHook('pre-commit', { cwd: task.path, env: hooks.env })

    expect(code).toBe(0)
    expect(json.warnings).toEqual([
      `hackwin ${VERSION} is newer than ${older}, the version pinned in hackwin.yml; continuing`,
    ])
  })
})

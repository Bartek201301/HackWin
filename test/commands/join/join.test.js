import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { delimiter, join } from 'node:path'
import { Readable } from 'node:stream'
import { parse } from 'yaml'
import { VERSION } from '../../../src/cli/context.js'
import { main } from '../../../src/cli/main.js'
import { createFakeClock, exec } from '../../../src/core/runtime/index.js'
import { isJoinComplete, readLocal } from '../../../src/core/state/index.js'
import { checkNode, envKeys } from '../../../src/commands/join/checks.js'
import { withSettingsBlock } from '../../../src/commands/join/settings.js'
import { accounts, createFakeGitHub, httpError, teamConfig, yaml } from '../../harness/index.js'
import { createHookFixture } from '../../internal/hook/hook-fixture.js'

/** @typedef {import('../../harness/index.js').FakeGitHub} FakeGitHub */

// removeMergedWorktrees as it is, unless a test rewords the reasons it gives for the worktrees it
// keeps, as a later wording of src/core/worktrees might: join reads `merged`, not the reason.
const keptReasons = vi.hoisted(() => ({ reword: false }))
vi.mock('../../../src/core/worktrees/index.js', async (importOriginal) => {
  /** @type {typeof import('../../../src/core/worktrees/index.js')} */
  const actual = await importOriginal()
  /** @type {Record<string, string>} */
  const reworded = {
    'its pull request is not merged': 'the task is still open',
    'it is the current worktree': 'join runs in it',
  }
  return {
    ...actual,
    /** @type {typeof actual.removeMergedWorktrees} */
    removeMergedWorktrees: async (git, github) => {
      const result = await actual.removeMergedWorktrees(git, github)
      if (!keptReasons.reword) return result
      const kept = result.kept.map((entry) => ({
        ...entry,
        reason: reworded[entry.reason] ?? entry.reason,
      }))
      return { ...result, kept }
    },
  }
})
afterEach(() => {
  keptReasons.reword = false
})

const LEAD = accounts.lead.login
const BUILDER1 = accounts.builder1.login // counter, todos

/** The checks of the checklist, in order (7.2 steps 1 to 10 without step 8). */
const CHECK_NAMES = [
  'identity',
  'github',
  'git',
  'node',
  'agent',
  'install',
  'hooks',
  'settings',
  '.env.local',
  'worktrees',
  'queue',
]

/** What the install of the tests leaves behind: a marker in the ignored node_modules/, as npm ci would. */
const INSTALL_MARKER = 'node_modules/.hackwin-install'

/**
 * A team repository of 3 members whose main holds the hook shims, with `hackwin` and a `claude`
 * command on PATH. With `nodeProject` main is the Node fixture, whose .gitignore holds the
 * entries of 6.4 and whose package.json matches `paths.manifests`; its install runs offline.
 * @param {{ nodeProject?: boolean }} [options]
 */
async function createJoinFixture({ nodeProject = true } = {}) {
  /** @type {Parameters<typeof createHookFixture>[0]} */
  let options = {}
  if (nodeProject) {
    const config = teamConfig(3)
    config.hackwin.commands.install = `mkdir -p node_modules && pwd > ${INSTALL_MARKER}`
    options = { nodeProject: true, config: { hackwin: config.hackwin, owners: config.owners } }
  }
  const hooks = await createHookFixture(options)
  const { fixture } = hooks
  const agentBin = join(fixture.dir, 'agent-bin')
  mkdirSync(agentBin)
  writeFileSync(join(agentBin, 'claude'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(agentBin, 'claude'), 0o755)
  const answers = writeAnswers(fixture.dir, 'answers.yml', {
    language: 'Polish',
    explanation_style: 'step by step',
  })
  return {
    hooks,
    fixture,
    /** The environment with `hackwin` and `claude` on PATH. */
    env: { ...hooks.env, PATH: `${agentBin}${delimiter}${hooks.env.PATH}` },
    /** An answers file with both answers of join. */
    answers,
  }
}

/**
 * @param {string} dir
 * @param {string} name
 * @param {Record<string, unknown>} content
 */
function writeAnswers(dir, name, content) {
  const file = join(dir, name)
  writeFileSync(file, yaml(content))
  return file
}

/**
 * Run `hackwin join` in-process in a checkout, as this login, against the fake GitHub.
 * @param {string} cwd
 * @param {object} options
 * @param {Record<string, string | undefined>} options.env
 * @param {FakeGitHub} options.fake
 * @param {string} [options.login]
 * @param {string[]} [options.args]
 * @param {string[]} [options.input] Lines typed in the terminal.
 * @param {boolean} [options.tty] stdin and stdout are terminals: the caller is `terminal`.
 * @param {import('../../../src/core/runtime/index.js').Clock} [options.clock]
 */
async function runJoin(cwd, { env, fake, login = BUILDER1, args = [], input = [], tty, clock }) {
  let stdout = ''
  let stderr = ''
  const stdin = Object.assign(Readable.from(input), { isTTY: Boolean(tty) })
  const code = await main(['join', ...args], {
    cwd,
    env,
    stdin,
    stdout: { write: (chunk) => (stdout += chunk), isTTY: Boolean(tty) },
    stderr: { write: (chunk) => (stderr += chunk) },
    ghExecutor: fake.as(login),
    clock,
  })
  return { code, stdout, stderr, lines: stdout.split('\n') }
}

/**
 * The checklist lines of an output: one per check, with its mark.
 * @param {string[]} lines
 */
function checklist(lines) {
  return lines.filter((line) => /^(?:pass|fail|skip) {2}/.test(line))
}

/**
 * A PATH with `hackwin`, git and the system tools, but no agent command, even when one is
 * installed on this machine.
 * @param {string} dir The fixture's directory.
 */
async function pathWithoutAgent(dir) {
  const git = await exec('sh', ['-c', 'command -v git'])
  const bin = join(dir, 'git-only')
  mkdirSync(bin)
  symlinkSync(git.stdout.trim(), join(bin, 'git'))
  return [join(dir, 'bin'), bin, '/bin', '/usr/bin'].join(delimiter)
}

/**
 * The body of a task issue (8.1).
 * @param {{ role: string, paths: string[], wave?: number, deadline?: string }} block
 */
function taskBody({ role, paths, wave = 1, deadline = '2026-10-25T12:00:00+02:00' }) {
  return [
    '```yaml',
    yaml({
      kind: 'task',
      role,
      wave,
      paths,
      depends_on: [],
      acceptance_tests: ['test/features.test.js'],
      deadline,
    })
      .trimEnd()
      .replace(/^/, '# hackwin:task\n'),
    '```',
    '',
    '## Problem',
    'Something is missing.',
  ].join('\n')
}

describe('AC5: join on a builder account passes every check, activates the hooks, writes the local files and leaves git status clean; .env.local is required by .env.example and never opened', () => {
  test('every check passes, core.hooksPath is .githooks, local.yml and CLAUDE.local.md exist, and git status is clean', async () => {
    const { fixture, env, answers } = await createJoinFixture()
    const clone = await fixture.clone('builder1')
    const fake = createFakeGitHub()

    const result = await runJoin(clone.path, { env, fake, args: ['--answers', answers] })

    expect(result.code).toBe(0)
    const lines = checklist(result.lines)
    expect(lines.map((line) => line.slice(0, 6))).toEqual(CHECK_NAMES.map(() => 'pass  '))
    expect(lines.map((line) => line.slice(6, line.indexOf(': ')))).toEqual(CHECK_NAMES)
    expect(lines).toContain(`pass  identity: ${BUILDER1} is Builder One, roles counter, todos`)
    expect(lines).toContain(
      `pass  github: gh is logged in as ${BUILDER1}, with write access to hackwin-test/app`,
    )
    expect(lines).toContain(
      'pass  hooks: core.hooksPath set to .githooks; the self test passed for pre-commit and pre-push',
    )
    expect(result.stdout).toContain(`join complete for ${BUILDER1}: every check passed`)

    // The install ran in the main checkout of the clone.
    expect(readFileSync(join(clone.path, INSTALL_MARKER), 'utf8').trim()).toBe(clone.path)
    expect(await clone.git.configGet('core.hooksPath')).toBe('.githooks')

    const commonDir = await clone.git.commonDir()
    const record = await readLocal(commonDir)
    expect(record).toEqual({
      schema: 1,
      login: BUILDER1,
      language: 'Polish',
      explanation_style: 'step by step',
      join: { completed_at: expect.any(String), cli_version: VERSION },
    })
    expect(isJoinComplete(record, BUILDER1)).toBe(true)
    const claudeLocal = readFileSync(join(clone.path, 'CLAUDE.local.md'), 'utf8')
    expect(claudeLocal).toContain('- Answer language: Polish. Answer the human in this language.')
    expect(claudeLocal).toContain('- Explanation style: step by step.')

    const status = await clone.git.run(['status', '--porcelain', '--untracked-files=all'])
    expect(status.stdout).toBe('')
  })

  test('with a key in .env.example and no .env.local it exits 1 naming the Lead; with an unreadable .env.local it passes', async () => {
    const { fixture, env, answers } = await createJoinFixture()
    await fixture.commit('Add a key to .env.example', {
      files: { '.env.example': '# The key of the payment API\nPAYMENT_API_KEY=\n' },
      push: true,
    })
    const clone = await fixture.clone('builder1')
    const fake = createFakeGitHub()
    const envLocal = join(clone.path, '.env.local')

    const missing = await runJoin(clone.path, { env, fake, args: ['--answers', answers] })

    expect(missing.code).toBe(1)
    const failed = checklist(missing.lines).filter((line) => line.startsWith('fail'))
    expect(failed).toEqual([
      `fail  .env.local: .env.example lists 1 key, but ${envLocal} does not exist`,
    ])
    expect(missing.stdout).toContain(
      `      fix: ask the Lead for .env.local, sent over a private channel, and save it as ${envLocal}`,
    )
    expect(missing.stdout).toContain(
      `join not complete: 1 of 11 checks failed (.env.local); fix them, then run \`hackwin join\` in ${clone.path}`,
    )
    // The checks after it still ran.
    expect(checklist(missing.lines).at(-1)).toMatch(/^pass {2}queue: /)
    const commonDir = await clone.git.commonDir()
    expect(isJoinComplete(await readLocal(commonDir), BUILDER1)).toBe(false)

    writeFileSync(envLocal, 'PAYMENT_API_KEY=not-a-real-key\n')
    chmodSync(envLocal, 0o000)

    const unreadable = await runJoin(clone.path, { env, fake, args: ['--answers', answers] })

    expect(unreadable.code).toBe(0)
    expect(checklist(unreadable.lines)).toContain(
      `pass  .env.local: ${envLocal} is there for the 1 key of .env.example`,
    )
    expect(isJoinComplete(await readLocal(commonDir), BUILDER1)).toBe(true)
    const status = await clone.git.run(['status', '--porcelain', '--untracked-files=all'])
    expect(status.stdout).toBe('')
  })
})

describe('AC76/join: in a repository whose manifest does not exist yet, join skips the install with a notice', () => {
  test('no file matches paths.manifests: the install is skipped, every other check passes and join completes', async () => {
    const { fixture, env, answers } = await createJoinFixture({ nodeProject: false })
    const clone = await fixture.clone('builder1')
    expect(existsSync(join(clone.path, 'package.json'))).toBe(false)

    const result = await runJoin(clone.path, {
      env,
      fake: createFakeGitHub(),
      args: ['--answers', answers],
    })

    expect(result.code).toBe(0)
    const lines = checklist(result.lines)
    expect(lines).toContain('skip  install: no file matches paths.manifests (package.json)')
    expect(lines.filter((line) => !line.startsWith('pass'))).toEqual([
      'skip  install: no file matches paths.manifests (package.json)',
    ])
    expect(existsSync(join(clone.path, 'node_modules'))).toBe(false)
    expect(isJoinComplete(await readLocal(await clone.git.commonDir()), BUILDER1)).toBe(true)
  })
})

describe('1.4e/rerun: a second join changes nothing and creates no duplicate', () => {
  test('the hooks path, CLAUDE.local.md, the local files and git status stay as they were; only the time of the join record moves', async () => {
    const { fixture, env, answers } = await createJoinFixture()
    const clone = await fixture.clone('builder1')
    const fake = createFakeGitHub()
    const clock = createFakeClock('2026-10-24T09:00:00.000Z')
    const commonDir = await clone.git.commonDir()

    const first = await runJoin(clone.path, { env, fake, clock, args: ['--answers', answers] })
    expect(first.code).toBe(0)

    const snapshot = async () => ({
      hooksPath: (await clone.git.run(['config', '--get-all', 'core.hooksPath'])).stdout,
      claudeLocal: readFileSync(join(clone.path, 'CLAUDE.local.md'), 'utf8'),
      local: parse(readFileSync(join(commonDir, 'hackwin', 'local.yml'), 'utf8')),
      state: readdirSync(join(commonDir, 'hackwin'), { recursive: true }).sort(),
      status: (await clone.git.run(['status', '--porcelain', '--ignored', '--untracked-files=all']))
        .stdout,
      worktrees: (await clone.git.run(['worktree', 'list', '--porcelain'])).stdout,
    })
    const before = await snapshot()
    clock.advance(60 * 60 * 1000)

    const second = await runJoin(clone.path, { env, fake, clock, args: ['--answers', answers] })

    expect(second.code).toBe(0)
    expect(checklist(second.lines)).toContain(
      'pass  hooks: core.hooksPath is .githooks; the self test passed for pre-commit and pre-push',
    )
    const after = await snapshot()
    expect(after.hooksPath).toBe('.githooks\n')
    expect(after.claudeLocal.match(/<!-- hackwin:begin -->/g)).toHaveLength(1)
    expect({ ...after, local: null }).toEqual({ ...before, local: null })
    expect(before.local.join.completed_at).toBe('2026-10-24T09:00:00.000Z')
    expect(after.local).toEqual({
      ...before.local,
      join: { ...before.local.join, completed_at: '2026-10-24T10:00:00.000Z' },
    })
  })
})

describe('1.4e/identity: a login outside the team exits 2 and is told to ask the Lead', () => {
  test('nothing is written and the hooks stay as they were', async () => {
    const { fixture, env, answers } = await createJoinFixture({ nodeProject: false })
    const clone = await fixture.clone('stranger')

    const result = await runJoin(clone.path, {
      env,
      fake: createFakeGitHub(),
      login: 'not-on-the-team',
      args: ['--answers', answers],
    })

    expect(result.code).toBe(2)
    expect(result.stderr).toContain(
      'hackwin join: the gh login not-on-the-team is not a member of the team in hackwin.yml',
    )
    expect(result.stderr).toContain('to resolve: ask the Lead to add you to `hackwin.yml`')
    expect(result.stdout).toBe('')
    expect(await readLocal(await clone.git.commonDir())).toBeNull()
    expect(await clone.git.configGet('core.hooksPath')).toBeNull()
  })
})

describe('1.4e/checklist: a failed check prints its fix and the others continue', () => {
  test('without write access and without the agent command join exits 1, names both fixes, runs every other check and writes no join record', async () => {
    const { fixture, env, answers } = await createJoinFixture()
    const clone = await fixture.clone('builder1')
    const fake = createFakeGitHub({ collaborators: { [LEAD]: 'admin', [BUILDER1]: 'read' } })

    const result = await runJoin(clone.path, {
      env: { ...env, PATH: await pathWithoutAgent(fixture.dir) },
      fake,
      args: ['--answers', answers],
    })

    expect(result.code).toBe(1)
    const lines = checklist(result.lines)
    expect(lines).toHaveLength(CHECK_NAMES.length)
    expect(lines.filter((line) => line.startsWith('fail'))).toEqual([
      `fail  github: ${BUILDER1} has no write access to hackwin-test/app`,
      `fail  agent: claude, the agent of ${BUILDER1} in hackwin.yml, is not on the PATH`,
    ])
    expect(result.stdout).toContain(
      `      fix: ask the Lead to give ${BUILDER1} write access to hackwin-test/app, then accept the invitation GitHub sends`,
    )
    expect(result.stdout).toContain(
      '      fix: install Claude Code so that the `claude` command is on the PATH',
    )
    expect(result.stdout).toContain(
      `join not complete: 2 of 11 checks failed (github, agent); fix them, then run \`hackwin join\` in ${clone.path}`,
    )
    // The steps after the failures did their work.
    expect(await clone.git.configGet('core.hooksPath')).toBe('.githooks')
    const record = await readLocal(await clone.git.commonDir())
    expect(record).toEqual({
      schema: 1,
      login: BUILDER1,
      language: 'Polish',
      explanation_style: 'step by step',
    })
  })

  test('with --json the checklist goes to stderr and stdout carries the result with every check', async () => {
    const { fixture, env, answers } = await createJoinFixture()
    const clone = await fixture.clone('builder1')

    const result = await runJoin(clone.path, {
      env,
      fake: createFakeGitHub(),
      args: ['--answers', answers, '--json'],
    })

    expect(result.code).toBe(0)
    const json = JSON.parse(result.stdout)
    expect(json).toMatchObject({ command: 'join', ok: true, exitCode: 0 })
    expect(json.data.checks.map((/** @type {any} */ check) => check.name)).toEqual(CHECK_NAMES)
    expect(json.data.join).toEqual({ completed_at: expect.any(String), cli_version: VERSION })
    expect(result.stderr).toContain('pass  queue: ')
  })

  test('a GitHub failure fails its check, the other checks still run, and join exits 3', async () => {
    const { fixture, env, answers } = await createJoinFixture()
    const clone = await fixture.clone('builder1')
    const fake = createFakeGitHub()
    fake.on('GET repos/{owner}/{repo}/issues', () => {
      throw httpError(502, 'Bad Gateway')
    })

    const result = await runJoin(clone.path, { env, fake, args: ['--answers', answers] })

    expect(result.code).toBe(3)
    const lines = checklist(result.lines)
    expect(lines).toHaveLength(CHECK_NAMES.length)
    expect(lines.at(-1)).toMatch(/^fail {2}queue: .*HTTP 502/)
    expect(result.stderr).toMatch(/^hackwin join: .*HTTP 502/m)
    expect(isJoinComplete(await readLocal(await clone.git.commonDir()), BUILDER1)).toBe(false)
  })

  test('Node 22 or later passes; an older Node fails and names the minimum', () => {
    expect(checkNode('22.0.0')).toEqual({ result: 'passed', detail: 'Node 22.0.0' })
    expect(checkNode('v24.11.1')).toEqual({ result: 'passed', detail: 'Node 24.11.1' })
    expect(checkNode('v20.18.1')).toEqual({
      result: 'failed',
      detail: 'Node 20.18.1 is older than 22, the oldest version hackwin runs on',
      fixes: ['install Node 22 or later'],
    })
  })

  test('the keys of .env.example are its KEY= lines, not its comments or blank lines', () => {
    expect(envKeys(null)).toEqual([])
    expect(envKeys('')).toEqual([])
    expect(envKeys('# API_KEY=\n\n')).toEqual([])
    expect(envKeys('API_KEY=\nexport DB_URL=postgres://localhost\r\n  SPACED = 1\n')).toEqual([
      'API_KEY',
      'DB_URL',
      'SPACED',
    ])
  })
})

describe('1.4e/settings: the answer language and the explanation style come from the terminal, the answers file or the earlier join', () => {
  test('in an interactive terminal join asks both questions; Enter keeps the default', async () => {
    const { fixture, env } = await createJoinFixture()
    const clone = await fixture.clone('builder1')

    const result = await runJoin(clone.path, {
      env,
      fake: createFakeGitHub(),
      tty: true,
      input: ['Polish\n', '\n'],
    })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Answer language of your agent sessions [en]: ')
    expect(result.stdout).toContain(
      'Explanation style, for example concise or step by step [concise]: ',
    )
    expect(checklist(result.lines)).toContain(
      'pass  settings: answer language Polish, explanation style concise, in local.yml and CLAUDE.local.md',
    )
    expect(await readLocal(await clone.git.commonDir())).toMatchObject({
      language: 'Polish',
      explanation_style: 'concise',
    })
  })

  test('outside a terminal without answers the settings check fails and names the fix; later runs reuse the earlier answers', async () => {
    const { fixture, env, answers } = await createJoinFixture()
    const clone = await fixture.clone('builder1')
    const fake = createFakeGitHub()

    const without = await runJoin(clone.path, { env, fake })

    expect(without.code).toBe(1)
    expect(checklist(without.lines).filter((line) => line.startsWith('fail'))).toEqual([
      'fail  settings: no language and explanation_style: join asks for them in an interactive terminal, or reads them from --answers <file>',
    ])
    expect(without.stdout).toContain(`      fix: run \`hackwin join\` in ${clone.path}`)
    expect(existsSync(join(clone.path, 'CLAUDE.local.md'))).toBe(false)

    expect((await runJoin(clone.path, { env, fake, args: ['--answers', answers] })).code).toBe(0)
    const again = await runJoin(clone.path, { env, fake })

    expect(again.code).toBe(0)
    expect(checklist(again.lines)).toContain(
      'pass  settings: answer language Polish, explanation style step by step, in local.yml and CLAUDE.local.md',
    )
  })

  test('new answers replace the block of CLAUDE.local.md and keep the lines the member wrote', async () => {
    const { fixture, env, answers } = await createJoinFixture()
    const clone = await fixture.clone('builder1')
    const fake = createFakeGitHub()
    const file = join(clone.path, 'CLAUDE.local.md')
    writeFileSync(file, '# My notes\n\nPrefer small commits.\n')

    expect((await runJoin(clone.path, { env, fake, args: ['--answers', answers] })).code).toBe(0)
    const other = writeAnswers(fixture.dir, 'other.yml', {
      language: 'English',
      explanation_style: 'concise',
    })
    expect((await runJoin(clone.path, { env, fake, args: ['--answers', other] })).code).toBe(0)

    const text = readFileSync(file, 'utf8')
    expect(text).toBe(
      withSettingsBlock('# My notes\n\nPrefer small commits.\n', {
        language: 'English',
        explanation_style: 'concise',
      }),
    )
    expect(text.startsWith('# My notes\n\nPrefer small commits.\n\n<!-- hackwin:begin -->')).toBe(
      true,
    )
    expect(text.match(/<!-- hackwin:begin -->/g)).toHaveLength(1)
    expect(text).not.toContain('Polish')
  })

  test('an answers file that does not exist exits 2 before any check and writes nothing', async () => {
    const { fixture, env } = await createJoinFixture({ nodeProject: false })
    const clone = await fixture.clone('builder1')
    const file = join(fixture.dir, 'missing.yml')

    const result = await runJoin(clone.path, {
      env,
      fake: createFakeGitHub(),
      args: ['--answers', file],
    })

    expect(result.code).toBe(2)
    expect(result.stderr).toContain(`hackwin join: cannot read the answers file ${file}: ENOENT`)
    expect(checklist(result.lines)).toEqual([])
    expect(await readLocal(await clone.git.commonDir())).toBeNull()
    expect(await clone.git.configGet('core.hooksPath')).toBeNull()
  })
})

describe("1.4e/worktrees: join removes the worktrees of merged tasks and shows the member's queue", () => {
  test("a merged task loses its worktree, an open one keeps it, and the queue lists the open tasks of the member's roles", async () => {
    const { fixture, env, answers } = await createJoinFixture({ nodeProject: false })
    const clone = await fixture.clone('builder1')
    const fake = createFakeGitHub({
      issues: [
        {
          number: 3,
          title: 'Todo list',
          body: taskBody({ role: 'todos', paths: ['src/features/todos/**'], wave: 2 }),
          labels: ['ready'],
        },
        {
          number: 4,
          title: 'Counter reset',
          body: taskBody({ role: 'counter', paths: ['src/features/counter/**'] }),
          labels: ['blocked'],
        },
        {
          number: 5,
          title: 'Greeting',
          body: taskBody({ role: 'greeting', paths: ['src/features/greeting/**'] }),
          labels: ['ready'],
        },
        {
          number: 6,
          title: 'Counter step',
          body: taskBody({ role: 'counter', paths: ['src/features/counter/**'] }),
          labels: ['in-progress'],
        },
      ],
      pulls: [
        { number: 11, title: 'Counter', head: 'task/1-counter', state: 'closed', merged: true },
        { number: 12, title: 'Todos', head: 'task/2-todos' },
      ],
    })
    await clone.git.fetch()
    const worktrees = join(fixture.dir, 'builder1.worktrees')
    for (const [branch, dir] of [
      ['task/1-counter', '1-counter'],
      ['task/2-todos', '2-todos'],
    ]) {
      await clone.git.worktreeAdd(join(worktrees, dir), {
        branch,
        createBranch: true,
        startPoint: 'origin/main',
      })
    }

    const result = await runJoin(clone.path, { env, fake, args: ['--answers', answers] })

    expect(result.code).toBe(0)
    expect(existsSync(join(worktrees, '1-counter'))).toBe(false)
    expect(existsSync(join(worktrees, '2-todos'))).toBe(true)
    expect(result.stdout).toContain(
      [
        'pass  worktrees: removed 1 worktree of merged tasks',
        `      removed ${join(worktrees, '1-counter')}`,
        'pass  queue: 2 tasks of your roles (counter, todos)',
        '      #4 Counter reset: blocked, role counter, wave 1, due 2026-10-25T12:00:00+02:00',
        '      #3 Todo list: ready, role todos, wave 2, due 2026-10-25T12:00:00+02:00',
      ].join('\n'),
    )
  })

  test('started inside the worktree of a merged task, join keeps that worktree and says why', async () => {
    const { fixture, env, answers } = await createJoinFixture({ nodeProject: false })
    const clone = await fixture.clone('builder1')
    const fake = createFakeGitHub({
      pulls: [
        { number: 11, title: 'Counter', head: 'task/1-counter', state: 'closed', merged: true },
      ],
    })
    await clone.git.fetch()
    const worktree = join(fixture.dir, 'builder1.worktrees', '1-counter')
    await clone.git.worktreeAdd(worktree, {
      branch: 'task/1-counter',
      createBranch: true,
      startPoint: 'origin/main',
    })

    const result = await runJoin(worktree, { env, fake, args: ['--answers', answers] })

    expect(result.code).toBe(0)
    expect(existsSync(worktree)).toBe(true)
    expect(result.stdout).toContain(
      [
        'pass  worktrees: no worktree of a merged task to remove',
        `      kept ${worktree}: it is the current worktree`,
      ].join('\n'),
    )
    // The rest of join works on the main checkout of the clone.
    expect(existsSync(join(clone.path, 'CLAUDE.local.md'))).toBe(true)
    expect(existsSync(join(worktree, 'CLAUDE.local.md'))).toBe(false)
  })

  test('join tells the kept worktrees of merged tasks by the field merged, whatever the text of the reason', async () => {
    const { fixture, env, answers } = await createJoinFixture({ nodeProject: false })
    const clone = await fixture.clone('builder1')
    const fake = createFakeGitHub({
      pulls: [
        { number: 11, title: 'Counter', head: 'task/1-counter', state: 'closed', merged: true },
        { number: 12, title: 'Todos', head: 'task/2-todos' },
      ],
    })
    await clone.git.fetch()
    const worktrees = join(fixture.dir, 'builder1.worktrees')
    for (const [branch, dir] of [
      ['task/1-counter', '1-counter'],
      ['task/2-todos', '2-todos'],
    ]) {
      await clone.git.worktreeAdd(join(worktrees, dir), {
        branch,
        createBranch: true,
        startPoint: 'origin/main',
      })
    }
    keptReasons.reword = true

    const result = await runJoin(join(worktrees, '1-counter'), {
      env,
      fake,
      args: ['--answers', answers],
    })

    expect(result.code).toBe(0)
    expect(existsSync(join(worktrees, '1-counter'))).toBe(true)
    expect(existsSync(join(worktrees, '2-todos'))).toBe(true)
    const at = result.lines.indexOf('pass  worktrees: no worktree of a merged task to remove')
    expect(at).toBeGreaterThanOrEqual(0)
    expect(result.lines.slice(at + 1, at + 3)).toEqual([
      `      kept ${join(worktrees, '1-counter')}: join runs in it`,
      `pass  queue: empty: no open task of your roles (counter, todos) waits to be taken`,
    ])
    expect(result.stdout).not.toContain(join(worktrees, '2-todos'))
  })
})

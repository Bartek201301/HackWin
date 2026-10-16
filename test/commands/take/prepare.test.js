import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { readMainSeen } from '../../../src/core/state/index.js'
import { accounts, createFakeGitHub, hackwinObject, yaml } from '../../harness/index.js'
import {
  DEADLINE,
  agentBin,
  expectInOrder,
  promptFileOf,
  take,
  task,
  teamFixture,
  worktreeOf,
} from './helpers.js'

/** @typedef {import('../../harness/index.js').Fixture} Fixture */

const LEAD = accounts.lead.login
const BUILDER1 = accounts.builder1.login // counter, todos
const BUILDER2 = accounts.builder2.login // greeting

describe('AC11: take <N> creates a worktree on a task/ branch whose base is the current origin/main, sets in-progress, and outputs a prompt that contains all seven parts of section 7.7 step 6', () => {
  test('in a terminal, take 7 claims the task, creates the worktree from the newest main and starts Claude Code in it with the prompt', async () => {
    const fixture = await teamFixture('ac11')
    const clone = await fixture.joinedClone({
      name: 'builder1',
      login: BUILDER1,
      language: 'pl',
      explanation_style: 'step by step',
    })
    // main moves after the clone was made, so the base must come from the fetch.
    const mainSha = await fixture.publish(
      { 'src/features/counter/value.js': 'export const value = 1\n' },
      { message: 'Counter value' },
    )
    const fake = createFakeGitHub({
      issues: [
        {
          ...task(7, {
            title: 'Counter reset button',
            role: 'counter',
            paths: ['src/features/counter/reset/**'],
            acceptance_tests: ['test/counter/reset.test.js'],
          }),
          comments: [
            { body: 'A question that is not a scope change.', author: BUILDER2 },
            { body: 'Scope change: the button also clears the history.', author: LEAD },
          ],
        },
      ],
    })
    const agents = agentBin(fixture, 'ac11')

    const result = await take(fixture, clone.path, fake, BUILDER1, ['7'], {
      env: agents.env,
      tty: true,
    })
    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)

    // The worktree, on its task branch, at the current origin/main, without an upstream.
    const worktree = worktreeOf(fixture, 'builder1', '7-counter-reset-button')
    expect(await worktree.git.currentBranch()).toBe('task/7-counter-reset-button')
    expect(await worktree.git.revParse('HEAD')).toBe(mainSha)
    const upstream = await worktree.git.run(['rev-parse', '--abbrev-ref', '@{upstream}'], {
      allowFailure: true,
    })
    expect(upstream.code).not.toBe(0)

    // The claim: in-progress in place of ready, the caller as assignee, the role label.
    const issue = fake.find(7)
    expect(issue?.labels.sort()).toEqual(['in-progress', 'role:counter'])
    expect(issue?.assignees).toEqual([BUILDER1])

    // Claude Code started in the worktree with the prompt as its one argument.
    const promptFile = promptFileOf(clone, 7)
    const prompt = readFileSync(promptFile, 'utf8')
    expect(agents.call('claude')).toEqual({ cwd: worktree.path, args: [prompt] })
    expect(agents.called('codex')).toBe(false)
    expect(result.stdout).toContain(`prompt: ${promptFile}`)
    expect(result.stdout).toContain(`starting Claude Code in ${worktree.path}`)
    expect(result.stdout).toContain('the Claude Code session of #7 ended with exit code 0')

    // The seven parts, in order.
    expectInOrder(prompt, [
      '# Task #7: Counter reset button',
      '## 1. The task',
      '### Problem',
      'Something is missing.',
      '### Expected result',
      'It exists.',
      '### Acceptance tests',
      '- `test/counter/reset.test.js`',
      '### Deadline',
      `${DEADLINE}. This is the hard stop time`,
      '### Scope changes',
      `${LEAD}, `,
      '> Scope change: the button also clears the history.',
      '## 2. Your role and its paths',
      'Your role for this task is `counter`. It owns these paths:',
      '- `src/features/counter/**`',
      "The task's own paths",
      '- `src/features/counter/reset/**`',
      'Anyone may edit the paths on the open list: `README.md`.',
      'Every other path must not be touched',
      'stop and ask the Lead, who writes a task for it',
      '## 3. Where to run',
      `- Worktree: \`${worktree.path}\``,
      '- Branch: `task/7-counter-reset-button`',
      `Never work in the main checkout, \`${clone.path}\``,
      '## 4. What changed on main',
      `\`origin/main\` is at \`${mainSha}\`.`,
      'No main commit was recorded in this clone before',
      '## 5. When you finish',
      '1. Commit your work on `task/7-counter-reset-button`.',
      `2. Run \`hackwin ship\` in \`${worktree.path}\`.`,
      '3. Stop, and report the pull request number and the full head SHA.',
      'Never merge a pull request',
      '## 6. Security',
      'Never read or print `.env.local`',
      'Leave every database and production config change to the Lead',
      'also not outside the repository',
      '## 7. Personal settings',
      '- Answer in this language: pl.',
      '- Explanation style: step by step.',
      '- Code, comments, commits, issues and pull requests stay in the project language: en.',
    ])
    expect(prompt).not.toContain('# hackwin:task')
    expect(prompt).not.toContain('A question that is not a scope change.')

    // take recorded the main commit of the prompt for the worktree.
    expect((await readMainSeen(clone.commonDir, worktree.path))?.main_sha).toBe(mainSha)
    fixture.cleanup()
  })
})

describe('1.5b/in-session: with the caller kind claude-code, take prints the prompt file path and the start command instead of starting an agent, and labels and branch are the same as in a terminal', () => {
  test('the same task taken in a terminal and through the wrapper', async () => {
    const fixture = await teamFixture('in-session')
    const inTerminal = await fixture.joinedClone({ name: 'terminal', login: BUILDER1 })
    const inSession = await fixture.joinedClone({ name: 'session', login: BUILDER1 })
    const issues = () => [task(7, { role: 'counter', paths: ['src/features/counter/**'] })]
    const terminalFake = createFakeGitHub({ issues: issues() })
    const sessionFake = createFakeGitHub({ issues: issues() })
    const agents = agentBin(fixture, 'in-session')

    const terminal = await take(fixture, inTerminal.path, terminalFake, BUILDER1, ['7'], {
      env: agents.env,
      tty: true,
    })
    expect(terminal.code).toBe(0)
    expect(agents.called('claude')).toBe(true)
    agents.reset()

    // The wrappers set HACKWIN_CALLER=claude-code; it wins over the terminal.
    const session = await take(fixture, inSession.path, sessionFake, BUILDER1, ['7'], {
      env: { ...agents.env, HACKWIN_CALLER: 'claude-code' },
      tty: true,
    })
    expect(session.code).toBe(0)
    expect(agents.called('claude')).toBe(false)

    const worktree = worktreeOf(fixture, 'session', '7-task-7')
    const promptFile = promptFileOf(inSession, 7)
    const command = `claude "$(cat ${promptFile})"`
    expect(session.stdout.trimEnd().split('\n').slice(-2)).toEqual([
      `prompt: ${promptFile}`,
      `start Claude Code for #7 in a new terminal: run \`${command}\` in ${worktree.path}`,
    ])

    // Labels, assignees and branch as in the terminal.
    expect(sessionFake.find(7)?.labels.sort()).toEqual(terminalFake.find(7)?.labels.sort())
    expect(sessionFake.find(7)?.assignees).toEqual(terminalFake.find(7)?.assignees)
    const terminalWorktree = worktreeOf(fixture, 'terminal', '7-task-7')
    expect(await worktree.git.currentBranch()).toBe(await terminalWorktree.git.currentBranch())
    expect(await worktree.git.revParse('HEAD')).toBe(await terminalWorktree.git.revParse('HEAD'))

    // The printed command, run in a new terminal, starts Claude Code there with the prompt.
    execFileSync('/bin/sh', ['-c', `cd ${worktree.path} && ${command}`], { env: agents.env })
    expect(agents.call('claude')).toEqual({
      cwd: worktree.path,
      args: [readFileSync(promptFile, 'utf8').replace(/\n+$/, '')],
    })
    fixture.cleanup()
  })
})

describe('AC72: on a CLI before Phase 3, take for a member whose agent is codex prepares the worktree, sets the label and prints the path of the prompt file and the command that starts Codex (I10)', () => {
  test('in a terminal, take starts no agent and prints the Codex command', async () => {
    const fixture = await teamFixture('codex', (hackwin) => {
      hackwin.team.members[1].agent = 'codex'
    })
    const clone = await fixture.joinedClone({ name: 'builder1', login: BUILDER1 })
    const fake = createFakeGitHub({
      issues: [task(7, { role: 'counter', paths: ['src/features/counter/**'] })],
    })
    const agents = agentBin(fixture, 'codex')

    const result = await take(fixture, clone.path, fake, BUILDER1, ['7'], {
      env: agents.env,
      tty: true,
    })
    expect(result.code).toBe(0)
    expect(agents.called('codex')).toBe(false)
    expect(agents.called('claude')).toBe(false)

    const worktree = worktreeOf(fixture, 'builder1', '7-task-7')
    expect(await worktree.git.currentBranch()).toBe('task/7-task-7')
    expect(fake.find(7)?.labels).toContain('in-progress')
    const promptFile = promptFileOf(clone, 7)
    const command = `codex --cd ${worktree.path} "$(cat ${promptFile})"`
    expect(result.stdout.trimEnd().split('\n').slice(-2)).toEqual([
      `prompt: ${promptFile}`,
      `start Codex for #7 in a new terminal: run \`${command}\` in any directory`,
    ])

    // The printed command starts Codex in the worktree with the prompt (docs/verification.md, row A).
    execFileSync('/bin/sh', ['-c', command], { env: agents.env, cwd: fixture.dir })
    expect(agents.call('codex').args).toEqual([
      '--cd',
      worktree.path,
      readFileSync(promptFile, 'utf8').replace(/\n+$/, ''),
    ])
    fixture.cleanup()
  })
})

describe('AC76/take: in a repository whose manifest does not exist yet, take skips the install with a notice', () => {
  test('no file matches paths.manifests', async () => {
    const fixture = await teamFixture('no-manifest', (hackwin) => {
      hackwin.commands.install = 'pwd -P > .install-ran'
    })
    const clone = await fixture.joinedClone({ name: 'builder1', login: BUILDER1 })
    const fake = createFakeGitHub({
      issues: [task(7, { role: 'counter', paths: ['src/features/counter/**'] })],
    })
    const result = await take(fixture, clone.path, fake, BUILDER1, ['7'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(
      'install skipped: no file matches paths.manifests (package.json)',
    )
    const worktree = worktreeOf(fixture, 'builder1', '7-task-7')
    expect(existsSync(worktree.path)).toBe(true)
    expect(existsSync(join(worktree.path, '.install-ran'))).toBe(false)
    expect(existsSync(promptFileOf(clone, 7))).toBe(true)
    fixture.cleanup()
  })
})

describe('1.5b/install: take runs commands.install in the worktree, and a failed install exits 1 with the log and keeps the worktree and the claim', () => {
  /** @type {Fixture} */
  let fixture
  /** @type {Awaited<ReturnType<Fixture['joinedClone']>>} */
  let clone

  beforeAll(async () => {
    fixture = await teamFixture(
      'install',
      (hackwin) => {
        hackwin.commands.install = 'pwd -P > .install-ran'
      },
      { 'package.json': '{}\n' },
    )
    clone = await fixture.joinedClone({ name: 'builder1', login: BUILDER1 })
  })
  afterAll(() => fixture.cleanup())

  test('the install runs in the new worktree', async () => {
    const fake = createFakeGitHub({
      issues: [task(7, { role: 'counter', paths: ['src/features/counter/**'] })],
    })
    const result = await take(fixture, clone.path, fake, BUILDER1, ['7'])
    expect(result.code).toBe(0)
    const worktree = worktreeOf(fixture, 'builder1', '7-task-7')
    expect(result.stdout).toContain(`install passed in ${worktree.path}: pwd -P > .install-ran`)
    expect(readFileSync(join(worktree.path, '.install-ran'), 'utf8').trim()).toBe(worktree.path)
  })

  test('a failed install exits 1 with the end of its log; the worktree and the claim stay and no prompt is written', async () => {
    const hackwin = hackwinObject(3)
    hackwin.commands.install = "echo 'resolving packages'; echo 'npm ERR! code E404' >&2; exit 7"
    await fixture.publish({ 'hackwin.yml': yaml(hackwin) }, { message: 'Break the install' })
    const fake = createFakeGitHub({
      issues: [task(8, { role: 'todos', paths: ['src/features/todos/**'] })],
    })
    const result = await take(fixture, clone.path, fake, BUILDER1, ['8'])
    expect(result.code).toBe(1)
    const worktree = worktreeOf(fixture, 'builder1', '8-task-8')
    expect(result.stdout).toContain(
      `install failed in ${worktree.path}: \`${hackwin.commands.install}\` exited with code 7`,
    )
    expect(result.stdout).toContain('  resolving packages')
    expect(result.stdout).toContain('  npm ERR! code E404')
    expect(result.stdout).toContain(
      `the worktree and the claim stay; fix the install, then run \`hackwin take 8\` in ${clone.path} to finish the remaining steps`,
    )
    expect(await worktree.git.currentBranch()).toBe('task/8-task-8')
    expect(fake.find(8)?.labels).toContain('in-progress')
    expect(fake.find(8)?.assignees).toEqual([BUILDER1])
    expect(existsSync(promptFileOf(clone, 8))).toBe(false)
  })
})

describe("1.5h/project-env/take: the install runs with the command's environment, not with process.env", () => {
  test('a variable set only in the environment of the command reaches the install, one set only in process.env does not', async () => {
    const fixture = await teamFixture(
      'project-env',
      (hackwin) => {
        hackwin.commands.install = 'echo "${PROBE_CTX-unset} ${PROBE_PROCESS-unset}" > .install-env'
      },
      { 'package.json': '{}\n' },
    )
    const clone = await fixture.joinedClone({ name: 'builder1', login: BUILDER1 })
    const fake = createFakeGitHub({
      issues: [task(7, { role: 'counter', paths: ['src/features/counter/**'] })],
    })
    const env = { ...fixture.env, PROBE_CTX: 'ctx' }
    // After the fixture: its environment is a copy of process.env.
    vi.stubEnv('PROBE_PROCESS', 'process')
    try {
      const result = await take(fixture, clone.path, fake, BUILDER1, ['7'], { env })
      expect(result.code, result.stderr).toBe(0)
    } finally {
      vi.unstubAllEnvs()
    }
    const worktree = worktreeOf(fixture, 'builder1', '7-task-7')
    expect(readFileSync(join(worktree.path, '.install-env'), 'utf8')).toBe('ctx unset\n')
    fixture.cleanup()
  })
})

describe('1.5b/worktree-failure: when the worktree cannot be created, the label and assignee change is undone and take exits 2', () => {
  /** @type {Fixture} */
  let fixture
  /** @type {Awaited<ReturnType<Fixture['joinedClone']>>} */
  let clone

  beforeAll(async () => {
    fixture = await teamFixture('worktree-failure')
    clone = await fixture.joinedClone({ name: 'builder1', login: BUILDER1 })
  })
  afterAll(() => fixture.cleanup())

  test.each([
    ['without a role label', ['ready']],
    ['with its role label', ['ready', 'role:counter']],
  ])('a task %s gets its labels back', async (_, labels) => {
    // Something else already sits at the path of the worktree.
    const path = join(fixture.dir, 'builder1.worktrees', '7-task-7')
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'notes.txt'), 'not a worktree\n')
    const fake = createFakeGitHub({
      issues: [task(7, { role: 'counter', paths: ['src/features/counter/**'], labels })],
    })
    const result = await take(fixture, clone.path, fake, BUILDER1, ['7'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain(`the worktree of #7 cannot be created at ${path}:`)
    expect(result.stderr).toContain('the in-progress label and the assignment were undone')
    expect(result.stderr).toContain(`to resolve: run \`hackwin take 7\` in ${clone.path}`)
    expect(fake.find(7)?.labels.sort()).toEqual([...labels].sort())
    expect(fake.find(7)?.assignees).toEqual([])
    expect(existsSync(promptFileOf(clone, 7))).toBe(false)
  })
})

describe('1.5b/agent: an agent that cannot be started leaves the worktree and the claim and prints the prompt file path and the start command', () => {
  test('claude is not on PATH', async () => {
    const fixture = await teamFixture('no-claude')
    const clone = await fixture.joinedClone({ name: 'builder1', login: BUILDER1 })
    const fake = createFakeGitHub({
      issues: [task(7, { role: 'counter', paths: ['src/features/counter/**'] })],
    })
    const agents = agentBin(fixture, 'no-claude', { claude: false })
    const result = await take(fixture, clone.path, fake, BUILDER1, ['7'], {
      env: agents.env,
      tty: true,
    })
    expect(result.code).toBe(1)
    const worktree = worktreeOf(fixture, 'builder1', '7-task-7')
    const promptFile = promptFileOf(clone, 7)
    expect(result.stdout).toContain(`prompt: ${promptFile}`)
    expect(result.stdout.trimEnd().split('\n').slice(-2)).toEqual([
      'Claude Code could not be started: `claude` is not installed or not on PATH; the worktree and the claim stay',
      `start Claude Code for #7 in a new terminal: run \`claude "$(cat ${promptFile})"\` in ${worktree.path}`,
    ])
    expect(await worktree.git.currentBranch()).toBe('task/7-task-7')
    expect(fake.find(7)?.labels).toContain('in-progress')
    fixture.cleanup()
  })

  test('with --json in a terminal, take prints the command instead of giving the terminal to the agent', async () => {
    const fixture = await teamFixture('json')
    const clone = await fixture.joinedClone({ name: 'builder1', login: BUILDER1 })
    const fake = createFakeGitHub({
      issues: [task(7, { role: 'counter', paths: ['src/features/counter/**'] })],
    })
    const agents = agentBin(fixture, 'json')
    const result = await take(fixture, clone.path, fake, BUILDER1, ['7', '--json'], {
      env: agents.env,
      tty: true,
    })
    expect(result.code).toBe(0)
    expect(agents.called('claude')).toBe(false)
    const json = JSON.parse(result.stdout)
    const worktree = worktreeOf(fixture, 'builder1', '7-task-7')
    const promptFile = promptFileOf(clone, 7)
    expect(json.data).toMatchObject({
      task: { number: 7, role: 'counter' },
      claim: { assignees: [BUILDER1], roleAdded: 'role:counter' },
      worktree: { path: worktree.path, branch: 'task/7-task-7', how: 'create' },
      install: { skipped: true },
      prompt: { file: promptFile, changes: { from: null, recorded: null, files: [] } },
      start: {
        agent: 'claude',
        mode: 'printed',
        reason: 'json',
        command: `claude "$(cat ${promptFile})"`,
        dir: worktree.path,
      },
    })
    expect(json.data.claim.labels.sort()).toEqual(['in-progress', 'role:counter'])
    fixture.cleanup()
  })
})

describe('1.5b/changes: the prompt lists what changed on main since the main commit last recorded for the worktree, or in the clone for a new worktree, own scope first', () => {
  test('a first take, a take of a second task and a take that reuses the first worktree', async () => {
    const fixture = await teamFixture('changes')
    const clone = await fixture.joinedClone({ name: 'builder1', login: BUILDER1 })
    const fresh = (number, paths) =>
      createFakeGitHub({ issues: [task(number, { role: 'counter', paths })] })

    // The first take in the clone has no recorded commit.
    const first = await take(
      fixture,
      clone.path,
      fresh(7, ['src/features/counter/a/**']),
      BUILDER1,
      ['7'],
    )
    expect(first.code).toBe(0)
    const seven = worktreeOf(fixture, 'builder1', '7-task-7')
    const firstMain = await seven.git.revParse('HEAD')
    expect(readFileSync(promptFileOf(clone, 7), 'utf8')).toContain(
      'No main commit was recorded in this clone before',
    )

    // main moves: one file in builder1's scope (todos) and one in another role's.
    const secondMain = await fixture.publish(
      {
        'src/features/greeting/hello.js': 'export const hello = 1\n',
        'src/features/todos/list.js': 'export const list = []\n',
      },
      { message: 'Greeting and todos' },
    )

    // A new worktree starts from the commit recorded last anywhere in the clone.
    const second = await take(
      fixture,
      clone.path,
      fresh(8, ['src/features/counter/b/**']),
      BUILDER1,
      ['8'],
    )
    expect(second.code).toBe(0)
    const eight = readFileSync(promptFileOf(clone, 8), 'utf8')
    expectInOrder(eight, [
      `\`origin/main\` is at \`${secondMain}\`.`,
      `Files changed on main since \`${firstMain}\`, the main commit last recorded in this clone`,
      'In your scope:',
      '- A `src/features/todos/list.js`',
      'Elsewhere:',
      '- A `src/features/greeting/hello.js`',
    ])

    // The reused worktree of #7 starts from its own record, not from the newer one of #8.
    const thirdMain = await fixture.publish({ 'docs/guide.md': '# Guide\n' }, { message: 'Guide' })
    const third = await take(
      fixture,
      clone.path,
      fresh(7, ['src/features/counter/a/**']),
      BUILDER1,
      ['7'],
    )
    expect(third.code).toBe(0)
    expect(third.stdout).toContain(`worktree: ${seven.path} on task/7-task-7, reused`)
    const seventh = readFileSync(promptFileOf(clone, 7), 'utf8')
    expectInOrder(seventh, [
      `\`origin/main\` is at \`${thirdMain}\`.`,
      `Files changed on main since \`${firstMain}\`, the main commit last recorded for this worktree`,
      '- A `src/features/todos/list.js`',
      '- A `docs/guide.md`',
      '- A `src/features/greeting/hello.js`',
    ])
    expect((await readMainSeen(clone.commonDir, seven.path))?.main_sha).toBe(thirdMain)

    // A take with nothing new on main says so.
    const fourth = await take(
      fixture,
      clone.path,
      fresh(7, ['src/features/counter/a/**']),
      BUILDER1,
      ['7'],
    )
    expect(fourth.code).toBe(0)
    expect(readFileSync(promptFileOf(clone, 7), 'utf8')).toContain(
      `No file changed on main since \`${thirdMain}\`, the main commit last recorded for this worktree`,
    )
    fixture.cleanup()
  })
})

describe('1.5b/steps: hooks, cleanup of merged worktrees, waiting pull requests, links and a reused branch', () => {
  /** @type {Fixture} */
  let fixture
  /** @type {Awaited<ReturnType<Fixture['joinedClone']>>} */
  let clone

  beforeAll(async () => {
    fixture = await teamFixture('steps')
    clone = await fixture.joinedClone({ name: 'builder1', login: BUILDER1 })
  })
  afterAll(() => fixture.cleanup())

  test('step 1 repairs core.hooksPath with a warning (E20)', async () => {
    await clone.git.run(['config', '--unset', 'core.hooksPath'])
    const fake = createFakeGitHub({
      issues: [task(7, { role: 'counter', paths: ['src/features/counter/**'] })],
    })
    const result = await take(fixture, clone.path, fake, BUILDER1, ['7'])
    expect(result.code).toBe(0)
    expect(result.stderr).toContain(
      'warning: core.hooksPath was not set, so the git hooks were off; set it to .githooks (E20)',
    )
    expect(await clone.git.configGet('core.hooksPath')).toBe('.githooks')
  })

  test("steps 2 and 3 remove the worktree of a merged task and warn about the caller's pull requests that wait for them", async () => {
    const merged = join(fixture.dir, 'builder1.worktrees', '5-old-task')
    await clone.git.worktreeAdd(merged, {
      branch: 'task/5-old-task',
      createBranch: true,
      startPoint: 'origin/main',
    })
    const fake = createFakeGitHub({
      issues: [task(9, { role: 'todos', paths: ['src/features/todos/a/**'] })],
      pulls: [
        {
          number: 6,
          title: 'Old task',
          head: 'task/5-old-task',
          state: 'closed',
          merged: true,
          author: BUILDER1,
          files: [],
        },
        {
          number: 20,
          title: 'Todo badge',
          head: 'task/19-todo-badge',
          author: BUILDER1,
          labels: ['gate:failed', 'needs-owner'],
          files: [{ path: 'src/features/todos/badge.js', status: 'added', previousPath: null }],
        },
        {
          number: 22,
          title: 'Greeting',
          head: 'task/21-greeting',
          author: BUILDER2,
          labels: ['gate:failed', 'scope-violation'],
          files: [{ path: 'src/features/greeting/a.js', status: 'added', previousPath: null }],
        },
      ],
    })
    const result = await take(fixture, clone.path, fake, BUILDER1, ['9'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(`removed the worktree of a merged task: ${merged}`)
    expect(existsSync(merged)).toBe(false)
    expect(result.stderr).toContain(
      'warning: PR #20 Todo badge waits for you: gate:failed, needs-owner',
    )
    expect(result.stderr).not.toContain('PR #22')
  })

  test('step 5 links .env.local and CLAUDE.local.md of the main checkout, and a later take keeps the links', async () => {
    writeFileSync(join(clone.path, '.env.local'), 'EXAMPLE=placeholder\n')
    writeFileSync(join(clone.path, 'CLAUDE.local.md'), 'Answer in English.\n')
    const fake = () =>
      createFakeGitHub({
        issues: [task(11, { role: 'counter', paths: ['src/features/counter/c/**'] })],
      })
    const result = await take(fixture, clone.path, fake(), BUILDER1, ['11'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('linked .env.local and CLAUDE.local.md from the main checkout')
    const worktree = worktreeOf(fixture, 'builder1', '11-task-11')
    for (const name of ['.env.local', 'CLAUDE.local.md']) {
      expect(lstatSync(join(worktree.path, name)).isSymbolicLink()).toBe(true)
      expect(readlinkSync(join(worktree.path, name))).toBe(join(clone.path, name))
    }
    expect(await worktree.git.isClean()).toBe(true)

    const again = await take(fixture, clone.path, fake(), BUILDER1, ['11'])
    expect(again.code).toBe(0)
    expect(again.stdout).not.toContain('linked')
  })

  test('step 5 adds a worktree for the branch an earlier take left, and a branch without commits of its own moves to the current origin/main', async () => {
    const fake = () =>
      createFakeGitHub({
        issues: [task(12, { role: 'counter', paths: ['src/features/counter/d/**'] })],
      })
    expect((await take(fixture, clone.path, fake(), BUILDER1, ['12'])).code).toBe(0)
    const worktree = worktreeOf(fixture, 'builder1', '12-task-12')
    await clone.git.worktreeRemove(worktree.path, { force: true })
    const main = await fixture.publish(
      { 'src/shared/types.js': 'export {}\n' },
      { message: 'Types' },
    )

    const result = await take(fixture, clone.path, fake(), BUILDER1, ['12'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(
      `worktree: ${worktree.path} on task/12-task-12, added for the existing branch`,
    )
    expect(result.stdout).toContain(
      `fast-forwarded task/12-task-12 to origin/main ${main.slice(0, 12)}`,
    )
    expect(await worktree.git.revParse('HEAD')).toBe(main)
  })
})

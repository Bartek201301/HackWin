import { describe, expect, test } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { main } from '../../../src/cli/main.js'
import { quoteShellArg } from '../../../src/core/runtime/exec.js'
import { readCheckRecord, statePaths } from '../../../src/core/state/index.js'
import {
  accounts,
  createFakeGitHub,
  createFixture,
  hackwinObject,
  httpError,
  ownersObject,
  yaml,
} from '../../harness/index.js'

const ISSUE = 12
const TITLE = 'Counter reset'
const BRANCH = 'task/12-counter-reset'
const TEST_FILE = 'src/features/counter/reset.test.mjs'
const NODE = quoteShellArg(process.execPath)

// Stand-ins for the project's commands, committed on main under tools/ (a shared path).
const TOOLS = {
  // Fails when a file under src/ contains BROKEN.
  'tools/check.mjs': `
    import { readdirSync, readFileSync } from 'node:fs'
    const broken = readdirSync('src', { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.parentPath + '/' + entry.name)
      .filter((file) => readFileSync(file, 'utf8').includes('BROKEN'))
    for (const file of broken) console.log('broken: ' + file)
    console.log(broken.length === 0 ? 'check passed' : 'check failed')
    process.exit(broken.length === 0 ? 0 : 1)
  `,
  // Runs the named test files: a file that contains FAIL fails.
  'tools/test.mjs': `
    import { readFileSync } from 'node:fs'
    let failed = 0
    for (const file of process.argv.slice(2)) {
      const ok = !readFileSync(file, 'utf8').includes('FAIL')
      if (!ok) failed += 1
      console.log((ok ? 'PASS ' : 'FAIL ') + file)
    }
    console.log(failed + ' failed')
    process.exit(failed > 0 ? 1 : 0)
  `,
  // Formats the named files: removes trailing spaces.
  'tools/format.mjs': `
    import { readFileSync, writeFileSync } from 'node:fs'
    for (const file of process.argv.slice(2)) {
      writeFileSync(file, readFileSync(file, 'utf8').replace(/[ \\t]+$/gm, ''))
    }
  `,
  // Writes how many files src/features/counter holds into src/shared/counter-files.txt.
  'tools/generate.mjs': `
    import { readdirSync, writeFileSync } from 'node:fs'
    const count = readdirSync('src/features/counter').length
    writeFileSync('src/shared/counter-files.txt', count + '\\n')
  `,
}

const MAIN_FILES = {
  'README.md': '# Fixture\n',
  ...TOOLS,
  'src/shared/index.js': 'export const shared = 1\n',
  'src/shared/counter-files.txt': '1\n',
  'src/features/counter/index.js': 'export const count = 0\n',
  'src/features/todos/index.js': 'export const todos = []\n',
  'src/features/greeting/index.js': "export const greeting = 'hello'\n",
}

/** The work of the task: inside its paths, formatted, with a passing acceptance test. */
const WORK = {
  'src/features/counter/reset.js': 'export const reset = () => 0\n',
  [TEST_FILE]: 'PASS\n',
}

/**
 * The task block of issue 12, in the form of 8.1.
 * @param {{ paths?: string[], acceptance_tests?: string[] }} [block]
 */
function taskBody({ paths = ['src/features/counter/**'], acceptance_tests = [TEST_FILE] } = {}) {
  const fields = {
    kind: 'task',
    role: 'counter',
    wave: 2,
    paths,
    depends_on: [],
    acceptance_tests,
    deadline: '2026-10-25T12:00:00+02:00',
  }
  return `\`\`\`yaml\n# hackwin:task\n${yaml(fields)}\`\`\`\n\n## Problem\nReset the counter.\n`
}

/**
 * A team of 3 on the stand-in project, a joined main checkout, the task issue on a fake GitHub
 * and the worktree of the task with one commit of `work`, pushed unless `push` is false.
 * builder1 holds `counter` and `todos`, builder2 holds `greeting`, the Lead `shared`.
 * @param {object} [options]
 * @param {Record<string, string>} [options.work]
 * @param {boolean} [options.push]
 * @param {Parameters<typeof taskBody>[0]} [options.block]
 * @param {string[]} [options.labels]
 * @param {string | null} [options.generate]
 */
async function scene({
  work = WORK,
  push = true,
  block,
  labels = ['in-progress', 'role:counter'],
  generate = null,
} = {}) {
  const hackwin = hackwinObject(3)
  hackwin.commands = {
    ...hackwin.commands,
    install: 'true',
    check: `${NODE} tools/check.mjs`,
    test: `${NODE} tools/test.mjs`,
    format: `${NODE} tools/format.mjs`,
    generate: generate === null ? null : `${NODE} ${generate}`,
    lockfile_regen: 'true',
  }
  const fixture = await createFixture({
    files: MAIN_FILES,
    config: { hackwin, owners: ownersObject() },
  })
  const joined = await fixture.join(fixture.main, { login: accounts.builder1.login })
  const fake = createFakeGitHub({
    issues: [{ number: ISSUE, title: TITLE, body: taskBody(block), labels }],
  })
  const worktree = await fixture.worktree({ issue: ISSUE, title: TITLE, files: work, push })
  const env = { ...fixture.env, TMPDIR: join(fixture.dir, 'tmp') }
  return { fixture, fake, worktree, env, commonDir: joined.commonDir }
}

/**
 * Run `hackwin ship` in-process as builder1.
 * @param {Awaited<ReturnType<typeof scene>>} s
 * @param {{ cwd?: string, json?: boolean }} [options]
 */
async function ship(s, { cwd = s.worktree.path, json = false } = {}) {
  let stdout = ''
  let stderr = ''
  const code = await main(json ? ['ship', '--json'] : ['ship'], {
    cwd,
    env: s.env,
    stdin: Readable.from([]),
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
    ghExecutor: s.fake.as(accounts.builder1.login),
  })
  return { code, stdout, stderr }
}

/**
 * The commit a branch of the origin points to, or null.
 * @param {Awaited<ReturnType<typeof scene>>} s
 * @param {string} [branch]
 */
function remoteBranch(s, branch = BRANCH) {
  return s.fixture.gitAt(s.fixture.origin).tryRevParse(`refs/heads/${branch}`)
}

/**
 * Expect a blocked ship: exit 1, the remote branch where it was, no check record for HEAD.
 * @param {Awaited<ReturnType<typeof scene>>} s
 * @param {{ code: number, stderr: string }} result
 * @param {string | null} remoteBefore
 * @param {number} step
 */
async function expectBlocked(s, result, remoteBefore, step) {
  expect(result.code, result.stderr).toBe(1)
  expect(result.stderr).toContain(`hackwin ship: blocked: step ${step},`)
  expect(result.stderr).toContain(`rule: ship step ${step}:`)
  expect(await remoteBranch(s)).toBe(remoteBefore)
  const head = await s.worktree.git.revParse('HEAD')
  expect(await readCheckRecord(s.commonDir, head)).toBeNull()
}

describe('AC15: ship exits 1 and leaves the remote branch unchanged', () => {
  test('for a conflict with main, with the files listed; the merge stays in progress', async () => {
    const s = await scene({
      work: { ...WORK, 'src/features/counter/index.js': 'export const count = 1\n' },
    })
    await s.fixture.publish(
      { 'src/features/counter/index.js': 'export const count = 2\n' },
      { message: 'Change the counter on main' },
    )
    const before = await remoteBranch(s)
    const result = await ship(s)
    await expectBlocked(s, result, before, 2)
    expect(result.stderr).toContain('conflicts in 1 file')
    expect(result.stderr).toContain('  - src/features/counter/index.js')
    expect(result.stderr).toContain(`to resolve: run \`hackwin ship\` in ${s.worktree.path}`)
    expect(await s.worktree.git.tryRevParse('MERGE_HEAD')).not.toBeNull()
    expect(await s.worktree.git.conflictedFiles()).toEqual(['src/features/counter/index.js'])
  })

  test('for a failing acceptance test, naming the step and its log', async () => {
    const s = await scene({ work: { ...WORK, [TEST_FILE]: 'FAIL\n' } })
    const before = await remoteBranch(s)
    const result = await ship(s)
    await expectBlocked(s, result, before, 8)
    expect(result.stderr).toContain(`\`${NODE} tools/test.mjs ${TEST_FILE}\` exited 1`)
    expect(result.stdout).toContain(`FAIL ${TEST_FILE}`)
    const log = /- log: (.+)$/m.exec(result.stderr)?.[1] ?? ''
    expect(log.startsWith(join(s.env.TMPDIR, 'hackwin-ship'))).toBe(true)
    expect(log.endsWith('acceptance.log')).toBe(true)
    expect(readFileSync(log, 'utf8')).toContain(`FAIL ${TEST_FILE}`)
  })

  test('for a named acceptance test that does not exist, also one named by a test id', async () => {
    const s = await scene({
      block: { acceptance_tests: [TEST_FILE, 'src/features/counter/missing.test.mjs', 'AC11'] },
    })
    const before = await remoteBranch(s)
    const result = await ship(s)
    await expectBlocked(s, result, before, 8)
    expect(result.stderr).toContain('2 acceptance tests of issue #12 are not existing files')
    expect(result.stderr).toContain('  - src/features/counter/missing.test.mjs')
    expect(result.stderr).toContain('  - AC11')
    expect(result.stdout).not.toContain(`PASS ${TEST_FILE}`)
  })

  test("for a file outside the author's scope", async () => {
    const s = await scene({
      work: { ...WORK, 'src/features/greeting/index.js': "export const greeting = 'hi'\n" },
    })
    const before = await remoteBranch(s)
    const result = await ship(s)
    await expectBlocked(s, result, before, 3)
    expect(result.stderr).toContain(
      `  - src/features/greeting/index.js (role greeting, held by ${accounts.builder2.login})`,
    )
    expect(result.stderr).toContain(`roles of ${accounts.builder1.login} (counter, todos)`)
  })

  test('for an unformatted changed file, which the check leaves as it was', async () => {
    const unformatted = 'export const reset = () => 0   \n'
    const s = await scene({ work: { ...WORK, 'src/features/counter/reset.js': unformatted } })
    const before = await remoteBranch(s)
    const result = await ship(s)
    await expectBlocked(s, result, before, 5)
    expect(result.stderr).toContain('  - src/features/counter/reset.js')
    expect(result.stderr).toContain(
      `to resolve: run \`${NODE} tools/format.mjs src/features/counter/reset.js\` in ${s.worktree.path}`,
    )
    const file = join(s.worktree.path, 'src/features/counter/reset.js')
    expect(readFileSync(file, 'utf8')).toBe(unformatted)
    expect(await s.worktree.git.isClean()).toBe(true)
  })

  test('for an added line that matches a secret pattern, without printing the secret', async () => {
    const token = ['gh', 'p_', 'A1b2'.repeat(9)].join('')
    const s = await scene({
      work: { ...WORK, 'src/features/counter/reset.js': `export const token = '${token}'\n` },
    })
    const before = await remoteBranch(s)
    const result = await ship(s)
    await expectBlocked(s, result, before, 4)
    expect(result.stderr).toContain('  - src/features/counter/reset.js:1: github-token')
    expect(result.stdout + result.stderr).not.toContain(token)
  })
})

describe('AC17: ship outside a task worktree exits 2; on a spike branch it exits 1', () => {
  test('ship outside a task worktree exits 2 and prints the worktree path', async () => {
    const s = await scene()
    const result = await ship(s, { cwd: s.fixture.main })
    expect(result.code, result.stderr).toBe(2)
    expect(result.stderr).toContain(`#12 ${s.worktree.path}`)
    expect(result.stderr).toContain(`to resolve: run \`hackwin ship\` in ${s.worktree.path}`)
  })

  test('ship on a spike/ branch exits 1', async () => {
    const s = await scene()
    const spike = join(s.fixture.dir, 'spike')
    await s.fixture.git.worktreeAdd(spike, {
      branch: 'spike/try-a-reset',
      createBranch: true,
      startPoint: 'origin/main',
    })
    const result = await ship(s, { cwd: spike })
    expect(result.code, result.stderr).toBe(1)
    expect(result.stderr).toContain('spike branches are never merged')
    expect(result.stderr).toContain('rule: E16')
  })
})

describe('AC54/ship: with core.hooksPath unset in a joined clone, ship sets it again', () => {
  test('ship repairs core.hooksPath (E20) and warns', async () => {
    const s = await scene()
    await s.fixture.git.run(['config', '--unset', 'core.hooksPath'])
    expect(await s.fixture.git.configGet('core.hooksPath')).toBeNull()
    const result = await ship(s)
    expect(result.code, result.stderr).toBe(0)
    expect(await s.fixture.git.configGet('core.hooksPath')).toBe('.githooks')
    expect(await s.worktree.git.configGet('core.hooksPath')).toBe('.githooks')
    expect(result.stderr).toContain('warning: core.hooksPath was not set')
  })
})

describe('1.5d/ship: merge main and local checks', () => {
  test('merges the remote branch and main, runs steps 1 to 9 in order and writes the check record of the merged head', async () => {
    const s = await scene()
    const remote = await s.fixture.publish(
      { 'src/features/counter/notes.md': 'from another clone\n' },
      { branch: BRANCH, message: 'Add notes from another clone' },
    )
    const own = await s.fixture.commit('More local work', {
      dir: s.worktree.path,
      files: { 'src/features/counter/limit.js': 'export const limit = 10\n' },
    })
    const main = await s.fixture.publish(
      { 'src/shared/index.js': 'export const shared = 2\n' },
      { message: 'Change shared code on main' },
    )

    const result = await ship(s)
    expect(result.code, result.stderr).toBe(0)
    const head = await s.worktree.git.revParse('HEAD')
    for (const commit of [own, remote, main]) {
      expect(await s.worktree.git.isAncestor(commit, head)).toBe(true)
    }
    expect(await remoteBranch(s)).toBe(remote)

    const steps = [...result.stdout.matchAll(/^step (\d+), /gm)].map((match) => Number(match[1]))
    expect(steps).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(result.stdout).toContain(`merged the commits of origin/${BRANCH} that the branch lacked`)
    expect(result.stdout).toContain('step 2, merge main: merged origin/main')
    expect(result.stdout).toContain(`every check passed for ${head} on ${BRANCH}`)
    expect(result.stdout).toContain('nothing was pushed')

    const record = await readCheckRecord(s.commonDir, head)
    expect(record).toMatchObject({ schema: 1, sha: head, branch: BRANCH, issue: ISSUE })
    expect(record?.checks.map(({ name, result: outcome }) => `${name} ${outcome}`)).toEqual([
      'scope passed',
      'secrets passed',
      'format passed',
      'generated skipped',
      'check passed',
      'acceptance passed',
    ])
    expect(existsSync(join(statePaths(s.commonDir).checks, `${head}.json`))).toBe(true)
  })

  test('a branch that is not on origin yet ships, and --json gives the result', async () => {
    const s = await scene({ push: false })
    const result = await ship(s, { json: true })
    expect(result.code, result.stderr).toBe(0)
    const json = JSON.parse(result.stdout)
    expect(json).toMatchObject({
      command: 'ship',
      ok: true,
      data: { issue: ISSUE, branch: BRANCH, merged: { remote: 'absent' }, pushed: false },
    })
    expect(await remoteBranch(s)).toBeNull()
  })

  test('a changed file inside the roles but outside the task paths only warns (A15)', async () => {
    const s = await scene({
      work: { ...WORK, 'src/features/todos/index.js': 'export const todos = [1]\n' },
    })
    const result = await ship(s)
    expect(result.code, result.stderr).toBe(0)
    expect(result.stderr).toContain(
      'warning: 1 changed file outside the paths of task #12, inside your roles (A15): src/features/todos/index.js',
    )
  })

  test('a failing full check stops at step 7 with the tail and the log, before the acceptance tests', async () => {
    const s = await scene({ work: { ...WORK, 'src/features/counter/reset.js': '// BROKEN\n' } })
    const before = await remoteBranch(s)
    const result = await ship(s)
    await expectBlocked(s, result, before, 7)
    expect(result.stdout).toContain('broken: src/features/counter/reset.js')
    expect(result.stdout).not.toContain('step 8')
    expect(result.stderr).toMatch(/- log: .+check\.log$/m)
  })

  test('a change that makes a generated file stale stops at step 6 and leaves the file as it was', async () => {
    const s = await scene({ generate: 'tools/generate.mjs' })
    const before = await remoteBranch(s)
    const result = await ship(s)
    await expectBlocked(s, result, before, 6)
    expect(result.stderr).toContain('  - src/shared/counter-files.txt')
    expect(readFileSync(join(s.worktree.path, 'src/shared/counter-files.txt'), 'utf8')).toBe('1\n')
    expect(await s.worktree.git.isClean()).toBe(true)
  })

  test('a conflict with the commits of the remote branch stops at step 1; after the session resolves and commits, ship passes', async () => {
    const s = await scene()
    const remote = await s.fixture.publish(
      { 'src/features/counter/reset.js': 'export const reset = () => -1\n' },
      { branch: BRANCH, message: 'Change the reset from another clone' },
    )
    await s.fixture.commit('Change the reset locally', {
      dir: s.worktree.path,
      files: { 'src/features/counter/reset.js': 'export const reset = () => 1\n' },
    })
    const result = await ship(s)
    await expectBlocked(s, result, remote, 1)
    expect(result.stderr).toContain('  - src/features/counter/reset.js')

    const again = await ship(s)
    expect(again.code).toBe(2)
    expect(again.stderr).toContain(`a merge is in progress in ${s.worktree.path}`)

    writeFileSync(
      join(s.worktree.path, 'src/features/counter/reset.js'),
      WORK['src/features/counter/reset.js'],
    )
    await s.worktree.git.run(['add', '--all'])
    await s.worktree.git.run(['commit', '--quiet', '--no-edit'])
    const resolved = await ship(s)
    expect(resolved.code, resolved.stderr).toBe(0)
    expect(resolved.stdout).toContain(`has no commit that the branch lacks`)
  })

  test('a working tree with changes exits 2', async () => {
    const s = await scene()
    writeFileSync(join(s.worktree.path, 'scratch.txt'), 'notes\n')
    const result = await ship(s)
    expect(result.code, result.stderr).toBe(2)
    expect(result.stderr).toContain('has changes: 1 path, scratch.txt')
  })

  test('a task that is not in progress or in review exits 2 and names take', async () => {
    const s = await scene({ labels: ['ready', 'role:counter'] })
    const result = await ship(s)
    expect(result.code, result.stderr).toBe(2)
    expect(result.stderr).toContain('issue #12 is ready, not in-progress or in-review')
    expect(result.stderr).toContain(`to resolve: run \`hackwin take 12\` in ${s.fixture.main}`)
  })

  test('a failed GitHub call in step 1 exits 3', async () => {
    const s = await scene()
    s.fake.on('GET repos/{owner}/{repo}/issues/:number', () => {
      throw httpError(502, 'Bad Gateway')
    })
    const before = await remoteBranch(s)
    const result = await ship(s)
    expect(result.code, result.stderr).toBe(3)
    expect(await remoteBranch(s)).toBe(before)
  })
})

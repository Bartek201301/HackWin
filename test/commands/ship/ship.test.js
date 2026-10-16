import { describe, expect, test } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readCheckRecord, shipLogPath, statePaths } from '../../../src/core/state/index.js'
import { accounts, httpError } from '../../harness/index.js'
import {
  BRANCH,
  ISSUE,
  NODE,
  TEST_FILE,
  WORK,
  remoteBranch,
  scene,
  ship,
  stepsOf,
} from './scene.js'

/** @import { Scene } from './scene.js' */

/**
 * Expect a blocked ship: exit 1, the remote branch where it was, no check record for HEAD.
 * @param {Scene} s
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
    expect(log).toBe(shipLogPath(s.commonDir, ISSUE, 'acceptance'))
    expect(existsSync(join(/** @type {string} */ (s.env.TMPDIR), 'hackwin-ship'))).toBe(false)
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

    expect(stepsOf(result.stdout)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14])
    expect(result.stdout).toContain(`merged the commits of origin/${BRANCH} that the branch lacked`)
    expect(result.stdout).toContain('step 2, merge main: merged origin/main')
    expect(result.stdout).toContain(`step 9, check record: written for ${head}`)
    expect(result.stdout).toContain(`step 10, push: pushed ${head} to origin/${BRANCH}`)
    expect(await remoteBranch(s)).toBe(head)

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
    const head = await s.worktree.git.revParse('HEAD')
    expect(json).toMatchObject({
      command: 'ship',
      ok: true,
      data: {
        issue: ISSUE,
        branch: BRANCH,
        head,
        merged: { remote: 'absent' },
        checksReused: false,
        pushed: true,
        pullRequest: { action: 'opened' },
        report: { created: true },
      },
    })
    expect(json.lines.at(-1)).toBe(
      `PR #${json.data.pullRequest.number} opened at ${head}. Do not merge. Stop.`,
    )
    expect(await remoteBranch(s)).toBe(head)
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

describe('1.5g/outsider-task: ship refuses the worktree of an issue that no member of the team wrote', () => {
  const message = (/** @type {string} */ who) =>
    `#${ISSUE}, the issue of ${BRANCH}, is not a task: it was written by ${who}, who is not a member of the team in hackwin.yml; only an issue that team.lead or one of team.members wrote is a task`

  test('ship exits 2, names the author and leaves the remote branch unchanged', async () => {
    const s = await scene({ author: 'mallory' })
    const before = await remoteBranch(s)
    const result = await ship(s)
    expect(result.code, result.stderr).toBe(2)
    expect(result.stderr).toContain(`hackwin ship: ${message('mallory')}`)
    expect(result.stderr).not.toContain('# hackwin:task')
    expect(await remoteBranch(s)).toBe(before)

    const json = JSON.parse((await ship(s, { json: true })).stdout)
    expect(json).toMatchObject({ ok: false, exitCode: 2 })
    expect(json.error.message).toBe(message('mallory'))
    expect(json.error.details).toEqual({ author: 'mallory', member: false })
  })

  test('an author with a control character is quoted with it escaped', async () => {
    const s = await scene({ author: 'mal\u001b[2Jlory' })
    const result = await ship(s)
    expect(result.code, result.stderr).toBe(2)
    expect(result.stderr).toContain(message('"mal\\u001b[2Jlory"'))
    expect(result.stderr).not.toContain('\u001b')
  })
})

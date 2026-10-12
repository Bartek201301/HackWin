import { describe, expect, test } from 'vitest'
import { accounts } from '../../harness/index.js'
import { commit } from '../hook/hook-fixture.js'
import { ALL_STEPS, TEST_FILE, WORK, createCiScene, stepsOf } from './ci-fixture.js'

const lead = accounts.lead.login
const builder1 = accounts.builder1.login

describe('1.4b/scope: the scope check uses the roles of the author, never the role of the task', () => {
  test("the Lead's change of a shared file for a task of the role counter passes", async () => {
    const scene = await createCiScene()
    const branch = 'task/21-counter-docs'
    const head = await scene.push(branch, { 'src/shared/index.js': 'export const shared = 2\n' })

    const result = await scene.runCi({ branch, head, author: lead })

    expect(result.code).toBe(0)
    expect(result.stderr).toContain(
      `step 3, scope check: 1 changed file inside the roles of ${lead}`,
    )
  })

  test("builder1's change of a counter file for a task of the shared role passes the scope check", async () => {
    const scene = await createCiScene()
    const branch = 'task/20-shared-change'
    const head = await scene.push(branch, {
      'src/features/counter/index.js': 'export const count = 1\n',
    })

    const result = await scene.runCi({ branch, head, author: builder1 })

    expect(result.code).toBe(0)
    expect(stepsOf(result)).toEqual(ALL_STEPS)
  })

  test('a login outside the team holds no role, so every changed file outside the open list fails', async () => {
    const scene = await createCiScene()
    const branch = 'task/12-counter-reset'
    const head = await scene.push(branch, { ...WORK, 'README.md': '# Open to everyone\n' })

    const result = await scene.runCi({ branch, head, author: 'someone-else' })

    expect(result.code).toBe(1)
    expect(result.json.error.message).toContain(
      'lie outside the roles of its author someone-else, who holds no role in hackwin.yml on origin/main',
    )
    expect(result.json.error.objects).toEqual([
      `src/features/counter/reset.js: role counter, held by ${builder1}`,
      `${TEST_FILE}: role counter, held by ${builder1}`,
    ])
  })
})

describe('AC47/ci: an edit outside scope committed with --no-verify', () => {
  test('is blocked at commit, and committed with --no-verify and pushed, it fails CI', async () => {
    const scene = await createCiScene()
    const clone = await scene.hooks.joinedClone('builder1')
    const task = await scene.hooks.taskWorktree(clone, 12, 'Counter reset')
    const outside = { 'src/shared/index.js': 'export const shared = 3\n' }

    const blocked = await commit(task.git, { ...WORK, ...outside })
    expect(blocked.code).not.toBe(0)
    expect(blocked.stderr).toContain("rule: E1: edits stay inside the author's ownership scope")

    const committed = await task.git.run(['commit', '--quiet', '--no-verify', '-m', 'Reset'], {
      allowFailure: true,
    })
    expect(committed.code).toBe(0)
    const pushed = await task.git.run(
      ['push', '--quiet', '--no-verify', 'origin', `HEAD:refs/heads/${task.branch}`],
      { allowFailure: true },
    )
    expect(pushed.code).toBe(0)
    const head = await task.git.revParse('HEAD')

    const result = await scene.runCi({ branch: task.branch, head })

    expect(result.code).toBe(1)
    expect(result.json.error).toMatchObject({
      kind: 'blocked',
      rule: "E1: edits stay inside the author's ownership scope",
      objects: [`src/shared/index.js: role shared, held by ${lead}`],
    })
    expect(result.json.error.message).toBe(
      `step 3, scope check: 1 changed file of pull request #30 lies outside the roles of its author ${builder1}, who holds counter, todos`,
    )
    expect(result.stderr).not.toContain('step 4, ')
  })

  test('files that arrive from main never count: the three-dot diff holds only the branch', async () => {
    const scene = await createCiScene()
    const branch = 'task/12-counter-reset'
    await scene.push(branch, WORK)
    // The Lead changes a shared file on main, and builder1 merges main into the branch.
    await scene.fixture.publish({ 'src/shared/index.js': 'export const shared = 4\n' })
    const clone = await scene.fixture.clone('merger')
    await clone.git.run(['checkout', '--quiet', branch])
    await clone.git.run(['merge', '--quiet', '--no-edit', 'origin/main'])
    await clone.git.push({ refspecs: [`HEAD:refs/heads/${branch}`] })
    const head = await clone.git.revParse('HEAD')

    const result = await scene.runCi({ branch, head })

    expect(result.code).toBe(0)
    expect(result.stderr).toContain(
      `step 3, scope check: 2 changed files inside the roles of ${builder1}`,
    )
  })
})

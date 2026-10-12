import { describe, expect, test } from 'vitest'
import { VERSION } from '../../../src/cli/context.js'
import { accounts } from '../../harness/index.js'
import { ALL_STEPS, TEST_FILE, WORK, createCiScene, sceneConfig, stepsOf } from './ci-fixture.js'

const builder1 = accounts.builder1.login

describe('1.4b/ci: a pull request that follows every rule', () => {
  test('passes steps 1 to 4 and 6 to 9 in order, on the merged tree, and leaves no scratch worktree', async () => {
    const scene = await createCiScene()
    const branch = 'task/12-counter-reset'
    const head = await scene.push(branch, WORK)
    // main moves on after the branch started: the merge in step 7 is a real merge.
    await scene.fixture.publish({ 'src/features/todos/list.js': 'export const list = []\n' })

    const result = await scene.runCi({ branch, head })

    expect(result.code).toBe(0)
    expect(result.json.ok).toBe(true)
    expect(stepsOf(result)).toEqual(ALL_STEPS)
    expect(result.json.data).toMatchObject({
      pullRequest: 30,
      head,
      base: 'main',
      author: builder1,
      task: 12,
      version: VERSION,
    })
    expect(result.json.lines).toEqual([`hackwin CI passed for pull request #30 at ${head}`])
    const order = ALL_STEPS.map((step) => result.stderr.indexOf(`step ${step}, `))
    expect(order.every((index) => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(result.stderr).toContain(
      'step 7, merge with the base branch: merges with origin/main; installs; hackwin.yml sets no commands.generate',
    )
    expect(result.stderr).toContain(
      'step 9, check and acceptance tests: `' + sceneConfig().hackwin.commands.check + '` passed',
    )

    expect(scene.leftovers()).toEqual([])
    const worktrees = await result.checkout.git.worktreeList()
    expect(worktrees.map((worktree) => worktree.path)).toEqual([result.checkout.path])
    expect(await result.checkout.git.revParse('HEAD')).toBe(head)
    expect(await result.checkout.git.isClean()).toBe(true)
  })

  test('the check runs on the tree merged with the current main, not on the head alone', async () => {
    const scene = await createCiScene()
    const branch = 'task/12-counter-reset'
    const head = await scene.push(branch, WORK)
    await scene.fixture.publish({ 'src/features/todos/list.js': 'export const list = BROKEN\n' })

    const result = await scene.runCi({ branch, head })

    expect(result.code).toBe(1)
    expect(result.json.error).toMatchObject({
      kind: 'blocked',
      rule: 'E13: merge test on the current base branch before every merge',
    })
    expect(result.json.error.message).toMatch(
      /^step 9, check and acceptance tests: the check failed on the merged tree/,
    )
    expect(result.stderr).toContain('broken: src/features/todos/list.js')
    expect(scene.leftovers()).toEqual([])
  })
})

describe('1.4b/ci: the rest of the steps', () => {
  test('a pull request that conflicts with the current main fails the merge step', async () => {
    const scene = await createCiScene()
    const branch = 'task/12-counter-reset'
    const head = await scene.push(branch, {
      ...WORK,
      'src/features/counter/index.js': 'export const count = 1\n',
    })
    await scene.fixture.publish({ 'src/features/counter/index.js': 'export const count = 2\n' })

    const result = await scene.runCi({ branch, head })

    expect(result.code).toBe(1)
    expect(result.json.error).toMatchObject({
      rule: 'E13: merge test on the current base branch before every merge',
      objects: ['src/features/counter/index.js'],
    })
    expect(result.json.error.message).toBe(
      'step 7, merge with the base branch: pull request #30 conflicts with origin/main',
    )
    expect(scene.leftovers()).toEqual([])
    expect((await result.checkout.git.worktreeList()).length).toBe(1)
  })

  test('an install that changes a tracked file fails the merge step', async () => {
    const config = sceneConfig((hackwin) => {
      hackwin.commands.install = 'echo installed > README.md'
    })
    const scene = await createCiScene({ config })
    const branch = 'task/12-counter-reset'
    const head = await scene.push(branch, WORK)

    const result = await scene.runCi({ branch, head })

    expect(result.code).toBe(1)
    expect(result.json.error).toMatchObject({
      rule: 'E10: generated files are produced only by the Lead and are current',
      objects: ['README.md'],
    })
  })

  test('an unformatted changed file fails the format check, and only changed files are checked', async () => {
    const scene = await createCiScene()
    await scene.fixture.publish({ 'src/features/todos/index.js': 'export const todos = []   \n' })
    const branch = 'task/12-counter-reset'
    const head = await scene.push(branch, {
      ...WORK,
      'src/features/counter/reset.js': 'export const reset = () => 0  \n',
    })

    const result = await scene.runCi({ branch, head })

    expect(result.code).toBe(1)
    expect(result.json.error).toMatchObject({
      rule: 'E14: the changed files are formatted',
      objects: ['src/features/counter/reset.js'],
    })
    expect(result.json.error.resolve).toContain('in the worktree of task #12')
  })

  test('an acceptance test that is not an existing file fails, and a failing one fails with its output', async () => {
    const scene = await createCiScene()
    const branch = 'task/12-counter-reset'
    const missing = await scene.push(branch, {
      'src/features/counter/reset.js': WORK['src/features/counter/reset.js'],
    })

    const first = await scene.runCi({ branch, head: missing })

    expect(first.code).toBe(1)
    expect(first.json.error).toMatchObject({
      rule: 'T5: a named acceptance test that does not exist counts as a failure',
      objects: [TEST_FILE],
    })

    const failing = await scene.push(branch, { [TEST_FILE]: 'FAIL\n' })
    const second = await scene.runCi({ branch, head: failing })

    expect(second.code).toBe(1)
    expect(second.json.error.message).toMatch(
      /^step 9, check and acceptance tests: the acceptance tests failed/,
    )
    expect(second.stderr).toContain(`FAIL ${TEST_FILE}`)
    expect(scene.leftovers()).toEqual([])
  })

  test('outside a run on a pull request event, or on another commit than its head, it refuses to start', async () => {
    const scene = await createCiScene()
    const branch = 'task/12-counter-reset'
    const head = await scene.push(branch, WORK)
    const main = await scene.fixture.git.revParse('origin/main')

    const outside = await scene.runCi({ branch, head, event: false })
    expect(outside.code).toBe(2)
    expect(outside.json.error).toMatchObject({
      kind: 'precondition',
      message:
        'hackwin internal ci checks one pull request in a run of the hackwin workflow: GITHUB_EVENT_PATH is not set',
    })

    const elsewhere = await scene.runCi({ branch, head, checkoutAt: main })
    expect(elsewhere.code).toBe(2)
    expect(elsewhere.json.error.message).toBe(
      `the checkout is at ${main}, not at ${head}, the head commit of pull request #30`,
    )
  })
})

import { describe, expect, test } from 'vitest'
import { TEST_FILE, WORK, createCiScene, taskBody } from './ci-fixture.js'

describe('AC71/ci: the task link in CI', () => {
  test('a pull request that names no open task with a valid data block fails CI', async () => {
    const scene = await createCiScene()
    scene.issues.push(
      { number: 15, title: 'Done task', body: scene.issues[0].body, state: 'closed' },
      { number: 16, title: 'Just an issue', body: 'Make the counter nicer.' },
      {
        number: 17,
        title: 'Task without deadline',
        body: taskBody({
          kind: 'task',
          role: 'counter',
          paths: ['src/features/counter/**'],
          depends_on: [],
          acceptance_tests: [TEST_FILE],
        }),
      },
    )
    const cases = [
      {
        branch: 'task/12-counter-reset',
        body: 'Resets the counter.\n',
        message: 'the body has no line `Closes #<N>` that names the task',
      },
      {
        branch: 'task/12-counter-reset',
        body: 'Closes #12\nFixes #15\n',
        message: 'the body names more than one issue to close',
      },
      {
        branch: 'task/12-counter-reset',
        body: 'Closes #16\n',
        message: 'the body closes another issue than the task of task/12-counter-reset',
      },
      {
        branch: 'feature/counter',
        body: 'Closes #12\n',
        message: 'feature/counter is not a task branch task/<N>-<slug>',
      },
      {
        branch: 'task/15-done-task',
        body: 'Closes #15\n',
        message: 'issue #15 is not an open issue',
      },
      {
        branch: 'task/99-missing',
        body: 'Closes #99\n',
        message: 'issue #99 is not an open issue',
      },
      {
        branch: 'task/16-just-an-issue',
        body: 'Closes #16\n',
        message: 'issue #16 is not a task with a valid data block',
      },
      {
        branch: 'task/17-task-without-deadline',
        body: 'Closes #17\n',
        message: 'issue #17 is not a task with a valid data block',
      },
    ]
    /** @type {Record<string, string>} */
    const heads = {}
    for (const { branch } of cases) heads[branch] ??= await scene.push(branch, WORK)

    const results = await Promise.all(
      cases.map(({ branch, body }) => scene.runCi({ branch, head: heads[branch], body })),
    )

    for (const [index, { branch, message }] of cases.entries()) {
      const result = results[index]
      expect(result.code, message).toBe(1)
      expect(result.json.error.rule, message).toBe(
        'E11: one issue, one pull request; the pull request names a valid open task',
      )
      expect(result.json.error.message, message).toBe(`step 2, task link: ${message}`)
      expect(result.stderr, message).not.toContain('step 3, ')
    }
    expect(results[7].json.error.objects).toEqual([expect.stringMatching(/^issue #17: .*deadline/)])
    expect(results[6].json.error.objects).toEqual(['issue #16: no # hackwin:task block'])
  })

  test('a pull request opened by hand from a spike/ branch fails CI', async () => {
    const scene = await createCiScene()
    const branch = 'spike/try-counter'
    const head = await scene.push(branch, WORK)

    const result = await scene.runCi({ branch, head, body: 'Closes #12\n' })

    expect(result.code).toBe(1)
    expect(result.json.error).toMatchObject({
      kind: 'blocked',
      rule: 'E16: spike/ branches are never merged',
      objects: ['branch spike/try-counter', 'pull request #30'],
    })
    expect(result.json.error.message).toBe(
      'step 2, task link: spike/try-counter is a spike/ branch, which is never merged',
    )
  })
})

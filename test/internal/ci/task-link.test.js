import { describe, expect, test } from 'vitest'
import { accounts } from '../../harness/index.js'
import { ALL_STEPS, TEST_FILE, WORK, createCiScene, stepsOf, taskBody } from './ci-fixture.js'

const E11 = 'E11: one issue, one pull request; the pull request names a valid open task'

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

describe('1.4i/outsider-task: the task link in CI names a task that a member of the team wrote', () => {
  test('a task issue by an account outside the team fails step 2, which names the issue and its author; the same issue by a member passes', async () => {
    const scene = await createCiScene()
    const issue = {
      number: 31,
      title: 'Counter reset',
      body: scene.issues[0].body,
      labels: ['in-review', 'role:counter'],
      author: 'mallory',
    }
    scene.issues.push(issue)
    const branch = 'task/31-counter-reset'
    const head = await scene.push(branch, WORK)

    const outsider = await scene.runCi({ branch, head })

    expect(outsider.code).toBe(1)
    expect(outsider.json.error).toMatchObject({
      kind: 'blocked',
      rule: E11,
      objects: ['issue #31'],
    })
    expect(outsider.json.error.message).toBe(
      'step 2, task link: issue #31 was written by mallory, who is not a member of the team in hackwin.yml; only an issue that team.lead or one of team.members wrote is a task',
    )
    expect(outsider.json.error.resolve).toBe(
      'ask the Lead to write the task, move the work to the branch task/<N>-<slug> of that task with a pull request that holds `Closes #<N>`, and close pull request #30',
    )
    expect(outsider.stderr).not.toContain('step 3, ')

    // An author that holds an escape character is named quoted, never as it is.
    issue.author = 'mallory\u001b[2J'
    const escaped = await scene.runCi({ branch, head })

    expect(escaped.code).toBe(1)
    expect(escaped.json.error.message).toBe(
      'step 2, task link: issue #31 was written by "mallory\\u001b[2J", who is not a member of the team in hackwin.yml; only an issue that team.lead or one of team.members wrote is a task',
    )

    issue.author = accounts.builder2.login
    const member = await scene.runCi({ branch, head })

    expect(member.code).toBe(0)
    expect(stepsOf(member)).toEqual(ALL_STEPS)
    expect(member.json.data.task).toBe(31)
    expect(member.stderr).toContain(
      'step 2, task link: task/31-counter-reset closes task #31, an open task with a valid data block',
    )
  })
})

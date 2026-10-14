import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
  accounts,
  createFakeGitHub,
  createFixture,
  hackwinObject,
  yaml,
} from '../../harness/index.js'
import { blockBody, pull, take, task } from './helpers.js'

/** @typedef {import('../../harness/index.js').Fixture} Fixture */

const LEAD = accounts.lead.login
const BUILDER1 = accounts.builder1.login // counter, todos
const BUILDER2 = accounts.builder2.login // greeting

/** @type {Fixture} */
let fixture
/** @type {{ lead: string, builder1: string, builder2: string }} */
let clones

beforeAll(async () => {
  fixture = await createFixture({ team: 3 })
  await fixture.join(fixture.main, { login: LEAD })
  clones = {
    lead: fixture.main,
    builder1: (await fixture.joinedClone({ name: 'builder1', login: BUILDER1 })).path,
    builder2: (await fixture.joinedClone({ name: 'builder2', login: BUILDER2 })).path,
  }
})

afterAll(() => fixture.cleanup())

describe('AC12: take exits 1 with a specific reason for each failed check, and 2 where join has not completed', () => {
  test('the caller does not hold the role of the task', async () => {
    const fake = createFakeGitHub({
      issues: [task(7, { role: 'greeting', paths: ['src/features/greeting/**'] })],
    })
    const result = await take(fixture, clones.builder1, fake, BUILDER1, ['7'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain(
      `blocked: #7 cannot be taken: #7 is a task of the role greeting, which ${BUILDER2} holds on main; you hold counter, todos`,
    )
    expect(result.stderr).toContain('rule: take check 1')
    expect(result.stderr).toContain(`to resolve: run \`hackwin take\` in ${clones.builder1}`)
  })

  test('a dependency is still open', async () => {
    const fake = createFakeGitHub({
      issues: [
        task(3, { role: 'shared', paths: ['src/shared/**'] }),
        task(7, { role: 'counter', paths: ['src/features/counter/**'], depends_on: [3] }),
      ],
    })
    const result = await take(fixture, clones.builder1, fake, BUILDER1, ['7'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('#7 cannot be taken: blocked by #3, still open')
    expect(result.stderr).toContain('rule: take check 3')
    expect(result.stderr).toContain('- #3 Task 3: open')
  })

  test('an open pull request changes a file inside the task paths', async () => {
    const fake = createFakeGitHub({
      issues: [task(7, { role: 'counter', paths: ['src/features/counter/**'] })],
      pulls: [pull(20, ['src/features/counter/button.js', 'src/features/counter/state.js'])],
    })
    const result = await take(fixture, clones.builder1, fake, BUILDER1, ['7'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain(
      '#7 cannot be taken: path collision with PR #20: src/features/counter/button.js, and 1 more',
    )
    expect(result.stderr).toContain('rule: take check 4')
  })

  test('the caller already runs as many tasks as their sessions value', async () => {
    const fake = createFakeGitHub({
      issues: [
        task(5, {
          role: 'counter',
          paths: ['src/features/counter/a/**'],
          labels: ['in-progress'],
          assignees: [BUILDER1],
        }),
        task(6, {
          role: 'todos',
          paths: ['src/features/todos/**'],
          labels: ['in-progress'],
          assignees: [BUILDER1],
        }),
        task(7, { role: 'counter', paths: ['src/features/counter/b/**'] }),
      ],
    })
    const result = await take(fixture, clones.builder1, fake, BUILDER1, ['7'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain(
      '#7 cannot be taken: you already run 2 tasks: #5, #6; your sessions value in hackwin.yml is 2',
    )
    expect(result.stderr).toContain('rule: take check 5')
    expect(result.stderr).toMatch(/to resolve: run `hackwin ship` in .*\.worktrees\/5-task-5/)
  })

  test('in a clone where join has not completed, take exits 2 and names hackwin join', async () => {
    const fresh = await fixture.clone('not-joined')
    const fake = createFakeGitHub({
      issues: [task(7, { role: 'counter', paths: ['src/features/counter/**'] })],
    })
    for (const args of [['7'], []]) {
      const result = await take(fixture, fresh.path, fake, BUILDER1, args)
      expect(result.code).toBe(2)
      expect(result.stderr).toContain('`hackwin join` has not completed in this clone')
      expect(result.stderr).toContain(`to resolve: run \`hackwin join\` in ${fresh.path}`)
    }
  })

  test('a join record of another login does not count', async () => {
    const fake = createFakeGitHub({
      issues: [task(7, { role: 'greeting', paths: ['src/features/greeting/**'] })],
    })
    const result = await take(fixture, clones.builder1, fake, BUILDER2, ['7'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain(
      `\`hackwin join\` completed in this clone for ${BUILDER1}, not for ${BUILDER2}`,
    )
  })
})

describe('AC13: take without a number picks the first takeable task of the queue and lists the skipped tasks', () => {
  /** The queue of builder1: wave 1 by deadline (#10, #11, #13), then wave 2 (#12). */
  const issues = () => [
    task(2, { role: 'shared', paths: ['src/shared/**'] }),
    task(10, {
      title: 'Counter reset',
      role: 'counter',
      paths: ['src/features/counter/reset/**'],
      depends_on: [2],
      deadline: '2026-10-25T10:00:00+02:00',
    }),
    task(11, {
      title: 'Todo list',
      role: 'todos',
      paths: ['src/features/todos/list/**'],
      deadline: '2026-10-25T11:00:00+02:00',
    }),
    task(12, {
      title: 'Counter step',
      role: 'counter',
      paths: ['src/features/counter/step/**'],
      wave: 2,
    }),
    task(13, {
      title: 'Todo filter',
      role: 'todos',
      paths: ['src/features/todos/filter/**'],
      deadline: '2026-10-25T13:00:00+02:00',
    }),
    task(14, { title: 'Greeting', role: 'greeting', paths: ['src/features/greeting/**'] }),
    task(15, {
      title: 'Counter style',
      role: 'counter',
      paths: ['src/features/counter/style/**'],
      labels: ['in-progress'],
      assignees: [BUILDER1],
    }),
  ]

  test('the first task that passes every check is selected after the skipped ones', async () => {
    const fake = createFakeGitHub({
      issues: issues(),
      pulls: [pull(20, ['src/features/todos/list/item.js'])],
    })
    const result = await take(fixture, clones.builder1, fake, BUILDER1)
    expect(result.code).toBe(0)
    expect(result.stdout.trimEnd().split('\n').slice(0, 4)).toEqual([
      'skipped #10 Counter reset: blocked by #2, still open',
      'skipped #11 Todo list: path collision with PR #20: src/features/todos/list/item.js',
      'selected #13 Todo filter (role todos)',
      `claimed #13: in-progress, assigned to ${BUILDER1}, labeled role:todos`,
    ])
    expect(fake.find(13)?.labels).toContain('in-progress')
    expect(fake.find(10)?.labels).toEqual(['ready'])
  })

  test('--json gives the selected task and every skipped task with its check and reason', async () => {
    const fake = createFakeGitHub({
      issues: issues(),
      pulls: [pull(20, ['src/features/todos/list/item.js'])],
    })
    const result = await take(fixture, clones.builder1, fake, BUILDER1, ['--json'])
    expect(result.code).toBe(0)
    const json = JSON.parse(result.stdout)
    expect(json.ok).toBe(true)
    expect(json.data.task).toMatchObject({
      number: 13,
      role: 'todos',
      paths: ['src/features/todos/filter/**'],
      deadline: '2026-10-25T13:00:00+02:00',
    })
    expect(json.data.skipped.map((entry) => [entry.number, entry.check, entry.reason])).toEqual([
      [10, 3, 'blocked by #2, still open'],
      [11, 4, 'path collision with PR #20: src/features/todos/list/item.js'],
    ])
  })

  test('a queue in which no task passes exits 1 and lists every task with its reason', async () => {
    const fake = createFakeGitHub({
      issues: [
        ...issues().filter((issue) => issue.number !== 13 && issue.number !== 12),
        task(12, {
          title: 'Counter step',
          role: 'counter',
          paths: ['src/features/counter/step/**'],
          wave: 2,
          labels: ['needs-lead'],
        }),
      ],
      pulls: [pull(20, ['src/features/todos/list/item.js'])],
    })
    const result = await take(fixture, clones.builder1, fake, BUILDER1)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('no task of your queue can be taken yet: all 3 failed a check')
    expect(result.stderr).toContain('- #10 Counter reset: blocked by #2, still open')
    expect(result.stderr).toContain(
      '- #11 Todo list: path collision with PR #20: src/features/todos/list/item.js',
    )
    expect(result.stderr).toContain('- #12 Counter step: #12 waits for the Lead (needs-lead)')
  })

  test('an empty queue exits 0 with "queue empty" and sends the member to the Lead for the next wave', async () => {
    const fake = createFakeGitHub({
      issues: [
        task(14, { role: 'greeting', paths: ['src/features/greeting/**'] }),
        task(16, { role: 'counter', paths: ['src/features/counter/**'], state: 'closed' }),
        task(17, { role: 'todos', paths: ['src/features/todos/**'], labels: ['in-review'] }),
      ],
    })
    const result = await take(fixture, clones.builder1, fake, BUILDER1)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('queue empty')
    expect(result.stdout).toContain('ask the Lead for the next wave')
  })

  test('with the session limit reached, take exits 1 once with check 5 instead of skipping every task', async () => {
    const fake = createFakeGitHub({
      issues: [
        ...issues(),
        task(16, {
          role: 'todos',
          paths: ['src/features/todos/done/**'],
          labels: ['in-progress'],
          assignees: [BUILDER1],
        }),
      ],
    })
    const result = await take(fixture, clones.builder1, fake, BUILDER1)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('no task can be taken: you already run 2 tasks: #15, #16')
    expect(result.stderr).not.toContain('#13')
  })
})

describe('AC53: after a role swap is merged on main, the new holder can take the open tasks of the role and the previous holder cannot', () => {
  /** @type {Fixture} */
  let swap
  /** @type {{ builder1: string, builder2: string }} */
  let swapClones

  beforeAll(async () => {
    swap = await createFixture({ team: 3, name: 'swap' })
    swapClones = {
      builder1: (await swap.joinedClone({ name: 'builder1', login: BUILDER1 })).path,
      builder2: (await swap.joinedClone({ name: 'builder2', login: BUILDER2 })).path,
    }
  })
  afterAll(() => swap.cleanup())

  test('the role greeting moves from builder2 to builder1', async () => {
    // A fresh GitHub for each take: a take that succeeds claims the task.
    const fresh = () =>
      createFakeGitHub({
        issues: [
          task(4, { title: 'Greeting', role: 'greeting', paths: ['src/features/greeting/**'] }),
        ],
      })

    expect((await take(swap, swapClones.builder2, fresh(), BUILDER2, ['4'])).code).toBe(0)
    expect((await take(swap, swapClones.builder1, fresh(), BUILDER1, ['4'])).code).toBe(1)

    // The swap: one line per member in hackwin.yml, merged on main (3.4).
    const hackwin = hackwinObject(3)
    hackwin.team.members[1].roles = ['counter', 'greeting']
    hackwin.team.members[2].roles = ['todos']
    await swap.publish({ 'hackwin.yml': yaml(hackwin) }, { message: 'Swap greeting and todos' })

    const newHolder = await take(swap, swapClones.builder1, fresh(), BUILDER1, ['4'])
    expect(newHolder.code).toBe(0)
    expect(newHolder.stdout).toContain('selected #4 Greeting (role greeting)')
    const fromQueue = await take(swap, swapClones.builder1, fresh(), BUILDER1)
    expect(fromQueue.stdout).toContain('selected #4 Greeting (role greeting)')

    const previous = await take(swap, swapClones.builder2, fresh(), BUILDER2, ['4'])
    expect(previous.code).toBe(1)
    expect(previous.stderr).toContain(
      `#4 is a task of the role greeting, which ${BUILDER1} holds on main; you hold todos`,
    )
    const previousQueue = await take(swap, swapClones.builder2, fresh(), BUILDER2)
    expect(previousQueue.stdout).toContain('queue empty')
  })
})

describe('AC65/take: an issue with an invalid data block is refused by take with the reason', () => {
  test('a path of another role and a missing deadline', async () => {
    const body = blockBody(
      yaml({
        kind: 'task',
        role: 'counter',
        wave: 1,
        paths: ['src/features/counter/**', 'src/features/greeting/**'],
        depends_on: [],
        acceptance_tests: ['test/features.test.js'],
      }).trimEnd(),
    )
    const fake = createFakeGitHub({ issues: [{ number: 9, title: 'Hand written', body }] })
    const result = await take(fixture, clones.builder1, fake, BUILDER1, ['9'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('#9 cannot be taken: the task block of #9 is invalid:')
    expect(result.stderr).toContain(
      "paths[1] (src/features/greeting/**) lies in the role greeting, not in the task's role counter",
    )
    expect(result.stderr).toContain('deadline is missing')
    expect(result.stderr).toContain('rule: take check 2')
    expect(result.stderr).toContain('to resolve: ask the Lead to correct the task block of #9')
  })

  test('a block that is not valid YAML', async () => {
    const fake = createFakeGitHub({
      issues: [{ number: 9, title: 'Broken', body: blockBody('role: [counter') }],
    })
    const result = await take(fixture, clones.builder1, fake, BUILDER1, ['9'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain(
      'the task block of #9 is invalid: the task block is not valid YAML',
    )
  })
})

describe('1.5a/preconditions: take N needs an open task issue', () => {
  const fake = () =>
    createFakeGitHub({
      issues: [
        { number: 1, title: 'A question', body: 'No block here.' },
        task(2, { role: 'counter', paths: ['src/features/counter/**'], state: 'closed' }),
      ],
      pulls: [pull(3, ['src/features/counter/a.js'])],
    })

  test.each([
    ['abc', 'not an issue number: abc'],
    ['0', 'not an issue number: 0'],
    ['99', '#99 does not exist'],
    ['1', '#1 is not a task issue'],
    ['2', '#2 is closed'],
    ['3', '#3 is a pull request, not a task issue'],
  ])('take %s exits 2', async (arg, message) => {
    const result = await take(fixture, clones.builder1, fake(), BUILDER1, [arg])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain(message)
  })

  test.each([
    [[], 'take --release needs the number of the task'],
    [['2'], '#2 is closed'],
    [['3'], '#3 is a pull request, not a task issue'],
  ])('take %j --release exits 2', async (args, message) => {
    const result = await take(fixture, clones.builder1, fake(), BUILDER1, [...args, '--release'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain(message)
  })
})

describe('1.5a/checks: the details of the five checks', () => {
  test.each([
    [['in-progress'], [BUILDER2], `#7 is in progress, assigned to ${BUILDER2}`],
    [['in-review'], [], '#7 is in review'],
    [['cut'], [], '#7 is cut'],
    [['ready', 'needs-lead'], [], '#7 waits for the Lead (needs-lead)'],
  ])('check 2 refuses a task labeled %j', async (labels, assignees, reason) => {
    const fake = createFakeGitHub({
      issues: [task(7, { role: 'counter', paths: ['src/features/counter/**'], labels, assignees })],
    })
    const result = await take(fixture, clones.builder1, fake, BUILDER1, ['7'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain(`#7 cannot be taken: ${reason}`)
    expect(result.stderr).toContain('rule: take check 2')
  })

  test('closed dependencies pass, and a dependency that does not exist counts as open', async () => {
    const fake = createFakeGitHub({
      issues: [
        task(3, { role: 'shared', paths: ['src/shared/**'], state: 'closed' }),
        task(7, { role: 'counter', paths: ['src/features/counter/**'], depends_on: [3] }),
        task(8, { role: 'counter', paths: ['src/features/counter/**'], depends_on: [3, 99] }),
      ],
    })
    expect((await take(fixture, clones.builder1, fake, BUILDER1, ['7'])).code).toBe(0)
    const missing = await take(fixture, clones.builder1, fake, BUILDER1, ['8'])
    expect(missing.code).toBe(1)
    expect(missing.stderr).toContain('blocked by #99 (no such issue), still open')
  })

  test('a file on the open list in an open pull request is no collision (H6)', async () => {
    const fake = createFakeGitHub({
      issues: [task(7, { role: 'counter', paths: ['src/features/counter/**', 'README.md'] })],
      pulls: [pull(20, ['README.md', 'src/features/todos/a.js'])],
    })
    const result = await take(fixture, clones.builder1, fake, BUILDER1, ['7'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('selected #7 Task 7 (role counter)')
  })

  test('a rename out of the task paths is a collision', async () => {
    const fake = createFakeGitHub({
      issues: [task(7, { role: 'counter', paths: ['src/features/counter/**'] })],
      pulls: [
        pull(20, [
          { path: 'src/shared/button.js', previousPath: 'src/features/counter/button.js' },
        ]),
      ],
    })
    const result = await take(fixture, clones.builder1, fake, BUILDER1, ['7'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('path collision with PR #20: src/features/counter/button.js')
  })

  test('a task in progress with overlapping paths is a collision, also for another member', async () => {
    const fake = createFakeGitHub({
      issues: [
        task(7, { role: 'counter', paths: ['src/features/counter/**'] }),
        task(8, {
          role: 'counter',
          paths: ['src/features/counter/ui/**'],
          labels: ['in-progress'],
          assignees: [BUILDER2],
        }),
      ],
    })
    const result = await take(fixture, clones.builder1, fake, BUILDER1, ['7'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain(
      '#7 cannot be taken: path collision with #8, in progress: src/features/counter/** overlaps src/features/counter/ui/**',
    )
  })

  test('tasks in progress that share only paths on the open list do not collide (H6)', async () => {
    const fake = createFakeGitHub({
      issues: [
        task(7, { role: 'counter', paths: ['src/features/counter/a/**', 'README.md'] }),
        task(8, {
          role: 'counter',
          paths: ['src/features/counter/b/**', 'README.md'],
          labels: ['in-progress'],
          assignees: [BUILDER1],
        }),
      ],
    })
    const result = await take(fixture, clones.builder1, fake, BUILDER1, ['7'])
    expect(result.code).toBe(0)
  })

  test('only in-progress tasks assigned to the caller count against the sessions value', async () => {
    const fake = createFakeGitHub({
      issues: [
        task(5, {
          role: 'counter',
          paths: ['src/features/counter/a/**'],
          labels: ['in-progress'],
          assignees: [BUILDER1],
        }),
        task(6, {
          role: 'todos',
          paths: ['src/features/todos/a/**'],
          labels: ['in-review'],
          assignees: [BUILDER1],
        }),
        task(8, {
          role: 'greeting',
          paths: ['src/features/greeting/**'],
          labels: ['in-progress'],
          assignees: [BUILDER2],
        }),
        task(7, { role: 'todos', paths: ['src/features/todos/b/**'] }),
      ],
    })
    const result = await take(fixture, clones.builder1, fake, BUILDER1, ['7'])
    expect(result.code).toBe(0)
  })

  test('the Lead takes a task of the shared role from the main checkout', async () => {
    const fake = createFakeGitHub({
      issues: [
        task(7, { title: 'Shared types', role: 'shared', paths: ['src/shared/**'], wave: null }),
      ],
    })
    const result = await take(fixture, clones.lead, fake, LEAD)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('selected #7 Shared types (role shared)')
  })
})

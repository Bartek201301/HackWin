import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { parseHackwinConfig, parseOwners } from '../../../src/core/config/index.js'
import { parseTaskBlock } from '../../../src/core/tasks/index.js'
import {
  accounts,
  createFakeGitHub,
  createFixture,
  hackwinObject,
  ownersObject,
  yaml,
} from '../../harness/index.js'
import { CHECK_RULES } from '../../../src/commands/take/checks.js'
import { blockBody, take, task } from './helpers.js'

/** @typedef {import('../../harness/index.js').Fixture} Fixture */

const LEAD = accounts.lead.login
const BUILDER1 = accounts.builder1.login // counter, todos

/** An account outside the team. */
const OUTSIDER = 'mallory'

/** A control character, a line break or a bidirectional format character other than a line feed. */
const UNSAFE =
  /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/

/** @type {Fixture} */
let fixture
/** @type {string} */
let clone

beforeAll(async () => {
  fixture = await createFixture({ team: 3 })
  await fixture.join(fixture.main, { login: LEAD })
  clone = (await fixture.joinedClone({ name: 'builder1', login: BUILDER1 })).path
})

afterAll(() => fixture.cleanup())

/**
 * A valid task of builder1's role counter, written by this account.
 * @param {number} number
 * @param {string} author
 */
function counterTask(number, author) {
  return {
    ...task(number, {
      title: 'Counter reset',
      role: 'counter',
      paths: ['src/features/counter/**'],
    }),
    author,
  }
}

/** @param {string} who How the message names the author. */
function outsiderMessage(who) {
  return `is not a task issue: it was written by ${who}, who is not a member of the team in hackwin.yml; only an issue that team.lead or one of team.members wrote is a task (8.1)`
}

describe('1.5g/outsider-task: take never takes an issue that no member of the team wrote', () => {
  test("an outsider's issue with a valid task block is not in the queue", async () => {
    const fake = createFakeGitHub({ issues: [counterTask(30, OUTSIDER)] })
    const result = await take(fixture, clone, fake, BUILDER1)
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('queue empty')
    expect(result.stdout).not.toContain('#30')
    expect(fake.find(30)).toMatchObject({ labels: ['ready'], assignees: [] })
  })

  test("the queue skips an outsider's issue and takes a member's task after it", async () => {
    const fake = createFakeGitHub({
      issues: [
        counterTask(30, OUTSIDER),
        task(31, { title: 'Todo list', role: 'todos', paths: ['src/features/todos/**'] }),
      ],
    })
    const result = await take(fixture, clone, fake, BUILDER1)
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('selected #31 Todo list (role todos)')
    expect(result.stdout).not.toContain('#30')
    expect(fake.find(30)).toMatchObject({ labels: ['ready'], assignees: [] })
  })

  test('take N on it exits 2, names the author and changes nothing', async () => {
    const fake = createFakeGitHub({ issues: [counterTask(30, OUTSIDER)] })
    for (const args of [['30'], ['30', '--release']]) {
      const result = await take(fixture, clone, fake, BUILDER1, args)
      expect(result.code, result.stderr).toBe(2)
      expect(result.stderr).toContain(`hackwin take: #30 ${outsiderMessage(OUTSIDER)}`)
      expect(result.stderr).not.toContain('# hackwin:task')
      expect(result.stderr).toContain(`to resolve: run \`hackwin take\` in ${clone}`)
    }
    expect(fake.find(30)).toMatchObject({ labels: ['ready'], assignees: [] })
  })

  test('--json gives the author and member: false', async () => {
    const fake = createFakeGitHub({ issues: [counterTask(30, OUTSIDER)] })
    const result = await take(fixture, clone, fake, BUILDER1, ['30', '--json'])
    expect(result.code, result.stderr).toBe(2)
    const json = JSON.parse(result.stdout)
    expect(json.ok).toBe(false)
    expect(json.error.message).toBe(`#30 ${outsiderMessage(OUTSIDER)}`)
    expect(json.error.details).toEqual({ author: OUTSIDER, member: false })
  })

  test('without a task block, the author is still the reason', async () => {
    const fake = createFakeGitHub({
      issues: [{ number: 30, title: 'A question', body: 'No block here.', author: OUTSIDER }],
    })
    const result = await take(fixture, clone, fake, BUILDER1, ['30'])
    expect(result.code, result.stderr).toBe(2)
    expect(result.stderr).toContain(`#30 ${outsiderMessage(OUTSIDER)}`)
  })

  test('an author with a control character is quoted with it escaped', async () => {
    const fake = createFakeGitHub({ issues: [counterTask(30, 'mal\u001b[2J\rlory')] })
    const result = await take(fixture, clone, fake, BUILDER1, ['30'])
    expect(result.code, result.stderr).toBe(2)
    expect(result.stderr).toContain(`#30 ${outsiderMessage('"mal\\u001b[2J\\rlory"')}`)
    expect(result.stderr).not.toMatch(UNSAFE)
  })

  test.each([
    ['builder1', BUILDER1],
    ['builder1 in upper case', BUILDER1.toUpperCase()],
    ['the Lead', LEAD],
  ])('the same issue written by %s is taken as before', async (_, author) => {
    const fake = createFakeGitHub({ issues: [counterTask(30, author)] })
    const queued = await take(fixture, clone, fake, BUILDER1)
    expect(queued.code, queued.stderr).toBe(0)
    expect(queued.stdout).toContain('selected #30 Counter reset (role counter)')
    expect(queued.stdout).toContain(
      `claimed #30: in-progress, assigned to ${BUILDER1}, labeled role:counter`,
    )

    const again = createFakeGitHub({ issues: [counterTask(30, author)] })
    const numbered = await take(fixture, clone, again, BUILDER1, ['30'])
    expect(numbered.code, numbered.stderr).toBe(0)
    expect(numbered.stdout).toContain('selected #30 Counter reset (role counter)')
    expect(again.find(30)?.labels).toContain('in-progress')
  })
})

describe('1.5g/block-errors: take prints the errors of a task block as parseTaskBlock gives them', () => {
  const config = {
    hackwin: parseHackwinConfig(yaml(hackwinObject(3))),
    owners: parseOwners(yaml(ownersObject())),
  }

  // A YAML escape in double quotes and how an error writes the character it decodes to: the
  // escape character (clear the screen, reset the terminal), a carriage return, a line feed and
  // both.
  test.each([
    ['\\e[2J', '\\u001b[2J'],
    ['\\ec', '\\u001bc'],
    ['\\r', '\\r'],
    ['\\n', '\\n'],
    ['a\\r\\nb', 'a\\r\\nb'],
  ])('"%s" in the block is printed escaped', async (escape, shown) => {
    const body = blockBody(
      [
        `"x${escape}": 1`,
        `kind: "task${escape}"`,
        `role: "counter${escape}"`,
        `wave: "1${escape}"`,
        `paths: ["src/features/counter/${escape}x.js"]`,
        'depends_on: []',
        'acceptance_tests: [test/features.test.js]',
        `deadline: "2026-10-25${escape}"`,
      ].join('\n'),
    )
    const parsed = /** @type {any} */ (parseTaskBlock(body, config))
    expect(parsed).toMatchObject({ isTask: true, valid: false })
    /** @type {string[]} */
    const errors = parsed.errors
    expect(errors).toContain(`role "counter${shown}" is not a role of owners.yml`)

    const fake = createFakeGitHub({
      issues: [{ number: 9, title: 'Hand written', body, author: LEAD }],
    })
    const result = await take(fixture, clone, fake, BUILDER1, ['9'])
    expect(result.code, result.stderr).toBe(1)
    expect(result.stderr.split('\n')).toEqual([
      `hackwin take: blocked: #9 cannot be taken: the task block of #9 is invalid: ${errors.join('; ')}`,
      `  rule: ${CHECK_RULES[2]}`,
      ...errors.map((error) => `  - #9: ${error}`),
      '  to resolve: ask the Lead to correct the task block of #9 (8.1)',
      '',
    ])
    expect(result.stdout + result.stderr).not.toMatch(UNSAFE)
  })
})

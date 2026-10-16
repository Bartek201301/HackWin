import { describe, expect, test } from 'vitest'
import { stringify } from 'yaml'
import { parseHackwinConfig, parseOwners } from '../../../src/core/config/index.js'
import {
  LABELS,
  SCOPE_CHANGE,
  WAITING_LABELS,
  branchName,
  checkTaskLink,
  dependenciesOf,
  parseBranch,
  parseTaskBlock,
  parseTaskLink,
  queueOf,
  roleLabel,
  setTaskStatus,
  shown,
  slugOf,
  toTask,
  writtenByTeam,
} from '../../../src/core/tasks/index.js'
import { createGitHub } from '../../../src/core/github/index.js'
import { hackwinObject, ownersObject, yaml } from '../config/fixtures.js'

const config = {
  hackwin: parseHackwinConfig(yaml(hackwinObject())),
  owners: parseOwners(yaml(ownersObject())),
}

/** A valid block of the role web, as an object. */
function blockObject() {
  return {
    kind: 'task',
    role: 'web',
    wave: 1,
    paths: ['src/features/web/**', 'README.md'],
    depends_on: [3],
    acceptance_tests: ['test/web/form.test.js'],
    deadline: '2026-10-25T12:00:00+02:00',
  }
}

/**
 * An issue body with the block in a fenced yaml block, as the task issue template writes it.
 * @param {unknown} block
 */
function body(block) {
  const text = typeof block === 'string' ? block : stringify(block)
  return `\`\`\`yaml\n# hackwin:task\n${text}\`\`\`\n\n## Problem\nThe form is missing.\n\n## Expected result\nA form.\n`
}

/**
 * @param {Partial<import('../../../src/core/github/index.js').Issue> & { number: number }} fields
 * @returns {import('../../../src/core/github/index.js').Issue}
 */
function issue(fields) {
  return {
    title: `Task ${fields.number}`,
    body: body(blockObject()),
    state: 'open',
    stateReason: null,
    labels: [],
    assignees: [],
    author: 'lead',
    url: `https://github.com/o/r/issues/${fields.number}`,
    createdAt: '2026-10-10T10:00:00Z',
    updatedAt: '2026-10-10T10:00:00Z',
    closedAt: null,
    isPullRequest: false,
    ...fields,
  }
}

/**
 * A GitHub client whose executor answers `GET issues/<n>` from a table.
 * @param {Record<number, object>} issues
 */
function github(issues) {
  return createGitHub({
    repo: 'o/r',
    executor: async (args) => {
      const match = /^repos\/\{owner\}\/\{repo\}\/issues\/(\d+)$/.exec(args[3])
      const found = match ? issues[Number(match[1])] : undefined
      if (!found) return { code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }
      return { code: 0, stdout: JSON.stringify(found), stderr: '' }
    },
  })
}

/**
 * An issue as the REST API returns it.
 * @param {number} number
 * @param {{ state?: string, body?: string, pull?: boolean, author?: string | null }} [fields]
 */
function rawIssue(
  number,
  { state = 'open', body: text = body(blockObject()), pull = false, author = 'lead' } = {},
) {
  return {
    number,
    title: 'Login form',
    body: text,
    state,
    labels: [],
    assignees: [],
    user: author === null ? null : { login: author },
    ...(pull ? { pull_request: {} } : {}),
  }
}

/**
 * A pull request of a task branch that names this issue.
 * @param {number} number
 */
function pullOf(number) {
  return { headRef: `task/${number}-login`, body: `Closes #${number}\n` }
}

describe('1.3b/task-block: the task block of 8.1', () => {
  test('a valid block parses, keeping the keys of 8.1', () => {
    expect(parseTaskBlock(body(blockObject()), config)).toEqual({
      isTask: true,
      valid: true,
      block: blockObject(),
    })
    const { wave, depends_on, ...minimal } = blockObject()
    expect(parseTaskBlock(body(minimal), config)).toEqual({
      isTask: true,
      valid: true,
      block: { ...minimal, wave: null, depends_on: [] },
    })
  })

  test('a body without the block is not a task, the status issue included', () => {
    expect(parseTaskBlock('Just an idea, no block.', config)).toEqual({ isTask: false })
    expect(parseTaskBlock('', config)).toEqual({ isTask: false })
    expect(parseTaskBlock(null, config)).toEqual({ isTask: false })
    const status = '```yaml\n# hackwin:gate-status\nheartbeat: now\n```\n'
    expect(parseTaskBlock(status, config)).toEqual({ isTask: false })
    const example = '````markdown\n```yaml\n# hackwin:task\nkind: task\n```\n````\n'
    expect(parseTaskBlock(example, config)).toEqual({ isTask: false })
  })

  test('a block with Windows line endings parses', () => {
    expect(parseTaskBlock(body(blockObject()).replace(/\n/g, '\r\n'), config)).toMatchObject({
      valid: true,
    })
  })

  /** @type {Array<[string, (block: any) => void, RegExp]>} */
  const broken = [
    [
      'a path in another role',
      (block) => block.paths.push('src/features/api/**'),
      /paths\[2\] \(src\/features\/api\/\*\*\) lies in the role api, not in the task's role web/,
    ],
    [
      'a path that spans two roles',
      (block) => block.paths.push('src/**'),
      /paths\[2\] \(src\/\*\*\) spans the roles .*every path lies in exactly one role or on the open list/,
    ],
    [
      'empty acceptance tests outside the kind foundation',
      (block) => {
        block.acceptance_tests = []
      },
      /acceptance_tests is empty; only the kind foundation may have none/,
    ],
    [
      'a missing deadline',
      (block) => {
        delete block.deadline
      },
      /deadline is missing/,
    ],
    [
      'a deadline without an offset',
      (block) => {
        block.deadline = '2026-10-25 12:00'
      },
      /is not an ISO 8601 time with an offset/,
    ],
    ['an unknown kind', (block) => (block.kind = 'chore'), /kind "chore" is not one of/],
    [
      'the kind foundation, which arrives with Phase 2',
      (block) => (block.kind = 'foundation'),
      /kind foundation arrives with Phase 2 \(I15\)/,
    ],
    [
      'an unknown role',
      (block) => (block.role = 'mobile'),
      /role mobile is not a role of owners.yml/,
    ],
    ['no paths', (block) => (block.paths = []), /paths is empty/],
    [
      'an unsupported glob',
      (block) => block.paths.push('src/features/web/[id].js'),
      /paths\[2\] .* is not supported/,
    ],
    [
      'bad dependencies',
      (block) => (block.depends_on = ['#3']),
      /depends_on must be a list of issue numbers/,
    ],
    ['an unknown key', (block) => (block.owner = 'lead'), /owner is not a key of the task block/],
  ]

  for (const [name, breakIt, reason] of broken) {
    test(`${name} makes the block invalid with a reason`, () => {
      const block = blockObject()
      breakIt(block)
      const parsed = parseTaskBlock(body(block), config)
      expect(parsed).toMatchObject({ isTask: true, valid: false })
      expect(/** @type {any} */ (parsed).errors.join('\n')).toMatch(reason)
    })
  }

  test('a path on the open list is allowed for any role; every broken rule is reported', () => {
    const block = { ...blockObject(), role: 'api', paths: ['README.md', 'src/features/api/**'] }
    expect(parseTaskBlock(body(block), config)).toMatchObject({ valid: true })
    const many = { ...blockObject(), acceptance_tests: [], deadline: undefined, kind: 'x' }
    expect(/** @type {any} */ (parseTaskBlock(body(many), config)).errors).toHaveLength(3)
  })

  test('broken YAML, two blocks, an unclosed block and a bare marker are invalid', () => {
    const cases = [
      ['```yaml\n# hackwin:task\nkind: [task\n```\n', /not valid YAML/],
      [`${body(blockObject())}\n${body(blockObject())}`, /2 # hackwin:task blocks/],
      ['```yaml\n# hackwin:task\nkind: task\n', /no closing fence/],
      ['# hackwin:task\nkind: task\n', /must start a fenced yaml code block/],
    ]
    for (const [text, reason] of /** @type {Array<[string, RegExp]>} */ (cases)) {
      const parsed = /** @type {any} */ (parseTaskBlock(text, config))
      expect(parsed.isTask).toBe(true)
      expect(parsed.valid).toBe(false)
      expect(parsed.errors.join('\n')).toMatch(reason)
    }
  })

  test('toTask carries the status from labels; an issue without a block is no task', () => {
    expect(toTask(issue({ number: 5, body: 'no block' }), config)).toBeNull()
    const task = toTask(issue({ number: 5, labels: ['role:web', 'ready', 'in-progress'] }), config)
    expect(task).toMatchObject({ number: 5, status: 'in-progress', valid: true, errors: [] })
    expect(toTask(issue({ number: 5, state: 'closed' }), config)?.status).toBe('closed')
    expect(toTask(issue({ number: 5, labels: ['cut'], state: 'closed' }), config)?.status).toBe(
      'cut',
    )
    expect(toTask(issue({ number: 5 }), config)?.status).toBe('open')
    const invalid = toTask(
      issue({ number: 6, body: body({ ...blockObject(), deadline: null }) }),
      config,
    )
    expect(invalid).toMatchObject({ valid: false, block: null })
    expect(invalid?.errors).toEqual(['deadline is missing; every task has one (T11)'])
  })
})

describe('1.3b/queue: the member queue of 8.1 and readiness', () => {
  /**
   * @param {number} number
   * @param {{ wave?: number | null, deadline?: string, role?: string, labels?: string[], state?: 'open' | 'closed' }} [options]
   */
  function task(
    number,
    {
      wave = 1,
      deadline = '2026-10-25T12:00:00+02:00',
      role = 'web',
      labels = [],
      state = 'open',
    } = {},
  ) {
    const paths = role === 'web' ? ['src/features/web/**'] : ['src/features/api/**']
    const block = { ...blockObject(), wave, deadline, role, paths }
    if (wave === null) delete block.wave
    return /** @type {import('../../../src/core/tasks/index.js').Task} */ (
      toTask(issue({ number, labels, state, body: body(block) }), config)
    )
  }

  test('ordered by wave with tasks without a wave last, then deadline, then number', () => {
    const tasks = [
      task(10, { wave: null }),
      task(11, { wave: 2 }),
      task(12, { wave: 1, deadline: '2026-10-25T18:00:00+02:00' }),
      task(13, { wave: 1, deadline: '2026-10-25T10:00:00+02:00' }),
      task(9, { wave: 1, deadline: '2026-10-25T18:00:00+02:00' }),
      // The same instant as 13, written with another offset: the number decides.
      task(8, { wave: 1, deadline: '2026-10-25T08:00:00Z' }),
    ]
    expect(queueOf(tasks, ['web']).map((t) => t.number)).toEqual([8, 13, 9, 12, 11, 10])
  })

  test('excludes tasks in progress, in review, cut, closed, invalid or of other roles', () => {
    const invalid = /** @type {any} */ (
      toTask(issue({ number: 7, body: body({ ...blockObject(), deadline: null }) }), config)
    )
    const tasks = [
      task(1),
      task(2, { labels: ['in-progress'] }),
      task(3, { labels: ['in-review'] }),
      task(4, { labels: ['cut'] }),
      task(5, { state: 'closed' }),
      task(6, { role: 'api' }),
      invalid,
      task(8, { labels: ['blocked'] }),
      task(9, { labels: ['ready'] }),
    ]
    expect(queueOf(tasks, ['web']).map((t) => t.number)).toEqual([1, 8, 9])
    expect(queueOf(tasks, ['web', 'api']).map((t) => t.number)).toEqual([1, 6, 8, 9])
    expect(queueOf(tasks, [])).toEqual([])
  })

  test('takeable from the actual state of the dependencies, whatever the labels say', () => {
    const blocked = task(20, { labels: ['ready'] })
    expect(dependenciesOf(blocked, new Map([[3, { state: 'open' }]]))).toEqual({
      takeable: false,
      open: [3],
    })
    expect(dependenciesOf(blocked, { 3: { state: 'closed' } })).toEqual({
      takeable: true,
      open: [],
    })
    expect(dependenciesOf(blocked, {})).toEqual({ takeable: false, open: [3] })
  })
})

describe('1.3b/task-link: the task link of a pull request', () => {
  test('slug and branch name (A9)', () => {
    expect(slugOf('Add the login form to the web app')).toBe('add-the-login-form')
    expect(slugOf('1.3b Foundation: configuration, ownership, tasks')).toBe(
      '1-3b-foundation-configuration-ownership',
    )
    expect(slugOf('Fix -- the   bug   now')).toBe('fix-the-bug-now')
    expect(slugOf('Zażółć gęślą jaźń')).toBe('za-g-l-ja')
    expect(slugOf('日本語')).toBe('task')
    expect(branchName(42, 'Add the login form')).toBe('task/42-add-the-login-form')
    expect(parseBranch('task/42-add-the-login-form')).toEqual({ kind: 'task', issue: 42 })
    expect(parseBranch('refs/heads/task/7')).toEqual({ kind: 'task', issue: 7 })
    expect(parseBranch('spike/try-it')).toEqual({ kind: 'spike' })
    expect(parseBranch('main')).toEqual({ kind: 'other' })
    expect(parseBranch('task/x-42')).toEqual({ kind: 'other' })
  })

  const template = '## Task\n\nCloses #42\n\n## Role and scope\n\n- Role: web\n'

  test('a task/ branch with Closes #<N> passes the parser', () => {
    expect(parseTaskLink({ branch: 'task/42-login-form', body: template })).toEqual({
      ok: true,
      issue: 42,
    })
    expect(parseTaskLink({ branch: 'task/42-login-form', body: 'Closes #42   \r\n' })).toEqual({
      ok: true,
      issue: 42,
    })
  })

  test('a missing link, several references, a mismatch and a spike/ branch fail', () => {
    const fail = (/** @type {string} */ branch, /** @type {string | null} */ text) =>
      parseTaskLink({ branch, body: text })
    expect(fail('task/42-x', '## Task\n\nCloses #\n')).toEqual({
      ok: false,
      reason: 'no-closes-line',
    })
    expect(fail('task/42-x', null)).toEqual({ ok: false, reason: 'no-closes-line' })
    expect(fail('task/42-x', 'Fixes #42\n')).toEqual({ ok: false, reason: 'no-closes-line' })
    expect(fail('task/42-x', 'closes #42\n')).toEqual({ ok: false, reason: 'no-closes-line' })
    expect(fail('task/42-x', `${template}\nCloses #42\n`)).toEqual({
      ok: false,
      reason: 'several-closing-references',
    })
    for (const other of [
      'Also fixes #7.',
      'resolves: owner/repo#7',
      'Fixed https://github.com/o/r/issues/7',
    ]) {
      expect(fail('task/42-x', `${template}\n${other}\n`), other).toEqual({
        ok: false,
        reason: 'several-closing-references',
      })
    }
    expect(fail('task/42-x', 'Closes #43\n')).toEqual({
      ok: false,
      reason: 'branch-issue-mismatch',
    })
    expect(fail('spike/42-x', template)).toEqual({ ok: false, reason: 'spike-branch' })
    expect(fail('feature/login', template)).toEqual({ ok: false, reason: 'no-task-branch' })
  })

  test('an open task with a valid block passes; a closed issue, an invalid block and a spike fail', async () => {
    const client = github({
      42: rawIssue(42),
      43: rawIssue(43, { state: 'closed' }),
      44: rawIssue(44, { body: body({ ...blockObject(), deadline: null }) }),
      45: rawIssue(45, { body: 'not a task' }),
      46: rawIssue(46, { pull: true }),
    })
    const pull = (/** @type {string} */ headRef, /** @type {number} */ n) => ({
      headRef,
      body: `Closes #${n}\n`,
    })
    expect(await checkTaskLink(client, config, pull('task/42-login', 42))).toEqual({
      ok: true,
      issue: 42,
    })
    expect(await checkTaskLink(client, config, pull('task/43-login', 43))).toEqual({
      ok: false,
      reason: 'issue-not-open',
    })
    expect(await checkTaskLink(client, config, pull('task/99-login', 99))).toEqual({
      ok: false,
      reason: 'issue-not-open',
    })
    const invalid = { ok: false, reason: 'invalid-task-block', author: 'lead', member: true }
    expect(await checkTaskLink(client, config, pull('task/44-login', 44))).toEqual({
      ...invalid,
      errors: ['deadline is missing; every task has one (T11)'],
    })
    expect(await checkTaskLink(client, config, pull('task/45-login', 45))).toEqual({
      ...invalid,
      errors: ['issue #45 has no # hackwin:task block'],
    })
    expect(await checkTaskLink(client, config, pull('task/46-login', 46))).toEqual({
      ...invalid,
      errors: ['#46 is a pull request, not a task issue'],
    })
    expect(await checkTaskLink(client, config, pull('spike/42-login', 42))).toEqual({
      ok: false,
      reason: 'spike-branch',
    })
    expect(await checkTaskLink(client, config, { headRef: 'task/42-login', body: '' })).toEqual({
      ok: false,
      reason: 'no-closes-line',
    })
  })
})

describe('1.3b/task-author: an issue is a task only when a member of the team wrote it', () => {
  test("an outsider's issue with a valid block gives no task; the Lead's or a member's does", () => {
    expect(toTask(issue({ number: 7, author: 'mallory' }), config)).toBeNull()
    expect(toTask(issue({ number: 7, author: null }), config)).toBeNull()
    for (const author of ['lead', 'builder-one', 'builder-two']) {
      expect(toTask(issue({ number: 7, author }), config)).toMatchObject({ number: 7, valid: true })
    }
    // Not even an invalid block of an outsider is a task, so its errors are never shown.
    const broken = body({ ...blockObject(), deadline: null })
    expect(toTask(issue({ number: 7, author: 'mallory', body: broken }), config)).toBeNull()
  })

  test('the case of the login does not matter', () => {
    for (const author of ['Lead', 'LEAD', 'Builder-One', 'BUILDER-TWO']) {
      expect(writtenByTeam({ author }, config)).toBe(true)
      expect(toTask(issue({ number: 7, author }), config)).toMatchObject({ valid: true })
    }
    expect(writtenByTeam({ author: 'Mallory' }, config)).toBe(false)
    expect(writtenByTeam({ author: null }, config)).toBe(false)
    expect(writtenByTeam({ author: '' }, config)).toBe(false)
  })

  test('team.lead counts even where team.members leaves the Lead out', () => {
    const team = { lead: 'Chief', members: config.hackwin.team.members }
    const other = { ...config, hackwin: { ...config.hackwin, team } }
    expect(writtenByTeam({ author: 'chief' }, other)).toBe(true)
    expect(writtenByTeam({ author: 'builder-one' }, other)).toBe(true)
    expect(writtenByTeam({ author: 'mallory' }, other)).toBe(false)
  })

  test("checkTaskLink fails for a pull request that names an outsider's issue, naming the author", async () => {
    const client = github({
      50: rawIssue(50, { author: 'mallory' }),
      51: rawIssue(51, { author: null }),
      52: rawIssue(52, { author: 'mallory', body: 'no block' }),
      53: rawIssue(53, { author: 'Builder-One' }),
      54: rawIssue(54, { author: 'LEAD' }),
      55: rawIssue(55, { author: 'mal\u001b[2Jlory' }),
    })
    expect(await checkTaskLink(client, config, pullOf(50))).toEqual({
      ok: false,
      reason: 'invalid-task-block',
      author: 'mallory',
      member: false,
      errors: [
        'issue #50 was written by mallory, who is not a member of the team in hackwin.yml; only an issue that team.lead or one of team.members wrote is a task',
      ],
    })
    expect(await checkTaskLink(client, config, pullOf(51))).toMatchObject({
      ok: false,
      reason: 'invalid-task-block',
      author: null,
      member: false,
      errors: [expect.stringMatching(/^issue #51 was written by an unknown account, who is not/)],
    })
    expect(await checkTaskLink(client, config, pullOf(52))).toMatchObject({
      reason: 'invalid-task-block',
      member: false,
      errors: [expect.stringContaining('written by mallory')],
    })
    expect(await checkTaskLink(client, config, pullOf(53))).toEqual({ ok: true, issue: 53 })
    expect(await checkTaskLink(client, config, pullOf(54))).toEqual({ ok: true, issue: 54 })
    const strange = /** @type {any} */ (await checkTaskLink(client, config, pullOf(55)))
    expect(strange.errors[0]).toContain('written by "mal\\u001b[2Jlory", who is not')
    expect(strange.errors[0]).not.toMatch(UNSAFE)
  })
})

/**
 * A control character (C0, DEL, C1), a Unicode line or paragraph separator, or a bidirectional
 * format character.
 */
const UNSAFE =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/

describe('1.3b/task-block-errors: no control character, line break or bidi format character in the errors of a task block', () => {
  /** @param {string} text The block after its marker line. */
  const errorsOf = (text) => {
    const parsed = /** @type {any} */ (
      parseTaskBlock(`\`\`\`yaml\n# hackwin:task\n${text}\n\`\`\`\n`, config)
    )
    expect(parsed).toMatchObject({ isTask: true, valid: false })
    for (const error of parsed.errors) expect(error).not.toMatch(UNSAFE)
    return /** @type {string[]} */ (parsed.errors)
  }

  // A YAML escape in double quotes, and how an error writes the character it decodes to: the
  // escape character (clear the screen, reset the terminal), a carriage return, a line feed,
  // both, the C1 control sequence introducer, DEL, the next line of C1, the line and paragraph
  // separators, and bidirectional format characters (the right-to-left override, the Arabic
  // letter mark, the right-to-left mark and the left-to-right isolate).
  const values = [
    ['\\e[2J', '\\u001b[2J'],
    ['\\ec', '\\u001bc'],
    ['\\r', '\\r'],
    ['\\n', '\\n'],
    ['a\\r\\nb', 'a\\r\\nb'],
    ['\\x9b31m', '\\u009b31m'],
    ['\\x7f', '\\u007f'],
    ['\\N', '\\u0085'],
    ['\\L', '\\u2028'],
    ['\\P', '\\u2029'],
    ['\\u202E', '\\u202e'],
    ['\\u061C', '\\u061c'],
    ['\\u200F', '\\u200f'],
    ['\\u2066', '\\u2066'],
  ]

  for (const [yaml, shown] of values) {
    test(`"${yaml}" in every value that an error names is quoted with the character escaped`, () => {
      const errors = errorsOf(
        [
          `"x${yaml}": 1`,
          `kind: "task${yaml}"`,
          `role: "web${yaml}"`,
          `wave: "1${yaml}"`,
          `paths: ["src/features/web/${yaml}[id].js", "**/z${yaml}"]`,
          'acceptance_tests: [test/web/form.test.js]',
          `deadline: "2026-10-25${yaml}"`,
        ].join('\n'),
      )
      expect(errors).toHaveLength(7)
      expect(errors[0]).toBe(`"x${shown}" is not a key of the task block`)
      expect(errors[1]).toBe(
        `kind "task${shown}" is not one of task, proposal, integration, contract-change, foundation`,
      )
      expect(errors[2]).toBe(`role "web${shown}" is not a role of owners.yml`)
      expect(errors[3]).toBe(`wave must be a whole number, not "1${shown}"`)
      expect(errors[4].startsWith(`paths[0] ("src/features/web/${shown}[id].js") "[" is not`)).toBe(
        true,
      )
      // The bracket of \e[2J makes both globs below fail the glob syntax instead.
      const bracket = yaml.includes('[')
      expect(errors[5].startsWith(`paths[1] ("**/z${shown}") `)).toBe(true)
      if (!bracket) expect(errors[5]).toMatch(/\) spans the roles web \(/)
      expect(errors[6].startsWith(`deadline "2026-10-25${shown}" is not an ISO 8601 time`)).toBe(
        true,
      )

      const other = errorsOf(
        [
          'kind: task',
          'role: web',
          `paths: ["src/features/api/${yaml}x"]`,
          'acceptance_tests: [test/web/form.test.js]',
          'deadline: "2026-10-25T12:00:00+02:00"',
        ].join('\n'),
      )
      expect(other).toHaveLength(1)
      expect(other[0].startsWith(`paths[0] ("src/features/api/${shown}x") `)).toBe(true)
      if (!bracket) {
        expect(other[0]).toBe(
          `paths[0] ("src/features/api/${shown}x") lies in the role api, not in the task's role web`,
        )
      }
    })
  }

  test('a value without a control character or line break is shown as before', () => {
    const errors = errorsOf(
      [
        'owner: lead',
        'kind: x',
        'role: webb',
        'wave: one',
        'paths: ["src/features/web/[id].js"]',
        'acceptance_tests: [t]',
        'deadline: tomorrow',
      ].join('\n'),
    )
    expect(errors).toEqual([
      'owner is not a key of the task block',
      'kind "x" is not one of task, proposal, integration, contract-change, foundation',
      'role webb is not a role of owners.yml',
      'wave must be a whole number, not "one"',
      'paths[0] (src/features/web/[id].js) "[" is not supported: character classes, groups and extglobs are not; write \\[ for the character itself',
      'deadline "tomorrow" is not an ISO 8601 time with an offset, such as "2026-10-17T23:59:00+02:00"',
    ])
  })

  test('raw characters in the body, and in the message of the YAML parser', () => {
    // The parser's message for an invalid escape quotes the character after the backslash.
    for (const [char, shown] of [
      ['\u001b', '\\u001b'],
      ['\u009b', '\\u009b'],
      ['\u007f', '\\u007f'],
      ['\u2028', '\\u2028'],
      ['\u202e', '\\u202e'],
    ]) {
      expect(errorsOf(`kind: "a\\${char}b"`)).toEqual([
        `the task block is not valid YAML: Invalid escape sequence \\${shown}`,
      ])
    }
    const errors = errorsOf(
      'k\u001b[31m: 1\nkind: "a\u009bb"\nrole: "\u2028"\nwave: "1\u202egnp.exe"',
    )
    expect(errors.slice(0, 4)).toEqual([
      '"k\\u001b[31m" is not a key of the task block',
      'kind "a\\u009bb" is not one of task, proposal, integration, contract-change, foundation',
      'role "\\u2028" is not a role of owners.yml',
      'wave must be a whole number, not "1\\u202egnp.exe"',
    ])
  })

  test('shown names a value as these errors do: a safe string as it is, any other quoted', () => {
    expect(shown('web')).toBe('web')
    expect(shown('src/features/web/[id].js')).toBe('src/features/web/[id].js')
    for (const [value, quoted] of [
      ['web\u001b[2J', '"web\\u001b[2J"'],
      ['a\r\nb', '"a\\r\\nb"'],
      ['\u009b31m', '"\\u009b31m"'],
      ['\u007f', '"\\u007f"'],
      ['\u0085', '"\\u0085"'],
      ['\u2028', '"\\u2028"'],
      ['1\u202egnp.exe', '"1\\u202egnp.exe"'],
      ['\u061c', '"\\u061c"'],
      ['\u200f', '"\\u200f"'],
      ['\u2066', '"\\u2066"'],
    ]) {
      expect(shown(value)).toBe(quoted)
      expect(shown(value)).not.toMatch(UNSAFE)
    }
  })
})

describe('1.3b/labels: the label catalogue of 8.2 and status transitions', () => {
  test('the catalogue holds every label of 8.2 except the role labels, each with color and description', () => {
    expect(LABELS.map((label) => label.name)).toEqual([
      'ready',
      'blocked',
      'in-progress',
      'in-review',
      'cut',
      'proposal',
      'needs-lead',
      'integration',
      'contract-change',
      'approved',
      'contract-changed',
      'gate:queued',
      'gate:testing',
      'gate:waiting-ci',
      'gate:merged',
      'gate:failed',
      'needs-owner',
      'scope-violation',
      'hotspot',
      'gate-status',
    ])
    for (const label of LABELS) {
      expect(label.color, label.name).toMatch(/^[0-9a-f]{6}$/)
      expect(label.description.length, label.name).toBeGreaterThan(0)
      expect(label.description.length, label.name).toBeLessThanOrEqual(100)
    }
    expect(roleLabel('web')).toBe('role:web')
  })

  test("the labels that wait for a pull request's author and the prefix of a scope change are exported", () => {
    // 7.7 step 3: a pull request labeled one of these waits for its author.
    expect(WAITING_LABELS).toEqual(['needs-owner', 'gate:failed', 'scope-violation'])
    expect(Object.isFrozen(WAITING_LABELS)).toBe(true)
    const catalogue = LABELS.map((label) => label.name)
    for (const label of WAITING_LABELS) expect(catalogue).toContain(label)
    // 8.1: a scope change is an issue comment that starts with "Scope change:".
    expect(SCOPE_CHANGE).toBe('Scope change:')
    expect('Scope change: contract change #12: the field is renamed'.startsWith(SCOPE_CHANGE)).toBe(
      true,
    )
  })

  test('a status transition adds the new label and removes the other status labels only', async () => {
    /** @type {string[]} */
    const calls = []
    let labels = ['role:web', 'ready', 'cut', 'blocked']
    const client = createGitHub({
      repo: 'o/r',
      executor: async (args, { input } = {}) => {
        calls.push(`${args[2]} ${args[3]}`)
        if (args[2] === 'POST') {
          labels = [...labels, ...JSON.parse(input ?? '{}').labels]
          return { code: 0, stdout: JSON.stringify(labels.map((name) => ({ name }))), stderr: '' }
        }
        const removed = decodeURIComponent(args[3].split('/').at(-1) ?? '')
        labels = labels.filter((label) => label !== removed)
        return { code: 0, stdout: '[]', stderr: '' }
      },
    })
    expect(await setTaskStatus(client, 5, 'in-progress')).toEqual([
      'role:web',
      'cut',
      'in-progress',
    ])
    expect(labels).toEqual(['role:web', 'cut', 'in-progress'])
    expect(calls).toEqual([
      'POST repos/{owner}/{repo}/issues/5/labels',
      'DELETE repos/{owner}/{repo}/issues/5/labels/ready',
      'DELETE repos/{owner}/{repo}/issues/5/labels/blocked',
    ])
    await expect(setTaskStatus(client, 5, /** @type {any} */ ('cut'))).rejects.toThrow(TypeError)
  })
})

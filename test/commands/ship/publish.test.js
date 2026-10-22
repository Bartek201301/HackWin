import { describe, expect, test } from 'vitest'
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { VERSION } from '../../../src/cli/context.js'
import {
  fillPullRequestBody,
  pullRequestBody,
  reportBody,
  reportMarker,
} from '../../../src/commands/ship/publish.js'
import { statePaths } from '../../../src/core/state/index.js'
import { parseTaskLink } from '../../../src/core/tasks/index.js'
import { accounts, httpError, rawResult } from '../../harness/index.js'
import { rewritePulls } from '../take/helpers.js'
import {
  BRANCH,
  HACKWIN_TEMPLATE,
  ISSUE,
  TEMPLATE,
  TEST_FILE,
  TITLE,
  remoteBranch,
  scene,
  ship,
  stepsOf,
  taskBody,
} from './scene.js'

/** @import { Scene } from './scene.js' */

const SHA = 'a'.repeat(40)

/**
 * The pull requests of the fake GitHub.
 * @param {Scene} s
 */
function pullsOf(s) {
  return s.fake.state.items.filter((item) => item.pull !== null)
}

/**
 * The comments on the task issue.
 * @param {Scene} s
 */
function commentsOf(s) {
  return s.fake.find(ISSUE)?.comments ?? []
}

/**
 * The last line of the output.
 * @param {string} stdout
 */
function lastLine(stdout) {
  return stdout.trimEnd().split('\n').at(-1)
}

/**
 * Remove the logs of the project commands, so that a later run shows whether they ran.
 * @param {Scene} s
 */
function clearLogs(s) {
  rmSync(join(statePaths(s.commonDir).logs, 'ship'), { recursive: true, force: true })
}

/**
 * True when a project command of ship (the full check or the acceptance tests) wrote a log.
 * @param {Scene} s
 */
function checksRan(s) {
  return existsSync(join(statePaths(s.commonDir).logs, 'ship'))
}

/**
 * Expect the state after a complete ship of `head`: the branch on origin, one open pull request
 * of the task that closes it, one report of that pull request at `head`, the issue in-review.
 * @param {Scene} s
 * @param {string} head
 * @returns {Promise<number>} The number of the pull request.
 */
async function expectShipped(s, head) {
  expect(await remoteBranch(s)).toBe(head)
  const pulls = pullsOf(s).filter((item) => item.state === 'open')
  expect(pulls).toHaveLength(1)
  const [pull] = pulls
  expect(pull.pull).toMatchObject({ head: BRANCH, base: 'main', draft: false, merged: false })
  expect(parseTaskLink({ branch: BRANCH, body: pull.body })).toEqual({ ok: true, issue: ISSUE })
  const reports = commentsOf(s).filter((comment) => comment.body.includes(head))
  expect(reports).toHaveLength(1)
  expect(reports[0].body).toContain(`PR #${pull.number}`)
  const labels = s.fake.find(ISSUE)?.labels
  expect(labels).toContain('in-review')
  expect(labels).not.toContain('in-progress')
  return pull.number
}

/**
 * The ways a ship stops in steps 10 to 14. Each makes the step fail and returns what undoes it;
 * `last` is the step of the last progress line: the last step that succeeded, or step 12, which
 * is skipped.
 * @type {Array<{ step: number, title: string, last: number, interrupt: (s: Scene) => () => void }>}
 */
const INTERRUPTIONS = [
  {
    step: 10,
    last: 9,
    title: 'push',
    interrupt: (s) => {
      const hook = join(s.fixture.origin, 'hooks', 'pre-receive')
      writeFileSync(hook, '#!/bin/sh\necho "the test refuses every push" >&2\nexit 1\n')
      chmodSync(hook, 0o755)
      return () => rmSync(hook)
    },
  },
  {
    step: 11,
    last: 10,
    title: 'pull request',
    interrupt: (s) =>
      s.fake.on('POST repos/{owner}/{repo}/pulls', () => {
        throw httpError(502, 'Bad Gateway')
      }),
  },
  {
    step: 13,
    last: 12,
    title: 'report',
    interrupt: (s) =>
      s.fake.on('POST repos/{owner}/{repo}/issues/:number/comments', () => {
        throw httpError(502, 'Bad Gateway')
      }),
  },
  {
    step: 14,
    last: 13,
    title: 'label',
    interrupt: (s) =>
      s.fake.on('POST repos/{owner}/{repo}/issues/:number/labels', () => {
        throw httpError(502, 'Bad Gateway')
      }),
  },
]

describe('AC16: ship pushes, opens the pull request, reports, sets in-review and stops', () => {
  test('after a successful ship: a PR with Closes #12, one comment with the PR, the full head SHA and the checks, the issue in-review, the stop line last', async () => {
    const s = await scene({ push: false })
    const result = await ship(s)
    expect(result.code, result.stderr).toBe(0)
    const head = await s.worktree.git.revParse('HEAD')
    const number = await expectShipped(s, head)

    const pull = /** @type {NonNullable<ReturnType<typeof s.fake.find>>} */ (s.fake.find(number))
    expect(pull.title).toBe(TITLE)
    expect(pull.author).toBe(accounts.builder1.login)
    expect(pull.body).toBe(TEMPLATE.replace('Closes #\n', `Closes #${ISSUE}\n`))

    const comments = commentsOf(s)
    expect(comments).toHaveLength(1)
    const report = comments[0].body
    expect(report.split('\n')[0]).toBe(reportMarker(number, head))
    expect(report).toContain(`opened PR #${number} at ${head}.`)
    expect(report).toContain('| 3 | scope check | passed |')
    expect(report).toContain('| 4 | secret scan | passed |')
    expect(report).toContain('| 5 | format check | passed |')
    expect(report).toContain('| 6 | generated file check | skipped |')
    expect(report).toMatch(/^\| 7 \| full check \| passed in \d+\.\d s \|$/m)
    expect(report).toMatch(/^\| 8 \| acceptance tests \| passed in \d+\.\d s \|$/m)
    expect(s.fake.find(ISSUE)?.labels).toEqual(['role:counter', 'in-review'])

    expect(stepsOf(result.stdout)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
    expect(lastLine(result.stdout)).toBe(`PR #${number} opened at ${head}. Do not merge. Stop.`)
  })

  test.each(INTERRUPTIONS)(
    'a ship that fails at step $step ($title) exits 3; run again, it completes without running the checks again and without a second PR or comment',
    async ({ step, title, last, interrupt }) => {
      const s = await scene({ push: false })
      const restore = interrupt(s)
      const first = await ship(s)
      expect(first.code, first.stderr).toBe(3)
      expect(first.stderr).toContain(`hackwin ship: step ${step}, ${title}: `)
      expect(first.stderr).toContain('run ship again: it continues at this step')
      expect(first.stderr).toContain(`to resolve: run \`cd ${s.worktree.path} && hackwin ship\``)
      expect(stepsOf(first.stdout).at(-1)).toBe(last)
      const head = await s.worktree.git.revParse('HEAD')
      expect(await remoteBranch(s)).toBe(step === 10 ? null : head)

      expect(checksRan(s)).toBe(true)
      restore()
      clearLogs(s)
      const again = await ship(s)
      expect(again.code, again.stderr).toBe(0)
      expect(checksRan(s)).toBe(false)
      expect(again.stdout).toContain(`steps 3 to 9, checks: passed for ${head} at `)
      expect(stepsOf(again.stdout)).toEqual([1, 2, 10, 11, 12, 13, 14])
      const number = await expectShipped(s, head)
      expect(pullsOf(s)).toHaveLength(1)
      expect(commentsOf(s)).toHaveLength(1)
      expect(lastLine(again.stdout)).toBe(`PR #${number} opened at ${head}. Do not merge. Stop.`)
    },
  )

  test('a ship of a new commit after a Gate failure updates the same PR', async () => {
    const s = await scene({ push: false })
    const first = await ship(s)
    expect(first.code, first.stderr).toBe(0)
    const before = await s.worktree.git.revParse('HEAD')
    const number = await expectShipped(s, before)
    const pull = /** @type {NonNullable<ReturnType<typeof s.fake.find>>} */ (s.fake.find(number))
    pull.labels = ['gate:failed', 'needs-owner']
    const body = pull.body

    const head = await s.fixture.commit('Fix what the Gate found', {
      dir: s.worktree.path,
      files: { 'src/features/counter/reset.js': 'export const reset = () => 0 * 1\n' },
    })
    const second = await ship(s)
    expect(second.code, second.stderr).toBe(0)
    expect(stepsOf(second.stdout)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
    expect(second.stdout).toContain(`step 11, pull request: PR #${number} of ${BRANCH} is open`)
    expect(await expectShipped(s, head)).toBe(number)
    expect(pullsOf(s)).toHaveLength(1)
    expect(pull.pull?.headSha).toBe(head)
    expect(pull.body).toBe(body)
    expect(commentsOf(s).map((comment) => comment.body.split('\n')[0])).toEqual([
      reportMarker(number, before),
      reportMarker(number, head),
    ])
    expect(lastLine(second.stdout)).toBe(`PR #${number} opened at ${head}. Do not merge. Stop.`)
  })
})

describe('1.5e/ship: push, pull request, report and rerun', () => {
  test('a ship run again after it finished repeats nothing', async () => {
    const s = await scene({ push: false })
    const first = await ship(s)
    expect(first.code, first.stderr).toBe(0)
    const head = await s.worktree.git.revParse('HEAD')
    clearLogs(s)
    const again = await ship(s, { json: true })
    expect(again.code, again.stderr).toBe(0)
    expect(checksRan(s)).toBe(false)
    expect(JSON.parse(again.stdout).data).toMatchObject({
      checksReused: true,
      pushed: false,
      pullRequest: { action: 'reused', changes: [] },
      report: { created: false },
    })
    expect(again.stderr).toContain(`step 10, push: origin/${BRANCH} is already at ${head}`)
    await expectShipped(s, head)
    expect(pullsOf(s)).toHaveLength(1)
    expect(commentsOf(s)).toHaveLength(1)
  })

  test('a pull request that was closed without a merge is not reused', async () => {
    const s = await scene({
      pulls: [{ number: 30, title: TITLE, head: BRANCH, body: 'Closes #12', state: 'closed' }],
    })
    const result = await ship(s)
    expect(result.code, result.stderr).toBe(0)
    const head = await s.worktree.git.revParse('HEAD')
    const number = await expectShipped(s, head)
    expect(number).not.toBe(30)
    expect(s.fake.find(30)?.state).toBe('closed')
    expect(result.stdout).toContain(`step 11, pull request: opened PR #${number} into main`)
  })

  test('an open draft pull request of the branch without the task link is marked ready and gets the body', async () => {
    const s = await scene({
      pulls: [{ number: 30, title: 'WIP', head: BRANCH, body: 'work in progress', draft: true }],
    })
    s.fake.on('pr ready', ({ args }) => {
      const pull = s.fake.find(Number(args[2]))
      if (pull?.pull) pull.pull.draft = false
      return rawResult({ stdout: '' })
    })
    const result = await ship(s)
    expect(result.code, result.stderr).toBe(0)
    const head = await s.worktree.git.revParse('HEAD')
    expect(await expectShipped(s, head)).toBe(30)
    expect(s.fake.find(30)?.body).toBe(pullRequestBody(TEMPLATE, ISSUE))
    expect(s.fake.find(30)?.title).toBe('WIP')
    expect(result.stdout).toContain('marked ready for review')
    expect(result.stdout).toContain('body rebuilt from the template')
    expect(lastLine(result.stdout)).toBe(`PR #30 opened at ${head}. Do not merge. Stop.`)
  })

  test('the pull request body fills the first `Closes #` line of the template (contracts 5.5)', () => {
    expect(pullRequestBody('## Task\n\nCloses #  \n\nCloses #\n', 7)).toBe(
      '## Task\n\nCloses #7\n\nCloses #\n',
    )
    expect(pullRequestBody('## Task\r\nCloses #\r\n', 7)).toBe('## Task\r\nCloses #7\r\n')
    expect(pullRequestBody('## Notes\n', 7)).toBe('Closes #7\n\n## Notes\n')
    expect(pullRequestBody(null, 7)).toBe('Closes #7')
  })

  test('the report starts with its marker and lists every check with its step', () => {
    const body = reportBody({
      pull: 13,
      sha: SHA,
      recordedAt: '2026-10-12T10:00:00.000Z',
      checks: [
        { name: 'scope', result: 'passed' },
        { name: 'generated', result: 'skipped' },
        { name: 'check', result: 'passed', duration_ms: 1234 },
      ],
    })
    expect(body.split('\n')[0]).toBe(`<!-- hackwin:ship-report pr=13 sha=${SHA} -->`)
    expect(body).toContain(`\`hackwin ship\` opened PR #13 at ${SHA}.`)
    expect(body).toContain('| 3 | scope check | passed |')
    expect(body).toContain('| 6 | generated file check | skipped |')
    expect(body).toContain('| 7 | full check | passed in 1.2 s |')
  })
})

describe('1.5c/ship: a rerun reuses only a pull request of this repository and only a check record of the same version of hackwin', () => {
  test('an open pull request of a fork from a branch of the same name is not reused: ship opens the pull request of the task', async () => {
    const s = await scene({ push: false })
    const fork = {
      number: 30,
      title: 'Work in a fork',
      body: 'Closes #12',
      state: 'open',
      draft: false,
      head: { ref: BRANCH, sha: 'f'.repeat(40), repo: { full_name: 'someone/fork' } },
      base: { ref: 'main', repo: { full_name: s.fake.state.repo } },
      labels: [],
      user: { login: accounts.builder2.login },
      html_url: `https://github.com/${s.fake.state.repo}/pull/30`,
    }
    rewritePulls(s.fake, (list) => [fork, ...list])

    const result = await ship(s)
    expect(result.code, result.stderr).toBe(0)
    const head = await s.worktree.git.revParse('HEAD')
    const number = await expectShipped(s, head)
    expect(number).not.toBe(30)
    expect(result.stdout).toContain(`step 11, pull request: opened PR #${number} into main`)
    const touched = s.fake.calls.filter((call) => call.endpoint?.includes('pulls/30'))
    expect(touched).toEqual([])
    expect(result.stderr).not.toContain('#30')
  })

  test('a green check record that another version of hackwin wrote does not skip the checks', async () => {
    const s = await scene({ push: false })
    const restore = INTERRUPTIONS[0].interrupt(s)
    const first = await ship(s)
    expect(first.code, first.stderr).toBe(3)
    restore()
    const head = await s.worktree.git.revParse('HEAD')
    const file = join(statePaths(s.commonDir).checks, `${head}.json`)
    const record = JSON.parse(readFileSync(file, 'utf8'))
    expect(record.cli_version).toBe(VERSION)
    writeFileSync(file, JSON.stringify({ ...record, cli_version: '0.0.9' }))

    clearLogs(s)
    const again = await ship(s)
    expect(again.code, again.stderr).toBe(0)
    expect(checksRan(s)).toBe(true)
    expect(again.stdout).toContain(
      `steps 3 to 9, checks: the green check record of ${head} was written by hackwin 0.0.9, not ${VERSION}, so the checks run again`,
    )
    expect(stepsOf(again.stdout)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
    expect(JSON.parse(readFileSync(file, 'utf8')).cli_version).toBe(VERSION)
    await expectShipped(s, head)
  })
})

/** @import { BodyFacts } from '../../../src/commands/ship/publish.js' */

/**
 * The facts of a ship whose checks all passed, for task 12 of the role `counter`.
 * @param {Partial<BodyFacts>} [facts]
 * @returns {BodyFacts}
 */
function factsOf(facts = {}) {
  return {
    role: 'counter',
    mainRef: 'origin/main',
    passed: ['merge', 'scope', 'secrets', 'format', 'check', 'acceptance'],
    tests: [TEST_FILE],
    ...facts,
  }
}

/** The verification lines of HackWin's template after a ship that passed every step. */
const VERIFIED = [
  '- [x] Merged the current `origin/main` into the branch; no rebase, no force push',
  '- [x] Full project check passed on the head commit',
  `- [x] Acceptance tests of the task passed: \`${TEST_FILE}\``,
  '- [x] Only the changed files were formatted',
  '- [x] No env file and no secret in the added lines',
].join('\n')

/**
 * HackWin's template as ship fills it for issue 12 of the role `counter` with these tests.
 * @param {string[]} [tests]
 */
function filledTemplate(tests = [TEST_FILE]) {
  return HACKWIN_TEMPLATE.replace('Closes #\n', `Closes #${ISSUE}\n`)
    .replace('- Ownership role:\n', '- Ownership role: counter\n')
    .replaceAll('- [ ] ', '- [x] ')
    .replace(
      'Acceptance tests of the task passed:\n',
      `Acceptance tests of the task passed: ${tests.map((test) => `\`${test}\``).join(', ')}\n`,
    )
}

describe('1.5i/pr-body: ship fills in the role, the checks that passed and the acceptance tests in the pull request body built from the template', () => {
  test('the pull request that ship opens has the template with Closes #12, the role, a tick on each verification line and the acceptance tests', async () => {
    const s = await scene({ push: false, template: HACKWIN_TEMPLATE })
    const result = await ship(s)
    expect(result.code, result.stderr).toBe(0)
    const head = await s.worktree.git.revParse('HEAD')
    const number = await expectShipped(s, head)

    const body = /** @type {string} */ (s.fake.find(number)?.body)
    expect(body).toBe(filledTemplate())
    expect(body).toContain(`## Task\n\nCloses #${ISSUE}\n`)
    expect(body).toContain('- Ownership role: counter\n')
    expect(body).toContain(VERIFIED)
    expect(body).toContain("- Files changed outside the role's paths and the open list: none\n")
    expect(parseTaskLink({ branch: BRANCH, body })).toEqual({ ok: true, issue: ISSUE })
  })

  test('a rerun on the same commit gives the same body; a new head commit gives the new facts and keeps what the author wrote in the body', async () => {
    const s = await scene({ push: false, template: HACKWIN_TEMPLATE })
    const first = await ship(s)
    expect(first.code, first.stderr).toBe(0)
    const head = await s.worktree.git.revParse('HEAD')
    const number = await expectShipped(s, head)
    const pull = /** @type {NonNullable<ReturnType<typeof s.fake.find>>} */ (s.fake.find(number))
    const body = pull.body

    const again = await ship(s, { json: true })
    expect(again.code, again.stderr).toBe(0)
    expect(JSON.parse(again.stdout).data.pullRequest).toMatchObject({
      action: 'reused',
      changes: [],
    })
    expect(pull.body).toBe(body)

    // The author notes a limitation on GitHub, and the Lead adds an acceptance test to the task.
    const limitation = 'The reset has no undo yet.'
    pull.body = body.replace(
      '<!-- What does not work yet, and what was not checked. -->\n',
      `<!-- What does not work yet, and what was not checked. -->\n${limitation}\n`,
    )
    const second = 'src/features/counter/undo.test.mjs'
    const issue = /** @type {NonNullable<ReturnType<typeof s.fake.find>>} */ (s.fake.find(ISSUE))
    issue.body = taskBody({ acceptance_tests: [TEST_FILE, second] })
    const next = await s.fixture.commit('Add the undo test', {
      dir: s.worktree.path,
      files: { [second]: 'PASS\n' },
    })

    const updated = await ship(s, { json: true })
    expect(updated.code, updated.stderr).toBe(0)
    expect(await expectShipped(s, next)).toBe(number)
    expect(JSON.parse(updated.stdout).data.pullRequest).toMatchObject({
      action: 'updated',
      changes: [`body filled in with the role and the checks of ${next}`],
    })
    expect(pull.body).toBe(
      filledTemplate([TEST_FILE, second]).replace(
        '<!-- What does not work yet, and what was not checked. -->\n',
        `<!-- What does not work yet, and what was not checked. -->\n${limitation}\n`,
      ),
    )
    expect(pull.body).toContain(
      `- [x] Acceptance tests of the task passed: \`${TEST_FILE}\`, \`${second}\`\n`,
    )
  })

  test("a template that is not HackWin's stays as it is, and so does every line outside HackWin's block", () => {
    const plain = pullRequestBody(TEMPLATE, ISSUE)
    expect(fillPullRequestBody(plain, factsOf())).toBe(plain)

    const own =
      '## Our checklist\n\n- Ownership role:\n- [ ] Full project check passed on the head commit\n\n'
    const body = pullRequestBody(`${own}${HACKWIN_TEMPLATE}`, ISSUE)
    const filled = fillPullRequestBody(body, factsOf())
    expect(filled.startsWith(own)).toBe(true)
    expect(filled).toBe(`${own}${filledTemplate()}`)

    const broken = HACKWIN_TEMPLATE.replace('<!-- hackwin:end -->', '')
    expect(fillPullRequestBody(broken, factsOf())).toBe(broken)
  })

  test('a line ship cannot vouch for stays as it is', () => {
    const body = pullRequestBody(HACKWIN_TEMPLATE, ISSUE)

    // A step that did not pass, and a project whose default branch is not the one the line names.
    const unticked = fillPullRequestBody(
      body,
      factsOf({ mainRef: 'origin/trunk', passed: ['merge', 'scope', 'secrets', 'check'] }),
    )
    expect(unticked).toContain(
      [
        '- [ ] Merged the current `origin/main` into the branch; no rebase, no force push',
        '- [x] Full project check passed on the head commit',
        '- [ ] Acceptance tests of the task passed:',
        '- [ ] Only the changed files were formatted',
        '- [x] No env file and no secret in the added lines',
      ].join('\n'),
    )

    // Lines the author changed.
    const changed = body
      .replace('- Ownership role:\n', '- Ownership role: counter, with help from shared\n')
      .replace(
        '- [ ] Full project check passed on the head commit\n',
        '- [ ] Full project check passed on the head commit, and the demo runs\n',
      )
      .replace(
        '- [ ] Acceptance tests of the task passed:\n',
        '- [ ] Acceptance tests of the task passed: all but the slow one\n',
      )
    const filled = fillPullRequestBody(changed, factsOf())
    expect(filled).toContain('- Ownership role: counter, with help from shared\n')
    expect(filled).toContain(
      '- [ ] Full project check passed on the head commit, and the demo runs\n',
    )
    expect(filled).toContain('- [ ] Acceptance tests of the task passed: all but the slow one\n')
    expect(filled).toContain('- [x] Only the changed files were formatted\n')
  })

  test('the same facts give the same body, new facts replace what ship filled in before, and the task link parser accepts the body', () => {
    const body = pullRequestBody(HACKWIN_TEMPLATE, ISSUE)
    const filled = fillPullRequestBody(body, factsOf())
    expect(fillPullRequestBody(filled, factsOf())).toBe(filled)
    expect(parseTaskLink({ branch: BRANCH, body: filled })).toEqual({ ok: true, issue: ISSUE })

    const later = factsOf({ role: 'todos', tests: [] })
    const refilled = fillPullRequestBody(filled, later)
    expect(refilled).toBe(fillPullRequestBody(body, later))
    expect(refilled).toContain('- Ownership role: todos\n')
    expect(refilled).toContain('- [x] Acceptance tests of the task passed: the task names none\n')
    expect(parseTaskLink({ branch: BRANCH, body: refilled })).toEqual({ ok: true, issue: ISSUE })
  })

  test('a body with CRLF line endings, as GitHub keeps one edited in the browser, keeps them', () => {
    const body = pullRequestBody(HACKWIN_TEMPLATE, ISSUE).replaceAll('\n', '\r\n')
    expect(fillPullRequestBody(body, factsOf())).toBe(filledTemplate().replaceAll('\n', '\r\n'))
  })
})

describe('1.5k/step-12: ship says why step 12 does not run', () => {
  test('in a ship that opens a pull request, the line of step 12 comes right after the line of step 11 and right before the line of step 13, in the terminal and with --json', async () => {
    for (const json of [false, true]) {
      const s = await scene({ push: false })
      const result = await ship(s, { json })
      expect(result.code, result.stderr).toBe(0)
      // With --json, stdout holds only the JSON result, and the step lines go to stderr.
      const lines = (json ? result.stderr : result.stdout).split('\n')
      const at = lines.findIndex((line) => line.startsWith('step 11, pull request: opened PR #'))
      expect(at).toBeGreaterThanOrEqual(0)
      expect(lines[at + 1]).toBe(
        'step 12, hotspot notice: skipped, it comes in a later version of HackWin: a notice of the other open pull requests that change the same files',
      )
      expect(lines[at + 2]).toMatch(new RegExp(`^step 13, report: commented on issue #${ISSUE}: `))
    }
  })
})

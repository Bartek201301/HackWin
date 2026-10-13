import { describe, expect, test } from 'vitest'
import { chmodSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pullRequestBody, reportBody, reportMarker } from '../../../src/commands/ship/publish.js'
import { parseTaskLink } from '../../../src/core/tasks/index.js'
import { accounts, httpError, rawResult } from '../../harness/index.js'
import { BRANCH, ISSUE, TEMPLATE, TITLE, remoteBranch, scene, ship, stepsOf } from './scene.js'

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
  rmSync(join(/** @type {string} */ (s.env.TMPDIR), 'hackwin-ship'), {
    recursive: true,
    force: true,
  })
}

/**
 * True when a project command of ship (the full check or the acceptance tests) wrote a log.
 * @param {Scene} s
 */
function checksRan(s) {
  return existsSync(join(/** @type {string} */ (s.env.TMPDIR), 'hackwin-ship'))
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
 * `last` is the last step that succeeded.
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
    last: 11,
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

    expect(stepsOf(result.stdout)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14])
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
      expect(first.stderr).toContain(`to resolve: run \`hackwin ship\` in ${s.worktree.path}`)
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
      expect(stepsOf(again.stdout)).toEqual([1, 2, 10, 11, 13, 14])
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
    expect(stepsOf(second.stdout)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14])
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

import { afterEach, describe, expect, test } from 'vitest'
import { parseGateMarker } from '../../../src/commands/gate/comment.js'
import { parseDigestLine } from '../../../src/commands/gate/digest.js'
import { BUILDER1, createScene, task } from './scene.js'

/** @typedef {import('./scene.js').Scene} Scene */

/** Long enough for several runs of the merge test on a busy machine. */
const SLOW = 120_000

/** @type {Scene[]} */
let scenes = []

afterEach(async () => {
  await Promise.all(scenes.map((scene) => scene.cleanup()))
  scenes = []
})

/**
 * A scene whose CI times out only after many steps of the clock, unless the test sets another
 * timeout: a test that moves the clock on until something happens never meets it by accident.
 * @param {Parameters<typeof createScene>[0] & { ciTimeout?: number, flaky?: string[] }} [options]
 */
async function scene({ ciTimeout = 600, flaky = [], ...options } = {}) {
  const created = await createScene({
    patience: 60_000,
    ...options,
    configure: (hackwin, owners) => {
      hackwin.gate.ci_timeout_minutes = ciTimeout
      hackwin.gate.known_flaky_tests = flaky
      options.configure?.(hackwin, owners)
    },
  })
  scenes.push(created)
  return created
}

/**
 * A pull request of builder1 for a counter task.
 * @param {Scene} s
 * @param {number} issue
 */
async function counterPull(s, issue) {
  const branch = `task/${issue}-counter-work`
  const head = await s.push(branch, {
    files: { [`src/features/counter/c${issue}.js`]: `export const c = ${issue}\n` },
  })
  const pr = await s.openPull({ branch, author: BUILDER1, task: issue })
  return { branch, head, pr }
}

/** The Gate labels among a pull request's labels. */
const gateLabels = (/** @type {string[]} */ labels) =>
  labels.filter((label) => label.startsWith('gate:')).sort()

describe('AC28: CI reruns and known flaky tests', () => {
  test(
    'CI fails once and passes on the rerun: the pull request merges and the digest notes one rerun',
    async () => {
      const s = await scene({ issues: [task(200, 'counter')] })
      const pull = await counterPull(s, 200)
      s.check(pull.head, { conclusion: 'failure', workflowRun: 7001 })
      const actions = s.actions({
        rerun: (id) => s.check(pull.head, { conclusion: 'success', workflowRun: id }),
      })
      await s.start()
      await s.until(() => actions.reruns.length === 1, 'the rerun')
      expect(actions.reruns).toEqual([['run', 'rerun', '7001', '--failed']])
      await s.advanceUntil(() => s.digest().length > 0, 'the end of the run')
      await s.ended(pull.pr, 'merged')
      await s.quit()
      expect(s.out).toContain(
        `#${pull.pr} stage 8, ci: \`hackwin\` failed on head ${pull.head}; rerun 1 of the failed jobs started`,
      )
      const [line] = s.digest().map(parseDigestLine)
      expect(line).toMatchObject({ pr: pull.pr, result: 'merged' })
      expect(line?.note).toMatch(/^merge commit [0-9a-f]{12}; 1 CI rerun$/)
      expect(s.state().prs[String(pull.pr)].ci_reruns).toBe(1)
      expect(actions.views).toEqual([])
      expect(s.comments(pull.pr)).toEqual([])
    },
    SLOW,
  )

  test(
    'CI fails twice with a known flaky test named in the log: the result is flaky and the comment says the pull request is not blamed',
    async () => {
      const s = await scene({ issues: [task(202, 'counter')], flaky: ['test/clock/**'] })
      const pull = await counterPull(s, 202)
      s.check(pull.head, { conclusion: 'failure', workflowRun: 7002 })
      const actions = s.actions({
        rerun: (id) => s.check(pull.head, { conclusion: 'failure', workflowRun: id }),
        log: (id) =>
          [
            `test\tRun tests\t2026-10-24T10:00:00.0000000Z  FAIL  test/clock/tick.test.js:12:5 > ticks once a second (workflow run ${id})`,
            'test\tRun tests\t2026-10-24T10:00:00.0000000Z  Tests  1 failed | 41 passed',
          ].join('\n'),
      })
      await s.start()
      await s.until(() => actions.reruns.length === 1, 'the rerun')
      await s.advanceUntil(() => s.digest().length > 0, 'the end of the run')
      await s.ended(pull.pr, 'flaky')
      await s.quit()
      expect(actions.views).toEqual([['run', 'view', '7002', '--log-failed']])
      const comments = s.comments(pull.pr)
      expect(comments).toHaveLength(1)
      expect(parseGateMarker(comments[0].body)).toEqual({
        pr: pull.pr,
        sha: pull.head,
        stage: 'ci',
        result: 'flaky',
      })
      expect(comments[0].body).toContain(
        'the failed log names the known flaky test `test/clock/**` (`gate.known_flaky_tests`). The pull request is not blamed (G14).',
      )
      expect(comments[0].body).toContain('nothing for the author.')
      expect(gateLabels(s.labels(pull.pr))).toEqual(['gate:failed'])
      expect(s.out).toContain(
        `ATTENTION repeated-failure #${pull.pr}: the known flaky test test/clock/** failed again in CI of #${pull.pr} after 1 rerun; write a task to fix the test, then type \`retry ${pull.pr}\``,
      )
      expect(parseDigestLine(s.digest()[0])).toMatchObject({
        result: 'flaky',
        stage: 'ci',
        note: 'flaky: test/clock/**',
      })
      expect(s.merges()).toEqual([])
    },
    SLOW,
  )
})

describe('1.6d/ci: CI failures that blame the pull request', () => {
  test(
    'CI fails again after the rerun without a known flaky test: ci-failed, with a link to the check',
    async () => {
      const s = await scene({ issues: [task(204, 'counter')], flaky: ['test/clock/**'] })
      const pull = await counterPull(s, 204)
      s.check(pull.head, { conclusion: 'failure', workflowRun: 7004 })
      const actions = s.actions({
        rerun: (id) => s.check(pull.head, { conclusion: 'failure', workflowRun: id }),
        log: () => 'test\tRun tests\t  FAIL  test/counter.test.js > counts\n',
      })
      await s.start()
      await s.until(() => actions.reruns.length === 1, 'the rerun')
      await s.advanceUntil(() => s.digest().length > 0, 'the end of the run')
      await s.ended(pull.pr, 'failed')
      await s.quit()
      const [comment] = s.comments(pull.pr)
      expect(comment.body).toContain(
        `the required check failed on head \`${pull.head}\` after 1 rerun (\`ci-failed\`):`,
      )
      expect(comment.body).toMatch(
        /- `hackwin`: failure, https:\/\/github\.com\/hackwin-test\/app\/actions\/runs\/7004\/job\/\d+/,
      )
      expect(parseDigestLine(s.digest()[0])).toMatchObject({ stage: 'ci', note: 'ci-failed' })
      expect(s.state().attention).toEqual([])
    },
    SLOW,
  )

  test(
    'a check run that names no workflow run of GitHub Actions is not rerun: ci-failed at once',
    async () => {
      const s = await scene({ issues: [task(206, 'counter')] })
      const pull = await counterPull(s, 206)
      s.check(pull.head, { conclusion: 'failure' })
      await s.start()
      await s.ended(pull.pr, 'failed')
      await s.quit()
      expect(s.comments(pull.pr)[0].body).toContain(
        'and no rerun started: the failed check `hackwin` names no workflow run of GitHub Actions to rerun (`ci-failed`)',
      )
      expect(s.comments(pull.pr)[0].body).toContain(
        `If the failure has nothing to do with the pull request, the Lead types \`retry ${pull.pr}\` in the Gate terminal.`,
      )
    },
    SLOW,
  )
})

describe('AC57: retry after a CI timeout', () => {
  test(
    'after a CI timeout, retry <PR> typed in the Gate terminal queues the same head SHA again',
    async () => {
      const s = await scene({ issues: [task(210, 'counter')], ciTimeout: 2 })
      const pull = await counterPull(s, 210)
      await s.start()
      await s.until(() => s.out.includes(`#${pull.pr} passed stages 1 to 7`), 'stage 8')
      await s.advanceUntil(() => s.digest().length > 0, 'the CI timeout')
      await s.ended(pull.pr, 'failed')
      const [comment] = s.comments(pull.pr)
      expect(parseGateMarker(comment.body)).toMatchObject({ stage: 'ci', result: 'failed' })
      expect(comment.body).toContain(
        `the required checks did not succeed on head \`${pull.head}\` within \`gate.ci_timeout_minutes\`, 2 min (\`ci-timeout\`). Still waiting for:`,
      )
      expect(comment.body).toContain('- `hackwin`: no run yet')
      expect(parseDigestLine(s.digest()[0])).toMatchObject({ stage: 'ci', note: 'ci-timeout' })

      s.type(`retry ${pull.pr}`)
      await s.until(
        () => s.out.includes(`retry #${pull.pr}: queued again at the next poll`),
        'retry',
      )
      s.check(pull.head)
      await s.poll()
      await s.until(
        () =>
          s.out.includes(`retry #${pull.pr}: the head ${pull.head} joined the back of the queue`),
        'the queued head',
      )
      await s.ended(pull.pr, 'merged')
      await s.quit()
      expect(s.state().prs[String(pull.pr)]).toMatchObject({
        head_sha: pull.head,
        result: 'merged',
      })
      expect(s.merges()).toEqual([{ pr: pull.pr, sha: pull.head, admin: true, code: 0 }])
      expect(s.comments(pull.pr)).toHaveLength(1)
    },
    SLOW,
  )
})

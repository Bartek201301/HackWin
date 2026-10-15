import { afterEach, describe, expect, test } from 'vitest'
import { parseGateMarker } from '../../../src/commands/gate/comment.js'
import { parseDigestLine } from '../../../src/commands/gate/digest.js'
import { rawResult } from '../../harness/index.js'
import { BUILDER1, LEAD, createScene, task } from './scene.js'

/** @typedef {import('./scene.js').Scene} Scene */

/** Long enough for several runs of the merge test on a busy machine. */
const SLOW = 120_000

/** An account outside the team, which only the fake GitHub knows. */
const OUTSIDER = 'someone-outside'

/** @type {Scene[]} */
let scenes = []

afterEach(async () => {
  await Promise.all(scenes.map((scene) => scene.cleanup()))
  scenes = []
})

/** @param {Parameters<typeof createScene>[0]} [options] */
async function scene(options) {
  const created = await createScene({ patience: 60_000, ...options })
  scenes.push(created)
  return created
}

/**
 * A pull request of BUILDER1 on the task branch of an issue, with its CI green.
 * @param {Scene} s
 * @param {number} issue
 */
async function shipped(s, issue) {
  const branch = `task/${issue}-counter-work`
  const head = await s.push(branch, {
    files: { [`src/features/counter/i${issue}.js`]: 'export const i = 1\n' },
  })
  const pr = await s.openPull({ branch, author: BUILDER1, task: issue })
  s.check(head)
  return { head, pr }
}

describe('1.6e/outsiders: an issue that no member of the team wrote is no task (#74)', () => {
  test(
    'stage 2 fails a pull request that names it, with the issue and its author',
    async () => {
      const s = await scene({ issues: [{ ...task(300, 'counter'), author: OUTSIDER }] })
      const pull = await shipped(s, 300)
      await s.start()
      await s.ended(pull.pr, 'failed')
      await s.quit()
      const [comment] = s.comments(pull.pr)
      expect(parseGateMarker(comment.body)).toMatchObject({ stage: 'task-link', result: 'failed' })
      expect(comment.body).toContain(
        'the issue #300 that the pull request names is no task: no member of the team wrote it (`invalid-task-block`):',
      )
      expect(comment.body).toContain(
        `- \`issue #300 was written by ${OUTSIDER}, who is not a member of the team in hackwin.yml; only an issue that team.lead or one of team.members wrote is a task\``,
      )
      expect(parseDigestLine(s.digest()[0])).toMatchObject({
        stage: 'task-link',
        note: `task link: #300 written by ${OUTSIDER}, not a member`,
      })
      expect(s.merges()).toEqual([])
    },
    SLOW,
  )

  test(
    "stage 11 readies a member's dependent and never an outsider's",
    async () => {
      const s = await scene({
        issues: [
          task(302, 'counter'),
          {
            ...task(304, 'counter', undefined, { dependsOn: [302], status: 'blocked' }),
            author: OUTSIDER,
          },
          task(306, 'counter', undefined, { dependsOn: [302], status: 'blocked' }),
        ],
      })
      const pull = await shipped(s, 302)
      await s.start()
      await s.ended(pull.pr, 'merged')
      await s.quit()
      expect(s.labels(306)).toContain('ready')
      expect(s.labels(304)).toContain('blocked')
      expect(s.labels(304)).not.toContain('ready')
      expect(s.out).toContain(`#${pull.pr} the task #306, which depended on #302, is ready`)
      expect(s.out).not.toContain('the task #304')
    },
    SLOW,
  )

  test(
    'stage 7 reads the task again through the rule: an issue whose author is outside the team gives no acceptance tests',
    async () => {
      const s = await scene({ issues: [task(308, 'counter')] })
      const pull = await shipped(s, 308)
      // GitHub names another author at the second read of the task, the one of stage 7.
      let reads = 0
      const watch = () => {
        const remove = s.fake.on('GET repos/{owner}/{repo}/issues/:number', async ({ params }) => {
          remove()
          try {
            const answer = await s.fake.as(LEAD)([
              'api',
              '--method',
              'GET',
              `repos/{owner}/{repo}/issues/${params.number}`,
            ])
            if (Number(params.number) !== 308) return rawResult(answer)
            reads += 1
            if (reads < 2) return rawResult(answer)
            const issue = JSON.parse(answer.stdout)
            return rawResult({
              ...answer,
              stdout: JSON.stringify({ ...issue, user: { login: OUTSIDER } }),
            })
          } finally {
            watch()
          }
        })
      }
      watch()
      await s.start()
      await s.ended(pull.pr, 'failed')
      await s.quit()
      expect(reads).toBe(2)
      const [comment] = s.comments(pull.pr)
      expect(parseGateMarker(comment.body)).toMatchObject({ stage: 'merge-test', result: 'failed' })
      expect(comment.body).toContain(
        `the task #308 was written by ${OUTSIDER}, who is not a member of the team in hackwin.yml, so it is no task, so the Gate does not know its acceptance tests (8.1)`,
      )
      expect(parseDigestLine(s.digest()[0])).toMatchObject({
        note: 'merge test: the task was not written by a member',
      })
    },
    SLOW,
  )
})

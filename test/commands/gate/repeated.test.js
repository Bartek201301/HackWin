import { afterEach, describe, expect, test } from 'vitest'
import { BUILDER1, createScene, task } from './scene.js'

/** @typedef {import('./scene.js').Scene} Scene */

/** Long enough for several runs of the merge test on a busy machine. */
const SLOW = 120_000

/** A check that fails while a file named `broken.js` lies under `src/features/`. */
const CHECK = `import { readdirSync } from 'node:fs'
const broken = readdirSync('src/features', { recursive: true }).filter((path) => String(path).endsWith('broken.js'))
if (broken.length > 0) {
  console.error('broken: ' + broken.join(', '))
  process.exit(1)
}
`

/** @type {Scene[]} */
let scenes = []

afterEach(async () => {
  await Promise.all(scenes.map((scene) => scene.cleanup()))
  scenes = []
})

/** @param {Parameters<typeof createScene>[0]} [options] */
async function scene(options = {}) {
  const created = await createScene({
    patience: 60_000,
    ...options,
    files: { 'check.mjs': CHECK, 'src/features/.keep': '', ...options.files },
    configure: (hackwin, owners) => {
      hackwin.commands.check = 'node check.mjs'
      options.configure?.(hackwin, owners)
    },
  })
  scenes.push(created)
  return created
}

/**
 * The attention lines of a type for a pull request in the Gate's output.
 * @param {Scene} s
 * @param {number} pr
 */
function attentionLines(s, pr) {
  return s.out.split('\n').filter((line) => line.startsWith(`ATTENTION repeated-failure #${pr}:`))
}

describe('AC56: repeated failures raise one attention line, which closes when the stage passes', () => {
  test(
    'the same pull request failing stage 7 on two head SHAs in a row; its pass with a later head SHA closes the item',
    async () => {
      const s = await scene({ issues: [task(130, 'counter')] })
      const branch = 'task/130-counter-work'
      const first = await s.push(branch, {
        files: { 'src/features/counter/broken.js': 'export const broken = 1\n' },
      })
      const pr = await s.openPull({ branch, author: BUILDER1, task: 130 })
      await s.start()
      await s.ended(pr, 'failed')
      expect(attentionLines(s, pr)).toEqual([])

      const second = await s.push(branch, {
        files: { 'src/features/counter/broken.js': 'export const broken = 2\n' },
      })
      await s.poll()
      await s.ended(pr, 'failed', 2)
      expect(attentionLines(s, pr)).toEqual([
        `ATTENTION repeated-failure #${pr}: #${pr} failed stage 7, merge test on 2 head SHAs in a row (${first.slice(0, 12)}, ${second.slice(0, 12)}); the comments on #${pr} give each failure: help its author, or look for a cause outside the pull request`,
      ])
      expect(s.state().attention).toEqual([
        expect.objectContaining({
          type: 'repeated-failure',
          pr,
          stage: 'merge-test',
          resolved_at: null,
        }),
      ])
      expect(s.comments(pr)).toHaveLength(2)

      const fixed = await s.push(branch, { remove: ['src/features/counter/broken.js'] })
      s.check(fixed)
      await s.poll()
      await s.ended(pr, 'merged')
      await s.quit()
      expect(s.out).toContain(
        `#${pr}: the repeated-failure attention item is closed: #${pr} passes stage 7, merge test with head ${fixed}`,
      )
      expect(attentionLines(s, pr)).toHaveLength(1)
      expect(s.state().attention).toEqual([
        expect.objectContaining({ type: 'repeated-failure', resolved_at: expect.any(String) }),
      ])
      expect(s.status()?.attention).toEqual([])
    },
    SLOW,
  )

  test(
    'a failed smoke test after a merge raises one repeated failure line',
    async () => {
      const s = await scene({
        issues: [task(136, 'counter')],
        configure: (hackwin) => {
          hackwin.commands.smoke = 'node -e "process.exit(3)"'
        },
      })
      const branch = 'task/136-counter-work'
      const head = await s.push(branch, {
        files: { 'src/features/counter/fine.js': 'export const fine = 1\n' },
      })
      const pr = await s.openPull({ branch, author: BUILDER1, task: 136 })
      s.check(head)
      await s.start()
      await s.ended(pr, 'merged')
      await s.until(() => s.state().last_smoke.result === 'failed', 'the smoke test')
      await s.quit()
      const lines = attentionLines(s, pr)
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain(`the smoke test \`node -e "process.exit(3)"\` failed on main`)
      expect(s.state().attention).toEqual([
        expect.objectContaining({
          type: 'repeated-failure',
          pr,
          stage: 'smoke',
          resolved_at: null,
        }),
      ])
    },
    SLOW,
  )
})

describe('1.6e/repeated: the streaks of G23', () => {
  test(
    'two queue items in a row that fail the same stage raise one item, which the next queue item that passes the stage closes',
    async () => {
      const s = await scene({
        issues: [task(140, 'counter'), task(142, 'todos'), task(144, 'counter')],
      })
      const pulls = []
      for (const [issue, role] of /** @type {const} */ ([
        [140, 'counter'],
        [142, 'todos'],
      ])) {
        const branch = `task/${issue}-${role}-work`
        await s.push(branch, {
          files: { [`src/features/${role}/broken.js`]: 'export const b = 1\n' },
        })
        pulls.push(await s.openPull({ branch, author: BUILDER1, task: issue }))
      }
      const [first, second] = pulls
      await s.start()
      await s.ended(first, 'failed')
      await s.ended(second, 'failed')
      const line = `ATTENTION repeated-failure #${second}: 2 queue items in a row failed stage 7, merge test (#${first}, #${second}); look for a cause they share, such as main, CI or the machine of the Gate`
      expect(s.out.split('\n').filter((each) => each.startsWith('ATTENTION'))).toEqual([line])
      expect(s.state().attention).toEqual([
        expect.objectContaining({
          pr: second,
          stage: 'merge-test',
          across: true,
          resolved_at: null,
        }),
      ])

      const branch = 'task/144-counter-work'
      const head = await s.push(branch, {
        files: { 'src/features/counter/fine.js': 'export const fine = 1\n' },
      })
      const third = await s.openPull({ branch, author: BUILDER1, task: 144 })
      s.check(head)
      await s.poll()
      await s.ended(third, 'merged')
      await s.quit()
      expect(s.out).toContain(
        `#${second}: the repeated-failure attention item is closed: #${third} passes stage 7, merge test with head ${head}`,
      )
      expect(s.state().attention).toEqual([
        expect.objectContaining({ pr: second, resolved_at: expect.any(String) }),
      ])
      expect(s.state().streaks).toEqual({ queue: null, prs: expect.any(Object) })
    },
    SLOW,
  )

  test(
    'a head SHA that passes the stage ends the streak, also when a newer head replaces it later',
    async () => {
      const s = await scene({ issues: [task(146, 'counter')] })
      const branch = 'task/146-counter-work'
      await s.push(branch, {
        files: { 'src/features/counter/broken.js': 'export const broken = 1\n' },
      })
      const pr = await s.openPull({ branch, author: BUILDER1, task: 146 })
      await s.start()
      await s.ended(pr, 'failed')

      // The second head passes stage 7 and waits for CI, which never comes.
      const passing = await s.push(branch, { remove: ['src/features/counter/broken.js'] })
      await s.poll()
      await s.until(
        () => s.out.includes(`#${pr} passed stages 1 to 7 with head ${passing}`),
        'stage 8',
      )
      expect(s.state().streaks).toEqual({ queue: null, prs: {} })

      // The third head fails stage 7 again: the first one in a row.
      await s.push(branch, {
        files: { 'src/features/counter/broken.js': 'export const broken = 3\n' },
      })
      await s.poll()
      // The run of the second head ends as requeued; the third one runs from the next poll.
      await s.until(() => s.digest().some((line) => line.includes(' requeued ')), 'the requeue')
      await s.poll()
      await s.ended(pr, 'failed', 2)
      await s.quit()
      expect(s.out).not.toContain('ATTENTION')
      expect(s.state().attention).toEqual([])
      expect(s.state().streaks.prs[String(pr)].runs).toHaveLength(1)
    },
    SLOW,
  )
})

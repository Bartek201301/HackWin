import { afterEach, describe, expect, test } from 'vitest'
import { mkdirSync } from 'node:fs'
import { emptyState, saveState } from '../../../src/commands/gate/state.js'
import { BUILDER1, createScene, task } from './scene.js'

/** @typedef {import('./scene.js').Scene} Scene */

/** @type {Scene[]} */
let scenes = []

afterEach(async () => {
  await Promise.all(scenes.map((scene) => scene.cleanup()))
  scenes = []
})

/** @param {Parameters<typeof createScene>[0]} [options] */
async function scene(options) {
  const created = await createScene(options)
  scenes.push(created)
  return created
}

/** The Gate labels among a pull request's labels. */
const gateLabels = (/** @type {string[]} */ labels) =>
  labels.filter((label) => label.startsWith('gate:') || label === 'scope-violation').sort()

/**
 * A pull request of builder1 that adds one file in its own role.
 * @param {Scene} s
 * @param {number} issue
 * @param {string} role
 * @param {{ draft?: boolean, files?: Record<string, string>, body?: string }} [options]
 */
async function ownPull(s, issue, role, { draft = false, files, body } = {}) {
  const branch = `task/${issue}-${role}-work`
  const head = await s.push(branch, {
    files: files ?? { [`src/features/${role}/f${issue}.js`]: `export const n = ${issue}\n` },
  })
  const pr = await s.openPull({ branch, author: BUILDER1, task: issue, draft, body })
  return { branch, head, pr }
}

describe('1.6c/intake: drafts, the order of the queue and new head SHAs', () => {
  test('a draft is ignored; the queue keeps the order in which head SHAs joined; a new head SHA goes to the back', async () => {
    const s = await scene({ issues: [task(70, 'counter'), task(72, 'todos'), task(74, 'counter')] })
    const first = await ownPull(s, 70, 'counter')
    const second = await ownPull(s, 72, 'todos')
    const draft = await ownPull(s, 74, 'counter', { draft: true })
    await s.start()

    await s.until(() => s.out.includes(`#${first.pr} passed stages 1 to 6`), 'the first run')
    expect(s.state().queue).toEqual([first.pr, second.pr])
    expect(gateLabels(s.labels(first.pr))).toEqual(['gate:testing'])
    expect(gateLabels(s.labels(second.pr))).toEqual(['gate:queued'])
    expect(s.labels(draft.pr)).toEqual([])
    expect(s.state().prs[String(draft.pr)]).toBeUndefined()

    const later = await s.push(first.branch, {
      files: { 'src/features/counter/f70.js': 'export const n = 71\n' },
    })
    s.poll()
    await s.until(() => s.out.includes(`#${second.pr} passed stages 1 to 6`), 'the second run')
    expect(s.state().queue).toEqual([second.pr, first.pr])
    expect(s.state().prs[String(first.pr)]).toMatchObject({
      head_sha: later,
      stage: 'intake',
      result: null,
      first_seen_at: s.gate.clock.iso(),
    })
    expect(gateLabels(s.labels(first.pr))).toEqual(['gate:queued'])

    const ready = /** @type {any} */ (s.fake.find(draft.pr)).pull
    ready.draft = false
    s.poll()
    await s.until(() => s.state().queue.includes(draft.pr), 'the pull request ready for review')
    expect(s.state().queue).toEqual([second.pr, first.pr, draft.pr])
    expect(gateLabels(s.labels(draft.pr))).toEqual(['gate:queued'])
    await s.quit()
  })

  test('a pull request closed without a merge leaves the queue, its task returns to in-progress and its attention items close, except a secret', async () => {
    const s = await scene({
      issues: [task(76, 'counter'), task(78, 'counter'), task(80, 'todos')],
    })
    const outside = await ownPull(s, 76, 'counter', {
      files: { 'src/features/greeting/g.js': 'export const g = 1\n' },
    })
    const waiting = await ownPull(s, 78, 'counter')
    const queued = await ownPull(s, 80, 'todos')
    // A secret item of the same pull request, from before the start, stays open after the close.
    const before = emptyState()
    before.attention.push({
      type: 'secret',
      pr: outside.pr,
      since: '2026-10-24T09:00:00.000Z',
      todo: 'rotate',
      resolved_at: null,
    })
    mkdirSync(s.files.root, { recursive: true })
    await saveState(s.files.state, before)
    await s.start()
    await s.until(() => s.out.includes(`#${waiting.pr} passed stages 1 to 6`), 'the runs')
    expect(s.state().queue).toEqual([waiting.pr, queued.pr])
    expect(s.state().attention.map((item) => [item.type, item.pr, item.resolved_at])).toEqual([
      ['secret', outside.pr, null],
      ['scope-violation', outside.pr, null],
    ])

    for (const pr of [outside.pr, queued.pr]) {
      await s.as(BUILDER1).updatePullRequest(pr, { state: 'closed' })
    }
    s.poll()
    await s.until(
      () => s.out.includes(`#${queued.pr} was closed without a merge and left the queue`),
      'the closed pull requests',
    )
    await s.quit()
    const state = s.state()
    expect(state.queue).toEqual([waiting.pr])
    expect(state.prs[String(outside.pr)]).toBeUndefined()
    expect(state.prs[String(queued.pr)]).toBeUndefined()
    expect(s.out).toContain(
      `#${outside.pr} was closed without a merge and left the queue; its task #76 is in-progress again`,
    )
    expect(s.out).toContain(
      `#${outside.pr}: the scope-violation attention item is closed: the pull request is closed`,
    )
    for (const issue of [76, 80]) {
      const labels = s.labels(issue)
      expect(labels).toContain('in-progress')
      expect(labels).not.toContain('in-review')
    }
    expect(s.labels(78)).toContain('in-review')
    expect(state.attention.map((item) => [item.type, item.pr, item.resolved_at === null])).toEqual([
      ['secret', outside.pr, true],
      ['scope-violation', outside.pr, false],
    ])
  })

  test('retry queues the current head SHA of a failed run again, but never a head SHA with a secret', async () => {
    const s = await scene({ issues: [task(82, 'counter'), task(84, 'todos')] })
    const unlinked = await ownPull(s, 82, 'counter', { body: 'Work on the counter.' })
    const secret = await ownPull(s, 84, 'todos', {
      files: {
        'src/features/todos/t.js': `export const t = '${['ghp', 'Z9y8X7w6'.repeat(5)].join('_')}'\n`,
      },
    })
    await s.start()
    await s.ended(unlinked.pr, 'failed')
    await s.ended(secret.pr, 'failed')
    expect(s.comments(unlinked.pr)[0].body).toContain('(`no-closes-line`)')
    expect(s.comments(unlinked.pr)[0].body).toContain(
      `edit the body to hold exactly one line \`Closes #82\`, then ask the Lead to type \`retry ${unlinked.pr}\` in the Gate terminal`,
    )

    await s.as(BUILDER1).updatePullRequest(unlinked.pr, { body: 'Closes #82' })
    s.type(`retry ${unlinked.pr}`)
    s.type(`retry ${secret.pr}`)
    await s.until(
      () => s.out.includes(`retry #${secret.pr}: the head SHA of #${secret.pr} adds a secret`),
      'the refused retry',
    )
    s.poll()
    await s.until(() => s.out.includes(`#${unlinked.pr} passed stages 1 to 6`), 'the retried run')
    expect(s.out).toContain(
      `retry #${unlinked.pr}: the head ${unlinked.head} joined the back of the queue`,
    )
    expect(gateLabels(s.labels(unlinked.pr))).toEqual(['gate:testing'])
    expect(s.comments(unlinked.pr)).toHaveLength(1)
    await s.quit()
    expect(s.state().queue).toEqual([unlinked.pr])
    expect(s.state().prs[String(secret.pr)]).toMatchObject({ result: 'failed', stage: 'secrets' })
  })
})

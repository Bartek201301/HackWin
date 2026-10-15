import { afterEach, describe, expect, test, vi } from 'vitest'
import { mkdirSync } from 'node:fs'
import { parseGateMarker } from '../../../src/commands/gate/comment.js'
import { parseDigestLine } from '../../../src/commands/gate/digest.js'
import { emptyState, pullRecord, saveState } from '../../../src/commands/gate/state.js'
import { BUILDER1, LEAD, createScene, task } from './scene.js'

// The waits of these tests are long (helpers.js, until; scene.js), so that a loaded machine
// fails no test; a test may take as long as its waits.
vi.setConfig({ testTimeout: 120_000 })

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

/**
 * Hold every answer to `GET pulls/<N>`, the first call of stage 2, until `release()`.
 * @param {Scene} s
 */
function holdStage2(s) {
  /** @type {() => void} */
  let release = () => {}
  const released = new Promise((resolve) => (release = () => resolve(null)))
  const held = { count: 0, release }
  const remove = s.fake.on('GET repos/{owner}/{repo}/pulls/:number', async ({ args }) => {
    held.count += 1
    await released
    remove()
    const answer = await s.fake.as(LEAD)(args)
    return JSON.parse(answer.stdout)
  })
  return held
}

describe('1.6c/stages: what each of stages 1 to 6 does', () => {
  test('stage 2 fails a pull request from a branch that is not a task branch', async () => {
    const s = await scene({ issues: [task(90, 'counter')] })
    const head = await s.push('feature/counter', {
      files: { 'src/features/counter/a.js': 'export const a = 1\n' },
    })
    const pr = await s.openPull({ branch: 'feature/counter', author: BUILDER1, task: 90 })
    await s.start()
    await s.ended(pr, 'failed')
    const [comment] = s.comments(pr)
    expect(parseGateMarker(comment.body)).toEqual({
      pr,
      sha: head,
      stage: 'task-link',
      result: 'failed',
    })
    expect(comment.body).toContain('failed at stage 2, task link')
    expect(comment.body).toContain(
      'the branch `feature/counter` is not a task branch `task/<N>-<slug>`',
    )
    expect(comment.body).toContain('(`no-task-branch`)')
    expect(comment.body).toContain(
      "open the pull request with `hackwin ship` in the task's worktree",
    )
    expect(s.digest().map(parseDigestLine)).toEqual([
      expect.objectContaining({
        pr,
        result: 'failed',
        stage: 'task-link',
        note: 'task link: no-task-branch',
      }),
    ])
    await s.quit()
  })

  test('stage 5 raises a production config attention item that names the ledger, and the run goes on', async () => {
    const s = await scene({
      issues: [task(92, 'shared', ['deploy/**'])],
      configure: (hackwin) => {
        hackwin.paths.gated.production_config = ['deploy/**']
        hackwin.paths.ledger = 'docs/ledger.md'
      },
    })
    const head = await s.push('task/92-shared-deploy', {
      files: { 'deploy/prod.env.yml': 'replicas: 2\n' },
    })
    const pr = await s.openPull({ branch: 'task/92-shared-deploy', author: LEAD, task: 92 })
    await s.start()
    await s.until(() => s.out.includes(`#${pr} passed stages 1 to 7 with head ${head}`), 'the run')
    expect(s.out).toContain(
      `ATTENTION production-config #${pr}: review the production config change in deploy/prod.env.yml and apply it by hand outside HackWin, then record it in docs/ledger.md; the Gate tests and merges the pull request like any other`,
    )
    expect(s.notifications).toEqual([])
    expect(s.comments(pr)).toEqual([])
    await s.quit()
    expect(s.state().prs[String(pr)]).toMatchObject({
      gated: ['production_config'],
      stage: 'ci',
      result: null,
    })
    expect(s.state().attention).toEqual([
      expect.objectContaining({ type: 'production-config', pr, resolved_at: null }),
    ])
  })

  test('quit during a stage ends the run before the next stage', async () => {
    const s = await scene({ issues: [task(94, 'counter')] })
    await s.push('task/94-counter-quit', {
      files: { 'src/features/counter/q.js': 'export const q = 1\n' },
    })
    const pr = await s.openPull({ branch: 'task/94-counter-quit', author: BUILDER1, task: 94 })
    const held = holdStage2(s)
    await s.start()
    await s.until(() => held.count === 1, 'stage 2')
    s.type('quit')
    await s.until(() => s.out.includes('quit: the Gate stops after the current step'), 'quit')
    held.release()
    await s.quit()
    const state = s.state()
    expect(state.queue).toEqual([pr])
    expect(state.prs[String(pr)]).toMatchObject({ stage: 'task-link', result: null })
    expect(state.prs[String(pr)].stage_times).toHaveProperty('task-link')
    expect(state.prs[String(pr)].stage_times).not.toHaveProperty('scope')
    expect(s.comments(pr)).toEqual([])
  })

  test('stage 1 fetches again with increasing waits while the fetch fails', async () => {
    const missing = 'f'.repeat(40)
    const s = await scene({ issues: [task(96, 'counter')] })
    // A queued head SHA that the origin no longer holds: its branch is gone.
    const branch = 'task/96-counter-gone'
    await s.push(branch, { files: { 'src/features/counter/g.js': 'export const g = 1\n' } })
    const pr = await s.openPull({ branch, author: BUILDER1, task: 96 })
    s.fake.setBranch(branch, null)
    const pull = /** @type {any} */ (s.fake.find(pr)).pull
    pull.headSha = missing
    const state = emptyState()
    state.queue = [pr]
    state.prs[String(pr)] = { ...pullRecord(missing, '2026-10-24T09:00:00.000Z'), stage: 'intake' }
    mkdirSync(s.files.root, { recursive: true })
    await saveState(s.files.state, state)
    await s.start()

    for (const [index, wait] of [5, 10, 20, 40, 60, 60].entries()) {
      await s.until(
        () =>
          s.out.split('\n').filter((line) => line.includes(`#${pr} stage 1, fetch: failed`))
            .length ===
          index + 1,
        `fetch ${index + 1}`,
      )
      expect(s.out.trimEnd().split('\n').at(-1)).toContain(
        `#${pr} stage 1, fetch: failed, the Gate tries again in ${wait} s:`,
      )
      s.gate.clock.advance(wait * 1000)
    }
    await s.quit()
    expect(s.state().prs[String(pr)]).toMatchObject({ stage: 'fetch', result: null })
    expect(s.state().queue).toEqual([pr])
  })

  test('a new head SHA during a run ends that run as requeued after its current stage', async () => {
    const s = await scene({ issues: [task(98, 'counter')] })
    const branch = 'task/98-counter-moving'
    const first = await s.push(branch, {
      files: { 'src/features/counter/m.js': 'export const m = 1\n' },
    })
    const pr = await s.openPull({ branch, author: BUILDER1, task: 98 })
    const held = holdStage2(s)
    await s.start()
    await s.until(() => held.count === 1, 'stage 2')

    const second = await s.push(branch, {
      files: { 'src/features/counter/m.js': 'export const m = 2\n' },
    })
    await s.poll()
    await s.until(() => s.state().prs[String(pr)]?.head_sha === second, 'the new head SHA')
    expect(s.out).toContain(
      `#${pr}: the new head ${second} arrived during the run of ${first}, which stops after its current stage`,
    )
    held.release()
    await s.until(() => s.digest().length === 1, 'the end of the first run')
    expect(parseDigestLine(s.digest()[0])).toMatchObject({
      pr,
      result: 'requeued',
      stage: 'task-link',
      note: `the new head ${second} joined the back of the queue`,
    })
    await s.poll()
    await s.until(
      () => s.out.includes(`#${pr} passed stages 1 to 7 with head ${second}`),
      'the run of the new head',
    )
    await s.quit()
    expect(s.comments(pr)).toEqual([])
    expect(s.state().queue).toEqual([pr])
  })
})

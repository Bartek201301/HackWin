import { afterEach, describe, expect, test } from 'vitest'
import { parseGateMarker } from '../../../src/commands/gate/comment.js'
import { BUILDER1, BUILDER2, createScene, task } from './scene.js'

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

describe("AC25: a pull request with a file outside its author's scope", () => {
  test('gets scope-violation, a comment with files and owners and an attention line, is not merged, and the item closes when a later head SHA passes the scope check', async () => {
    const s = await scene({ issues: [task(20, 'counter')] })
    const branch = 'task/20-counter-reset'
    const head = await s.push(branch, {
      files: {
        'src/features/counter/reset.js': 'export const reset = () => 0\n',
        'src/features/greeting/hello.js': 'export const hello = "hi"\n',
      },
    })
    const pr = await s.openPull({ branch, author: BUILDER1, task: 20 })
    await s.start()

    await s.ended(pr, 'scope-violation')
    expect(
      s
        .labels(pr)
        .filter((label) => label.startsWith('gate:') || label === 'scope-violation')
        .sort(),
    ).toEqual(['gate:failed', 'scope-violation'])
    const comments = s.comments(pr)
    expect(comments).toHaveLength(1)
    expect(parseGateMarker(comments[0].body)).toEqual({
      pr,
      sha: head,
      stage: 'scope',
      result: 'scope-violation',
    })
    expect(comments[0].body).toContain('failed at stage 3, scope')
    expect(comments[0].body).toContain(
      `- \`src/features/greeting/hello.js\`: role \`greeting\`, held by ${BUILDER2}`,
    )
    expect(comments[0].body).not.toContain('src/features/counter/reset.js')
    expect(s.out).toContain(
      `ATTENTION scope-violation #${pr}: ${BUILDER1} changes files outside their roles: src/features/greeting/hello.js (greeting, ${BUILDER2})`,
    )
    const state = s.state()
    expect(state.queue).toEqual([])
    expect(state.prs[String(pr)]).toMatchObject({
      head_sha: head,
      stage: 'scope',
      result: 'scope-violation',
    })
    expect(state.attention).toEqual([
      expect.objectContaining({ type: 'scope-violation', pr, resolved_at: null }),
    ])
    // Not merged: the pull request is open, and no merge was asked for.
    expect(s.fake.find(pr)).toMatchObject({ state: 'open', pull: { merged: false } })
    expect(
      s.fake.calls.some((call) => call.args[0] === 'pr' || /\/merge$/.test(call.endpoint ?? '')),
    ).toBe(false)

    const later = await s.push(branch, { remove: ['src/features/greeting/hello.js'] })
    await s.poll()
    await s.until(
      () => s.out.includes(`#${pr} passed stages 1 to 7 with head ${later}`),
      'the later head SHA',
    )
    expect(
      s.labels(pr).filter((label) => label.startsWith('gate:') || label === 'scope-violation'),
    ).toEqual(['gate:waiting-ci'])
    expect(s.comments(pr)).toHaveLength(1)
    expect(s.out).toContain(
      `#${pr}: the scope-violation attention item is closed: head ${later} passes stage 3`,
    )
    await s.quit()
    expect(s.state().attention).toEqual([
      expect.objectContaining({ type: 'scope-violation', pr, resolved_at: expect.any(String) }),
    ])
  })
})

describe("1.6c/scope: stage 3 checks the author's roles, never the role of the task", () => {
  test("a change in the author's own role passes for a task of another role, and a change outside the author's roles fails for a task of that role", async () => {
    const s = await scene({ issues: [task(30, 'greeting'), task(32, 'counter')] })
    await s.push('task/32-counter-limit', {
      files: { 'src/features/counter/limit.js': 'export const limit = 9\n' },
    })
    const outside = await s.openPull({
      branch: 'task/32-counter-limit',
      author: BUILDER2,
      task: 32,
    })
    await s.push('task/30-greeting-counter', {
      files: { 'src/features/counter/greet.js': 'export const greet = 1\n' },
    })
    const own = await s.openPull({ branch: 'task/30-greeting-counter', author: BUILDER1, task: 30 })
    await s.start()

    await s.until(() => s.out.includes(`#${own} passed stages 1 to 7`), 'the run of the own change')
    expect(s.labels(outside)).toEqual(expect.arrayContaining(['gate:failed', 'scope-violation']))
    expect(s.comments(outside)[0].body).toContain(
      `- \`src/features/counter/limit.js\`: role \`counter\`, held by ${BUILDER1}`,
    )
    expect(s.comments(outside)[0].body).toContain(`${BUILDER2} holds \`greeting\``)
    expect(s.labels(own)).not.toContain('scope-violation')
    expect(s.comments(own)).toEqual([])
    await s.quit()
    expect(s.state().attention.map((item) => [item.type, item.pr])).toEqual([
      ['scope-violation', outside],
    ])
  })
})

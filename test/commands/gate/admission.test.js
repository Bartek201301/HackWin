import { afterEach, describe, expect, test, vi } from 'vitest'
import { mkdirSync } from 'node:fs'
import { pullRef } from '../../../src/commands/gate/pulls.js'
import { emptyState, pullRecord, saveState } from '../../../src/commands/gate/state.js'
import { BUILDER1, LEAD, createScene, task } from './scene.js'

// The waits of these tests are long (helpers.js, until; scene.js), so that a loaded machine
// fails no test; a test may take as long as its waits.
vi.setConfig({ testTimeout: 120_000 })

/** @typedef {import('./scene.js').Scene} Scene */

/** A login that is no member of the fixture's team. */
const OUTSIDER = 'outside-dev'
/** A fork of the fake's repository, `hackwin-test/app`. */
const FORK = 'outside-dev/app'

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

/** The labels a Gate run sets. */
const gateLabels = (/** @type {string[]} */ labels) =>
  labels.filter(
    (label) => label.startsWith('gate:') || label === 'needs-owner' || label === 'scope-violation',
  )

/**
 * Make a pull request of the fake come from a fork: its head no longer follows the branch.
 * @param {Scene} s
 * @param {number} pr
 */
function fromFork(s, pr) {
  const pull = /** @type {any} */ (s.fake.find(pr)).pull
  pull.headRepo = FORK
}

/**
 * Hold the answers to the list of pull requests, which intake asks first, until `release()`.
 * @param {Scene} s
 */
function holdIntake(s) {
  /** @type {() => void} */
  let release = () => {}
  const released = new Promise((resolve) => (release = () => resolve(null)))
  const held = { count: 0, release }
  const remove = s.fake.on('GET repos/{owner}/{repo}/pulls', async ({ args }) => {
    held.count += 1
    await released
    remove()
    const answer = await s.fake.as(LEAD)(args)
    return JSON.parse(answer.stdout)
  })
  return held
}

describe('1.6c/outsiders: the Gate tests only the pull requests of the team', () => {
  test('a pull request from a fork, and one of no member, never go through the stages: each gets an attention line and is left alone', async () => {
    const s = await scene({
      issues: [task(110, 'counter'), task(112, 'counter'), task(114, 'counter')],
    })
    await s.push('task/110-counter-fork', {
      files: { 'src/features/counter/f.js': 'export const f = 1\n' },
    })
    const fork = await s.openPull({ branch: 'task/110-counter-fork', author: BUILDER1, task: 110 })
    fromFork(s, fork)
    await s.push('task/112-counter-readme', { files: { 'README.md': '# Open to everyone\n' } })
    const stranger = await s.openPull({
      branch: 'task/112-counter-readme',
      author: OUTSIDER,
      task: 112,
    })
    await s.push('task/114-counter-own', {
      files: { 'src/features/counter/own.js': 'export const own = 1\n' },
    })
    const member = await s.openPull({ branch: 'task/114-counter-own', author: BUILDER1, task: 114 })
    await s.start()
    await s.until(() => s.out.includes(`#${member} passed stages 1 to 7`), "the member's run")

    expect(s.out).toContain(
      `ATTENTION scope-violation #${fork}: the Gate does not test #${fork}: its head lies in ${FORK}, not in this repository, and the Gate tests only branches of this repository; close it, or move the change to a task branch of this repository`,
    )
    expect(s.out).toContain(
      `ATTENTION scope-violation #${stranger}: the Gate does not test #${stranger}: its author ${OUTSIDER} is not a member of the team in hackwin.yml, and the Gate tests only the pull requests of members; close it, or add ${OUTSIDER} to hackwin.yml first`,
    )
    for (const pr of [fork, stranger]) {
      expect(gateLabels(s.labels(pr))).toEqual([])
      expect(s.comments(pr)).toEqual([])
      expect(await s.fixture.git.tryRevParse(pullRef(pr))).toBeNull()
    }
    expect(s.notifications).toEqual([])
    // The next poll leaves them alone and prints nothing new about them.
    const before = s.out
    await s.poll()
    await s.quit()
    expect(s.out.slice(before.length)).not.toContain('ATTENTION')
    const state = s.state()
    expect(state.queue).toEqual([member])
    expect(Object.keys(state.prs)).toEqual([String(member)])
    expect(state.attention.map((item) => [item.type, item.pr, item.resolved_at])).toEqual([
      ['scope-violation', fork, null],
      ['scope-violation', stranger, null],
    ])
  })

  test('the attention item closes when the pull request is closed, and a queued one from a fork leaves the queue at stage 2', async () => {
    const s = await scene({ issues: [task(116, 'counter')] })
    await s.push('task/116-counter-old', {
      files: { 'src/features/counter/o.js': 'export const o = 1\n' },
    })
    const pr = await s.openPull({ branch: 'task/116-counter-old', author: BUILDER1, task: 116 })
    fromFork(s, pr)
    const head = /** @type {any} */ (s.fake.find(pr)).pull.headSha
    await s.as(LEAD).addLabels(pr, ['gate:queued'])
    // Queued in a state of before this rule.
    const state = emptyState()
    state.queue = [pr]
    state.prs[String(pr)] = { ...pullRecord(head, '2026-10-24T09:00:00.000Z'), stage: 'intake' }
    mkdirSync(s.files.root, { recursive: true })
    await saveState(s.files.state, state)
    await s.start()

    await s.until(() => s.out.includes(`ATTENTION scope-violation #${pr}:`), 'the attention line')
    await s.until(() => s.state().queue.length === 0, 'the queue without it')
    expect(s.state().prs[String(pr)]).toBeUndefined()
    expect(gateLabels(s.labels(pr))).toEqual([])
    expect(s.comments(pr)).toEqual([])

    await s.as(BUILDER1).updatePullRequest(pr, { state: 'closed' })
    await s.poll()
    await s.until(
      () =>
        s.out.includes(
          `#${pr}: the scope-violation attention item is closed: the pull request is closed`,
        ),
      'the closed item',
    )
    await s.quit()
    expect(s.state().attention).toEqual([
      expect.objectContaining({ type: 'scope-violation', pr, resolved_at: expect.any(String) }),
    ])
    // A task of a pull request the Gate left alone keeps its status.
    expect(s.labels(116)).toContain('in-review')
  })
})

describe('1.6c/intake: every open head SHA is scanned, whatever its base', () => {
  test('a pull request into another branch is scanned at intake and fails on a secret, but never joins the queue; retargeted to main, it does', async () => {
    const secret = ['ghp', 'Q1w2E3r4'.repeat(5)].join('_')
    const s = await scene({ issues: [task(120, 'counter'), task(122, 'counter')] })
    await s.push('release', { message: 'Start the release branch' })
    await s.push('task/120-counter-leak', {
      from: 'release',
      files: { 'src/features/counter/leak.js': `export const k = '${secret}'\n` },
    })
    const leak = await s.openPull({
      branch: 'task/120-counter-leak',
      author: BUILDER1,
      task: 120,
      base: 'release',
    })
    await s.push('task/122-counter-clean', {
      from: 'release',
      files: { 'src/features/counter/clean.js': 'export const c = 1\n' },
    })
    const clean = await s.openPull({
      branch: 'task/122-counter-clean',
      author: BUILDER1,
      task: 122,
      base: 'release',
    })
    await s.start()
    await s.ended(leak, 'failed')
    await s.until(
      async () => (await s.fixture.git.tryRevParse(pullRef(clean))) !== null,
      'the fetch of the clean head',
    )

    expect(s.comments(leak)).toHaveLength(1)
    expect(s.comments(leak)[0].body).toContain('- `src/features/counter/leak.js:1: github-token`')
    expect(s.comments(leak)[0].body).not.toContain(secret)
    expect(gateLabels(s.labels(leak))).toEqual(['gate:failed'])
    expect(s.notifications).toHaveLength(1)
    expect(await s.fixture.git.tryRevParse(pullRef(clean))).toBe(
      /** @type {any} */ (s.fake.find(clean)).pull.headSha,
    )
    expect(gateLabels(s.labels(clean))).toEqual([])
    expect(s.state().queue).toEqual([])
    expect(s.state().prs[String(clean)]).toBeUndefined()

    // The next poll scans neither head again.
    const writes = s.fake.calls.length
    await s.poll()
    expect(s.fake.calls.slice(writes).filter((call) => call.method !== 'GET')).toEqual([])

    await s.as(BUILDER1).updatePullRequest(clean, { base: 'main' })
    await s.poll()
    await s.until(() => s.out.includes(`#${clean} passed stages 1 to 7`), 'the retargeted run')
    await s.quit()
    expect(s.state().queue).toEqual([clean])
    expect(s.comments(clean)).toEqual([])
  })

  test('once quit is typed, intake starts no new work', async () => {
    const s = await scene({ issues: [task(124, 'counter')] })
    await s.push('task/124-counter-late', {
      files: { 'src/features/counter/l.js': 'export const l = 1\n' },
    })
    const pr = await s.openPull({ branch: 'task/124-counter-late', author: BUILDER1, task: 124 })
    const held = holdIntake(s)
    await s.start()
    await s.until(() => held.count === 1, 'the list of pull requests')
    s.type('quit')
    await s.until(() => s.out.includes('quit: the Gate stops after the current step'), 'quit')
    held.release()
    await s.quit()
    expect(gateLabels(s.labels(pr))).toEqual([])
    expect(s.state().prs[String(pr)]).toBeUndefined()
    expect(s.state().queue).toEqual([])
    expect(await s.fixture.git.tryRevParse(pullRef(pr))).toBeNull()
  })
})

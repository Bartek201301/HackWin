// `status` against a real Gate: the Gate of the scene of the Gate's tests, with the real pipeline,
// writes the status issue into the fake GitHub and its heartbeat into the Lead's clone; `status`
// reads them on the Lead's laptop, the Gate's clone, and on a builder's joined clone.

import { afterEach, describe, expect, test } from 'vitest'
import { gateFiles, readHeartbeat, writeHeartbeat } from '../../../src/commands/gate/state.js'
import { STATUS_LABEL } from '../../../src/commands/gate/status-issue.js'
import { BUILDER1, BUILDER2, LEAD, STATUS_MS, createScene, task } from '../gate/scene.js'
import { fixedClock, runStatus } from './helpers.js'

/** @typedef {import('../gate/scene.js').Scene} Scene */

/** `gate.heartbeat_stale_seconds` of the team configuration. */
const STALE_SECONDS = 300

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
 * The status issue of the fake GitHub.
 * @param {Scene} s
 * @returns {any}
 */
function statusItem(s) {
  return s.fake.state.items.find((item) => item.labels.includes(STATUS_LABEL))
}

/**
 * A time some seconds after another.
 * @param {string} iso
 * @param {number} seconds
 */
const after = (iso, seconds) => new Date(Date.parse(iso) + seconds * 1000).toISOString()

describe("AC61: status on a builder's machine while the Gate runs", () => {
  test('shows a heartbeat age below the stale threshold, the open attention items and the digest line of a pull request the Gate has just processed, all read from the status issue', async () => {
    const s = await scene({ issues: [task(20, 'counter')] })
    const branch = 'task/20-counter-reset'
    await s.push(branch, {
      files: {
        'src/features/counter/reset.js': 'export const reset = () => 0\n',
        'src/features/greeting/hello.js': 'export const hello = "hi"\n',
      },
    })
    const pr = await s.openPull({ branch, author: BUILDER1, task: 20 })
    const builder = await s.fixture.joinedClone({ name: 'builder1', login: BUILDER1 })
    await s.start()
    await s.ended(pr, 'scope-violation')

    // The Gate publishes the run at its next edit of the status issue.
    s.gate.clock.advance(STATUS_MS)
    await s.until(
      () => s.status()?.digest.some((entry) => entry.pr === pr) && s.status()?.attention.length,
      'the run in the status issue',
    )
    const published = /** @type {any} */ (s.status())
    const now = after(published.heartbeat_at, 40)
    const result = await runStatus({
      cwd: builder.path,
      env: s.fixture.env,
      executor: s.fake.as(BUILDER1),
      clock: fixedClock(now),
      json: true,
    })

    expect(result.code).toBe(0)
    const { data, lines } = result.json
    // The builder's clone has no Gate files: everything comes from the status issue.
    expect(await readHeartbeat(gateFiles(builder.commonDir).heartbeat)).toBeNull()
    expect(data.gate).toMatchObject({
      state: 'running',
      source: 'status-issue',
      heartbeat_at: published.heartbeat_at,
      age_seconds: 40,
    })
    expect(data.gate.age_seconds).toBeLessThan(STALE_SECONDS)
    expect(lines[0]).toBe('gate: running, heartbeat 40s ago')

    const [item] = published.attention
    expect(item).toMatchObject({ type: 'scope-violation', pr })
    expect(data.attention).toContainEqual({ kind: 'gate', ...item })
    expect(lines).toContain(`  ATTENTION scope-violation #${pr}: ${item.todo}`)
    expect(lines).toContain(
      `  your pull request #${pr} (gate:failed, scope-violation): scope-violation at stage scope: ${published.digest[0].note}`,
    )

    const [line] = published.digest.filter((/** @type {any} */ entry) => entry.pr === pr)
    expect(line).toMatchObject({ author: BUILDER1, result: 'scope-violation', stage: 'scope' })
    expect(data.digest.lines).toContainEqual(line)
    expect(
      lines.some((text) => text.includes(`#${pr} ${BUILDER1} scope-violation stage=scope`)),
    ).toBe(true)
    expect(data.blocked).toContainEqual(
      expect.objectContaining({
        kind: 'failed-pull',
        pr,
        labels: ['gate:failed', 'scope-violation'],
      }),
    )
    expect(item.todo).toContain(`(greeting, ${BUILDER2})`)
  })
})

describe('AC31/status: the stale warning and the stop notice', () => {
  test("with the Gate killed for longer than the stale threshold, status starts with the stale warning on the Lead's laptop and on a builder's machine; after quit it starts with the stop notice", async () => {
    const s = await scene()
    const files = gateFiles(await s.fixture.git.commonDir())
    const builder = await s.fixture.joinedClone({ name: 'builder1', login: BUILDER1 })
    await s.start()
    s.gate.clock.advance(STATUS_MS)
    await s.until(
      () => s.status()?.heartbeat_at === s.gate.clock.iso(),
      'an edit of the status issue',
    )

    /** @param {string} now */
    const onBoth = async (now) => {
      const clock = fixedClock(now)
      const laptop = await runStatus({
        cwd: s.fixture.main,
        env: s.fixture.env,
        executor: s.fake.as(LEAD),
        clock,
      })
      const machine = await runStatus({
        cwd: builder.path,
        env: s.fixture.env,
        executor: s.fake.as(BUILDER1),
        clock,
      })
      expect(laptop.code).toBe(0)
      expect(machine.code).toBe(0)
      return { laptop: laptop.lines[0], builder: machine.lines[0] }
    }

    // A killed Gate leaves the status issue and its local heartbeat as they were, without a stop
    // time: the state just before `quit`.
    const killed = {
      body: statusItem(s).body,
      heartbeat: /** @type {any} */ (await readHeartbeat(files.heartbeat)),
    }
    await s.quit()
    const quit = {
      body: statusItem(s).body,
      heartbeat: /** @type {any} */ (await readHeartbeat(files.heartbeat)),
    }
    expect(quit.heartbeat.stopped_at).not.toBeNull()
    statusItem(s).body = killed.body
    await writeHeartbeat(files.heartbeat, killed.heartbeat)
    const beat = /** @type {any} */ (s.status()).heartbeat_at
    expect(killed.heartbeat.heartbeat_at).toBe(beat)

    expect(await onBoth(after(beat, STALE_SECONDS - 1))).toEqual({
      laptop: 'gate: running, heartbeat 4m59s ago',
      builder: 'gate: running, heartbeat 4m59s ago',
    })
    const stale = `warning: the Gate's heartbeat is 5m01s old (${beat}), older than 300s, and the Lead has not stopped it: the Gate may be down, and merges wait while it is; ask the Lead to look at the Gate terminal`
    expect(await onBoth(after(beat, STALE_SECONDS + 1))).toEqual({ laptop: stale, builder: stale })

    // After `quit` the status issue and the local heartbeat carry the stop time.
    statusItem(s).body = quit.body
    await writeHeartbeat(files.heartbeat, quit.heartbeat)
    const stoppedAt = quit.heartbeat.stopped_at
    const notice = `the Lead stopped the Gate at ${stoppedAt}, 1h00m ago; merges wait until the Lead starts it again`
    expect(await onBoth(after(stoppedAt, 3600))).toEqual({ laptop: notice, builder: notice })
  })
})

import { afterEach, describe, expect, test } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatGateMarker, parseGateMarker } from '../../../src/commands/gate/comment.js'
import { parseDigestLine } from '../../../src/commands/gate/digest.js'
import {
  acquireLock,
  parseElapsed,
  processStartedAt,
  runningGate,
} from '../../../src/commands/gate/lock.js'
import { formatStatusBody } from '../../../src/commands/gate/status-issue.js'
import { rawResult } from '../../harness/index.js'
import { readJson } from './helpers.js'
import { BUILDER1, LEAD, STATUS_MS, createScene, task } from './scene.js'

/** @typedef {import('./scene.js').Scene} Scene */

/** Long enough for two Gates and their merge tests on a busy machine. */
const SLOW = 180_000

/** @type {Scene[]} */
let scenes = []

afterEach(async () => {
  await Promise.all(scenes.map((scene) => scene.cleanup()))
  scenes = []
})

/** @param {Parameters<typeof createScene>[0]} [options] */
async function scene(options) {
  const created = await createScene({ patience: 90_000, ...options })
  scenes.push(created)
  return created
}

/**
 * A pull request that adds a file on a task branch, with its CI green.
 * @param {Scene} s
 * @param {{ issue: number, file: string }} pull
 */
async function shipped(s, { issue, file }) {
  const branch = `task/${issue}-counter-work`
  const head = await s.push(branch, { files: { [file]: 'export const value = 1\n' } })
  const pr = await s.openPull({ branch, author: BUILDER1, task: issue })
  s.check(head)
  return { branch, head, pr }
}

/**
 * A script for the check of hackwin.yml that, until the file `release` exists, leaves the file
 * `started` and waits: a merge test that the test interrupts.
 * @param {string} started
 * @param {string} release
 */
function holdScript(started, release) {
  return [
    "import { existsSync, writeFileSync } from 'node:fs'",
    `if (!existsSync(${JSON.stringify(release)})) {`,
    `  writeFileSync(${JSON.stringify(started)}, String(process.pid))`,
    '  await new Promise((resolve) => {',
    `    const timer = setInterval(() => existsSync(${JSON.stringify(release)}) && (clearInterval(timer), resolve()), 20)`,
    '  })',
    '}',
    '',
  ].join('\n')
}

/**
 * Merge as GitHub does for `gh pr merge`, through the REST call that the fake answers the same
 * way, for a handler of `pr merge` that does something more.
 * @param {Scene} s
 * @param {string[]} args The arguments of `gh pr merge`.
 */
async function mergeAsGitHub(s, args) {
  const sha = args[args.indexOf('--match-head-commit') + 1]
  await s.fake.as(LEAD)(
    ['api', '--method', 'PUT', `repos/{owner}/{repo}/pulls/${args[2]}/merge`, '--input', '-'],
    { input: JSON.stringify({ sha, merge_method: 'merge' }) },
  )
  return rawResult({ code: 0, stdout: '', stderr: '' })
}

/** The Gate labels among a pull request's labels. */
const gateLabels = (/** @type {string[]} */ labels) =>
  labels.filter((label) => label.startsWith('gate:') || label === 'needs-owner').sort()

describe('AC22: a Gate killed and started again merges once and comments once', () => {
  test(
    'killed during the merge test, the restart runs the pull request from stage 1 with its head SHA and merges it once, without a comment',
    async () => {
      const hold = realpathSync(mkdtempSync(join(tmpdir(), 'hackwin-gate-hold-')))
      const started = join(hold, 'started')
      const release = join(hold, 'release')
      const s = await scene({
        issues: [task(120, 'counter')],
        files: { 'hold.mjs': holdScript(started, release) },
        configure: (hackwin) => {
          hackwin.commands.check = 'node hold.mjs'
        },
      })
      s.cleanupAlso(hold)
      const pull = await shipped(s, { issue: 120, file: 'src/features/counter/k.js' })

      const first = s.fork()
      await s.until(() => existsSync(started), 'the merge test of the first Gate')
      expect(s.state()).toMatchObject({ starts: 1, queue: [pull.pr] })
      expect(s.state().prs[String(pull.pr)]).toMatchObject({
        head_sha: pull.head,
        stage: 'merge-test',
        result: null,
      })
      await first.kill()
      // The command of the killed Gate ends once the test lets it.
      writeFileSync(release, '')

      const second = s.fork()
      await s.ended(pull.pr, 'merged')
      expect(await second.quit()).toBe(0)
      expect(second.out).toContain(
        `replaced the lock of a Gate that no longer runs (pid ${first.child.pid})`,
      )
      expect(second.out).toContain('Gate started: start 2, restart 1')
      expect(second.out).toContain(
        'removed the scratch worktree of a Gate that stopped during a run; the next merge test builds it again',
      )
      expect(s.merges()).toEqual([{ pr: pull.pr, sha: pull.head, admin: true, code: 0 }])
      expect(s.comments(pull.pr)).toEqual([])
      expect(gateLabels(s.labels(pull.pr))).toEqual(['gate:merged'])
      expect(s.digest().map(parseDigestLine)).toEqual([
        expect.objectContaining({ pr: pull.pr, result: 'merged', stage: 'after-merge' }),
      ])
      expect(s.state()).toMatchObject({ starts: 2, queue: [] })
    },
    SLOW,
  )

  test(
    'killed right after its comment, the restart fails the run again and posts no second comment',
    async () => {
      const s = await scene({
        issues: [task(122, 'counter')],
        configure: (hackwin) => {
          hackwin.commands.check = 'node -e "process.exit(1)"'
        },
      })
      const pull = await shipped(s, { issue: 122, file: 'src/features/counter/c.js' })
      /** @type {ReturnType<Scene['fork']> | null} */
      let first = null
      /** @type {Promise<void> | null} */
      let killed = null
      const remove = s.fake.on(
        'POST repos/{owner}/{repo}/issues/:number/comments',
        async ({ params, body }) => {
          remove()
          const answer = await s.fake.as(LEAD)(
            [
              'api',
              '--method',
              'POST',
              `repos/{owner}/{repo}/issues/${params.number}/comments`,
              '--input',
              '-',
            ],
            { input: JSON.stringify(body) },
          )
          // The Gate dies after GitHub took the comment and before it recorded the failure.
          killed = first?.kill() ?? null
          return rawResult(answer)
        },
      )
      first = s.fork()
      await s.until(() => killed !== null, 'the comment of the first Gate')
      await killed
      expect(s.comments(pull.pr)).toHaveLength(1)
      expect(s.state()).toMatchObject({ queue: [pull.pr] })
      expect(s.state().prs[String(pull.pr)]).toMatchObject({ result: null, failures: [] })
      expect(s.digest()).toEqual([])

      const second = s.fork()
      await s.ended(pull.pr, 'failed')
      expect(await second.quit()).toBe(0)
      const comments = s.comments(pull.pr)
      expect(comments).toHaveLength(1)
      expect(parseGateMarker(comments[0].body)).toEqual({
        pr: pull.pr,
        sha: pull.head,
        stage: 'merge-test',
        result: 'failed',
      })
      expect(second.out).toContain(
        `#${pull.pr}: the comment of this failure of head ${pull.head} at stage 7, merge test is on the pull request already, from before the Gate stopped, so it posts no second one`,
      )
      expect(gateLabels(s.labels(pull.pr))).toEqual(['gate:failed'])
      expect(s.state().prs[String(pull.pr)].failures).toEqual([
        expect.objectContaining({ stage: 'merge-test', sha: pull.head }),
      ])
      expect(s.digest().map(parseDigestLine)).toEqual([
        expect.objectContaining({ pr: pull.pr, result: 'failed', stage: 'merge-test' }),
      ])
    },
    SLOW,
  )

  test(
    'killed right after GitHub merged, the restart finishes the run after the merge and merges nothing again',
    async () => {
      const s = await scene({ issues: [task(124, 'counter')] })
      const pull = await shipped(s, { issue: 124, file: 'src/features/counter/m.js' })
      /** @type {ReturnType<Scene['fork']> | null} */
      let first = null
      /** @type {Promise<void> | null} */
      let killed = null
      const remove = s.fake.on('pr merge', async ({ args }) => {
        remove()
        const answer = await mergeAsGitHub(s, args)
        killed = first?.kill() ?? null
        return answer
      })
      first = s.fork()
      await s.until(() => killed !== null, 'the merge of the first Gate')
      await killed
      expect(/** @type {any} */ (s.fake.find(pull.pr)).pull.merged).toBe(true)
      expect(s.state().prs[String(pull.pr)]).toMatchObject({ stage: 'merge', result: null })

      const second = s.fork()
      await s.ended(pull.pr, 'merged')
      expect(await second.quit()).toBe(0)
      expect(second.out).toContain(
        `#${pull.pr}: GitHub merged head ${pull.head}, which the Gate had not recorded, so the run goes on after the merge`,
      )
      expect(s.merges()).toEqual([{ pr: pull.pr, sha: pull.head, admin: true, code: 0 }])
      expect(gateLabels(s.labels(pull.pr))).toEqual(['gate:merged'])
      expect(/** @type {any} */ (s.fake.find(124)).state).toBe('closed')
      expect(s.comments(pull.pr)).toEqual([])
      expect(s.digest().map(parseDigestLine)).toEqual([
        expect.objectContaining({ pr: pull.pr, result: 'merged' }),
      ])
    },
    SLOW,
  )
})

describe("1.6e/comments: only the Gate's own comment of the same head SHA and stage counts", () => {
  test(
    "a marker in another account's comment, or in the Lead's comment for another head SHA, does not keep the Gate from commenting",
    async () => {
      const s = await scene({
        issues: [task(126, 'counter')],
        configure: (hackwin) => {
          hackwin.commands.check = 'node -e "process.exit(1)"'
        },
      })
      const branch = 'task/126-counter-work'
      const head = await s.push(branch, {
        files: { 'src/features/counter/o.js': 'export const o = 1\n' },
      })
      const pr = await s.openPull({ branch, author: BUILDER1, task: 126 })
      const marker = (/** @type {string} */ sha) =>
        `${formatGateMarker({ pr, sha, stage: 'merge-test', result: 'failed' })}\nA copy.\n`
      await s.as(BUILDER1).createComment(pr, marker(head))
      await s.as(LEAD).createComment(pr, marker('b'.repeat(40)))
      await s.start()
      await s.ended(pr, 'failed')
      await s.quit()
      const comments = s.comments(pr)
      expect(comments).toHaveLength(3)
      expect(comments[2].author).toBe(LEAD)
      expect(parseGateMarker(comments[2].body)).toEqual({
        pr,
        sha: head,
        stage: 'merge-test',
        result: 'failed',
      })
      expect(s.out).not.toContain('is on the pull request already')
    },
    SLOW,
  )
})

/** An answer of GitHub to a read of a pull request, cut short. */
const CUT = rawResult({ code: 0, stdout: '{"number": 1, "merged": tr', stderr: '' })

describe('1.6e/merged-after-all: a run in stage 10 ends failed only when GitHub did not merge its head', () => {
  test(
    'GitHub merged, but its answer is not readable: the Gate asks again and finishes with stage 11',
    async () => {
      const s = await scene({
        issues: [
          task(128, 'counter'),
          task(129, 'counter', undefined, { dependsOn: [128], status: 'blocked' }),
        ],
      })
      const pull = await shipped(s, { issue: 128, file: 'src/features/counter/z.js' })
      let cut = 0
      const removeMerge = s.fake.on('pr merge', async ({ args }) => {
        removeMerge()
        const answer = await mergeAsGitHub(s, args)
        // The read of the pull request right after the merge gets an answer cut short.
        const removeRead = s.fake.on('GET repos/{owner}/{repo}/pulls/:number', () => {
          removeRead()
          cut += 1
          return CUT
        })
        return answer
      })
      await s.start()
      await s.ended(pull.pr, 'merged')
      await s.quit()
      expect(cut).toBe(1)
      expect(s.out).toContain(
        `#${pull.pr}: GitHub merged head ${pull.head}, which the Gate had not recorded, so the run goes on after the merge`,
      )
      expect(s.merges()).toEqual([{ pr: pull.pr, sha: pull.head, admin: true, code: 0 }])
      expect(s.comments(pull.pr)).toEqual([])
      expect(gateLabels(s.labels(pull.pr))).toEqual(['gate:merged'])
      expect(/** @type {any} */ (s.fake.find(128)).state).toBe('closed')
      expect(s.labels(129)).toContain('ready')
      expect(s.digest().map(parseDigestLine)).toEqual([
        expect.objectContaining({ pr: pull.pr, result: 'merged', stage: 'after-merge' }),
      ])
      expect(s.state().attention).toEqual([])
    },
    SLOW,
  )

  test(
    'a restart that cannot read whether GitHub merged asks once more before it gives the run up, and finishes with stage 11',
    async () => {
      const s = await scene({ issues: [task(127, 'counter')] })
      const branch = 'task/127-counter-work'
      const head = await s.push(branch, {
        files: { 'src/features/counter/y.js': 'export const y = 1\n' },
      })
      const pr = await s.openPull({ branch, author: BUILDER1, task: 127 })
      await s.start()
      await s.until(() => s.out.includes(`#${pr} passed stages 1 to 7`), 'stage 8')
      await s.quit()
      // As when the Gate stopped inside stage 10 after GitHub merged.
      const state = s.state()
      state.prs[String(pr)].stage = 'merge'
      writeFileSync(s.files.state, JSON.stringify(state))
      await mergeAsGitHub(s, ['pr', 'merge', String(pr), '--merge', '--match-head-commit', head])
      // The next two reads of the pull request, by intake and by the resume, are cut short.
      let cut = 0
      const remove = s.fake.on('GET repos/{owner}/{repo}/pulls/:number', () => {
        cut += 1
        if (cut === 2) remove()
        return CUT
      })
      await s.start()
      await s.ended(pr, 'merged')
      await s.quit()
      expect(cut).toBe(2)
      expect(s.out).toContain(
        `#${pr}: GitHub merged head ${head}, which the Gate had not recorded, so the run goes on after the merge`,
      )
      expect(s.out).not.toContain('left the queue')
      expect(s.merges()).toEqual([])
      expect(s.comments(pr)).toEqual([])
      expect(gateLabels(s.labels(pr))).toEqual(['gate:merged'])
      expect(/** @type {any} */ (s.fake.find(127)).state).toBe('closed')
      expect(s.digest().map(parseDigestLine)).toEqual([
        expect.objectContaining({ pr, result: 'merged', stage: 'after-merge' }),
      ])
    },
    SLOW,
  )
})

describe('1.6e/restart: what a start finds of a Gate that stopped', () => {
  test('the scratch worktree and half made install copies are removed', async () => {
    const s = await scene()
    const scratch = join(s.files.worktrees, 'scratch')
    mkdirSync(s.files.worktrees, { recursive: true })
    await s.fixture.git.run(['worktree', 'add', '--detach', '--quiet', scratch, 'HEAD'])
    writeFileSync(join(scratch, 'left-by-a-command.txt'), 'x\n')
    const half = join(s.files.cache, '.0123456789abcdef.0a1b2c')
    mkdirSync(join(half, 'files'), { recursive: true })

    await s.start()
    expect(s.out).toContain(
      'removed the scratch worktree of a Gate that stopped during a run; the next merge test builds it again',
    )
    expect(existsSync(scratch)).toBe(false)
    expect(existsSync(half)).toBe(false)
    const worktrees = await s.fixture.git.worktreeList()
    expect(worktrees.filter((worktree) => worktree.path.endsWith('/scratch'))).toEqual([])
    await s.quit()
  })

  test('a lock whose pid now belongs to a process that started later is replaced', async () => {
    const s = await scene()
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    })
    try {
      // As after a reboot: a running process has the pid that the lock names, but the lock says
      // its own process had started an hour earlier.
      mkdirSync(s.files.root, { recursive: true })
      writeFileSync(
        s.files.lock,
        JSON.stringify({
          schema: 1,
          pid: other.pid,
          started_at: '2026-10-24T09:00:00.000Z',
          token: 'before-the-reboot',
          process_started_by: new Date(Date.now() - 3_600_000).toISOString(),
        }),
      )
      await s.start()
      expect(s.out).toContain(`replaced the lock of a Gate that no longer runs (pid ${other.pid})`)
      expect(readJson(s.files.lock).pid).toBe(process.pid)
      await s.quit()
    } finally {
      other.kill()
    }
  })
})

describe('1.6e/lock: the lock judges a holder by its pid and when its process started', () => {
  test('the elapsed times of ps', () => {
    expect(parseElapsed('00:05')).toBe(5_000)
    expect(parseElapsed('12:34')).toBe((12 * 60 + 34) * 1000)
    expect(parseElapsed('01:02:03')).toBe((3600 + 120 + 3) * 1000)
    expect(parseElapsed('2-03:04:05')).toBe(((2 * 24 + 3) * 3600 + 4 * 60 + 5) * 1000)
    expect(parseElapsed('')).toBe(null)
    expect(parseElapsed('5 min')).toBe(null)
  })

  test('a running process holds its lock until the lock says its process started earlier', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hackwin-gate-lock-')))
    const file = join(dir, 'gate.lock')
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    })
    try {
      const pid = /** @type {number} */ (other.pid)
      const started = await processStartedAt(pid)
      expect(started).not.toBe(null)
      const window = /** @type {{ earliest: number, latest: number }} */ (started)
      expect(window.earliest).toBeLessThanOrEqual(window.latest)
      expect(window.latest).toBeLessThanOrEqual(Date.now())

      const taken = await acquireLock(file, { pid, now: new Date('2026-10-24T10:00:00.000Z') })
      expect(taken).toMatchObject({ acquired: true })
      const record = readJson(file)
      expect(Date.parse(record.process_started_by)).toBeGreaterThanOrEqual(window.earliest)
      expect(await runningGate(file)).toEqual(record)
      expect(await acquireLock(file, { pid: process.pid, now: new Date() })).toEqual({
        acquired: false,
        holder: record,
      })

      // A step of the clock: the process seems to have started 30 s after the lock's time.
      writeFileSync(
        file,
        JSON.stringify({
          ...record,
          process_started_by: new Date(window.earliest - 30_000).toISOString(),
        }),
      )
      expect(await runningGate(file)).toMatchObject({ pid })

      // The same pid with a lock of a process that had started an hour earlier: another process.
      writeFileSync(
        file,
        JSON.stringify({
          ...record,
          process_started_by: new Date(window.earliest - 3_600_000).toISOString(),
        }),
      )
      expect(await runningGate(file)).toBe(null)

      // A lock without that time, of an earlier version: the pid alone decides.
      const { process_started_by: _, ...older } = record
      writeFileSync(file, JSON.stringify(older))
      expect(await runningGate(file)).toEqual(older)
    } finally {
      other.kill()
    }
  })
})

describe('1.6e/status-guard: before each edit the Gate reads the status issue as status finds it', () => {
  /**
   * The body of the status issue as another Gate writes it.
   * @param {Scene} s
   * @param {{ heartbeat_at: string, stopped_at?: string | null }} times
   */
  function otherGateBody(s, { heartbeat_at, stopped_at = null }) {
    return formatStatusBody({
      heartbeat_at,
      stopped_at,
      starts: 1,
      gate_id: 'fedcba9876543210',
      protection: 'full-restricted',
      update_restricted: true,
      queue: [],
      attention: [],
      digest: [],
    }).body
  }

  test('another Gate writing the same issue stops this one at its next edit, which writes nothing', async () => {
    const s = await scene()
    const gate = await s.start()
    const issue = /** @type {any} */ (
      s.fake.state.items.find((item) => item.labels.includes('gate-status'))
    )
    // Another Gate, started at the same moment, writes the issue a second later.
    const body = otherGateBody(s, {
      heartbeat_at: new Date(Date.parse(gate.clock.iso()) + 1000).toISOString(),
    })
    issue.body = body
    gate.clock.advance(STATUS_MS)
    const error = await gate.done.then(
      () => null,
      (/** @type {any} */ failure) => failure,
    )
    expect(error?.exitCode).toBe(2)
    expect(error?.message).toContain(
      `another Gate is running for this project: the status issue #${issue.number} holds the heartbeat of the Gate fedcba9876543210`,
    )
    expect(gate.io.out).toContain(
      `status issue: #${issue.number} holds the heartbeat of the Gate fedcba9876543210 at`,
    )
    expect(gate.io.out).toContain(
      'so this Gate stops after the current step and writes the issue no more',
    )
    // The other Gate's body stands, without a stop time of this one.
    expect(issue.body).toBe(body)
    expect(existsSync(s.files.lock)).toBe(false)
  })

  test('an older open status issue of another live Gate stops this one; a stale one is taken over', async () => {
    const s = await scene({
      issues: [
        { number: 50, title: 'HackWin Gate status', labels: ['gate-status'], state: 'closed' },
      ],
    })
    const gate = await s.start()
    const own = /** @type {any} */ (
      s.fake.state.items.find((item) => item.labels.includes('gate-status') && item.number !== 50)
    )
    const older = /** @type {any} */ (s.fake.find(50))
    // The other Gate's issue, which this Gate's start did not find, is open with a stale
    // heartbeat: this Gate writes it from now on.
    older.state = 'open'
    older.body = otherGateBody(s, { heartbeat_at: '2026-10-24T09:00:00.000Z' })
    gate.clock.advance(STATUS_MS)
    await s.until(
      () => gate.io.out.includes('so the Gate writes it from now on instead of'),
      'the edit',
    )
    expect(gate.io.out).toContain(
      `status issue: #50 is the oldest open issue with the label gate-status, which \`status\` reads, so the Gate writes it from now on instead of #${own.number}`,
    )
    await s.until(() => s.status()?.gate_id !== 'fedcba9876543210', 'the takeover')
    expect(older.body).toContain(`heartbeat_at: "${gate.clock.iso()}"`)

    // Now the other Gate writes it again, live: this Gate stops at its next edit.
    older.body = otherGateBody(s, { heartbeat_at: gate.clock.iso() })
    gate.clock.advance(STATUS_MS)
    const error = await gate.done.then(
      () => null,
      (/** @type {any} */ failure) => failure,
    )
    expect(error?.message).toContain(
      'another Gate is running for this project: the status issue #50',
    )
  })

  test('a status issue closed by hand is opened again at the next edit, and pinned', async () => {
    const s = await scene()
    const gate = await s.start()
    const issue = /** @type {any} */ (
      s.fake.state.items.find((item) => item.labels.includes('gate-status'))
    )
    issue.state = 'closed'
    issue.pinned = false
    gate.clock.advance(STATUS_MS)
    await s.until(() => issue.state === 'open', 'the edit')
    await s.until(() => gate.io.out.includes('was closed, so the Gate opened it again'), 'the line')
    expect(gate.io.out).toContain(
      `status issue: #${issue.number} was closed, so the Gate opened it again, since \`status\` reads only open issues`,
    )
    expect(issue.pinned).toBe(true)
    expect(s.status()?.heartbeat_at).toBe(gate.clock.iso())
    await s.quit()
    expect(s.status()?.stopped_at).not.toBe(null)
  })
})

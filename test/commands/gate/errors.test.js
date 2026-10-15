import { afterEach, describe, expect, test } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MAX_COMMENT_LENGTH,
  failureComment,
  parseGateMarker,
} from '../../../src/commands/gate/comment.js'
import { parseDigestLine } from '../../../src/commands/gate/digest.js'
import { isOutage } from '../../../src/commands/gate/pulls.js'
import { PreconditionError, RemoteError } from '../../../src/core/runtime/index.js'
import { httpError, rawResult } from '../../harness/index.js'
import { isPending, readJson } from './helpers.js'
import { BUILDER1, STATUS_MS, createScene, task } from './scene.js'

/** @typedef {import('./scene.js').Scene} Scene */

/** Long enough for several runs of the merge test on a busy machine. */
const SLOW = 120_000

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
 * A pull request that adds or changes files on a task branch, with its CI green unless asked.
 * @param {Scene} s
 * @param {{ issue: number, role?: string, files: Record<string, string>, green?: boolean }} pull
 */
async function shipped(s, { issue, role = 'counter', files, green = true }) {
  const branch = `task/${issue}-${role}-work`
  const head = await s.push(branch, { files })
  const pr = await s.openPull({ branch, author: BUILDER1, task: issue })
  if (green) s.check(head)
  return { branch, head, pr }
}

describe('AC78: errors, outages, a moving main and a closed pull request', () => {
  test(
    "an unexpected error inside one pull request's run fails it with gate-error, and the next one merges",
    async () => {
      const s = await scene({ issues: [task(150, 'counter'), task(152, 'todos')] })
      const broken = await shipped(s, {
        issue: 150,
        files: { 'src/features/counter/a.js': 'export const a = 1\n' },
      })
      const next = await shipped(s, {
        issue: 152,
        role: 'todos',
        files: { 'src/features/todos/b.js': 'export const b = 1\n' },
      })
      /** @type {number[]} */
      const answered = []
      // GitHub answers stage 2's read of the first pull request with JSON cut short.
      const remove = s.fake.on('GET repos/{owner}/{repo}/pulls/:number', ({ params }) => {
        remove()
        answered.push(Number(params.number))
        return rawResult({ code: 0, stdout: `{"number": ${params.number}, "head": `, stderr: '' })
      })
      await s.start()
      await s.ended(broken.pr, 'failed')
      await s.ended(next.pr, 'merged')
      await s.quit()
      expect(answered).toEqual([broken.pr])

      const [comment] = s.comments(broken.pr)
      expect(s.comments(broken.pr)).toHaveLength(1)
      expect(parseGateMarker(comment.body)).toEqual({
        pr: broken.pr,
        sha: broken.head,
        stage: 'task-link',
        result: 'failed',
      })
      const log = `.git/hackwin/gate/logs/pr-${broken.pr}/${broken.head.slice(0, 12)}-gate-error-task-link.log`
      expect(comment.body).toContain('**HackWin Gate: failed at stage 2, task link.**')
      expect(comment.body).toContain(
        'an unexpected error of the Gate stopped the run at this stage (`gate-error`): `',
      )
      expect(comment.body).toContain(
        `The full error stays on the Lead's laptop, in the Gate's directory: \`${log}\``,
      )
      expect(readFileSync(join(s.fixture.main, log), 'utf8')).toContain('SyntaxError')
      expect(s.out).toContain(
        `#${broken.pr} stage 2, task link: an unexpected error of the Gate stopped the run (gate-error): `,
      )
      expect(s.labels(broken.pr)).toContain('gate:failed')
      const lines = s.digest().map(parseDigestLine)
      expect(lines).toEqual([
        expect.objectContaining({ pr: broken.pr, result: 'failed', stage: 'task-link' }),
        expect.objectContaining({ pr: next.pr, result: 'merged' }),
      ])
      expect(lines[0]?.note).toMatch(/^gate-error: /)
      expect(s.merges()).toEqual([{ pr: next.pr, sha: next.head, admin: true, code: 0 }])
    },
    SLOW,
  )

  test(
    'while GitHub and origin are unreachable the Gate keeps running and its local heartbeat advances; it records when GitHub last answered',
    async () => {
      const s = await scene()
      const gate = await s.start()
      await s.poll()
      const answered = gate.clock.iso()
      await s.until(() => s.state().last_github_ok_at === answered, 'the state of the poll')

      await s.reachable(false)
      for (let poll = 1; poll <= 3; poll += 1) {
        await s.poll()
        await s.until(
          () => readJson(s.files.heartbeat).heartbeat_at === gate.clock.iso(),
          'the heartbeat of the poll',
        )
        expect(readJson(s.files.heartbeat).last_github_ok_at).toBe(answered)
        await s.until(() => s.state().last_poll_at === gate.clock.iso(), 'the state of the poll')
        expect(s.state().last_github_ok_at).toBe(answered)
      }
      expect(await isPending(gate.done)).toBe(true)
      expect(s.out).toContain('poll: the fetch of origin failed, the next poll tries again')
      expect(s.out).toContain('poll: the intake failed, the next poll tries again')
      expect(s.out).toContain(
        `status issue: not written, the Gate tries again in ${STATUS_MS / 1000} s`,
      )

      await s.reachable(true)
      await s.poll()
      await s.until(() => s.state().last_github_ok_at === gate.clock.iso(), 'the next answer')
      expect(readJson(s.files.heartbeat).heartbeat_at).toBe(gate.clock.iso())
      await s.quit()
      expect(s.state().starts).toBe(1)
    },
    SLOW,
  )

  test(
    'when main moves between the merge test and the merge, stages 6 and 7 run again on the new main before the merge (G20)',
    async () => {
      const s = await scene({ issues: [task(154, 'counter')] })
      const pull = await shipped(s, {
        issue: 154,
        files: { 'src/features/counter/n.js': 'export const n = 1\n' },
        green: false,
      })
      await s.start()
      await s.until(() => s.out.includes(`#${pull.pr} passed stages 1 to 7`), 'stage 8')
      const tested = s.state().prs[String(pull.pr)].tested_main_sha
      const moved = await s.push('main', { files: { 'docs/notes.md': '# Notes\n' } })
      s.check(pull.head)
      await s.advanceUntil(() => s.digest().length > 0, 'the end of the run')
      await s.ended(pull.pr, 'merged')
      await s.quit()
      expect(s.out).toContain(
        `#${pull.pr} stage 9, freshness: main moved from ${tested} to ${moved} since the merge test, so stages 6 and 7 run again (G20)`,
      )
      const logs = join(s.files.logs, `pr-${pull.pr}`)
      for (const main of [tested, moved]) {
        expect(
          existsSync(join(logs, `${pull.head.slice(0, 12)}-on-${main.slice(0, 12)}-check.log`)),
        ).toBe(true)
      }
      expect(s.state().prs[String(pull.pr)].tested_main_sha).toBe(moved)
      expect(s.merges()).toEqual([{ pr: pull.pr, sha: pull.head, admin: true, code: 0 }])
    },
    SLOW,
  )

  test(
    'when main moves to a change that conflicts, stage 6 finds it before the merge, and nothing is merged',
    async () => {
      const s = await scene({
        issues: [task(156, 'counter')],
        files: { 'src/features/counter/count.js': 'export const count = 0\n' },
      })
      const pull = await shipped(s, {
        issue: 156,
        files: { 'src/features/counter/count.js': 'export const count = 1\n' },
        green: false,
      })
      await s.start()
      await s.until(() => s.out.includes(`#${pull.pr} passed stages 1 to 7`), 'stage 8')
      await s.push('main', {
        files: { 'src/features/counter/count.js': 'export const count = 2\n' },
      })
      s.check(pull.head)
      await s.advanceUntil(() => s.digest().length > 0, 'the end of the run')
      await s.ended(pull.pr, 'needs-owner')
      await s.quit()
      expect(s.out).toContain(`#${pull.pr} stage 9, freshness: main moved from`)
      expect(parseDigestLine(s.digest()[0])).toMatchObject({ stage: 'conflicts' })
      expect(s.merges()).toEqual([])
    },
    SLOW,
  )

  test(
    'a pull request closed without a merge during its run leaves the queue, its task returns to in-progress, and the next one merges',
    async () => {
      const s = await scene({ issues: [task(158, 'counter'), task(160, 'todos')] })
      const closed = await shipped(s, {
        issue: 158,
        files: { 'src/features/counter/c.js': 'export const c = 1\n' },
        green: false,
      })
      const next = await shipped(s, {
        issue: 160,
        role: 'todos',
        files: { 'src/features/todos/d.js': 'export const d = 1\n' },
      })
      await s.start()
      await s.until(() => s.out.includes(`#${closed.pr} passed stages 1 to 7`), 'stage 8')
      expect(s.state().queue).toEqual([closed.pr, next.pr])
      await s.as(BUILDER1).updatePullRequest(closed.pr, { state: 'closed' })
      await s.poll()
      await s.ended(next.pr, 'merged')
      await s.quit()
      expect(s.out).toContain(
        `#${closed.pr} was closed without a merge and left the queue; its task #158 is in-progress again`,
      )
      expect(s.labels(158)).toContain('in-progress')
      expect(s.labels(158)).not.toContain('in-review')
      expect(s.state().queue).toEqual([])
      expect(s.state().prs[String(closed.pr)]).toBeUndefined()
      expect(s.digest().map(parseDigestLine)).toEqual([
        expect.objectContaining({ pr: next.pr, result: 'merged' }),
      ])
    },
    SLOW,
  )
})

describe('1.6e/retry: a stage that GitHub fails runs again after waits that grow', () => {
  test(
    'stage 2 runs again after 5, 10 and 20 s, then the run goes on',
    async () => {
      const s = await scene({ issues: [task(162, 'counter')] })
      const pull = await shipped(s, {
        issue: 162,
        files: { 'src/features/counter/r.js': 'export const r = 1\n' },
      })
      let failed = 0
      const remove = s.fake.on('GET repos/{owner}/{repo}/pulls/:number', () => {
        failed += 1
        if (failed === 3) remove()
        throw httpError(502, 'Server Error')
      })
      await s.start()
      await s.advanceUntil(() => s.digest().length > 0, 'the end of the run', 5_000)
      await s.ended(pull.pr, 'merged')
      await s.quit()
      const retries = s.out
        .split('\n')
        .filter((line) =>
          line.includes(`#${pull.pr} stage 2, task link: GitHub or the network failed`),
        )
      expect(retries.map((line) => / again in (\d+) s:/.exec(line)?.[1])).toEqual(['5', '10', '20'])
      expect(s.comments(pull.pr)).toEqual([])
    },
    SLOW,
  )
})

describe('1.6e/heartbeat-gaps: a heartbeat later than gate.heartbeat_stale_seconds records a gap (M7)', () => {
  test('at a start, after the last heartbeat of the clone', async () => {
    const s = await scene()
    mkdirSync(s.files.root, { recursive: true })
    writeFileSync(
      s.files.heartbeat,
      JSON.stringify({
        schema: 1,
        pid: 1,
        heartbeat_at: '2026-10-24T09:00:00.000Z',
        last_github_ok_at: null,
        stopped_at: null,
      }),
    )
    await s.start()
    await s.quit()
    expect(s.out).toContain(
      "heartbeat gap: the last heartbeat of this clone's Gate was at 2026-10-24T09:00:00.000Z, 1h00m ago; merges waited meanwhile (M7)",
    )
    expect(s.state().heartbeat_gaps).toEqual([
      { from: '2026-10-24T09:00:00.000Z', to: '2026-10-24T10:00:00.000Z' },
    ])
  })

  test('while the Gate runs, as after the laptop slept, and not between regular polls', async () => {
    const s = await scene()
    const gate = await s.start()
    await s.poll()
    await s.poll()
    expect(s.state().heartbeat_gaps).toEqual([])
    const last = readJson(s.files.heartbeat).heartbeat_at
    gate.clock.advance(600_000)
    await s.until(() => s.state().heartbeat_gaps.length > 0, 'the gap')
    await s.quit()
    expect(s.state().heartbeat_gaps).toEqual([
      { from: last, to: new Date(Date.parse(last) + 600_000).toISOString() },
    ])
    expect(s.out).toContain(`heartbeat gap: no heartbeat from ${last} to `)
  })
})

describe('1.6e/refusals: an outage is waited out, a refusal ends the run, and every end is visible', () => {
  test('which errors are an outage', () => {
    const remote = (/** @type {number | undefined} */ status, message = 'GitHub call failed') =>
      new RemoteError(message, { status, tail: [] })
    expect(isOutage(remote(undefined))).toBe(true)
    expect(isOutage(remote(502))).toBe(true)
    expect(isOutage(remote(429))).toBe(true)
    expect(isOutage(remote(401))).toBe(true)
    expect(isOutage(remote(403, 'GitHub call failed: HTTP 403: API rate limit exceeded'))).toBe(
      true,
    )
    expect(isOutage(remote(403, 'GitHub call failed: HTTP 403: Resource not accessible'))).toBe(
      false,
    )
    expect(isOutage(remote(404))).toBe(false)
    expect(isOutage(remote(422))).toBe(false)
    const login = new PreconditionError('gh is not logged in to GitHub', {
      resolve: { command: 'gh auth login', dir: 'any directory' },
    })
    expect(isOutage(login)).toBe(true)
    expect(isOutage(new PreconditionError('the directory /x does not exist'))).toBe(false)
    expect(isOutage(new SyntaxError('Unexpected end of JSON input'))).toBe(false)
  })

  test(
    'a refusal of GitHub at a stage fails the run with gate-error and an attention item, and the next one merges',
    async () => {
      const s = await scene({ issues: [task(170, 'counter'), task(172, 'todos')] })
      const refused = await shipped(s, {
        issue: 170,
        files: { 'src/features/counter/x.js': 'export const x = 1\n' },
      })
      const next = await shipped(s, {
        issue: 172,
        role: 'todos',
        files: { 'src/features/todos/y.js': 'export const y = 1\n' },
      })
      const remove = s.fake.on('GET repos/{owner}/{repo}/pulls/:number', () => {
        remove()
        throw httpError(422, 'Validation Failed')
      })
      await s.start()
      await s.ended(refused.pr, 'failed')
      await s.ended(next.pr, 'merged')
      await s.quit()
      const [comment] = s.comments(refused.pr)
      expect(comment.body).toContain(
        'GitHub refused a call with HTTP 422, which waiting does not change, and stopped the run at this stage (`gate-error`)',
      )
      expect(s.out).toContain(
        `ATTENTION repeated-failure #${refused.pr}: stage 2, task link of #${refused.pr} failed with gate-error (`,
      )
      expect(s.out).not.toContain('runs the stage again')
      expect(s.state().attention).toEqual([
        expect.objectContaining({ pr: refused.pr, stage: 'task-link', resolved_at: null }),
      ])
      expect(parseDigestLine(s.digest()[0])?.note).toMatch(/^gate-error: /)
    },
    SLOW,
  )

  test(
    'an end that GitHub refuses still leaves the queue, with the label, a digest line and an attention item',
    async () => {
      const s = await scene({ issues: [task(174, 'todos'), task(176, 'counter')] })
      // Not a task branch: stage 2 fails, and GitHub refuses the comment.
      await s.push('feature/loose', {
        files: { 'src/features/counter/l.js': 'export const l = 1\n' },
      })
      const loose = await s.openPull({ branch: 'feature/loose', author: BUILDER1, task: 176 })
      const next = await shipped(s, {
        issue: 174,
        role: 'todos',
        files: { 'src/features/todos/n.js': 'export const n = 1\n' },
      })
      s.fake.on('POST repos/{owner}/{repo}/issues/:number/comments', () => {
        throw httpError(422, 'Validation Failed')
      })
      await s.start()
      await s.ended(next.pr, 'merged')
      await s.until(() => s.state().prs[String(loose)]?.result === 'failed', 'the end of the run')
      await s.quit()
      expect(s.comments(loose)).toEqual([])
      expect(s.labels(loose)).toContain('gate:failed')
      expect(s.labels(loose)).not.toContain('gate:testing')
      expect(s.out).toContain(
        `#${loose}: the run stopped on an error at task-link and left the queue without a comment: `,
      )
      expect(s.out).toContain(
        `ATTENTION repeated-failure #${loose}: the run of #${loose} stopped on an error at task-link and could not end through GitHub (`,
      )
      const line = s
        .digest()
        .map(parseDigestLine)
        .find((entry) => entry?.pr === loose)
      expect(line).toMatchObject({ result: 'failed', stage: 'task-link' })
      expect(line?.note).toMatch(/^abandoned: /)
      expect(s.state().queue).toEqual([])
    },
    SLOW,
  )

  test(
    'tries that go on for ten minutes raise one attention item, which closes when the stage passes',
    async () => {
      const s = await scene({ issues: [task(178, 'counter')] })
      const pull = await shipped(s, {
        issue: 178,
        files: { 'src/features/counter/t.js': 'export const t = 1\n' },
      })
      const remove = s.fake.on('GET repos/{owner}/{repo}/pulls/:number', () => {
        throw httpError(502, 'Server Error')
      })
      await s.start()
      await s.advanceUntil(
        () =>
          s.out.includes(
            `ATTENTION repeated-failure #${pull.pr}: GitHub or the network has failed`,
          ),
        'the attention item',
      )
      // The line comes before the write of the state file.
      await s.until(() => s.state().attention.length > 0, 'the item in the state file')
      expect(s.state().attention).toEqual([
        expect.objectContaining({ pr: pull.pr, stage: 'task-link', resolved_at: null }),
      ])
      remove()
      await s.advanceUntil(() => s.digest().length > 0, 'the end of the run')
      await s.ended(pull.pr, 'merged')
      await s.quit()
      expect(
        s.out
          .split('\n')
          .filter((line) => line.startsWith(`ATTENTION repeated-failure #${pull.pr}:`)),
      ).toHaveLength(1)
      expect(s.out).toContain(
        `#${pull.pr}: the repeated-failure attention item is closed: #${pull.pr} passes stage 2, task link with head ${pull.head}`,
      )
    },
    SLOW,
  )

  test('a comment stays within the length GitHub takes, whatever the log and the details hold', () => {
    const sha = 'c'.repeat(40)
    const body = failureComment({
      marker: { pr: 7, sha, stage: 'merge-test', result: 'failed' },
      title: 'stage 7, merge test',
      reason: 'the check failed',
      details: Array.from({ length: 200 }, (_, index) => `detail ${index} ${'d'.repeat(5_000)}`),
      log: {
        command: 'npm test',
        outcome: 'exit 1',
        tail: Array.from({ length: 20 }, (_, index) => `line ${index} ${'x'.repeat(100_000)}`),
        file: '.git/hackwin/gate/logs/pr-7/check.log',
      },
      next: 'fix it',
      main: 'd'.repeat(40),
    })
    expect(body.length).toBeLessThanOrEqual(MAX_COMMENT_LENGTH)
    expect(parseGateMarker(body)).toEqual({ pr: 7, sha, stage: 'merge-test', result: 'failed' })
    expect(body).toMatch(/^- and \d+ more$/m)
    expect(body).toContain('**Next action:** fix it')
    expect(body.split('\n').every((line) => line.length <= 1_200)).toBe(true)
  })
})

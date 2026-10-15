import { afterEach, describe, expect, test } from 'vitest'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BELL } from '../../../src/commands/gate/attention.js'
import { parseGateMarker } from '../../../src/commands/gate/comment.js'
import { createNotifier, notificationCommand } from '../../../src/commands/gate/notify.js'
import { emptyState, pullRecord, saveState } from '../../../src/commands/gate/state.js'
import { BUILTIN_PATTERNS } from '../../../src/core/secrets/index.js'
import { BUILDER1, LEAD, STATUS_MS, createScene, task } from './scene.js'

/** @typedef {import('./scene.js').Scene} Scene */

// Secret-shaped strings, built at run time so that no scanner flags this file itself.
/** Matches the built-in pattern `github-token`. */
const githubToken = ['ghp', 'a1B2c3D4'.repeat(5)].join('_')
/** Matches only TEAM_PATTERN, a pattern of the team's own hackwin.yml that GitHub does not know. */
const teamSecret = ['hwtest', 'q7w3e9r1t5y2u8i4o6p0a1s3'].join('_')
const TEAM_PATTERN = 'hwtest_[a-z0-9]{24}'

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
 * A pull request of builder1 for a `todos` task that adds `files`.
 * @param {Scene} s
 * @param {number} issue
 * @param {Record<string, string>} files
 */
async function todosPull(s, issue, files) {
  const branch = `task/${issue}-todos-work`
  const head = await s.push(branch, { files })
  const pr = await s.openPull({ branch, author: BUILDER1, task: issue })
  return { branch, head, pr }
}

/** The labels a Gate run sets. */
const gateLabels = (/** @type {string[]} */ labels) =>
  labels.filter((label) => label.startsWith('gate:') || label === 'needs-owner').sort()

describe('AC26: a pull request that adds a line matching a secret pattern', () => {
  test('fails at intake also behind a queued pull request, never shows the match, and its secret item stays open after a later head SHA until ack', async () => {
    const s = await scene({ issues: [task(40, 'counter'), task(42, 'todos')] })
    await s.push('task/40-counter-step', {
      files: { 'src/features/counter/step.js': 'export const step = 2\n' },
    })
    const ahead = await s.openPull({ branch: 'task/40-counter-step', author: BUILDER1, task: 40 })
    await s.start()
    await s.until(() => s.out.includes(`#${ahead} passed stages 1 to 7`), 'the pull request ahead')

    const { branch, head, pr } = await todosPull(s, 42, {
      'src/features/todos/config.js': `export const url = 'https://example.invalid'\nexport const token = '${githubToken}'\n`,
    })
    await s.poll()
    await s.ended(pr, 'failed')

    const [comment] = s.comments(pr)
    expect(parseGateMarker(comment.body)).toEqual({
      pr,
      sha: head,
      stage: 'secrets',
      result: 'failed',
    })
    expect(comment.body).toContain('failed at stage 4, secrets, at intake')
    expect(comment.body).toContain('- `src/features/todos/config.js:2: github-token`')
    expect(comment.body).not.toContain(githubToken)
    expect(gateLabels(s.labels(pr))).toEqual(['gate:failed'])
    expect(s.state().queue).toEqual([ahead])
    expect(s.state().prs[String(pr)]).toMatchObject({
      head_sha: head,
      stage: 'secrets',
      result: 'failed',
      secret_scanned_sha: head,
    })
    expect(s.out).toContain(
      `ATTENTION secret #${pr}: rotate the secret in src/features/todos/config.js:2: github-token at once, it is on a pushed branch; then type \`ack ${pr}\``,
    )
    expect(s.out).not.toContain(githubToken)
    expect(s.digest().join('\n')).not.toContain(githubToken)

    // The next edit of the status issue shows the open item.
    await s.poll()
    await s.until(
      () => s.status()?.attention.some((item) => item.type === 'secret' && item.pr === pr),
      'the secret item in the status issue',
    )

    const later = await s.push(branch, {
      files: { 'src/features/todos/config.js': "export const url = 'https://example.invalid'\n" },
    })
    await s.poll()
    await s.until(() => s.state().queue.includes(pr), 'the later head SHA in the queue')
    expect(s.state().queue).toEqual([ahead, pr])
    expect(s.state().prs[String(pr)]).toMatchObject({ head_sha: later, result: null })
    expect(gateLabels(s.labels(pr))).toEqual(['gate:queued'])
    expect(s.state().attention).toEqual([
      expect.objectContaining({ type: 'secret', pr, resolved_at: null }),
    ])

    s.type(`ack ${pr}`)
    await s.until(
      () => s.out.includes(`ack #${pr}: the secret attention item of #${pr} is closed`),
      'the ack',
    )
    s.gate.clock.advance(STATUS_MS)
    await s.until(
      () => s.status()?.attention.every((item) => item.type !== 'secret'),
      'the status issue without the secret item',
    )
    await s.quit()
    expect(s.state().attention).toEqual([
      expect.objectContaining({ type: 'secret', pr, resolved_at: expect.any(String) }),
    ])
    expect(s.comments(pr)).toHaveLength(1)
  })
})

describe('AC80/gate: the Gate blocks a secret that only a HackWin pattern knows', () => {
  test("a test secret that matches the team's pattern but no pattern GitHub recognizes is blocked", async () => {
    const s = await scene({
      issues: [task(44, 'todos')],
      configure: (hackwin) => {
        hackwin.gate.secret_patterns = [TEAM_PATTERN]
      },
    })
    expect(BUILTIN_PATTERNS.some((pattern) => pattern.regex.test(teamSecret))).toBe(false)
    const { pr } = await todosPull(s, 44, {
      'src/features/todos/key.js': `export const key = '${teamSecret}'\n`,
    })
    await s.start()
    await s.ended(pr, 'failed')
    expect(s.comments(pr)[0].body).toContain(
      '- `src/features/todos/key.js:1: gate.secret_patterns[0]`',
    )
    expect(s.comments(pr)[0].body).not.toContain(teamSecret)
    expect(gateLabels(s.labels(pr))).toEqual(['gate:failed'])
    expect(s.state().queue).toEqual([])
    expect(s.out).toContain(`ATTENTION secret #${pr}:`)
    expect(s.out).not.toContain(teamSecret)
    await s.quit()
  })
})

describe('AC79: a secret attention item raises one operating system notification', () => {
  test('at intake, once per item, and an item of another type raises none', async () => {
    const s = await scene({
      issues: [task(46, 'todos'), task(48, 'counter'), task(50, 'shared', ['db/**'])],
      configure: (hackwin) => {
        hackwin.paths.gated.migrations = ['db/migrations/**']
      },
    })
    const { branch, pr } = await todosPull(s, 46, {
      'src/features/todos/token.js': `export const t = '${githubToken}'\n`,
    })
    await s.push('task/48-counter-greeting', {
      files: { 'src/features/greeting/x.js': 'export const x = 1\n' },
    })
    const outside = await s.openPull({
      branch: 'task/48-counter-greeting',
      author: BUILDER1,
      task: 48,
    })
    await s.push('task/50-shared-migration', {
      files: { 'db/migrations/001-init.sql': 'create table t (id int);\n' },
    })
    const migration = await s.openPull({
      branch: 'task/50-shared-migration',
      author: LEAD,
      task: 50,
    })
    await s.start()
    await s.until(() => s.out.includes(`#${migration} passed stages 1 to 7`), 'the three runs')

    expect(s.notifications).toEqual([
      {
        title: `HackWin Gate: secret in #${pr}`,
        message: `rotate the secret in src/features/todos/token.js:1: github-token at once, it is on a pushed branch; then type \`ack ${pr}\``,
      },
    ])
    expect(s.out).toContain(`ATTENTION scope-violation #${outside}:`)
    expect(s.out).toContain(`ATTENTION migration #${migration}:`)
    expect(s.out).not.toContain(BELL)

    // A later head SHA with another secret finds the item still open: no second notification.
    await s.push(branch, {
      files: {
        'src/features/todos/token.js': `export const t = '${githubToken}'\nexport const u = '${githubToken}'\n`,
      },
    })
    await s.poll()
    await s.ended(pr, 'failed', 2)
    expect(s.comments(pr)).toHaveLength(2)
    expect(s.notifications).toHaveLength(1)
    await s.quit()
    expect(s.state().attention.filter((item) => item.type === 'secret')).toHaveLength(1)
  })

  test('at stage 4 for a head SHA that was not scanned yet', async () => {
    const s = await scene({ issues: [task(52, 'todos')] })
    const { head, pr } = await todosPull(s, 52, {
      'src/features/todos/token.js': `export const t = '${githubToken}'\n`,
    })
    // A state from before a restart: queued, the head not scanned yet.
    const state = emptyState()
    state.queue = [pr]
    state.prs[String(pr)] = { ...pullRecord(head, '2026-10-24T09:00:00.000Z'), stage: 'intake' }
    mkdirSync(s.files.root, { recursive: true })
    await saveState(s.files.state, state)
    await s.start()

    await s.ended(pr, 'failed')
    expect(parseGateMarker(s.comments(pr)[0].body)).toMatchObject({
      stage: 'secrets',
      result: 'failed',
    })
    expect(s.comments(pr)[0].body).toContain('failed at stage 4, secrets.')
    expect(s.notifications).toHaveLength(1)
    expect(s.notifications[0].title).toBe(`HackWin Gate: secret in #${pr}`)
    await s.quit()
    expect(s.state().prs[String(pr)]).toMatchObject({ secret_scanned_sha: head, result: 'failed' })
  })

  test('without a notification the terminal bell rings', async () => {
    const s = await scene({ issues: [task(54, 'todos')] })
    s.answerNotifications({
      shown: false,
      reason: 'Windows through WSL offers no notification command',
    })
    const { pr } = await todosPull(s, 54, {
      'src/features/todos/token.js': `export const t = '${githubToken}'\n`,
    })
    await s.start()
    await s.ended(pr, 'failed')
    expect(s.notifications).toHaveLength(1)
    expect(s.out.split(BELL)).toHaveLength(2)
    expect(s.out).toContain(
      `no operating system notification for the secret in #${pr} (Windows through WSL offers no notification command), so the terminal bell rang`,
    )
    await s.quit()
  })
})

describe('1.6c/notify: the notification command of each platform (docs/verification.md row 18)', () => {
  test('osascript on macOS, notify-send on Linux, none on Windows through WSL', () => {
    const texts = { title: 'HackWin Gate: secret in #7', message: 'rotate "it"; then `ack 7`' }
    expect(
      notificationCommand({ ...texts, platform: 'darwin', release: '25.6.0', env: {} }),
    ).toEqual({
      file: 'osascript',
      args: [
        '-e',
        'on run argv',
        '-e',
        'display notification (item 2 of argv) with title (item 1 of argv)',
        '-e',
        'end run',
        texts.title,
        texts.message,
      ],
    })
    expect(notificationCommand({ ...texts, platform: 'linux', release: '6.8.0', env: {} })).toEqual(
      {
        file: 'notify-send',
        args: ['--', texts.title, texts.message],
      },
    )
    expect(
      notificationCommand({
        ...texts,
        platform: 'linux',
        release: '5.15.153.1-microsoft-standard-WSL2',
        env: {},
      }),
    ).toEqual({ unsupported: 'Windows through WSL offers no notification command' })
    expect(
      notificationCommand({
        ...texts,
        platform: 'linux',
        release: '6.8.0',
        env: { WSL_DISTRO_NAME: 'Ubuntu' },
      }),
    ).toEqual({ unsupported: 'Windows through WSL offers no notification command' })
    expect(notificationCommand({ ...texts, platform: 'win32', release: '10', env: {} })).toEqual({
      unsupported: 'HackWin knows no notification command on win32',
    })
  })

  test('a missing command is not shown, with the reason', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'hackwin-no-path-'))
    const notify = createNotifier({ platform: 'linux', release: '6.8.0', env: { PATH: empty } })
    const notified = await notify({ title: 't', message: 'm' })
    expect(notified.shown).toBe(false)
    expect(notified.reason).toMatch(/notify-send/)
    const wsl = createNotifier({
      platform: 'linux',
      release: '6.6.36.3-microsoft-standard-WSL2',
      env: {},
    })
    expect(await wsl({ title: 't', message: 'm' })).toEqual({
      shown: false,
      reason: 'Windows through WSL offers no notification command',
    })
  })
})

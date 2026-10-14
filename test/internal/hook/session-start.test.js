import { describe, expect, test } from 'vitest'
import semver from 'semver'
import { VERSION } from '../../../src/cli/context.js'
import { createFakeClock } from '../../../src/core/runtime/clock.js'
import { readMainSeen, writeMainSeen } from '../../../src/core/state/index.js'
import { accounts, createFakeGitHub, httpError } from '../../harness/index.js'
import { runClaudeHook, sessionStart } from './claude-fixture.js'
import { createHookFixture, pinnedConfig } from './hook-fixture.js'

const builder1 = accounts.builder1.login

/**
 * builder1's worktree of task 12, the fake GitHub with that task, and a clock.
 * @param {object} [options]
 * @param {Parameters<typeof createFakeGitHub>[0]} [options.github]
 * @param {Parameters<typeof createHookFixture>[0]} [options.fixture]
 */
async function sessionScene({ github = {}, fixture = {} } = {}) {
  const hooks = await createHookFixture(fixture)
  const clone = await hooks.joinedClone('builder1')
  const task = await hooks.taskWorktree(clone, 12, 'Counter step')
  const fake = createFakeGitHub({
    issues: [{ number: 12, title: 'Counter step', labels: ['in-progress'] }],
    ...github,
  })
  const clock = createFakeClock('2026-10-20T10:00:00.000Z')
  /** @param {string} [cwd] @param {string} [login] */
  const start = (cwd = task.path, login = builder1) =>
    runClaudeHook('session-start', {
      cwd,
      env: hooks.env,
      event: sessionStart(cwd),
      fake,
      login,
      clock,
    })
  return { hooks, clone, task, fake, clock, start }
}

/** @param {{ stdout: string }} result */
const linesOf = (result) => result.stdout.trimEnd().split('\n')

describe('AC55: the session start summary', () => {
  test('lists the commits that reached main since the last session, the files of the own scope first, and records main', async () => {
    const { hooks, clone, task, clock, start } = await sessionScene()
    // `take` recorded the main commit of the worktree when it wrote the prompt.
    const taken = await clone.git.revParse('origin/main')
    await writeMainSeen(clone.commonDir, task.path, taken, '2026-10-20T09:00:00+00:00')
    const first = await hooks.fixture.publish(
      { 'src/features/greeting/hello.js': 'export const hello = 1\n' },
      { message: 'Say hello' },
    )
    const second = await hooks.fixture.publish(
      { 'src/features/counter/reset.js': 'export const reset = 0\n' },
      { message: 'Reset the counter' },
    )

    const result = await start()

    expect(result.code).toBe(0)
    expect(result.output).toBeNull()
    expect(linesOf(result)).toEqual([
      `HackWin session start for ${builder1} in ${task.path}, on task #12 (task/12-counter-step).`,
      `origin/main is at ${second.slice(0, 12)}. Commits that reached main since ${taken.slice(0, 12)}, the main commit last recorded for this worktree (2026-10-20T09:00:00+00:00):`,
      `- ${first.slice(0, 12)} Say hello`,
      `- ${second.slice(0, 12)} Reset the counter`,
      'Files these commits changed, your own scope first:',
      'In your roles (counter, todos):',
      '- A src/features/counter/reset.js',
      'Elsewhere:',
      '- A src/features/greeting/hello.js',
      `Recorded ${second.slice(0, 12)} as the main commit this worktree has seen.`,
    ])
    expect(await readMainSeen(clone.commonDir, task.path)).toEqual({
      main_sha: second,
      recorded_at: '2026-10-20T10:00:00.000Z',
    })

    clock.advance(60 * 60 * 1000)
    const again = await start()
    expect(linesOf(again)[1]).toBe(
      `origin/main is at ${second.slice(0, 12)}. No commit reached main since ${second.slice(0, 12)}, the main commit last recorded for this worktree (2026-10-20T10:00:00.000Z).`,
    )
  })
})

describe('1.4c/session-start: what the summary holds', () => {
  test('the new scope change comments on the task and the pull requests that wait for the member', async () => {
    const { clone, task, start } = await sessionScene({
      github: {
        issues: [
          {
            number: 12,
            title: 'Counter step',
            labels: ['in-progress'],
            comments: [
              { body: 'Scope change: the step is 2.', createdAt: '2026-10-20T08:00:00Z' },
              {
                body: 'Scope change: the step is 3.\n\nReason: the design changed.',
                createdAt: '2026-10-20T09:30:00Z',
              },
              { body: 'Nice progress.', createdAt: '2026-10-20T09:40:00Z' },
            ],
          },
        ],
        pulls: [
          {
            number: 20,
            title: 'Counter reset',
            head: 'task/11-counter-reset',
            headSha: 'a'.repeat(40),
            author: builder1,
            labels: ['in-review', 'gate:failed'],
          },
          {
            number: 21,
            title: 'Greeting',
            head: 'task/13-greeting',
            headSha: 'b'.repeat(40),
            author: accounts.builder2.login,
            labels: ['needs-owner'],
          },
          {
            number: 22,
            title: 'Todos',
            head: 'task/14-todos',
            headSha: 'c'.repeat(40),
            author: builder1,
            labels: ['gate:queued'],
          },
        ],
      },
    })
    const main = await clone.git.revParse('origin/main')
    await writeMainSeen(clone.commonDir, task.path, main, '2026-10-20T09:00:00+00:00')

    const result = await start()

    const lines = linesOf(result)
    expect(lines.slice(2, -1)).toEqual([
      'New scope changes on task #12, oldest first. A scope change wins over the issue text, and a later one over an earlier one:',
      `${accounts.lead.login}, 2026-10-20T09:30:00Z:`,
      '> Scope change: the step is 3.',
      '>',
      '> Reason: the design changed.',
      'Your pull requests that wait for you:',
      "- PR #20 Counter reset: gate:failed; read the Gate's comment on https://github.com/hackwin-test/app/pull/20",
    ])
  })

  test('the first session start in a clone says that no main commit was recorded, and records one', async () => {
    const { clone, task, start } = await sessionScene()
    const main = await clone.git.revParse('origin/main')

    const result = await start()

    expect(linesOf(result)).toEqual([
      `HackWin session start for ${builder1} in ${task.path}, on task #12 (task/12-counter-step).`,
      `origin/main is at ${main.slice(0, 12)}. No main commit was recorded in this clone before, so there is no list of the commits that reached main; the next session start lists the commits after this one.`,
      `Recorded ${main.slice(0, 12)} as the main commit this worktree has seen.`,
    ])
    expect((await readMainSeen(clone.commonDir, task.path))?.main_sha).toBe(main)
  })

  test('a worktree without a record starts from the commit last recorded anywhere in the clone', async () => {
    const { hooks, clone, start } = await sessionScene({
      github: { issues: [{ number: 13, title: 'Todos', labels: ['in-progress'] }] },
    })
    const before = await clone.git.revParse('origin/main')
    await writeMainSeen(clone.commonDir, clone.path, before, '2026-10-20T09:00:00+00:00')
    const added = await hooks.fixture.publish({ 'docs/plan.md': '# Plan\n' }, { message: 'Plan' })

    const result = await start(clone.path)

    expect(linesOf(result).slice(1, 6)).toEqual([
      `origin/main is at ${added.slice(0, 12)}. Commits that reached main since ${before.slice(0, 12)}, the main commit last recorded for this worktree (2026-10-20T09:00:00+00:00):`,
      `- ${added.slice(0, 12)} Plan`,
      'Files these commits changed, your own scope first:',
      'Elsewhere:',
      '- A docs/plan.md',
    ])
    const fresh = await hooks.taskWorktree(clone, 13, 'Todos')
    const other = await start(fresh.path)
    expect(linesOf(other)[1]).toBe(
      `origin/main is at ${added.slice(0, 12)}. No commit reached main since ${added.slice(0, 12)}, the main commit last recorded in this clone (2026-10-20T10:00:00.000Z).`,
    )
  })

  test('in the main checkout it fast-forwards main to origin/main (CM10)', async () => {
    const { hooks, clone, start } = await sessionScene()
    const added = await hooks.fixture.publish({ 'docs/plan.md': '# Plan\n' }, { message: 'Plan' })

    const result = await start(clone.path)

    expect(result.code).toBe(0)
    expect(linesOf(result)).toContain('The main checkout was fast-forwarded to origin/main.')
    expect(await clone.git.revParse('HEAD')).toBe(added)
  })

  test('a failed fetch or GitHub call is named, and the summary continues with what the clone has', async () => {
    const { clone, task, fake, start } = await sessionScene()
    await clone.git.run(['remote', 'set-url', 'origin', `${clone.path}-missing.git`])
    fake.on('GET repos/{owner}/{repo}/pulls', () => {
      throw httpError(502, 'Bad Gateway')
    })

    const result = await start()

    expect(result.code).toBe(0)
    const lines = linesOf(result)
    expect(lines[1]).toMatch(
      /^git fetch origin failed.*; this summary uses origin as this clone last fetched it\.$/,
    )
    expect(lines).toContain(
      'The pull requests that wait for you could not be read: GitHub call failed: gh api --method GET repos/{owner}/{repo}/pulls?state=open&per_page=100&page=1: gh: Bad Gateway (HTTP 502)',
    )
    expect(lines.at(-1)).toMatch(
      /^Recorded [0-9a-f]{12} as the main commit this worktree has seen\.$/,
    )
    expect(await readMainSeen(clone.commonDir, task.path)).not.toBeNull()
  })

  test('a summary that would be too long for the context stays below 10,000 characters and says where the rest is', async () => {
    const long = (text) => `${text} ${'and a long explanation '.repeat(20)}`.trim()
    const { hooks, clone, task, start } = await sessionScene({
      github: {
        issues: [
          {
            number: 12,
            title: 'Counter step',
            labels: ['in-progress'],
            comments: Array.from({ length: 30 }, (_, n) => ({
              body: `Scope change: number ${n + 1}.\n\n${long('Reason:')}\n${long('Detail:')}`,
              createdAt: `2026-10-20T09:${String(10 + n).padStart(2, '0')}:00Z`,
            })),
          },
        ],
        pulls: Array.from({ length: 40 }, (_, n) => ({
          number: 100 + n,
          title: long(`Pull request ${n}`),
          head: `task/${200 + n}-other`,
          headSha: 'a'.repeat(40),
          author: builder1,
          labels: ['gate:failed'],
        })),
      },
    })
    const taken = await clone.git.revParse('origin/main')
    await writeMainSeen(clone.commonDir, task.path, taken, '2026-10-20T09:00:00+00:00')
    // 150 commits with long subjects and 150 files reach main.
    const bulk = await hooks.fixture.clone('bulk')
    for (let n = 0; n < 150; n += 1) {
      await bulk.git.run(['commit', '--quiet', '--allow-empty', '-m', long(`Commit ${n}`)])
    }
    await hooks.fixture.commit('Many files', {
      dir: bulk.path,
      files: Object.fromEntries(
        Array.from({ length: 150 }, (_, n) => [`src/features/counter/file-${n}.js`, `${n}\n`]),
      ),
    })
    await bulk.git.push({ refspecs: ['HEAD:refs/heads/main'] })
    const head = await bulk.git.revParse('HEAD')

    const result = await start()

    expect(result.code).toBe(0)
    expect(result.stdout.length).toBeLessThanOrEqual(9000)
    const lines = linesOf(result)
    const range = `${taken.slice(0, 12)}..${head.slice(0, 12)}`
    expect(lines).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^- and \\d+ more; to see them, run \`git log --first-parent --oneline ${range}\` in ${task.path}$`,
        ),
      ),
    )
    expect(lines).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^- and \\d+ more files; to see them, run \`git diff --name-status ${range}\` in ${task.path}$`,
        ),
      ),
    )
    expect(lines).toContain(
      `Not every scope change is shown in full here; to read them all, run \`gh issue view 12 --comments\` in ${task.path}.`,
    )
    // The newest scope change is kept whole; the oldest gives way.
    expect(lines).toContain('> Scope change: number 30.')
    expect(lines).not.toContain('> Scope change: number 1.')
    expect(lines).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^- and \\d+ more; to see them, run \`gh pr list --author ${builder1} --state open\` in ${task.path}$`,
        ),
      ),
    )
    expect(lines.at(-1)).toBe(
      `Recorded ${head.slice(0, 12)} as the main commit this worktree has seen.`,
    )
  })

  test('without the join record it exits 2 and names hackwin join', async () => {
    const { hooks, fake } = await sessionScene()
    const { path } = await hooks.fixture.clone('not-joined')

    const result = await runClaudeHook('session-start', {
      cwd: path,
      env: hooks.env,
      event: sessionStart(path),
      fake,
    })

    expect(result.code).toBe(2)
    expect(result.stderr).toContain(`to resolve: run \`hackwin join\` in ${path}`)
  })

  test('CM12: a CLI older than the version pinned on origin/main exits 2 with the install command', async () => {
    const running = semver.parse(VERSION)
    const newer = `${running?.major}.${running?.minor}.${(running?.patch ?? 0) + 1}`
    const { start } = await sessionScene({ fixture: { config: pinnedConfig(newer) } })

    const result = await start()

    expect(result.code).toBe(2)
    expect(result.stderr).toContain(`to resolve: run \`npm install -g hackwin@${newer}\``)
  })
})

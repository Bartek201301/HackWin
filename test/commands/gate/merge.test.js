import { afterEach, describe, expect, test } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseGateMarker } from '../../../src/commands/gate/comment.js'
import { parseDigestLine } from '../../../src/commands/gate/digest.js'
import { deletableBranch } from '../../../src/commands/gate/merge.js'
import { quoteShellArg } from '../../../src/core/runtime/index.js'
import { ONE_APPROVAL } from '../../core/protection/rulesets.js'
import { httpError, rawResult } from '../../harness/index.js'
import { fixedClock, runStatus } from '../status/helpers.js'
import { BUILDER1, BUILDER2, LEAD, createScene, task } from './scene.js'

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
 * @param {{ issue: number, role: string, author: string, files: Record<string, string>, green?: boolean }} pull
 */
async function shipped(s, { issue, role, author, files, green = true }) {
  const branch = `task/${issue}-${role}-work`
  const head = await s.push(branch, { files })
  const pr = await s.openPull({ branch, author, task: issue })
  if (green) s.check(head)
  return { branch, head, pr }
}

/** The Gate labels among a pull request's labels. */
const gateLabels = (/** @type {string[]} */ labels) =>
  labels.filter((label) => label.startsWith('gate:') || label === 'needs-owner').sort()

/**
 * Git in the origin of a scene.
 * @param {Scene} s
 * @param {string[]} args
 */
function originGit(s, args) {
  return execFileSync('git', args, { cwd: s.fixture.origin, env: s.fixture.env, encoding: 'utf8' })
}

/** The first-parent history of main on the origin, newest first. */
function mainHistory(/** @type {Scene} */ s) {
  return originGit(s, ['rev-list', '--first-parent', 'main']).trim().split('\n')
}

describe('AC23: two pull requests that are ready at the same time', () => {
  test(
    'merge one after the other, and the second was tested on the merge commit of the first',
    async () => {
      const s = await scene({ issues: [task(110, 'counter'), task(112, 'todos')] })
      const before = mainHistory(s)
      const start = before[0]
      const first = await shipped(s, {
        issue: 110,
        role: 'counter',
        author: BUILDER1,
        files: { 'src/features/counter/a.js': 'export const a = 1\n' },
      })
      const second = await shipped(s, {
        issue: 112,
        role: 'todos',
        author: BUILDER1,
        files: { 'src/features/todos/b.js': 'export const b = 2\n' },
      })
      await s.start()
      await s.ended(first.pr, 'merged')
      await s.ended(second.pr, 'merged')
      await s.quit()

      const firstMerge = /** @type {any} */ (s.fake.find(first.pr)).pull.mergeCommitSha
      const secondMerge = /** @type {any} */ (s.fake.find(second.pr)).pull.mergeCommitSha
      const state = s.state()
      expect(state.prs[String(first.pr)].tested_main_sha).toBe(start)
      expect(state.prs[String(second.pr)].tested_main_sha).toBe(firstMerge)
      expect(mainHistory(s)).toEqual([secondMerge, firstMerge, ...before])
      expect(s.merges()).toEqual([
        { pr: first.pr, sha: first.head, admin: true, code: 0 },
        { pr: second.pr, sha: second.head, admin: true, code: 0 },
      ])
      expect(s.digest().map(parseDigestLine)).toEqual([
        expect.objectContaining({ pr: first.pr, result: 'merged', stage: 'after-merge' }),
        expect.objectContaining({ pr: second.pr, result: 'merged', stage: 'after-merge' }),
      ])
      expect(state.queue).toEqual([])
      for (const { pr, branch } of [first, second]) {
        expect(gateLabels(s.labels(pr))).toEqual(['gate:merged'])
        expect(s.comments(pr)).toEqual([])
        expect(originGit(s, ['branch', '--list', branch])).toBe('')
      }
      for (const issue of [110, 112]) {
        expect(/** @type {any} */ (s.fake.find(issue)).state).toBe('closed')
      }
    },
    SLOW,
  )
})

/** A check that imports every module under `src/` and calls its `check` export. */
const CHECK_SCRIPT = `import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const files = []
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path)
    else if (path.endsWith('.js')) files.push(path)
  }
}
walk('src')
for (const file of files) {
  const module = await import(pathToFileURL(file).href)
  if (typeof module.check === 'function') module.check()
}
console.log('checked ' + files.length + ' modules')
`

describe('AC24: a semantic conflict between two pull requests that are green alone', () => {
  test(
    'the Gate merges the rename and fails the call of the old name at stage 7, and the check passes on every commit of main',
    async () => {
      const s = await scene({
        issues: [task(120, 'counter'), task(122, 'greeting')],
        files: {
          'check.mjs': CHECK_SCRIPT,
          'src/features/counter/count.js': 'export function count(n) {\n  return n + 1\n}\n',
        },
        configure: (hackwin) => {
          hackwin.commands.check = 'node check.mjs'
        },
      })
      const before = originGit(s, ['rev-list', 'main']).trim().split('\n')
      const rename = await shipped(s, {
        issue: 120,
        role: 'counter',
        author: BUILDER1,
        files: {
          'src/features/counter/count.js': 'export function tally(n) {\n  return n + 1\n}\n',
        },
      })
      const caller = await shipped(s, {
        issue: 122,
        role: 'greeting',
        author: BUILDER2,
        files: {
          'src/features/greeting/hello.js': [
            "import { count } from '../counter/count.js'",
            '',
            'export function check() {',
            "  if (count(1) !== 2) throw new Error('count is wrong')",
            '}',
            '',
          ].join('\n'),
        },
      })
      await s.start()
      await s.ended(rename.pr, 'merged')
      await s.ended(caller.pr, 'failed')
      await s.quit()

      const [comment] = s.comments(caller.pr)
      expect(s.comments(caller.pr)).toHaveLength(1)
      expect(parseGateMarker(comment.body)).toEqual({
        pr: caller.pr,
        sha: caller.head,
        stage: 'merge-test',
        result: 'failed',
      })
      const merge = /** @type {any} */ (s.fake.find(rename.pr)).pull.mergeCommitSha
      expect(comment.body).toContain('**HackWin Gate: failed at stage 7, merge test.**')
      expect(comment.body).toContain(
        `the check failed on the merge of the head with main \`${merge}\``,
      )
      expect(comment.body).toContain('**Command:** `node check.mjs`, exit 1.')
      expect(comment.body).toContain("does not provide an export named 'count'")
      expect(comment.body).toMatch(
        /The full log stays on the Lead's laptop, in the Gate's directory: `\.git\/hackwin\/gate\/logs\/pr-\d+\/[0-9a-f]{12}-on-[0-9a-f]{12}-check\.log`\./,
      )
      expect(comment.body).toContain('the author asks the Lead for a task for that role (I14)')
      expect(gateLabels(s.labels(caller.pr))).toEqual(['gate:failed'])
      expect(s.merges().map((call) => call.pr)).toEqual([rename.pr])
      expect(parseDigestLine(s.digest()[1])).toMatchObject({
        pr: caller.pr,
        result: 'failed',
        stage: 'merge-test',
        note: 'merge test: check failed',
      })

      // `commands.check` passes on every commit of main.
      const commits = originGit(s, ['rev-list', 'main']).trim().split('\n')
      // The rename's commit and its merge commit joined main; the call of the old name did not.
      expect(commits).toHaveLength(before.length + 2)
      const dir = mkdtempSync(join(tmpdir(), 'hackwin-ac24-'))
      try {
        for (const [index, commit] of commits.entries()) {
          const tree = join(dir, String(index))
          originGit(s, ['worktree', 'add', '--detach', '--quiet', tree, commit])
          expect(execFileSync('node', ['check.mjs'], { cwd: tree, encoding: 'utf8' })).toMatch(
            /^checked \d+ modules/,
          )
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    SLOW,
  )
})

describe('AC27: drafts, pushes during a run, and the pinned merge', () => {
  test(
    'a draft is ignored and is queued and merged once it is marked ready',
    async () => {
      const s = await scene({ issues: [task(130, 'counter')] })
      const branch = 'task/130-counter-work'
      const head = await s.push(branch, {
        files: { 'src/features/counter/d.js': 'export const d = 1\n' },
      })
      const pr = await s.openPull({ branch, author: BUILDER1, task: 130, draft: true })
      s.check(head)
      await s.start()
      await s.poll()
      expect(s.state().queue).toEqual([])
      expect(s.state().prs[String(pr)]).toBeUndefined()
      expect(s.labels(pr)).toEqual([])
      expect(s.merges()).toEqual([])

      const ready = /** @type {any} */ (s.fake.find(pr)).pull
      ready.draft = false
      await s.poll()
      await s.ended(pr, 'merged')
      await s.quit()
      expect(s.merges()).toEqual([{ pr, sha: head, admin: true, code: 0 }])
    },
    SLOW,
  )

  test(
    'a push during the merge test ends the run, the new head SHA joins the back of the queue, and only tested heads are merged',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hackwin-ac27-'))
      const started = join(dir, 'started')
      const release = join(dir, 'release')
      // The first check holds until the test releases it; every later one passes at once.
      const hold = `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(started)}, ''); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) clearInterval(timer) }, 10)`
      const s = await scene({
        issues: [task(132, 'counter'), task(134, 'todos')],
        configure: (hackwin) => {
          hackwin.commands.check = `node -e ${quoteShellArg(hold)}`
        },
      })
      s.cleanupAlso(dir)
      const moving = await shipped(s, {
        issue: 132,
        role: 'counter',
        author: BUILDER1,
        files: { 'src/features/counter/m.js': 'export const m = 1\n' },
      })
      const behind = await shipped(s, {
        issue: 134,
        role: 'todos',
        author: BUILDER1,
        files: { 'src/features/todos/t.js': 'export const t = 1\n' },
      })
      await s.start()
      await s.until(() => existsSync(started), 'the merge test of the first head')
      const second = await s.push(moving.branch, {
        files: { 'src/features/counter/m.js': 'export const m = 2\n' },
      })
      s.check(second)
      try {
        await s.poll()
        await s.until(() => s.state().queue[0] === behind.pr, 'the new head at the back')
      } finally {
        writeFileSync(release, '')
      }
      expect(s.state().queue).toEqual([behind.pr, moving.pr])

      await s.ended(behind.pr, 'merged')
      await s.ended(moving.pr, 'merged')
      await s.quit()
      const lines = s.digest().map(parseDigestLine)
      expect(lines.map((line) => [line?.pr, line?.result])).toEqual([
        [moving.pr, 'requeued'],
        [behind.pr, 'merged'],
        [moving.pr, 'merged'],
      ])
      expect(lines[0]).toMatchObject({
        stage: 'merge-test',
        note: `the new head ${second} joined the back of the queue`,
      })
      expect(s.merges()).toEqual([
        { pr: behind.pr, sha: behind.head, admin: true, code: 0 },
        { pr: moving.pr, sha: second, admin: true, code: 0 },
      ])
      expect(/** @type {any} */ (s.fake.find(moving.pr)).pull.headSha).toBe(second)
      expect(s.comments(moving.pr)).toEqual([])
    },
    SLOW,
  )

  test(
    'a push between the tests and the merge: GitHub refuses the pinned merge, and the new head is tested before it is merged',
    async () => {
      const s = await scene({ issues: [task(136, 'counter')] })
      const first = await shipped(s, {
        issue: 136,
        role: 'counter',
        author: BUILDER1,
        files: { 'src/features/counter/p.js': 'export const p = 1\n' },
      })
      /** @type {string | null} */
      let second = null
      // The author pushes while the Gate merges, and GitHub answers as it does for a moved head.
      const remove = s.fake.on('pr merge', async () => {
        remove()
        second = await s.push(first.branch, {
          files: { 'src/features/counter/p.js': 'export const p = 2\n' },
        })
        s.check(second)
        return rawResult({
          code: 1,
          stdout: '',
          stderr:
            'GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)\n',
        })
      })
      await s.start()
      await s.until(() => s.digest().length === 1, 'the first run')
      expect(parseDigestLine(s.digest()[0])).toMatchObject({
        pr: first.pr,
        result: 'requeued',
        stage: 'merge',
        note: `the new head ${second} joined the back of the queue`,
      })
      expect(s.out).toContain(
        `#${first.pr} stage 10, merge: the head moved from ${first.head} to ${second} after the merge test, so GitHub did not merge it; the new head joins the back of the queue`,
      )
      await s.poll()
      await s.ended(first.pr, 'merged')
      await s.quit()
      expect(s.merges()).toEqual([
        { pr: first.pr, sha: first.head, admin: true, code: 1 },
        { pr: first.pr, sha: second, admin: true, code: 0 },
      ])
      expect(s.state().prs[String(first.pr)]).toMatchObject({ head_sha: second, result: 'merged' })
      expect(s.comments(first.pr)).toEqual([])
    },
    SLOW,
  )
})

describe('AC29: gated paths in version 1', () => {
  /** @param {any} hackwin */
  const migrations = (hackwin) => {
    hackwin.paths.gated.migrations = ['db/migrations/**']
  }
  const sql = { 'db/migrations/001_add_score.sql': 'ALTER TABLE scores ADD COLUMN bonus int;\n' }

  test(
    'a pull request of the Lead that touches a migration raises a migration attention line, is tested and merged like any other, and the item closes with the merge',
    async () => {
      const s = await scene({ issues: [task(140, 'shared', ['db/**'])], configure: migrations })
      const lead = await shipped(s, { issue: 140, role: 'shared', author: LEAD, files: sql })
      await s.start()
      await s.ended(lead.pr, 'merged')
      await s.quit()
      expect(s.out).toContain(
        `ATTENTION migration #${lead.pr}: review the migration in db/migrations/001_add_score.sql`,
      )
      expect(s.out).toContain(
        `#${lead.pr}: the migration attention item is closed: the pull request is merged`,
      )
      expect(s.state().prs[String(lead.pr)]).toMatchObject({
        gated: ['migration'],
        result: 'merged',
      })
      expect(s.state().attention).toEqual([
        expect.objectContaining({
          type: 'migration',
          pr: lead.pr,
          resolved_at: expect.any(String),
        }),
      ])
      expect(s.status()?.attention).toEqual([])
      expect(s.merges()).toEqual([{ pr: lead.pr, sha: lead.head, admin: true, code: 0 }])
    },
    SLOW,
  )

  test(
    "the same change in a builder's pull request fails with scope-violation",
    async () => {
      const s = await scene({ issues: [task(142, 'counter')], configure: migrations })
      const builder = await shipped(s, {
        issue: 142,
        role: 'counter',
        author: BUILDER1,
        files: sql,
      })
      await s.start()
      await s.ended(builder.pr, 'scope-violation')
      await s.quit()
      expect(s.comments(builder.pr)[0].body).toContain(
        '`db/migrations/001_add_score.sql`: role `shared`, held by',
      )
      expect(s.merges()).toEqual([])
    },
    SLOW,
  )

  test('while paths.gated is empty, the header says that no such attention line can be raised', async () => {
    const s = await scene()
    await s.start()
    await s.quit()
    expect(s.out).toContain(
      'notice: the Gate cannot ask you to review a migration or a production config change, because paths.gated in hackwin.yml is empty; if the project has such files, add their globs to paths.gated in a task of the shared role; if it has none, nothing needs doing',
    )
  })
})

describe('1.6d/freshness: main moved after the merge test', () => {
  test(
    'stages 6 and 7 run again on the new main before the merge (G20)',
    async () => {
      const s = await scene({ issues: [task(150, 'counter')] })
      const pull = await shipped(s, {
        issue: 150,
        role: 'counter',
        author: BUILDER1,
        files: { 'src/features/counter/f.js': 'export const f = 1\n' },
        green: false,
      })
      await s.start()
      await s.until(() => s.out.includes(`#${pull.pr} passed stages 1 to 7`), 'stage 8')
      const tested = s.state().prs[String(pull.pr)].tested_main_sha
      // A commit reaches main outside the Gate while the run waits for CI.
      const moved = await s.push('main', { files: { 'docs/notes.md': '# Notes\n' } })
      s.check(pull.head)
      await s.advanceUntil(() => s.digest().length > 0, 'the end of the run')
      await s.quit()
      expect(s.out).toContain(
        `#${pull.pr} stage 9, freshness: main moved from ${tested} to ${moved} since the merge test, so stages 6 and 7 run again (G20)`,
      )
      expect(parseDigestLine(s.digest()[0])).toMatchObject({ pr: pull.pr, result: 'merged' })
      expect(s.state().prs[String(pull.pr)].tested_main_sha).toBe(moved)
      const merge = /** @type {any} */ (s.fake.find(pull.pr)).pull.mergeCommitSha
      expect(mainHistory(s).slice(0, 2)).toEqual([merge, moved])
    },
    SLOW,
  )
})

describe('1.6d/merge: the pinned merge and what follows it', () => {
  test(
    'without the update restriction the Gate merges without --admin, closes the task and readies its dependents',
    async () => {
      const s = await scene({
        issues: [
          task(160, 'counter'),
          task(162, 'counter', undefined, { dependsOn: [160], status: 'blocked' }),
          task(164, 'todos', undefined, { dependsOn: [160, 166], status: 'blocked' }),
          task(166, 'todos', undefined, { status: 'ready' }),
        ],
      })
      // Only the rules for everyone: the protection state is full.
      s.fake.state.rulesets = s.fake.state.rulesets.filter(
        (ruleset) => ruleset.name !== 'hackwin-update-restriction',
      )
      const pull = await shipped(s, {
        issue: 160,
        role: 'counter',
        author: BUILDER1,
        files: { 'src/features/counter/n.js': 'export const n = 1\n' },
      })
      await s.start()
      await s.ended(pull.pr, 'merged')
      await s.quit()
      expect(s.merges()).toEqual([{ pr: pull.pr, sha: pull.head, admin: false, code: 0 }])
      expect(s.out).not.toContain('BLOCKED')
      expect(/** @type {any} */ (s.fake.find(160)).state).toBe('closed')
      expect(s.labels(162)).toContain('ready')
      expect(s.labels(162)).not.toContain('blocked')
      expect(s.labels(164)).toContain('blocked')
      expect(s.out).toContain(`#${pull.pr} the task #162, which depended on #160, is ready`)
    },
    SLOW,
  )

  test(
    'a refusal for another reason than a moved head fails the run with merge-refused',
    async () => {
      const s = await scene({ issues: [task(170, 'counter')] })
      const pull = await shipped(s, {
        issue: 170,
        role: 'counter',
        author: BUILDER1,
        files: { 'src/features/counter/r.js': 'export const r = 1\n' },
      })
      s.fake.on('pr merge', () =>
        rawResult({
          code: 1,
          stdout: '',
          stderr:
            'GraphQL: Repository rule violations found\n\nRequired status check "hackwin" is expected.\n (mergePullRequest)\n',
        }),
      )
      await s.start()
      await s.ended(pull.pr, 'failed')
      await s.quit()
      const [comment] = s.comments(pull.pr)
      expect(parseGateMarker(comment.body)).toMatchObject({ stage: 'merge', result: 'failed' })
      expect(comment.body).toContain(
        `GitHub refused the merge of head \`${pull.head}\` with \`--admin\` (\`merge-refused\`). It answered:`,
      )
      expect(comment.body).toContain('- `Required status check "hackwin" is expected.`')
      expect(parseDigestLine(s.digest()[0])).toMatchObject({ note: 'merge-refused' })
      expect(s.state().attention).toEqual([])
    },
    SLOW,
  )

  test(
    'under the update restriction the Gate does not merge while the Lead can bypass another rule',
    async () => {
      const s = await scene({ issues: [task(172, 'counter')] })
      await s.start()
      // After the start, a rule that the Lead's account can bypass joins the update restriction.
      const restriction = /** @type {any} */ (
        s.fake.state.rulesets.find((ruleset) => ruleset.name === 'hackwin-update-restriction')
      )
      restriction.rules.push(ONE_APPROVAL)
      const pull = await shipped(s, {
        issue: 172,
        role: 'counter',
        author: BUILDER1,
        files: { 'src/features/counter/b.js': 'export const b = 1\n' },
      })
      await s.poll()
      await s.ended(pull.pr, 'failed')
      await s.quit()
      expect(s.merges()).toEqual([])
      expect(s.comments(pull.pr)[0].body).toContain(
        '- `pull_request` of the rule set `hackwin-update-restriction`',
      )
      expect(s.out).toContain(
        `ATTENTION repeated-failure #${pull.pr}: the Gate merges nothing while the Lead's account can bypass \`pull_request\` of the rule set \`hackwin-update-restriction\``,
      )
      expect(parseDigestLine(s.digest()[0])).toMatchObject({
        stage: 'merge',
        note: 'merge-refused: rules the Lead can bypass',
      })
    },
    SLOW,
  )

  test(
    'quit during the merge stops before stage 11, and the next start finishes the run without a second merge',
    async () => {
      const s = await scene({ issues: [task(174, 'counter')] })
      const pull = await shipped(s, {
        issue: 174,
        role: 'counter',
        author: BUILDER1,
        files: { 'src/features/counter/q.js': 'export const q = 1\n' },
      })
      /** @type {() => void} */
      let release = () => {}
      const released = new Promise((resolve) => (release = () => resolve(null)))
      let held = 0
      const remove = s.fake.on('pr merge', async ({ args }) => {
        held += 1
        await released
        remove()
        // The merge itself, through the REST call that the fake answers as gh's merge.
        const sha = args[args.indexOf('--match-head-commit') + 1]
        await s.fake.as(LEAD)(
          ['api', '--method', 'PUT', `repos/{owner}/{repo}/pulls/${args[2]}/merge`, '--input', '-'],
          { input: JSON.stringify({ sha, merge_method: 'merge' }) },
        )
        return rawResult({ code: 0, stdout: '', stderr: '' })
      })
      await s.start()
      await s.until(() => held === 1, 'the merge')
      s.type('quit')
      await s.until(() => s.out.includes('quit: the Gate stops after the current step'), 'quit')
      release()
      await s.quit()
      expect(s.state()).toMatchObject({ queue: [pull.pr] })
      expect(s.state().prs[String(pull.pr)]).toMatchObject({ result: 'merged', stage: 'merge' })
      expect(s.digest()).toEqual([])
      expect(gateLabels(s.labels(pull.pr))).toEqual(['gate:waiting-ci'])

      await s.start()
      await s.ended(pull.pr, 'merged')
      await s.quit()
      expect(s.merges()).toEqual([{ pr: pull.pr, sha: pull.head, admin: true, code: 0 }])
      expect(s.state().queue).toEqual([])
      expect(gateLabels(s.labels(pull.pr))).toEqual(['gate:merged'])
      expect(s.comments(pull.pr)).toEqual([])
    },
    SLOW,
  )
})

describe('1.6d/smoke: the smoke test after a merge', () => {
  test(
    'a failed smoke test raises a repeated failure item, which closes when the smoke test passes after a later merge',
    async () => {
      const s = await scene({
        issues: [task(180, 'counter'), task(182, 'counter')],
        files: {
          'smoke.mjs':
            "import { existsSync } from 'node:fs'\nif (existsSync('src/features/counter/broken.js')) { console.error('the counter is broken'); process.exit(1) }\n",
        },
        configure: (hackwin) => {
          hackwin.commands.smoke = 'node smoke.mjs'
        },
      })
      const breaking = await shipped(s, {
        issue: 180,
        role: 'counter',
        author: BUILDER1,
        files: { 'src/features/counter/broken.js': 'export const broken = true\n' },
      })
      await s.start()
      await s.ended(breaking.pr, 'merged')
      await s.until(() => s.state().last_smoke.result === 'failed', 'the smoke test')
      const broken = /** @type {any} */ (s.fake.find(breaking.pr)).pull.mergeCommitSha
      expect(s.state().last_smoke).toEqual({ main_sha: broken, result: 'failed' })
      expect(s.out).toContain(
        `ATTENTION repeated-failure #${breaking.pr}: the smoke test \`node smoke.mjs\` failed on main ${broken.slice(0, 12)} after the merge of #${breaking.pr}`,
      )

      const branch = 'task/182-counter-fix'
      const head = await s.push(branch, { remove: ['src/features/counter/broken.js'] })
      const fix = await s.openPull({ branch, author: BUILDER1, task: 182 })
      s.check(head)
      await s.poll()
      await s.ended(fix, 'merged')
      await s.until(() => s.state().last_smoke.result === 'passed', 'the second smoke test')
      await s.quit()
      const fixed = /** @type {any} */ (s.fake.find(fix)).pull.mergeCommitSha
      expect(s.state().last_smoke).toEqual({ main_sha: fixed, result: 'passed' })
      expect(s.out).toContain(
        `#${breaking.pr}: the repeated-failure attention item is closed: the smoke test passes on main ${fixed}`,
      )
      expect(s.state().attention).toEqual([
        expect.objectContaining({
          type: 'repeated-failure',
          pr: breaking.pr,
          resolved_at: expect.any(String),
        }),
      ])
    },
    SLOW,
  )
})

/**
 * Merge as GitHub does for `gh pr merge`, through the REST call that the fake answers the same
 * way, for a handler of `pr merge` that does something first.
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

describe('1.6d/after-merge: what the Gate checks around the merge', () => {
  test('the Gate deletes only a task branch of this repository, never a default branch', () => {
    const where = { repository: 'acme/app', defaultBranches: ['main', 'trunk'] }
    const pull = (/** @type {string} */ headRef, headRepo = 'Acme/App') => ({ headRef, headRepo })
    expect(deletableBranch(pull('task/12-counter-work'), where)).toBe('task/12-counter-work')
    expect(deletableBranch(pull('main'), where)).toBeNull()
    expect(deletableBranch(pull('trunk'), where)).toBeNull()
    expect(deletableBranch(pull('feature/counter'), where)).toBeNull()
    expect(deletableBranch(pull('task/12-counter-work', 'fork/app'), where)).toBeNull()
    expect(deletableBranch({ headRef: 'task/12-counter-work', headRepo: null }, where)).toBeNull()
  })

  test(
    'a merge onto another main than the tested one raises an attention item',
    async () => {
      const s = await scene({ issues: [task(190, 'counter')] })
      const pull = await shipped(s, {
        issue: 190,
        role: 'counter',
        author: BUILDER1,
        files: { 'src/features/counter/u.js': 'export const u = 1\n' },
      })
      /** @type {string | null} */
      let moved = null
      // Main moves after stage 9, just before GitHub merges.
      const remove = s.fake.on('pr merge', async ({ args }) => {
        remove()
        moved = await s.push('main', { files: { 'docs/late.md': '# Late\n' } })
        return mergeAsGitHub(s, args)
      })
      await s.start()
      await s.ended(pull.pr, 'merged')
      await s.until(() => s.state().attention.length > 0, 'the attention item')
      await s.quit()
      const tested = s.state().prs[String(pull.pr)].tested_main_sha
      const merge = /** @type {any} */ (s.fake.find(pull.pr)).pull.mergeCommitSha
      expect(tested).not.toBe(moved)
      expect(s.out).toContain(
        `ATTENTION repeated-failure #${pull.pr}: #${pull.pr} was merged onto main ${String(moved).slice(0, 12)}, not onto ${tested.slice(0, 12)}, which the Gate tested: main moved between stage 9 and the merge, and GitHub cannot pin the base of a merge; the merge commit ${merge.slice(0, 12)} is untested, so check main`,
      )
      expect(s.merges()).toEqual([{ pr: pull.pr, sha: pull.head, admin: true, code: 0 }])
    },
    SLOW,
  )

  test(
    'a fetch of main that fails after the merge raises an attention item, since the smoke test did not run',
    async () => {
      const s = await scene({
        issues: [task(192, 'counter')],
        configure: (hackwin) => {
          hackwin.commands.smoke = 'node -e 0'
        },
      })
      const pull = await shipped(s, {
        issue: 192,
        role: 'counter',
        author: BUILDER1,
        files: { 'src/features/counter/v.js': 'export const v = 1\n' },
      })
      // After the merge, the Lead's clone can no longer reach the origin.
      const remove = s.fake.on('pr merge', async ({ args }) => {
        remove()
        const answer = await mergeAsGitHub(s, args)
        await s.fixture.git.run(['remote', 'set-url', 'origin', join(s.fixture.origin, 'gone')])
        return answer
      })
      await s.start()
      await s.ended(pull.pr, 'merged')
      await s.until(() => s.state().attention.length > 0, 'the attention item')
      await s.quit()
      expect(s.out).toContain(
        `ATTENTION repeated-failure #${pull.pr}: main was not fetched after the merge of #${pull.pr} (`,
      )
      expect(s.out).toContain(
        'so the Gate did not check that the merge commit has the tested main as its first parent and did not run the smoke test; fetch main and check it',
      )
      expect(s.state().last_smoke).toEqual({ main_sha: null, result: null })
    },
    SLOW,
  )

  test(
    'a protection read that fails before the merge is made again, and the Gate never merges on the read of its start',
    async () => {
      const s = await scene({ issues: [task(194, 'counter')] })
      await s.start()
      // After the start, the Lead's account can bypass another rule, and reads fail for a while.
      const restriction = /** @type {any} */ (
        s.fake.state.rulesets.find((ruleset) => ruleset.name === 'hackwin-update-restriction')
      )
      restriction.rules.push(ONE_APPROVAL)
      let failed = 0
      const remove = s.fake.on('GET repos/{owner}/{repo}/rules/branches/:branch*', () => {
        failed += 1
        throw httpError(502, 'Server Error')
      })
      const pull = await shipped(s, {
        issue: 194,
        role: 'counter',
        author: BUILDER1,
        files: { 'src/features/counter/w.js': 'export const w = 1\n' },
      })
      await s.poll()
      await s.until(
        () => s.out.includes(`#${pull.pr} stage 10, merge: failed, the Gate tries again in 5 s`),
        'the failed read',
      )
      expect(failed).toBe(1)
      expect(s.merges()).toEqual([])
      remove()
      await s.advanceUntil(() => s.digest().length > 0, 'the end of the run')
      await s.ended(pull.pr, 'failed')
      await s.quit()
      expect(s.merges()).toEqual([])
      expect(parseDigestLine(s.digest()[0])).toMatchObject({
        stage: 'merge',
        note: 'merge-refused: rules the Lead can bypass',
      })
    },
    SLOW,
  )
})

describe('1.6h/labels: a merged task is closed without its status label', () => {
  test(
    'the closed tasks lose in-review and keep their role, an open task keeps its labels, and status shows the tasks as closed',
    async () => {
      const s = await scene({
        issues: [
          task(180, 'counter'),
          task(182, 'todos'),
          task(184, 'counter', undefined, { dependsOn: [180], status: 'blocked' }),
          task(186, 'counter'),
        ],
      })
      const first = await shipped(s, {
        issue: 180,
        role: 'counter',
        author: BUILDER1,
        files: { 'src/features/counter/first.js': 'export const first = 1\n' },
      })
      const second = await shipped(s, {
        issue: 186,
        role: 'counter',
        author: BUILDER1,
        files: { 'src/features/counter/second.js': 'export const second = 2\n' },
      })
      // GitHub closes #180 through `Closes #180`; #186 is still open after its merge, as when
      // GitHub has not closed it yet, so the Gate closes it.
      s.fake.on('pr merge', async ({ args }) => {
        const merged = await mergeAsGitHub(s, args)
        if (Number(args[2]) === second.pr) {
          Object.assign(/** @type {any} */ (s.fake.find(186)), {
            state: 'open',
            stateReason: null,
            closedAt: null,
          })
        }
        return merged
      })
      await s.start()
      await s.ended(first.pr, 'merged')
      await s.ended(second.pr, 'merged')
      await s.quit()

      expect(s.out).not.toContain(`#${first.pr} closed its task #180`)
      expect(s.out).toContain(`#${second.pr} closed its task #186`)
      for (const issue of [180, 186]) {
        expect(/** @type {any} */ (s.fake.find(issue)).state).toBe('closed')
        expect(s.labels(issue)).toEqual(['role:counter'])
      }
      // An open task keeps its labels: #182 waits for a pull request, #184 is ready now.
      expect(s.labels(182)).toEqual(['in-review', 'role:todos'])
      expect(s.labels(184).sort()).toEqual(['ready', 'role:counter'])

      const status = await runStatus({
        cwd: s.fixture.main,
        env: s.fixture.env,
        executor: s.fake.as(BUILDER1),
        clock: fixedClock('2026-10-24T12:00:00.000Z'),
        json: true,
      })
      expect(status.code, status.err).toBe(0)
      const builder = status.json.data.who.find(
        (/** @type {any} */ member) => member.login === BUILDER1,
      )
      expect(builder.working.map((/** @type {any} */ item) => [item.number, item.status])).toEqual([
        [182, 'in-review'],
      ])
      // #184 is next: status reads its dependency #180 as closed.
      expect(builder.next.map((/** @type {any} */ item) => item.number)).toEqual([184])
      expect(status.json.data.blocked).toEqual([])
    },
    SLOW,
  )
})

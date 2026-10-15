import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, sep } from 'node:path'
import { parseDigestLine } from '../../../src/commands/gate/digest.js'
import { isPending } from './helpers.js'
import { BUILDER1, QUICK_COMMANDS, createScene, task } from './scene.js'

/** @typedef {import('./scene.js').Scene} Scene */

/** A token that matches the built-in pattern `github-token`, made here so that no file holds it. */
const TOKEN = ['ghp', 'a1B2c3D4'.repeat(5)].join('_')

/** A check that fails while a file named `broken.js` lies under `src/features/`. */
const CHECK = `import { readdirSync } from 'node:fs'
const broken = readdirSync('src/features', { recursive: true }).filter((path) => String(path).endsWith('broken.js'))
if (broken.length > 0) process.exit(1)
`

/** The names of the command line tools of models that a test traps on PATH. */
const MODEL_TOOLS = ['claude', 'codex', 'aider', 'gemini', 'ollama', 'llm', 'openai', 'copilot']

/** @type {Scene[]} */
let scenes = []

afterEach(async () => {
  vi.restoreAllMocks()
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
 * Programs named like the command line tools of models, first on the Gate's PATH, that leave a
 * line in a file when they run.
 * @param {Scene} s
 * @returns {string} The file.
 */
function modelTraps(s) {
  const bin = join(s.fixture.dir, 'model-bin')
  const marker = join(s.fixture.dir, 'model-called')
  mkdirSync(bin, { recursive: true })
  for (const name of MODEL_TOOLS) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> '${marker}'\n`)
    chmodSync(join(bin, name), 0o755)
  }
  s.fixture.env.PATH = `${bin}:${s.fixture.env.PATH}`
  return marker
}

/** The first words of every gh call the Gate made: `api`, `pr merge`, `issue pin`, `run rerun`. */
function ghCommands(/** @type {Scene} */ s) {
  return [
    ...new Set(
      s.fake.calls.map((call) =>
        call.args[0] === 'api' ? 'api' : call.args.slice(0, 2).join(' '),
      ),
    ),
  ].sort()
}

describe('AC21: the Gate processes 45 pull request events without exiting', () => {
  test('a scripted sequence of the events of the HackYeah night, with an outage, and the start count stays 1', async () => {
    const issues = Array.from({ length: 19 }, (_, index) =>
      task(200 + index, index % 2 === 0 ? 'counter' : 'todos'),
    )
    const s = await scene({
      issues,
      files: {
        'check.mjs': CHECK,
        'src/features/.keep': '',
        'src/features/counter/shared.js': 'export const shared = 0\n',
      },
      configure: (hackwin) => {
        hackwin.commands.check = 'node check.mjs'
      },
    })
    /** @type {string[]} */
    const events = []
    /** The heads the Gate should merge, by pull request. */
    const merged = new Map()
    /** @param {number} index */
    const roleOf = (index) => (index % 2 === 0 ? 'counter' : 'todos')
    /**
     * Push a commit to the task branch of the index-th task.
     * @param {number} index
     * @param {{ files?: Record<string, string>, remove?: string[] }} change
     */
    const push = (index, change) => s.push(`task/${200 + index}-${roleOf(index)}-work`, change)
    /**
     * Open the pull request of the index-th task as its author, after its first push.
     * @param {number} index
     * @param {{ files?: Record<string, string>, draft?: boolean }} [first]
     */
    const open = async (index, { files, draft = false } = {}) => {
      const head = await push(index, {
        files: files ?? {
          [`src/features/${roleOf(index)}/f${index}.js`]: `export const f = ${index}\n`,
        },
      })
      const pr = await s.openPull({
        branch: `task/${200 + index}-${roleOf(index)}-work`,
        author: BUILDER1,
        task: 200 + index,
        draft,
      })
      events.push(`#${pr} opened`)
      return { pr, head }
    }
    /** @param {{ pr: number, head: string }} pull @param {string} [conclusion] */
    const ci = (pull, conclusion = 'success') => {
      s.check(pull.head, { conclusion })
      events.push(`#${pull.pr} CI ${conclusion}`)
    }

    // Ten pull requests with green CI, open before the Gate starts.
    /** @type {Array<{ pr: number, head: string }>} */
    const first = []
    for (let index = 0; index < 10; index += 1) {
      const pull = await open(index)
      ci(pull)
      merged.set(pull.pr, pull.head)
      first.push(pull)
    }
    const gate = await s.start()
    for (const { pr } of first) await s.ended(pr, 'merged')

    // CI fails, then a new head passes.
    const failing = await open(10)
    ci(failing, 'failure')
    await s.poll()
    await s.advanceUntil(() => s.state().prs[String(failing.pr)]?.result === 'failed', 'ci-failed')
    const second = {
      pr: failing.pr,
      head: await push(10, { files: { 'src/features/counter/g.js': 'export const g = 1\n' } }),
    }
    events.push(`#${failing.pr} synchronized`)
    ci(second)
    merged.set(second.pr, second.head)
    await s.poll()
    await s.ended(second.pr, 'merged')

    // The merge test fails, then a fix.
    const broken = await open(11, {
      files: { 'src/features/todos/broken.js': 'export const b = 1\n' },
    })
    await s.poll()
    await s.ended(broken.pr, 'failed')
    const fixed = {
      pr: broken.pr,
      head: await push(11, { remove: ['src/features/todos/broken.js'] }),
    }
    events.push(`#${broken.pr} synchronized`)
    ci(fixed)
    merged.set(fixed.pr, fixed.head)
    await s.poll()
    await s.ended(fixed.pr, 'merged')

    // Closed without a merge while it waits for CI.
    const closing = await open(12)
    await s.poll()
    await s.until(() => s.out.includes(`#${closing.pr} passed stages 1 to 7`), 'stage 8')
    await s.as(BUILDER1).updatePullRequest(closing.pr, { state: 'closed' })
    events.push(`#${closing.pr} closed`)
    await s.poll()
    await s.until(() => s.state().prs[String(closing.pr)] === undefined, 'the closed one')

    // A draft, then ready for review.
    const draft = await open(13, { draft: true })
    await s.poll()
    expect(s.state().prs[String(draft.pr)]).toBeUndefined()
    const ready = /** @type {any} */ (s.fake.find(draft.pr))
    ready.pull.draft = false
    events.push(`#${draft.pr} ready for review`)
    ci(draft)
    merged.set(draft.pr, draft.head)
    await s.poll()
    await s.ended(draft.pr, 'merged')

    // A conflict, then a head that resolves it.
    const conflicting = await open(14, {
      files: { 'src/features/counter/shared.js': 'export const shared = 1\n' },
    })
    await s.push('main', {
      files: { 'src/features/counter/shared.js': 'export const shared = 2\n' },
    })
    await s.poll()
    await s.ended(conflicting.pr, 'needs-owner')
    const resolved = {
      pr: conflicting.pr,
      head: await push(14, {
        files: { 'src/features/counter/shared.js': 'export const shared = 2\n' },
      }),
    }
    events.push(`#${conflicting.pr} synchronized`)
    ci(resolved)
    merged.set(resolved.pr, resolved.head)
    await s.poll()
    await s.ended(resolved.pr, 'merged')

    // A secret at intake, then a head without it.
    const leaking = await open(15, {
      files: { 'src/features/todos/token.js': `export const token = '${TOKEN}'\n` },
    })
    await s.poll()
    await s.ended(leaking.pr, 'failed')
    const clean = {
      pr: leaking.pr,
      head: await push(15, { remove: ['src/features/todos/token.js'] }),
    }
    events.push(`#${leaking.pr} synchronized`)
    ci(clean)
    merged.set(clean.pr, clean.head)
    await s.poll()
    await s.ended(clean.pr, 'merged')

    // A push during the run.
    const moving = await open(16)
    await s.poll()
    await s.until(() => s.out.includes(`#${moving.pr} passed stages 1 to 7`), 'stage 8')
    const moved = {
      pr: moving.pr,
      head: await push(16, { files: { 'src/features/counter/h.js': 'export const h = 1\n' } }),
    }
    events.push(`#${moving.pr} synchronized`)
    await s.poll()
    await s.until(
      () =>
        s.digest().some((line) => line.includes(`#${moving.pr} `) && line.includes(' requeued ')),
      'the requeue',
    )
    ci(moved)
    merged.set(moved.pr, moved.head)
    await s.poll()
    await s.ended(moved.pr, 'merged')

    // GitHub and origin are unreachable for two polls.
    await s.reachable(false)
    await s.poll()
    await s.poll()
    await s.reachable(true)

    // One more with green CI, and a draft that is closed.
    const last = await open(17)
    ci(last)
    merged.set(last.pr, last.head)
    await s.poll()
    await s.ended(last.pr, 'merged')
    const abandoned = await open(18, { draft: true })
    await s.as(BUILDER1).updatePullRequest(abandoned.pr, { state: 'closed' })
    events.push(`#${abandoned.pr} closed`)
    await s.poll()

    expect(events).toHaveLength(45)
    expect(await isPending(gate.done)).toBe(true)
    expect(s.state()).toMatchObject({ starts: 1, queue: [] })
    expect(s.out).not.toContain('stopped on an unexpected error')
    expect(s.out).not.toContain('gate-error')
    expect(s.merges()).toEqual([...merged].map(([pr, sha]) => ({ pr, sha, admin: true, code: 0 })))
    const ends = s.digest().map(parseDigestLine)
    expect(ends.filter((line) => line?.result === 'merged')).toHaveLength(merged.size)
    await s.quit()
    expect(s.status()).toMatchObject({ starts: 1, stopped_at: expect.any(String), queue: [] })
  }, 600_000)
})

describe('AC34: a run of pull requests without conflicts makes no model call', () => {
  test('no command line tool of a model runs, nothing is fetched over HTTP, and gh is called only for GitHub', async () => {
    const s = await scene({
      issues: [task(230, 'counter'), task(232, 'todos'), task(234, 'counter')],
    })
    const marker = modelTraps(s)
    const fetched = vi.spyOn(globalThis, 'fetch')
    /** @type {number[]} */
    const pulls = []
    for (const [issue, role] of /** @type {const} */ ([
      [230, 'counter'],
      [232, 'todos'],
      [234, 'counter'],
    ])) {
      const branch = `task/${issue}-${role}-work`
      const head = await s.push(branch, {
        files: { [`src/features/${role}/m${issue}.js`]: 'export const m = 1\n' },
      })
      pulls.push(await s.openPull({ branch, author: BUILDER1, task: issue }))
      s.check(head)
    }
    await s.start()
    for (const pr of pulls) await s.ended(pr, 'merged')
    await s.quit()
    expect(existsSync(marker)).toBe(false)
    expect(fetched).not.toHaveBeenCalled()
    expect(ghCommands(s)).toEqual(['api', 'issue pin', 'pr merge'])
  }, 300_000)
})

describe("AC35: the Gate's only outputs are its terminal, its directory, gh and the notification", () => {
  test('a trace of the Gate process shows its writes inside its directory, and no process but git, ps, the project commands and the notification', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hackwin-gate-trace-')))
    const trace = join(dir, 'trace.jsonl')
    const bin = join(dir, 'bin')
    const notified = join(dir, 'notified')
    mkdirSync(bin)
    writeFileSync(join(bin, 'notify-send'), `#!/bin/sh\necho "$*" >> '${notified}'\n`)
    chmodSync(join(bin, 'notify-send'), 0o755)
    const s = await scene({ issues: [task(240, 'counter'), task(242, 'todos')] })
    s.cleanupAlso(dir)
    const marker = modelTraps(s)

    const fine = await s.push('task/240-counter-work', {
      files: { 'src/features/counter/t.js': 'export const t = 1\n' },
    })
    const good = await s.openPull({ branch: 'task/240-counter-work', author: BUILDER1, task: 240 })
    s.check(fine)
    await s.push('task/242-todos-work', {
      files: { 'src/features/todos/token.js': `export const token = '${TOKEN}'\n` },
    })
    const leaking = await s.openPull({ branch: 'task/242-todos-work', author: BUILDER1, task: 242 })

    const gate = s.fork({
      trace,
      notify: { platform: 'linux', release: '6.8.0-test', env: { PATH: `${bin}:/usr/bin:/bin` } },
    })
    await s.ended(leaking, 'failed')
    await s.ended(good, 'merged')
    expect(await gate.quit()).toBe(0)
    expect(gate.result).toMatchObject({ type: 'done' })

    /** @type {Array<Record<string, any>>} */
    const entries = readFileSync(trace, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    expect(entries[0]).toMatchObject({ kind: 'start', pid: gate.child.pid })

    // Every file the Gate's process writes lies in its own directory.
    const roots = [s.files.root, realpathSync(s.files.root)].map((root) => `${root}${sep}`)
    const writes = entries.filter((entry) => entry.kind === 'write')
    expect(writes.length).toBeGreaterThan(0)
    const outside = writes.filter(
      (entry) =>
        !roots.some(
          (root) => `${entry.path}${sep}`.startsWith(root) || entry.path.startsWith(root),
        ),
    )
    expect(outside).toEqual([])

    // The processes it starts: git, ps for its lock, the project's commands and the notification.
    const spawns = entries.filter((entry) => entry.kind === 'spawn')
    const commands = Object.values(QUICK_COMMANDS)
    const strangers = spawns.filter((entry) =>
      entry.shell
        ? !commands.some(
            (command) => entry.file === command || entry.file.startsWith(`${command} `),
          )
        : !['git', 'ps', 'notify-send'].includes(basename(entry.file)),
    )
    expect(strangers).toEqual([])
    expect(spawns.filter((entry) => basename(entry.file) === 'notify-send')).toHaveLength(1)
    expect(readFileSync(notified, 'utf8').split('\n').filter(Boolean)).toHaveLength(1)
    expect(
      spawns.filter((entry) => /claude|codex/i.test(`${entry.file} ${entry.args.join(' ')}`)),
    ).toEqual([])

    // No connection of its own: GitHub only through gh, and the terminal through stdout.
    expect(entries.filter((entry) => entry.kind === 'net')).toEqual([])
    expect(ghCommands(s)).toEqual(['api', 'issue pin', 'pr merge'])
    expect(existsSync(marker)).toBe(false)
    expect(gate.out).toContain(`#${good} ${BUILDER1} merged stage=after-merge`)
  }, 300_000)
})

// The parts of a flow scenario that do not depend on where GitHub is (1.7a, #26): the project's
// commands, the programs on PATH, a task issue written by hand from the template, a commit of a
// scripted session, an in-process run of `hackwin`, the Gate of the Lead, and reads of the state
// after a run. world-offline.js puts them on a fake GitHub linked to a bare origin; the scenarios
// of flow.fixture.test.js put them on a fixture repository.
//
// No scenario starts a real agent (plan section 9, decision 9): the `claude` on PATH only records
// where and with what it was started. The commands of the scenarios run with the environment of
// the scenario (`ctx.env`), which `join`, `take` and `ship` hand to the project's commands since
// #90 and #91.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { createContext } from '../../../src/cli/context.js'
import { main, prepareContext } from '../../../src/cli/main.js'
import { COMMANDS } from '../../../src/cli/registry.js'
import { parseDigestLine } from '../../../src/commands/gate/digest.js'
import { startGate as runGate } from '../../../src/commands/gate/gate.js'
import { createPipeline } from '../../../src/commands/gate/pipeline.js'
import { gateFiles } from '../../../src/commands/gate/state.js'
import { createGit } from '../../../src/core/git/index.js'
import { createOutput, quoteShellArg } from '../../../src/core/runtime/index.js'
import { teamConfig, yaml } from '../../harness/index.js'

/** @import { GhExecutor } from '../../../src/core/github/index.js' */
/** @import { Clock } from '../../../src/core/runtime/index.js' */

const CLI = fileURLToPath(new URL('../../../bin/hackwin.js', import.meta.url))

/** The task issue template that `setup` commits (6.4). */
export const TASK_TEMPLATE = '.github/ISSUE_TEMPLATE/hackwin-task.md'

/** The deadline of every task of the scenarios. */
export const DEADLINE = '2026-11-06T23:59:00+01:00'

/**
 * The commands of hackwin.yml in every scenario: quick ones of node that need no package, so
 * nothing is downloaded and the machine is not loaded. The check and the format pass, and an
 * acceptance test runs as `node <file>`. They work on GitHub Actions too, where the generated
 * workflow sets up node.
 */
export const QUICK_COMMANDS = Object.freeze({
  install: 'node -e 0',
  check: 'node -e 0',
  test: 'node',
  format: 'node -e 0',
  generate: null,
  lockfile_regen: 'node -e 0',
  smoke: null,
})

/**
 * @typedef {object} RunResult
 * @property {number} code
 * @property {string} stdout
 * @property {string} stderr
 * @property {any} json The parsed document of a run with `--json`, else null.
 */

/**
 * The programs of a member's machine, in `dir`: `hackwin`, the CLI of this checkout, which the
 * git hooks call, and `claude`, which only records each start in `<dir>/agent/<n>/`.
 * @param {string} dir
 * @returns {{ bin: string, agentLog: string }}
 */
export function writeTools(dir) {
  const bin = join(dir, 'bin')
  const agentLog = join(dir, 'agent')
  mkdirSync(bin, { recursive: true })
  mkdirSync(agentLog, { recursive: true })
  /** @param {string} name @param {string} text */
  const program = (name, text) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${text}`)
    chmodSync(join(bin, name), 0o755)
  }
  program('hackwin', `exec ${quoteShellArg(process.execPath)} ${quoteShellArg(CLI)} "$@"\n`)
  program(
    'claude',
    [
      `log=${quoteShellArg(agentLog)}`,
      'n=$(ls "$log" | wc -l | tr -d " ")',
      'start="$log/$((n + 1))"',
      'mkdir "$start"',
      'pwd -P > "$start/cwd"',
      'printf "%s" "$*" > "$start/args"',
      '',
    ].join('\n'),
  )
  return { bin, agentLog }
}

/**
 * An environment with the programs of `writeTools` first on PATH.
 * @param {Record<string, string | undefined>} env
 * @param {string} bin
 */
export function withTools(env, bin) {
  return { ...env, PATH: `${bin}${delimiter}${env.PATH ?? ''}` }
}

/**
 * The number of agent starts recorded in `agentLog`.
 * @param {string} agentLog
 */
export function agentStarts(agentLog) {
  let count = 0
  while (existsSync(join(agentLog, String(count + 1)))) count += 1
  return count
}

/**
 * Run `hackwin <argv>` in-process, as a script runs it: stdin and stdout are no terminals, so the
 * caller kind is `non-interactive` (contracts 3.5) and `take` prints the start command of the
 * agent instead of starting it.
 * @param {string[]} argv
 * @param {{ cwd: string, env: Record<string, string | undefined>, executor: GhExecutor, clock?: Clock, log?: (line: string) => void }} options
 * @returns {Promise<RunResult>}
 */
export async function runHackwin(argv, { cwd, env, executor, clock, log }) {
  let stdout = ''
  let stderr = ''
  const code = await main(argv, {
    cwd,
    env,
    stdin: Object.assign(Readable.from([]), { isTTY: false }),
    stdout: { write: (chunk) => (stdout += chunk), isTTY: false },
    stderr: { write: (chunk) => (stderr += chunk) },
    ghExecutor: executor,
    ...(clock ? { clock } : {}),
  })
  log?.(`hackwin ${argv.join(' ')} in ${cwd} exited ${code}\n${stdout}${stderr}`)
  let json = null
  if (argv.includes('--json')) {
    try {
      json = JSON.parse(stdout)
    } catch {
      json = null
    }
  }
  return { code, stdout, stderr, json }
}

/**
 * The answers of `setup --answers` (CM11) for the team of every flow scenario: a team of 2 (3.5),
 * the Lead with the shared role and `greeting`, builder1 with `counter` and `todos`, on the roles
 * of the Node fixture (test/harness/team.js). No name-only login (`NAME_ONLY_LOGINS`) is in it,
 * so nothing of a live scenario can invite, assign or mention one. Then the quick commands, no
 * invitation, and the answers of `join` that setup hands on for the Lead's machine.
 */
export function setupAnswers() {
  const answers = structuredClone(teamConfig(3).answers)
  const [lead, builder] = answers.team.members
  lead.roles = ['shared', 'greeting']
  answers.team.members = [lead, builder]
  Object.assign(answers.commands, QUICK_COMMANDS)
  return { ...answers, invite: false, language: 'English', explanation_style: 'concise' }
}

/**
 * Write the answers of `join` (CM11) into `dir` and return the file.
 * @param {string} dir
 */
export function joinAnswersFile(dir) {
  const file = join(dir, 'join-answers.yml')
  writeFileSync(file, yaml({ language: 'English', explanation_style: 'concise' }))
  return file
}

/**
 * @typedef {object} TaskInput
 * @property {string} title
 * @property {string} role
 * @property {string[]} paths
 * @property {string[]} acceptance
 * @property {number[]} [dependsOn]
 * @property {string} [deadline] DEADLINE by default; an empty text, as the template leaves it,
 *   makes the block invalid (8.1).
 */

/**
 * The body of a task issue written by hand from the task issue template on `origin/main` (I2):
 * the front matter goes, the data block is filled in, and so is each heading.
 * @param {string} template The text of TASK_TEMPLATE.
 * @param {TaskInput} task
 * @returns {string}
 */
export function taskBodyFromTemplate(template, task) {
  const block = yaml({
    kind: 'task',
    role: task.role,
    paths: task.paths,
    depends_on: task.dependsOn ?? [],
    acceptance_tests: task.acceptance,
    deadline: task.deadline ?? DEADLINE,
  })
  const body = template
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(
      /```yaml\n# hackwin:task\n[\s\S]*?```/,
      () => `\`\`\`yaml\n# hackwin:task\n${block}\`\`\``,
    )
    .replace('<!-- What is missing or wrong, in terms of the product. -->', `${task.title}.`)
    .replace(
      '<!-- What exists when the task is done, including the interfaces it must respect. -->',
      `${task.title} works.`,
    )
    .replace(
      '<!-- One line per criterion, each mapped to a test listed above. -->',
      task.acceptance.map((test) => `- ${test} passes`).join('\n'),
    )
    .replace('<!-- What this task must not change. -->', 'Every other path.')
  if (!body.includes(block)) throw new Error('the data block of the template was not filled in')
  return body
}

/**
 * The files of a scripted session: written into the worktree and committed with git, so that
 * the `pre-commit` hook runs as for the agent's own commit.
 * @param {string} worktree
 * @param {Record<string, string>} files
 * @param {{ env: Record<string, string | undefined>, message?: string, noVerify?: boolean }} options
 *   `noVerify` skips the hooks, for a commit that a scenario makes outside the rules on purpose.
 * @returns {Promise<string>} The new commit.
 */
export async function commitWork(
  worktree,
  files,
  { env, message = 'Do the task', noVerify = false },
) {
  for (const [path, content] of Object.entries(files)) {
    const file = join(worktree, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
  const git = createGit({ cwd: worktree, env })
  await git.run(['add', '--all'])
  await git.run(['commit', '--quiet', ...(noVerify ? ['--no-verify'] : []), '-m', message])
  return git.revParse('HEAD')
}

/**
 * Push a commit of `files` on a new branch from `origin/main`, from a member's main checkout,
 * with the hooks skipped (`--no-verify`): the gap of 10.6 that CI and the Gate close, as a member
 * who opens a pull request by hand would leave it. The checkout returns to `main`.
 * @param {{ path: string, env: Record<string, string | undefined> }} member
 * @param {{ branch: string, files: Record<string, string>, title?: string }} pull
 * @returns {Promise<string>} The pushed commit.
 */
export async function pushByHand(member, { branch, files, title = `Work on ${branch}` }) {
  const git = createGit({ cwd: member.path, env: member.env })
  await git.fetch({ prune: true })
  await git.run(['checkout', '--quiet', '-B', branch, 'refs/remotes/origin/main'])
  try {
    const head = await commitWork(member.path, files, {
      env: member.env,
      message: title,
      noVerify: true,
    })
    await git.run(['push', '--quiet', '--no-verify', 'origin', `HEAD:refs/heads/${branch}`])
    return head
  } finally {
    await git.run(['checkout', '--quiet', 'main'])
  }
}

/**
 * An acceptance test that passes when node runs it.
 * @param {string} what
 */
export function passingTest(what) {
  return `console.log(${JSON.stringify(`${what}: passed`)})\n`
}

/**
 * A clock whose time moves only through `advance()`; a sleep ends when the time reaches its end.
 * The offline Gate runs on it, so that each poll is one the scenario asked for.
 * @param {string} [start]
 */
export function manualClock(start = '2026-10-24T10:00:00.000Z') {
  let time = Date.parse(start)
  /** @type {Array<{ at: number, resolve: () => void }>} */
  let sleepers = []
  return {
    now: () => new Date(time),
    sleep: (/** @type {number} */ ms) =>
      ms <= 0
        ? Promise.resolve()
        : new Promise((resolve) => sleepers.push({ at: time + ms, resolve: () => resolve() })),
    /** @param {number} ms */
    advance(ms) {
      time += ms
      const due = sleepers.filter((sleeper) => sleeper.at <= time)
      sleepers = sleepers.filter((sleeper) => sleeper.at > time)
      for (const sleeper of due) sleeper.resolve()
    },
  }
}

/** @typedef {ReturnType<typeof manualClock>} ManualClock */

/**
 * Wait until `check` gives a truthy value. The wait is long, so that a loaded machine or a slow
 * GitHub does not fail a scenario; it only delays the report of a failure.
 * @template T
 * @param {() => T | Promise<T>} check
 * @param {string} what
 * @param {{ timeoutMs: number, everyMs?: number, detail?: () => string }} options
 * @returns {Promise<T>}
 */
export async function until(check, what, { timeoutMs, everyMs = 20, detail }) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${timeoutMs} ms waiting for ${what}${detail ? `:\n${detail()}` : ''}`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, everyMs))
  }
}

/**
 * Start the Lead's Gate in the main checkout, as `hackwin gate` runs in a terminal: the runner
 * prepares the context (contracts 3.6), and the Gate runs the real pipeline of section 9 until
 * `quit()` types `quit`. Two things of the laptop stay out of the test: the keep awake starts no
 * program, and a notification (G26) is only recorded.
 *
 * On a manual clock (`advance`), each poll is one the scenario asks for with `poll()`. On the
 * system clock the Gate polls by itself every `gate.poll_seconds`, and `poll()` does nothing.
 * @param {{ main: string, env: Record<string, string | undefined>, executor: GhExecutor, clock: Clock & { advance?: (ms: number) => void }, timeoutMs?: number, log?: (line: string) => void }} options
 *   `timeoutMs` is how long `ended()` waits by default.
 */
export async function startLeadGate({
  main: mainCheckout,
  env,
  executor,
  clock,
  timeoutMs: endTimeoutMs = 180_000,
  log,
}) {
  const stdin = Object.assign(new PassThrough(), { isTTY: true })
  let out = ''
  const terminal = {
    isTTY: true,
    write: (/** @type {string} */ chunk) => {
      out += chunk
      return true
    },
  }
  /** @type {unknown[]} */
  const notifications = []
  const ctx = await createContext({
    command: 'gate',
    args: [],
    flags: {},
    cwd: mainCheckout,
    env,
    stdin,
    stdoutIsTTY: true,
    out: createOutput({ stdout: terminal, stderr: terminal }),
    clock,
    ghExecutor: executor,
  })
  const entry = COMMANDS.find((command) => command.name === 'gate')
  await prepareContext(ctx, /** @type {NonNullable<typeof entry>} */ (entry))
  const files = gateFiles(ctx.gitCommonDir)
  const pipeline = createPipeline({
    notifier: async (notification) => {
      notifications.push(notification)
      return { shown: true, reason: null }
    },
  })
  // What the scenario sees of the polls: how many intakes ended.
  let intakes = 0
  let intaking = false
  const intake = /** @type {NonNullable<typeof pipeline.intake>} */ (pipeline.intake)
  const done = runGate(ctx, {
    pipeline: {
      ...pipeline,
      intake: async (gate) => {
        intaking = true
        try {
          await intake(gate)
        } finally {
          intaking = false
          intakes += 1
        }
      },
    },
    keepAwake: async () => ({
      active: true,
      command: 'none, a test',
      reason: null,
      stop: () => {},
    }),
  })
  /** @type {{ result?: unknown, error?: unknown } | null} */
  let ended = null
  done.then(
    (result) => (ended = { result }),
    (error) => (ended = { error }),
  )
  const detail = () => `the Gate printed:\n${out}`
  let stopped = false

  const handle = {
    files,
    notifications,
    get out() {
      return out
    },
    get ended() {
      return ended
    },

    /** The digest lines of the Gate, parsed. */
    digest() {
      if (!existsSync(files.digest)) return []
      return readFileSync(files.digest, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => parseDigestLine(line))
        .filter(Boolean)
    },

    /** The state file of the Gate. */
    state() {
      return JSON.parse(readFileSync(files.state, 'utf8'))
    },

    /**
     * With a manual clock, start the next poll and wait until its intake ended. The Gate starts
     * no poll while one is under way, so the clock moves only once the poll under way ended.
     * @param {{ timeoutMs?: number }} [options]
     */
    async poll({ timeoutMs = 120_000 } = {}) {
      if (!clock.advance) return
      await until(() => !intaking && intakes > 0, 'the end of the poll under way', {
        timeoutMs,
        detail,
      })
      const before = intakes
      clock.advance(60_000)
      await until(() => intakes > before && !intaking, 'the next poll', { timeoutMs, detail })
    },

    /**
     * Wait until a run of the pull request ended with `result`: its digest line is written and
     * the state file holds the result. The Gate saves the state file after the digest line, so a
     * test that reads the state right after the line could read the run before its end.
     * With a manual clock, the clock moves on by 30 seconds whenever the run waits, as stage 8
     * does between two looks at the checks.
     * @param {number} pr
     * @param {string} result
     * @param {{ timeoutMs?: number }} [options]
     */
    async ended(pr, result, { timeoutMs = endTimeoutMs } = {}) {
      return until(
        () => {
          const found = handle.digest().find((line) => line?.pr === pr && line.result === result)
          const saved = found && handle.savedResult(pr) === result
          if (!found && clock.advance && !intaking) clock.advance(30_000)
          if (ended && !saved) throw new Error(`the Gate stopped:\n${out}`)
          return saved ? found : null
        },
        `the digest line and the state of #${pr} with the result ${result}`,
        { timeoutMs, everyMs: clock.advance ? 50 : 1000, detail },
      )
    },

    /**
     * The result of the pull request in the state file, or null while the file or its record is
     * missing or is being replaced.
     * @param {number} pr
     * @returns {string | null}
     */
    savedResult(pr) {
      try {
        return handle.state().prs?.[String(pr)]?.result ?? null
      } catch {
        return null
      }
    },

    /** Type `quit` and wait until the Gate stopped; its result, or its error thrown. */
    async quit() {
      if (!stopped) stdin.write('quit\n')
      stopped = true
      // With a manual clock, the loop's sleep ends only when the time moves.
      const nudge = clock.advance ? setInterval(() => clock.advance?.(1000), 20) : null
      try {
        const result = await done
        log?.(`the Gate stopped; it printed:\n${out}`)
        return result
      } finally {
        if (nudge) clearInterval(nudge)
      }
    },
  }
  await until(() => out.includes('`quit`') || ended, 'the header of the Gate', {
    timeoutMs: 120_000,
    detail,
  })
  if (ended) throw new Error(`the Gate did not start:\n${out}`)
  return handle
}

/** @typedef {Awaited<ReturnType<typeof startLeadGate>>} LeadGate */

/**
 * The first parent history of a ref, newest first, as `{ sha, parents }`.
 * @param {import('../../../src/core/git/index.js').Git} git
 * @param {string} ref
 */
export async function firstParentHistory(git, ref) {
  const { stdout } = await git.run(['log', '--first-parent', '--format=%H %P', ref])
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, ...parents] = line.split(' ')
      return { sha, parents }
    })
}

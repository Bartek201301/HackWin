// The world of a parity scenario: the Lead's clone of a team repository, the Lead's gh, and the
// programs every command meets, offline (world-offline.js) or on a fixture repository
// (parity.fixture.test.js). The scenarios run a command in two ways:
//
// - From a terminal: `hackwin <command>` in-process, with stdin and stdout as terminals, so the
//   caller kind is `terminal` (contracts 3.5).
// - Through the Claude Code wrapper: the command line of the wrapper that `setup` committed,
//   `.claude/skills/<command>/SKILL.md`, run with `sh -c` in a child process, with `$ARGUMENTS`
//   replaced by what the session typed after `/<command>`, as the Bash tool of Claude Code runs
//   it (plan section 9, decision 9: no real Claude Code session starts). Its `hackwin` is the CLI
//   of this checkout, and its `gh` is gh-client.js, which reaches GitHub through the same
//   executor as the in-process commands: the fake GitHub, or the harness's guarded executor.
//
// On a fixture repository every call of the world, the scenario's own included, must name that
// repository as GH_REPO (repositoryRefusal). gh fills `repos/{owner}/{repo}` of a call without
// GH_REPO from the git remote of its working directory, which for the test process is this
// HackWin checkout; the harness's guard lets such a call through. On 20 October 2026 the first
// version of these scenarios created the issues #102 to #105 in Bartek201301/HackWin that way.
//
// No test starts a real agent: the `claude` on PATH only records where and with what it was
// started.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { delimiter, join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { createContext } from '../../../src/cli/context.js'
import { main, prepareContext } from '../../../src/cli/main.js'
import { COMMANDS } from '../../../src/cli/registry.js'
import { startGate as runGate } from '../../../src/commands/gate/gate.js'
import { createPipeline } from '../../../src/commands/gate/pipeline.js'
import { createGit } from '../../../src/core/git/index.js'
import { createGitHub } from '../../../src/core/github/index.js'
import {
  RemoteError,
  createOutput,
  exec,
  quoteShellArg,
  systemClock,
} from '../../../src/core/runtime/index.js'
import { WRAPPER_TIMEOUT_MS, wrapperPath } from '../../../src/generate/index.js'
import { yaml } from '../../harness/index.js'

/** @import { GhExecutor, GitHub } from '../../../src/core/github/index.js' */
/** @import { Clock } from '../../../src/core/runtime/index.js' */

const CLI = fileURLToPath(new URL('../../../bin/hackwin.js', import.meta.url))
const GH_CLIENT = fileURLToPath(new URL('./gh-client.js', import.meta.url))

/** The variable that tells gh-client.js where the bridge listens. */
export const BRIDGE_VARIABLE = 'HACKWIN_TEST_GH_BRIDGE'

/**
 * The commands of hackwin.yml in every scenario: quick ones of node that need no package, so
 * nothing is downloaded and the machine is not loaded. The check and the format pass, and the
 * acceptance tests run as `node <file>`. They work on GitHub Actions too, where the CI workflow
 * sets up node.
 */
export const QUICK_COMMANDS = Object.freeze({
  install: 'node -e 0',
  check: 'node -e 0',
  test: 'node',
  format: 'node -e 0',
})

/**
 * @typedef {object} RunResult
 * @property {number} code
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * @typedef {object} AgentStart
 * @property {string} cwd The directory `claude` started in.
 * @property {string[]} args Its arguments.
 */

/**
 * @typedef {object} BridgeCall
 * @property {string[]} args
 * @property {string | undefined} input
 * @property {Record<string, string>} env
 * @property {number} code
 */

/**
 * Create a world. Call `close()` when done.
 * @param {object} options
 * @param {string} options.main The main checkout of the Lead's clone.
 * @param {string} options.dir A directory of the scenario, outside every checkout, for its
 *   programs and files.
 * @param {Record<string, string | undefined>} options.env The base environment of the commands
 *   and of git: the fixture's, or the harness's of the Lead.
 * @param {GhExecutor} options.executor The Lead's gh.
 * @param {string | null} [options.repo] The fixture repository, `owner/name`: every call must
 *   name it as GH_REPO, and the world's own client does. Null for the fake GitHub.
 * @param {string} options.login The Lead's login.
 * @param {Settle | null} [options.settle] How to read GitHub after a write: on real GitHub,
 *   whose reads lag its writes; null for the fake GitHub, which needs one read.
 * @param {(line: string) => void} [options.log]
 */
export async function createWorld({
  main: mainCheckout,
  dir,
  env: base,
  executor: lead,
  repo = null,
  login,
  settle = null,
  log,
}) {
  /** @type {Array<{ args: string[], reason: string }>} */
  const refused = []
  /** @type {GhExecutor} */
  const executor =
    repo === null
      ? lead
      : async (args, call = {}) => {
          const reason = repositoryRefusal(args, call, repo)
          if (reason === null) return lead(args, call)
          refused.push({ args: [...args], reason })
          log?.(`refused by the parity scenario: gh ${args.join(' ')}: ${reason}`)
          return { code: 1, stdout: '', stderr: `refused by the parity scenario: ${reason}\n` }
        }

  const bin = join(dir, 'bin')
  const ghBin = join(dir, 'gh-bin')
  const agentLog = join(dir, 'agent')
  for (const path of [bin, ghBin, agentLog]) mkdirSync(path, { recursive: true })
  /** @param {string} file @param {string} text */
  const program = (file, text) => {
    writeFileSync(file, `#!/bin/sh\n${text}`)
    chmodSync(file, 0o755)
  }
  program(
    join(bin, 'hackwin'),
    `exec ${quoteShellArg(process.execPath)} ${quoteShellArg(CLI)} "$@"\n`,
  )
  // Records the directory and the arguments of each start in a directory of its own, numbered.
  program(
    join(bin, 'claude'),
    [
      `log=${quoteShellArg(agentLog)}`,
      'n=$(ls "$log" | wc -l | tr -d " ")',
      'start="$log/$((n + 1))"',
      'mkdir "$start"',
      'pwd -P > "$start/cwd"',
      `printf '%s' "$#" > "$start/argc"`,
      'i=0',
      'for arg in "$@"; do',
      '  i=$((i + 1))',
      `  printf '%s' "$arg" > "$start/arg$i"`,
      'done',
      '',
    ].join('\n'),
  )
  program(
    join(ghBin, 'gh'),
    `exec ${quoteShellArg(process.execPath)} ${quoteShellArg(GH_CLIENT)} "$@"\n`,
  )

  /** @type {BridgeCall[]} */
  const bridgeCalls = []
  const server = createServer((socket) => {
    let text = ''
    let answered = false
    socket.setEncoding('utf8')
    socket.on('data', async (chunk) => {
      text += chunk
      const end = text.indexOf('\n')
      if (end === -1 || answered) return
      answered = true
      /** @type {{ code: number, stdout: string, stderr: string }} */
      let answer
      /** @type {any} */
      let request = { args: [], env: {} }
      try {
        request = JSON.parse(text.slice(0, end))
        answer = await executor(request.args, { input: request.input, env: request.env })
      } catch (error) {
        answer = { code: 1, stdout: '', stderr: `${error?.message ?? error}\n` }
      }
      bridgeCalls.push({ ...request, code: answer.code })
      socket.end(`${JSON.stringify(answer)}\n`)
    })
    socket.on('error', () => {})
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(undefined))
  })
  const address = /** @type {import('node:net').AddressInfo} */ (server.address())

  const env = { ...base, PATH: `${bin}${delimiter}${base.PATH ?? ''}` }
  const wrapperEnv = {
    ...env,
    PATH: `${ghBin}${delimiter}${env.PATH}`,
    [BRIDGE_VARIABLE]: `127.0.0.1:${address.port}`,
  }
  const github = createGitHub({ executor, repo })
  const say = log ?? (() => {})

  const world = {
    main: mainCheckout,
    dir,
    login,
    /** The environment of every command and of git, with `hackwin` and `claude` first on PATH. */
    env,
    executor,
    /** The Lead's client, for what the scenario reads and writes on GitHub as the Lead. */
    github,
    /** Every gh call of the wrappers' child processes, in order. */
    bridgeCalls,
    /** The calls that named another repository than the fixture repository, or none. */
    refused,
    /** The environment of a wrapper's child process: the bridge's `gh` first on PATH. */
    wrapperEnv,
    log: say,

    /**
     * Git in a checkout, with the world's environment, so that the hooks find `hackwin`.
     * @param {string} [cwd]
     */
    git: (cwd = mainCheckout) => createGit({ cwd, env }),

    /**
     * Run `hackwin <argv>` in-process as the Lead: from a terminal by default, or with stdin and
     * stdout that are no terminals (`terminal: false`), as a script runs it.
     * @param {string[]} argv
     * @param {{ cwd?: string, terminal?: boolean, clock?: Clock }} [options]
     * @returns {Promise<RunResult>}
     */
    async run(argv, { cwd = mainCheckout, terminal = true, clock } = {}) {
      let stdout = ''
      let stderr = ''
      const code = await main(argv, {
        cwd,
        env,
        stdin: Object.assign(Readable.from([]), { isTTY: terminal }),
        stdout: { write: (chunk) => (stdout += chunk), isTTY: terminal },
        stderr: { write: (chunk) => (stderr += chunk) },
        ghExecutor: executor,
        ...(clock ? { clock } : {}),
      })
      say(`terminal: hackwin ${argv.join(' ')} in ${cwd} exited ${code}\n${stdout}${stderr}`)
      return { code, stdout, stderr }
    },

    /**
     * Run the Claude Code wrapper of a command in a checkout: the command line of its generated
     * skill in that checkout, with `$ARGUMENTS` replaced by what follows `/<command>`, through
     * `sh -c` in a child process, with the timeout the wrapper asks the Bash tool for.
     * @param {string} command
     * @param {string} [typed] What the session typed after `/<command>`.
     * @param {{ cwd?: string }} [options]
     * @returns {Promise<RunResult & { line: string }>}
     */
    async wrapper(command, typed = '', { cwd = mainCheckout } = {}) {
      const root = (await createGit({ cwd, env }).topLevel()).trim()
      const line = wrapperCommandLineOf(readFileSync(join(root, wrapperPath(command)), 'utf8'))
      const commandLine = line.replace('$ARGUMENTS', () => typed)
      const result = await exec('/bin/sh', ['-c', commandLine], {
        cwd,
        env: wrapperEnv,
        timeoutMs: WRAPPER_TIMEOUT_MS,
      })
      say(
        `wrapper /${command} ${typed}: ${commandLine} in ${cwd} exited ${result.code}\n${result.stdout}${result.stderr}`,
      )
      return { code: result.code ?? 1, stdout: result.stdout, stderr: result.stderr, line }
    },

    /**
     * Every start of `claude` so far, in order.
     * @returns {AgentStart[]}
     */
    agentStarts() {
      /** @type {AgentStart[]} */
      const starts = []
      for (let n = 1; existsSync(join(agentLog, String(n))); n += 1) {
        const read = (/** @type {string} */ name) =>
          readFileSync(join(agentLog, String(n), name), 'utf8')
        const count = Number(read('argc'))
        starts.push({
          cwd: read('cwd').trimEnd(),
          args: Array.from({ length: count }, (_, index) => read(`arg${index + 1}`)),
        })
      }
      return starts
    },

    /**
     * Read GitHub after a write, once the read has settled (see Settle); a single read offline.
     * @template T
     * @param {() => Promise<T>} read
     * @param {string} what What is read, for the error.
     * @returns {Promise<T>}
     */
    settled: (read, what) => (settle === null ? read() : settledRead(read, what, settle, say)),

    /** Stop the bridge. */
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  }
  return world
}

/** @typedef {Awaited<ReturnType<typeof createWorld>>} World */

/**
 * Why a call of a world on a fixture repository is refused, or null when it may run: it must
 * name the fixture repository as GH_REPO, and an endpoint that names a repository must name that
 * one.
 * @param {string[]} args
 * @param {{ env?: Record<string, string> }} call
 * @param {string} repo The fixture repository, `owner/name`.
 * @returns {string | null}
 */
export function repositoryRefusal(args, call, repo) {
  const named = call.env?.GH_REPO ?? null
  if (named === null) {
    return `the call names no repository (no GH_REPO), so gh would take the repository of its working directory; every call of this scenario names ${repo}`
  }
  if (named.toLowerCase() !== repo.toLowerCase()) {
    return `the call names ${named}; every call of this scenario names ${repo}`
  }
  for (const arg of args) {
    const match = /^\/?repos\/([^/{}]+)\/([^/{}?]+)/.exec(arg)
    if (match && `${match[1]}/${match[2]}`.toLowerCase() !== repo.toLowerCase()) {
      return `the endpoint ${arg} names ${match[1]}/${match[2]}; every call of this scenario names ${repo}`
    }
  }
  return null
}

/**
 * The timing of a read of real GitHub after a write, in milliseconds. GitHub's reads lag its
 * writes: on hackwin-fixture-b on 20 October 2026 an issue that the Lead had just created
 * answered HTTP 404 1.3 s later and was there 0.5 s after that, and src/commands/setup/settle.js
 * records reads that went back to the old value for up to 9.8 s. So a read counts only when every
 * read of the last `stableMs` agreed and at least `minMs` have passed since the read began.
 * @typedef {object} Settle
 * @property {number} minMs
 * @property {number} stableMs
 * @property {number} maxMs
 * @property {number} intervalMs
 */

/** The timing that setup uses for its own read back (src/commands/setup/settle.js). */
export const LIVE_SETTLE = Object.freeze({
  minMs: 15_000,
  stableMs: 5_000,
  maxMs: 90_000,
  intervalMs: 1_000,
})

/**
 * Read until the value settles. A read that fails without an HTTP status, with 429 or with a 5xx
 * is a missed sample, as a network failure passes; any other failure ends the wait.
 * @template T
 * @param {() => Promise<T>} read
 * @param {string} what
 * @param {Settle} settle
 * @param {(line: string) => void} log
 * @returns {Promise<T>}
 */
async function settledRead(read, what, { minMs, stableMs, maxMs, intervalMs }, log) {
  const start = Date.now()
  /** @type {{ value: T, key: string } | null} */
  let last = null
  /** @type {number | null} */
  let agreedSince = null
  let reads = 0
  for (;;) {
    try {
      const value = await read()
      const key = JSON.stringify(value)
      reads += 1
      if (last === null || agreedSince === null || key !== last.key) agreedSince = Date.now()
      last = { value, key }
    } catch (error) {
      const status = /** @type {any} */ (error)?.status
      if (
        !(error instanceof RemoteError) ||
        (status !== undefined && status !== 429 && status < 500)
      ) {
        throw error
      }
      agreedSince = null
    }
    const now = Date.now()
    if (
      last !== null &&
      agreedSince !== null &&
      now - start >= minMs &&
      now - agreedSince >= stableMs
    ) {
      log(`${what} settled after ${reads} reads in ${now - start} ms: ${last.key}`)
      return last.value
    }
    if (now - start >= maxMs) {
      throw new Error(
        `${what} did not settle on GitHub within ${maxMs} ms; the last read: ${last?.key ?? 'none'}`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/**
 * The command line of a generated wrapper: the one line of its `sh` code block.
 * @param {string} content
 * @returns {string}
 */
export function wrapperCommandLineOf(content) {
  const match = /^```sh\n(.*)\n```$/m.exec(content)
  if (!match) throw new Error(`the wrapper has no command line:\n${content}`)
  return match[1]
}

/**
 * The answers of `setup --answers` (CM11) for a solo team: the fixture team of one member
 * (test/harness/team.js), the quick commands, no invitation, and the answers of `join` that
 * setup hands on for the Lead's machine.
 * @param {import('../../harness/index.js').TeamConfig} team
 */
export function soloAnswers(team) {
  const answers = structuredClone(team.answers)
  Object.assign(answers.commands, QUICK_COMMANDS)
  return { ...answers, language: 'English', explanation_style: 'concise' }
}

/**
 * Run `hackwin setup --answers <file>` in the main checkout as the Lead, as a script runs it.
 * @param {World} world
 * @param {unknown} answers
 * @param {{ clock?: Clock }} [options] A fake clock offline, so that waiting for GitHub's reads to
 *   settle takes no time.
 */
export function runSetup(world, answers, { clock } = {}) {
  const file = join(world.dir, 'answers.yml')
  writeFileSync(file, yaml(answers))
  return world.run(['setup', '--answers', file], { terminal: false, clock })
}

/**
 * Write a task issue by hand as the Lead (I2): the task issue template that `setup` committed,
 * `.github/ISSUE_TEMPLATE/hackwin-task.md` on `origin/main`, with its data block filled in.
 * @param {World} world
 * @param {{ title: string, role: string, paths: string[], acceptance: string[], dependsOn?: number[] }} task
 * @returns {Promise<number>} The number of the issue.
 */
export async function writeTask(world, { title, role, paths, acceptance, dependsOn = [] }) {
  const git = world.git()
  await git.fetch({ prune: true })
  const template = await git.showFile('origin/main', '.github/ISSUE_TEMPLATE/hackwin-task.md')
  if (template === null) throw new Error('origin/main holds no task issue template')
  const block = yaml({
    kind: 'task',
    role,
    paths,
    depends_on: dependsOn,
    acceptance_tests: acceptance,
    deadline: '2026-10-25T12:00:00+02:00',
  })
  const body = template
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/```yaml\n# hackwin:task\n[\s\S]*?```/, `\`\`\`yaml\n# hackwin:task\n${block}\`\`\``)
    .replace('<!-- What is missing or wrong, in terms of the product. -->', `${title} is missing.`)
  if (!body.includes(block)) throw new Error('the data block of the template was not filled in')
  const issue = await world.github.createIssue({ title, body })
  world.log(`the Lead wrote task #${issue.number} by hand: ${title}`)
  // As a person sees the new issue on GitHub before taking it.
  const read = await world.settled(
    async () => (await world.github.getIssue(issue.number))?.number ?? null,
    `the new issue #${issue.number}`,
  )
  if (read !== issue.number) throw new Error(`#${issue.number} is not readable on GitHub`)
  return issue.number
}

/**
 * Commit work in a task worktree with git, as the agent session does: the files are written and
 * committed, and the `pre-commit` hook runs.
 * @param {World} world
 * @param {string} worktree
 * @param {Record<string, string>} files
 * @returns {Promise<string>} The new commit.
 */
export async function commitWork(world, worktree, files) {
  for (const [path, content] of Object.entries(files)) {
    const file = join(worktree, path)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, content)
  }
  const git = world.git(worktree)
  await git.run(['add', '--all'])
  await git.run(['commit', '--quiet', '-m', 'Do the task'])
  return git.revParse('HEAD')
}

/**
 * The labels and assignees of an issue or pull request, sorted, and its state.
 * @param {World} world
 * @param {number} number
 */
export async function labelsOf(world, number) {
  const issue = await world.github.getIssue(number)
  if (issue === null) throw new Error(`#${number} does not exist`)
  return {
    labels: [...issue.labels].sort(),
    assignees: [...issue.assignees].map((login) => login.toLowerCase()).sort(),
    state: issue.state,
  }
}

/**
 * The pull request of a branch, or null.
 * @param {World} world
 * @param {string} branch
 */
export async function pullOf(world, branch) {
  const pulls = await world.github.listPullRequests({ state: 'all', head: branch })
  return pulls.find((pull) => pull.headRef === branch) ?? null
}

/**
 * Start the Lead's Gate in the main checkout, as `hackwin gate` runs in a terminal: the runner
 * prepares the context (contracts 3.6), and the Gate runs the real pipeline of section 9 with the
 * system clock until `quit()` types `quit`. Two things of the laptop stay out of the test: the
 * keep awake starts no program, and a notification (G26) is only recorded, so nothing appears on
 * the screen of the machine that runs the test.
 * @param {World} world
 */
export async function startGate(world) {
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
    cwd: world.main,
    env: world.env,
    stdin,
    stdoutIsTTY: true,
    out: createOutput({ stdout: terminal, stderr: terminal }),
    clock: systemClock,
    ghExecutor: world.executor,
  })
  const entry = COMMANDS.find((command) => command.name === 'gate')
  await prepareContext(ctx, /** @type {NonNullable<typeof entry>} */ (entry))
  const done = runGate(ctx, {
    pipeline: createPipeline({
      notifier: async (notification) => {
        notifications.push(notification)
        return { shown: true, reason: null }
      },
    }),
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
  let stopped = false
  return {
    done,
    notifications,
    /** How the Gate ended, once it did: its result or its error; null while it runs. */
    get ended() {
      return ended
    },
    /** What the Gate printed in its terminal so far. */
    get out() {
      return out
    },
    /** Type `quit` and wait until the Gate stopped; its result, or its error thrown. */
    async quit() {
      if (!stopped) stdin.write('quit\n')
      stopped = true
      const result = await done
      world.log(`the Gate stopped; it printed:\n${out}`)
      return result
    },
  }
}

/**
 * Wait until `check` gives a truthy value, looking every `everyMs`. The wait is long, so that a
 * loaded machine or a slow GitHub does not fail a test; it only delays the report of a failure.
 * @template T
 * @param {() => T | Promise<T>} check
 * @param {string} what
 * @param {{ timeoutMs: number, everyMs?: number, detail?: () => string }} options `detail` is
 *   added to the error of a timeout, for example what the Gate printed.
 * @returns {Promise<T>}
 */
export async function until(check, what, { timeoutMs, everyMs = 100, detail }) {
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

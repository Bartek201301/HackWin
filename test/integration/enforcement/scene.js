// Shared pieces of the enforcement scenarios (task 1.7b, #27): one rule passed through every layer
// it has, the Claude Code hooks, the git hooks, `ship`, CI, the Gate and GitHub's rules (10.1),
// offline against the fake GitHub (enforcement.test.js) and on the fixture repositories
// (enforcement.fixture.test.js).
//
// - Commands run in-process through `main` (contracts 3.6), with the scenario's environment as
//   `ctx.env`, so the project's commands and the git hooks that a command triggers see its PATH
//   (#90, #91). Git hooks run in git's own child processes and find `hackwin` on that PATH.
// - The Gate runs in-process as `hackwin gate` runs in a terminal: the runner prepares its context
//   and the real pipeline of section 9 runs with the system clock until `quit`. The keep awake
//   starts no program, and a notification (G26) is only recorded.
// - No test starts a real agent or a real Claude Code session (plan section 9, decision 9): the
//   `claude` and `codex` on PATH do nothing, and the Claude Code hooks get recorded hook events,
//   run with the command line of the settings that `setup` generated.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { createContext } from '../../../src/cli/context.js'
import { main, prepareContext } from '../../../src/cli/main.js'
import { COMMANDS } from '../../../src/cli/registry.js'
import { parseDigestLine } from '../../../src/commands/gate/digest.js'
import { startGate } from '../../../src/commands/gate/gate.js'
import { INPUT_HELP } from '../../../src/commands/gate/input.js'
import { createPipeline } from '../../../src/commands/gate/pipeline.js'
import { gateFiles } from '../../../src/commands/gate/state.js'
import {
  createOutput,
  exec,
  execShell,
  exitCodeOf,
  quoteShellArg,
  systemClock,
} from '../../../src/core/runtime/index.js'
import { SETTINGS_PATH } from '../../../src/generate/index.js'
import { yaml } from '../../harness/index.js'

/** @import { GhExecutor } from '../../../src/core/github/index.js' */
/** @import { Clock } from '../../../src/core/runtime/index.js' */

const CLI = fileURLToPath(new URL('../../../bin/hackwin.js', import.meta.url))

/**
 * The commands of hackwin.yml in every scenario: quick ones of node that need no package, so
 * nothing is downloaded and the machine is not loaded. They work on GitHub Actions too, where the
 * CI workflow sets up node. The acceptance tests run as `node <file>`.
 */
export const QUICK_COMMANDS = Object.freeze({
  install: 'node -e 0',
  check: 'node -e 0',
  test: 'node',
  format: 'node -e 0',
})

/** The Lead's source of a generated file, and the generated file, both of the shared role. */
export const GENERATED_SOURCE = 'src/shared/words/source.txt'
export const GENERATED_FILE = 'src/shared/words/generated.txt'

/**
 * `commands.generate` of the scenarios that have one: it writes GENERATED_FILE as GENERATED_SOURCE
 * in capitals, and does nothing while the source does not exist, as on main. A change that
 * commits a source and a generated file that differs from it has stale generated files (E10).
 */
export const GENERATE = `node -e "const f=require('fs');if(f.existsSync('${GENERATED_SOURCE}'))f.writeFileSync('${GENERATED_FILE}',f.readFileSync('${GENERATED_SOURCE}','utf8').toUpperCase())"`

/**
 * The team's own secret pattern in `gate.secret_patterns`, as the lane tests of AC80 use it: a
 * pattern of HackWin that no pattern of GitHub's secret scanning knows, because the team made it
 * up (D19).
 */
export const TEAM_PATTERN = 'hwtest_[a-z0-9]{24}'

/** A test secret that matches only TEAM_PATTERN, built at run time so no scanner flags this file. */
export const TEST_SECRET = ['hwtest', 'k4m8n2b6v0c3x7z1l5j9h2g4'].join('_')

/**
 * The body of a task issue written by hand from the template (8.1).
 * @param {{ role: string, paths: string[], acceptance: string[], dependsOn?: number[] }} block
 * @returns {string}
 */
export function taskBody({ role, paths, acceptance, dependsOn = [] }) {
  const data = {
    kind: 'task',
    role,
    wave: 1,
    paths,
    depends_on: dependsOn,
    acceptance_tests: acceptance,
    deadline: '2026-11-06T23:59:00+01:00',
  }
  return [
    '```yaml',
    '# hackwin:task',
    yaml(data).trimEnd(),
    '```',
    '',
    '## Problem',
    'A scenario of the enforcement tests needs this task.',
  ].join('\n')
}

/**
 * The body of a pull request for a task, as `ship` writes it without a template.
 * @param {number} issue
 */
export function pullBody(issue) {
  return `Closes #${issue}\n`
}

/**
 * A directory with the programs that the commands and the git hooks of a scenario meet: a
 * `hackwin` that runs the CLI of this checkout (the shims of `.githooks` call it), and a `claude`
 * and a `codex` that do nothing (join's step 3 only looks them up; take, without a terminal,
 * starts no agent).
 * @param {string} dir
 * @returns {string}
 */
export function toolsDir(dir) {
  const bin = join(dir, 'tools')
  mkdirSync(bin, { recursive: true })
  const tools = {
    hackwin: `#!/bin/sh\nexec ${quoteShellArg(process.execPath)} ${quoteShellArg(CLI)} "$@"\n`,
    claude: '#!/bin/sh\nexit 0\n',
    codex: '#!/bin/sh\nexit 0\n',
  }
  for (const [name, text] of Object.entries(tools)) {
    writeFileSync(join(bin, name), text)
    chmodSync(join(bin, name), 0o755)
  }
  return bin
}

/**
 * Write files into a checkout, with their directories.
 * @param {string} root
 * @param {Record<string, string>} files Paths relative to the checkout, and their text.
 */
export function writeFiles(root, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
}

/**
 * The environment with a directory first on PATH.
 * @param {Record<string, string | undefined>} env
 * @param {string} bin
 * @returns {Record<string, string | undefined>}
 */
export function onPath(env, bin) {
  return { ...env, PATH: `${bin}${delimiter}${env.PATH ?? ''}` }
}

/**
 * @typedef {object} RunResult
 * @property {number} code
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * Run `hackwin <argv>` in-process, without a terminal, so the caller kind is `non-interactive`.
 * @param {string[]} argv
 * @param {{ cwd: string, env: Record<string, string | undefined>, executor: GhExecutor, clock?: Clock }} options
 *   `clock` is the system clock by default.
 * @returns {Promise<RunResult>}
 */
export async function runCli(argv, { cwd, env, executor, clock }) {
  let stdout = ''
  let stderr = ''
  const code = await main(argv, {
    cwd,
    env,
    stdin: Object.assign(Readable.from([]), { isTTY: false }),
    stdout: { write: (/** @type {string} */ chunk) => ((stdout += chunk), true), isTTY: false },
    stderr: { write: (/** @type {string} */ chunk) => ((stderr += chunk), true) },
    ghExecutor: executor,
    ...(clock ? { clock } : {}),
  })
  return { code, stdout, stderr }
}

/**
 * Run git in a checkout, without failing on a non-zero exit: a hook's refusal is the result.
 * @param {string} cwd
 * @param {string[]} args
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<RunResult>}
 */
export async function git(cwd, args, env) {
  const result = await exec('git', args, { cwd, env })
  return { code: result.code ?? 1, stdout: result.stdout, stderr: result.stderr }
}

/**
 * @typedef {object} GateRun
 * @property {Promise<unknown>} done Settles when the Gate stops; rejects when it refuses to start.
 * @property {string} commonDir The git common directory of the Lead's clone.
 * @property {Array<{ title: string, message: string }>} notifications
 * @property {string} out What the Gate printed so far.
 * @property {{ result?: unknown, error?: unknown } | null} ended
 * @property {(line: string) => void} type Types a line in the Gate's terminal.
 * @property {() => Promise<unknown>} quit Types `quit` and waits until the Gate stopped.
 */

/**
 * Start the Lead's Gate in the main checkout, as `hackwin gate` in a terminal.
 * @param {{ cwd: string, env: Record<string, string | undefined>, executor: GhExecutor }} options
 * @returns {Promise<GateRun>}
 */
export async function startLeadGate({ cwd, env, executor }) {
  const stdin = Object.assign(new PassThrough(), { isTTY: true })
  let out = ''
  const terminal = {
    isTTY: true,
    write: (/** @type {string} */ chunk) => {
      out += chunk
      return true
    },
  }
  /** @type {Array<{ title: string, message: string }>} */
  const notifications = []
  const ctx = await createContext({
    command: 'gate',
    args: [],
    flags: {},
    cwd,
    env,
    stdin,
    stdoutIsTTY: true,
    out: createOutput({ stdout: terminal, stderr: terminal }),
    clock: systemClock,
    ghExecutor: executor,
  })
  const entry = COMMANDS.find((command) => command.name === 'gate')
  await prepareContext(ctx, /** @type {NonNullable<typeof entry>} */ (entry))
  const done = startGate(ctx, {
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
  let quitting = false
  return {
    done,
    commonDir: ctx.gitCommonDir,
    notifications,
    get out() {
      return out
    },
    get ended() {
      return ended
    },
    type: (line) => stdin.write(`${line}\n`),
    async quit() {
      if (!quitting && ended === null) stdin.write('quit\n')
      quitting = true
      return done
    },
  }
}

/**
 * Stop a Gate on every path of a scenario: type `quit` unless it already ended, and wait until it
 * stopped, for at most `timeoutMs`. Its own error (a refusal to start included) is no error here.
 * @param {GateRun} gate
 * @param {{ timeoutMs: number, log: (line: string) => void }} options
 * @returns {Promise<boolean>} True when the Gate stopped within the time.
 */
export async function stopGate(gate, { timeoutMs, log }) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer
  const stopped = await Promise.race([
    gate.quit().then(
      () => true,
      () => true,
    ),
    new Promise((resolve) => (timer = setTimeout(() => resolve(false), timeoutMs))),
  ])
  clearTimeout(timer)
  if (!stopped) log(`the Gate did not stop within ${timeoutMs} ms after quit:\n${gate.out}`)
  else if (gate.ended?.error !== undefined) log(`the Gate ended with an error: ${gate.ended.error}`)
  return /** @type {boolean} */ (stopped)
}

/**
 * Wait until the Gate printed its header, or refused to start: `{ started }` or `{ refusal }`.
 * @param {GateRun} gate
 * @param {number} timeoutMs
 * @returns {Promise<{ started: true } | { refusal: { code: number, message: string } }>}
 */
export async function gateStart(gate, timeoutMs) {
  await until(() => gate.ended !== null || gate.out.includes(INPUT_HELP), 'the Gate to start', {
    timeoutMs,
    detail: () => gate.out,
  })
  const error = gate.ended?.error
  if (error !== undefined) {
    return {
      refusal: { code: exitCodeOf(error), message: /** @type {Error} */ (error).message ?? '' },
    }
  }
  if (gate.ended !== null) throw new Error(`the Gate stopped at once:\n${gate.out}`)
  return { started: true }
}

/**
 * Every line of the Gate's `digest.log`, oldest first.
 * @param {string} commonDir
 */
export function digestLines(commonDir) {
  const file = gateFiles(commonDir).digest
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => parseDigestLine(line))
    .filter((entry) => entry !== null)
}

/**
 * Wait until the digest holds a line of the pull request with this result, from the index `from`
 * of the digest on; the line.
 * @param {GateRun} gate
 * @param {number} pr
 * @param {string} result
 * @param {{ timeoutMs: number, from?: number }} options
 */
export async function digestOf(gate, pr, result, { timeoutMs, from = 0 }) {
  return until(
    () => {
      if (gate.ended !== null) throw new Error(`the Gate stopped:\n${gate.out}`)
      return digestLines(gate.commonDir)
        .slice(from)
        .find((entry) => entry.pr === pr && entry.result === result)
    },
    `the digest line ${result} of #${pr}`,
    { timeoutMs, everyMs: 1000, detail: () => gate.out },
  )
}

/**
 * Wait until `check` gives a truthy value. The waits are long, so that a loaded machine or a slow
 * GitHub does not fail a scenario; they only delay the report of a failure.
 * @template T
 * @param {() => T | Promise<T>} check
 * @param {string} what
 * @param {{ timeoutMs: number, everyMs?: number, detail?: () => string }} options
 * @returns {Promise<NonNullable<T>>}
 */
export async function until(check, what, { timeoutMs, everyMs = 200, detail }) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return /** @type {NonNullable<T>} */ (value)
    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${timeoutMs} ms waiting for ${what}${detail ? `:\n${detail()}` : ''}`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, everyMs))
  }
}

/**
 * The Bash commands with which a session of the Lead could merge a pull request (10.4, 10.6):
 * `gh pr merge` in the Gate's own form and bare, the REST merge through `gh api` in the forms of
 * `docs/verification.md` row 2, and the GraphQL mutation.
 * @param {{ repo: string, pr: number, sha: string }} target
 */
export function mergeCommands({ repo, pr, sha }) {
  return [
    `gh pr merge ${pr} --merge --admin --match-head-commit ${sha}`,
    `gh pr merge ${pr}`,
    `gh api -X PUT repos/${repo}/pulls/${pr}/merge`,
    `gh api repos/${repo}/pulls/${pr}/merge -X PUT -f merge_method=merge -f sha=${sha}`,
    `gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: "PR_x"}) { clientMutationId } }'`,
  ]
}

/**
 * A recorded PreToolUse event of a Bash call, in the form of Claude Code's hooks reference
 * (https://code.claude.com/docs/en/hooks, as test/internal/hook/claude-fixture.js records it).
 * @param {string} cwd
 * @param {string} command
 * @param {string} mode `default`, or `bypassPermissions` for a session with bypass permissions.
 */
export function bashEvent(cwd, command, mode) {
  return {
    session_id: 'f3b1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    transcript_path: '/Users/lead/.claude/projects/app/f3b1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d.jsonl',
    cwd,
    permission_mode: mode,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command, description: 'Merge the pull request', timeout: 120000 },
    tool_use_id: 'toolu_01HackWinEnforcement',
  }
}

/**
 * Whether a Bash deny rule of Claude Code's settings matches a command, by the matching that
 * https://code.claude.com/docs/en/permissions documents (docs/verification.md row 2): `*` stands
 * for any text, here for one character or more, so that the result holds whether or not a `*`
 * also matches empty text (question 8 of docs/verification.md is open).
 * @param {string} rule For example `Bash(gh pr merge *)`.
 * @param {string} command
 */
export function denyRuleMatches(rule, command) {
  const pattern = /^Bash\((.*)\)$/s.exec(rule)?.[1]
  if (pattern === undefined) return false
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.+')
  return new RegExp(`^${source}$`, 's').test(command)
}

/**
 * What a Claude Code session of the Lead meets when it tries each merge command in a checkout:
 * the deny rules of the generated settings that match it, and the decision of each PreToolUse hook
 * that the settings run for a Bash call, as Claude Code runs it (the command line with `sh -c`,
 * the event on stdin), with default permissions and with bypass permissions.
 * @param {{ checkout: string, env: Record<string, string | undefined>, commands: string[] }} options
 */
export async function leadSessionMerges({ checkout, env, commands }) {
  const settings = JSON.parse(readFileSync(join(checkout, SETTINGS_PATH), 'utf8'))
  /** @type {string[]} */
  const deny = settings.permissions?.deny ?? []
  /** @type {string[]} */
  const hookLines = (settings.hooks?.PreToolUse ?? [])
    .filter((group) => new RegExp(`^(?:${group.matcher ?? '.*'})$`).test('Bash'))
    .flatMap((group) => group.hooks ?? [])
    .filter((hook) => hook.type === 'command')
    .map((hook) => hook.command)
  const results = []
  for (const command of commands) {
    const decisions = []
    for (const mode of ['default', 'bypassPermissions']) {
      for (const line of hookLines) {
        const run = await execShell(line, {
          cwd: checkout,
          env,
          input: JSON.stringify(bashEvent(checkout, command, mode)),
        })
        let output = null
        try {
          output = JSON.parse(run.stdout)
        } catch {
          // Not a JSON decision: the hook allowed the call, or failed.
        }
        decisions.push({
          mode,
          hook: line,
          code: run.code,
          decision: output?.hookSpecificOutput?.permissionDecision ?? null,
          reason: output?.hookSpecificOutput?.permissionDecisionReason ?? null,
          stderr: run.stderr,
        })
      }
    }
    results.push({
      command,
      rules: deny.filter((rule) => denyRuleMatches(rule, command)),
      decisions,
    })
  }
  return { deny, hookLines, results }
}

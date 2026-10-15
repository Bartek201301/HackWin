// The checks of `join` (7.2), in the order of the checklist. Each one returns its outcome: passed,
// failed with the fixes to print, or skipped with a notice. A check that throws a HackwinError
// fails with the error's message and resolve, and the checks after it still run.

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runInstall } from '../../core/project/index.js'
import { exec } from '../../core/runtime/index.js'
import { writeLocal } from '../../core/state/index.js'
import { queueOf, toTask } from '../../core/tasks/index.js'
import { HOOKS_PATH, removeMergedWorktrees, repairHooksPath } from '../../core/worktrees/index.js'
import { selfTestHooks } from '../../internal/hook/self-test.js'
import { writeClaudeLocal } from './settings.js'

/** @import { CommandContext } from '../../cli/context.js' */
/** @import { Config, Identity } from '../../core/config/index.js' */
/** @import { Git } from '../../core/git/index.js' */
/** @import { Resolve } from '../../core/runtime/index.js' */
/** @import { LocalRecord } from '../../core/state/index.js' */
/** @import { Answers } from './settings.js' */

/** The oldest Node major version HackWin runs on (plan section 9, decision 11). */
export const NODE_MIN_MAJOR = 22

/** How many lines of a failed install's log, and how many tasks of the queue, `join` prints. */
const SHOWN_LINES = 10

/** The command of each agent, and what to install for it [D7]. */
const AGENTS = Object.freeze({
  claude: { command: 'claude', product: 'Claude Code' },
  codex: { command: 'codex', product: 'the Codex CLI' },
})

/**
 * @typedef {object} Outcome
 * @property {'passed' | 'failed' | 'skipped'} result
 * @property {string} detail What the check found, on its checklist line.
 * @property {Resolve[]} [fixes] How to fix a failed check.
 * @property {string[]} [notes] Lines printed under the checklist line.
 * @property {unknown} [data] For --json.
 */

/**
 * What the checks share.
 * @typedef {object} Scope
 * @property {CommandContext} ctx
 * @property {Config} config
 * @property {Identity} identity
 * @property {string} main The main checkout, where `join` installs, activates and writes.
 * @property {Git} git Git in the main checkout.
 * @property {Answers} answers
 * @property {LocalRecord} record The member's record of local.yml; the settings check updates it.
 */

/**
 * @typedef {object} CheckSpec
 * @property {string} name
 * @property {(scope: Scope) => Promise<Outcome>} run
 */

/** @type {ReadonlyArray<CheckSpec>} The checklist of 7.2, steps 1 to 10 without step 8 (Phase 3). */
export const CHECKS = Object.freeze([
  { name: 'identity', run: identityCheck },
  { name: 'github', run: githubCheck },
  { name: 'git', run: gitCheck },
  { name: 'node', run: async () => checkNode(process.versions.node) },
  { name: 'agent', run: agentCheck },
  { name: 'install', run: installCheck },
  { name: 'hooks', run: hooksCheck },
  { name: 'settings', run: settingsCheck },
  { name: '.env.local', run: envCheck },
  { name: 'worktrees', run: worktreesCheck },
  { name: 'queue', run: queueCheck },
])

/**
 * Step 1: the gh login is a member of the team. The runner has already matched it (a login
 * outside the team exits 2 before `join` starts), so this check only reports the match.
 * @param {Scope} scope
 * @returns {Promise<Outcome>}
 */
async function identityCheck({ identity }) {
  const lead = identity.isLead ? ', the Lead' : ''
  const roles = identity.roles.length === 0 ? 'no role' : `roles ${identity.roles.join(', ')}`
  return passed(`${identity.login} is ${identity.member.name}${lead}, ${roles}`)
}

/**
 * Step 2: gh is logged in (the runner asked for the login) and the login can write to the
 * repository.
 * @param {Scope} scope
 * @returns {Promise<Outcome>}
 */
async function githubCheck({ ctx, identity }) {
  const repository = await ctx.github.repository()
  const name = repository.nameWithOwner
  if (repository.permissions.push) {
    return passed(`gh is logged in as ${identity.login}, with write access to ${name}`)
  }
  return failed(`${identity.login} has no write access to ${name}`, [
    `ask the Lead to give ${identity.login} write access to ${name}, then accept the invitation GitHub sends`,
  ])
}

/**
 * Step 3: git with `merge-tree --write-tree`.
 * @param {Scope} scope
 * @returns {Promise<Outcome>}
 */
async function gitCheck({ git }) {
  const { major, minor, patch } = await git.version()
  await git.requireMergeTree()
  return passed(`git ${major}.${minor}.${patch}, with merge-tree --write-tree`)
}

/**
 * Step 3: Node 22 or later.
 * @param {string} version A Node version, such as `22.11.0` or `v20.18.1`.
 * @returns {Outcome}
 */
export function checkNode(version) {
  const plain = version.replace(/^v/, '')
  const major = Number(/^(\d+)\./.exec(plain)?.[1] ?? Number.NaN)
  if (major >= NODE_MIN_MAJOR) return passed(`Node ${plain}`)
  return failed(
    `Node ${plain} is older than ${NODE_MIN_MAJOR}, the oldest version hackwin runs on`,
    [`install Node ${NODE_MIN_MAJOR} or later`],
  )
}

/**
 * Step 3: the command of the member's agent is on the PATH. It is looked up, never run.
 * @param {Scope} scope
 * @returns {Promise<Outcome>}
 */
async function agentCheck({ ctx, identity }) {
  const agent = identity.member.agent
  const { command, product } = AGENTS[agent]
  const found = await exec('sh', ['-c', 'command -v "$1"', 'sh', command], { env: ctx.env })
  const path = found.stdout.trim()
  if (found.code === 0 && path !== '') return passed(`${command} at ${path}`)
  return failed(`${command}, the agent of ${identity.login} in hackwin.yml, is not on the PATH`, [
    `install ${product} so that the \`${command}\` command is on the PATH`,
  ])
}

/**
 * Step 4: `commands.install` in the main checkout, skipped with a notice while no file matches
 * `paths.manifests` (A62).
 * @param {Scope} scope
 * @returns {Promise<Outcome>}
 */
async function installCheck({ ctx, config, main }) {
  const logFile = installLog(ctx)
  const run = await runInstall({ cwd: main, config, logFile })
  if ('skipped' in run) {
    return { result: 'skipped', detail: run.notice.replace(/^install skipped:\s*/, '') }
  }
  const seconds = `${(run.durationMs / 1000).toFixed(1)} s`
  if (run.ok) return passed(`\`${run.command}\` passed in ${main} (${seconds})`)
  const why = run.timedOut
    ? `timed out after ${seconds}`
    : run.code === null
      ? 'was ended by a signal'
      : `exited ${run.code}`
  return failed(`\`${run.command}\` ${why} in ${main}`, [{ command: run.command, dir: main }], {
    notes: [...run.tail.slice(-SHOWN_LINES).map((line) => `  ${line}`), `log: ${logFile}`],
  })
}

/**
 * Step 5: core.hooksPath of the clone points at `.githooks`, and the hooks' self test of 1.4a
 * passes in the main checkout.
 * @param {Scope} scope
 * @returns {Promise<Outcome>}
 */
async function hooksCheck({ git }) {
  const { changed } = await repairHooksPath(git)
  const test = await selfTestHooks(git)
  const hooksPath = `core.hooksPath ${changed ? 'set to' : 'is'} ${HOOKS_PATH}`
  if (test.ok) {
    const hooks = test.checks.slice(1).map((check) => check.name)
    return passed(`${hooksPath}; the self test passed for ${hooks.join(' and ')}`, {
      data: { checks: test.checks },
    })
  }
  const failures = test.checks.filter((check) => !check.ok)
  return failed(
    failures.map((check) => check.detail).join('; '),
    failures.flatMap((check) => (check.resolve === undefined ? [] : [check.resolve])),
    { data: { checks: test.checks } },
  )
}

/**
 * Step 6: the answer language and the explanation style go into local.yml and CLAUDE.local.md.
 * @param {Scope} scope
 * @returns {Promise<Outcome>}
 */
async function settingsCheck(scope) {
  const { ctx, main, answers, record } = scope
  const { language, explanation_style } = answers
  if (language === null || explanation_style === null) {
    const missing = Object.entries(answers)
      .filter(([, value]) => value === null)
      .map(([key]) => key)
    return failed(
      `no ${missing.join(' and ')}: join asks for them in an interactive terminal, or reads them from --answers <file>`,
      [{ command: 'hackwin join', dir: main }],
    )
  }
  if (record.language !== language || record.explanation_style !== explanation_style) {
    scope.record = { ...record, language, explanation_style }
    await writeLocal(ctx.gitCommonDir, scope.record)
  }
  await writeClaudeLocal(main, { language, explanation_style })
  return passed(
    `answer language ${language}, explanation style ${explanation_style}, in local.yml and CLAUDE.local.md`,
  )
}

/**
 * Step 7: `.env.local` exists in the main checkout whenever `.env.example` lists a key. The file
 * is never opened: only its existence is checked.
 * @param {Scope} scope
 * @returns {Promise<Outcome>}
 */
async function envCheck({ main }) {
  const keys = envKeys(await readOptional(join(main, '.env.example')))
  if (keys.length === 0) return passed('.env.example lists no key, so no .env.local is needed')
  const path = join(main, '.env.local')
  const count = `${keys.length} key${keys.length === 1 ? '' : 's'}`
  if (await exists(path)) return passed(`${path} is there for the ${count} of .env.example`)
  return failed(`.env.example lists ${count}, but ${path} does not exist`, [
    `ask the Lead for .env.local, sent over a private channel, and save it as ${path}`,
  ])
}

/**
 * The keys of a dotenv file: every line `KEY=...`, also with `export`; comments and blank
 * lines are not keys.
 * @param {string | null} text
 * @returns {string[]}
 */
export function envKeys(text) {
  if (text === null) return []
  return text
    .split(/\r?\n/)
    .map((line) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=/.exec(line)?.[1])
    .filter((key) => key !== undefined)
}

/**
 * Step 9: the worktrees of tasks whose pull request is merged are removed (A35).
 * @param {Scope} scope
 * @returns {Promise<Outcome>}
 */
async function worktreesCheck({ ctx }) {
  // Git where join started, so that the worktree join runs in is kept even when its task is merged.
  const { removed, kept } = await removeMergedWorktrees(ctx.git, ctx.github)
  // A worktree of a task that is still open is not news; one of a merged task that stays is.
  const stays = kept.filter(({ merged }) => merged)
  const detail =
    removed.length === 0
      ? 'no worktree of a merged task to remove'
      : `removed ${removed.length} worktree${removed.length === 1 ? '' : 's'} of merged tasks`
  return passed(detail, {
    data: { removed, kept },
    notes: [
      ...removed.map((path) => `removed ${path}`),
      ...stays.map(({ path, reason }) => `kept ${path}: ${reason}`),
    ],
  })
}

/**
 * Step 10: the member's queue (8.1): open tasks of their roles that wait to be taken.
 * @param {Scope} scope
 * @returns {Promise<Outcome>}
 */
async function queueCheck({ ctx, config, identity }) {
  const tasks = (await ctx.github.listIssues({ state: 'open' }))
    .map((issue) => toTask(issue, config))
    .filter((task) => task !== null)
  const queue = queueOf(tasks, identity.roles)
  const roles = identity.roles.join(', ') || 'none'
  const entries = queue.map((task) => {
    const block = /** @type {NonNullable<typeof task.block>} */ (task.block)
    return {
      number: task.number,
      title: task.title,
      status: task.status,
      role: block.role,
      wave: block.wave,
      deadline: block.deadline,
    }
  })
  const lines = entries.slice(0, SHOWN_LINES).map((task) => {
    const wave = task.wave === null ? '' : `, wave ${task.wave}`
    return `#${task.number} ${task.title}: ${task.status}, role ${task.role}${wave}, due ${task.deadline}`
  })
  if (entries.length > SHOWN_LINES) lines.push(`and ${entries.length - SHOWN_LINES} more`)
  const detail =
    entries.length === 0
      ? `empty: no open task of your roles (${roles}) waits to be taken`
      : `${entries.length} task${entries.length === 1 ? '' : 's'} of your roles (${roles})`
  return passed(detail, { data: { tasks: entries }, notes: lines })
}

// Helpers.

/**
 * @param {string} detail
 * @param {{ notes?: string[], data?: unknown }} [extra]
 * @returns {Outcome}
 */
function passed(detail, extra = {}) {
  return { result: 'passed', detail, ...extra }
}

/**
 * @param {string} detail
 * @param {Resolve[]} fixes
 * @param {{ notes?: string[], data?: unknown }} [extra]
 * @returns {Outcome}
 */
function failed(detail, fixes, extra = {}) {
  return { result: 'failed', detail, fixes, ...extra }
}

/**
 * The log file of the install: in the temporary directory, outside the checkout, one per clone;
 * each run replaces it.
 * @param {CommandContext} ctx
 * @returns {string}
 */
function installLog(ctx) {
  const clone = createHash('sha256').update(resolve(ctx.gitCommonDir)).digest('hex').slice(0, 12)
  return join(ctx.env.TMPDIR || tmpdir(), 'hackwin-join', clone, 'install.log')
}

/**
 * The text of a file, or null when it does not exist.
 * @param {string} file
 * @returns {Promise<string | null>}
 */
async function readOptional(file) {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
    throw error
  }
}

/**
 * True when the path exists. Only its metadata is read, never its content.
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function exists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false
    throw error
  }
}

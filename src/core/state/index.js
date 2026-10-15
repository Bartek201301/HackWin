// Local state of a clone (5.3, 6.4): the records under <git-common-dir>/hackwin/ that more than
// one lane reads or writes. Every worktree of a clone shares the git common directory, so every
// worktree sees the same state (A6). The formats are in docs/build/contracts.md, section 5.
//
// A record file that is missing, unreadable or of another schema reads as null, so the command
// that writes it can always run again and replace it (CM3). Writes are atomic: a temporary file
// in the same directory, then a rename.

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

/** The schema of every file that hackwin writes. */
export const STATE_SCHEMA = 1

/** The results a check of a green check record may have; a record never holds a failed check. */
export const CHECK_RESULTS = Object.freeze(['passed', 'skipped'])

/** The checks that `ship` records, steps 3 to 8 of 7.9; a green record has every one of them. */
export const CHECK_NAMES = Object.freeze([
  'scope',
  'secrets',
  'format',
  'generated',
  'check',
  'acceptance',
])

/** The checks of a green record that may be `skipped`: the project has no `commands.generate`. */
export const SKIPPABLE_CHECKS = Object.freeze(['generated'])

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/**
 * @typedef {object} StatePaths
 * @property {string} root `<gitCommonDir>/hackwin`
 * @property {string} local `local.yml`, the record of `join` and the personal settings.
 * @property {string} checks `checks/`, one green check record per commit.
 * @property {string} sessions `sessions/`, the last main commit per worktree and the last `status`.
 * @property {string} prompts `prompts/`, whose content belongs to lane B (`take`).
 * @property {string} gate `gate/`, whose content belongs to lane C (the Gate).
 * @property {string} logs `logs/`, the logs of the project commands that a command runs.
 */

/**
 * The record of `local.yml` (contracts 5.1).
 * @typedef {object} LocalRecord
 * @property {number} [schema] Always 1; writeLocal sets it.
 * @property {string} login The gh login of the member on this machine.
 * @property {string} [language] The answer language.
 * @property {string} [explanation_style] The explanation style.
 * @property {JoinRecord} [join] The record of the last `join` that exited 0; absent before.
 */

/**
 * @typedef {object} JoinRecord
 * @property {string} completed_at ISO 8601 time.
 * @property {string} cli_version
 */

/**
 * One check of a green check record (contracts 5.2).
 * @typedef {object} CheckResult
 * @property {string} name One of CHECK_NAMES.
 * @property {'passed' | 'skipped'} result
 * @property {number} [duration_ms]
 */

/**
 * The green check record of one commit (contracts 5.2).
 * @typedef {object} CheckRecord
 * @property {number} [schema] Always 1; writeCheckRecord sets it.
 * @property {string} sha The full SHA of the commit.
 * @property {string} branch `task/<N>-<slug>`
 * @property {number} issue
 * @property {string} created_at ISO 8601 time.
 * @property {string} cli_version
 * @property {CheckResult[]} checks
 */

/**
 * The last main commit seen in a worktree (contracts 5.3).
 * @typedef {object} MainSeen
 * @property {string} main_sha
 * @property {string} recorded_at ISO 8601 time.
 */

/**
 * The paths of the local state of a clone, absolute.
 * @param {string} gitCommonDir
 * @returns {StatePaths}
 */
export function statePaths(gitCommonDir) {
  if (!gitCommonDir) throw new TypeError('statePaths needs the git common directory')
  const root = join(resolve(gitCommonDir), 'hackwin')
  return {
    root,
    local: join(root, 'local.yml'),
    checks: join(root, 'checks'),
    sessions: join(root, 'sessions'),
    prompts: join(root, 'prompts'),
    gate: join(root, 'gate'),
    logs: join(root, 'logs'),
  }
}

// local.yml (contracts 5.1).

/**
 * The record of `local.yml`, or null when there is none.
 * @param {string} dir The git common directory.
 * @returns {Promise<LocalRecord | null>}
 */
export async function readLocal(dir) {
  const text = await readText(statePaths(dir).local)
  if (text === null) return null
  let record
  try {
    record = parseYaml(text)
  } catch {
    return null
  }
  if (!isRecord(record) || typeof record.login !== 'string') return null
  if (record.join !== undefined && record.join !== null && !isObject(record.join)) return null
  return /** @type {LocalRecord} */ (record)
}

/**
 * Write `local.yml`, replacing the earlier record.
 * @param {string} dir The git common directory.
 * @param {LocalRecord} record
 * @returns {Promise<void>}
 */
export async function writeLocal(dir, record) {
  if (!isObject(record) || typeof record.login !== 'string' || record.login === '') {
    throw new TypeError('writeLocal needs a record with the login')
  }
  const { schema, ...fields } = record
  await writeAtomic(statePaths(dir).local, stringifyYaml({ schema: STATE_SCHEMA, ...fields }))
}

/**
 * True when `join` is complete for this login: the record has `join`, and its `login` equals the
 * caller's. GitHub logins are compared without case, as GitHub compares them.
 * @param {LocalRecord | null | undefined} record
 * @param {string} login The caller's gh login.
 * @returns {boolean}
 */
export function isJoinComplete(record, login) {
  if (!record || !isObject(record.join) || typeof record.login !== 'string') return false
  return typeof login === 'string' && login !== '' && sameLogin(record.login, login)
}

// checks/<sha>.json (contracts 5.2).

/**
 * The green check record of a commit, or null when there is none.
 * @param {string} dir The git common directory.
 * @param {string} sha The full SHA of the commit.
 * @returns {Promise<CheckRecord | null>}
 */
export async function readCheckRecord(dir, sha) {
  if (!FULL_SHA.test(sha)) return null
  const record = await readJson(join(statePaths(dir).checks, `${sha}.json`))
  if (!isRecord(record) || record.sha !== sha || !Array.isArray(record.checks)) return null
  return /** @type {CheckRecord} */ (record)
}

/**
 * Write the green check record of `record.sha`. A record never holds a failed check, so a check
 * with another result than `passed` or `skipped` is a TypeError.
 * @param {string} dir The git common directory.
 * @param {CheckRecord} record
 * @returns {Promise<void>}
 */
export async function writeCheckRecord(dir, record) {
  if (!isObject(record) || !FULL_SHA.test(record.sha)) {
    throw new TypeError('writeCheckRecord needs a record with the full SHA of the commit')
  }
  if (!Array.isArray(record.checks) || record.checks.length === 0) {
    throw new TypeError('writeCheckRecord needs the checks that ran')
  }
  const failed = record.checks.filter((check) => !CHECK_RESULTS.includes(check?.result))
  if (failed.length > 0) {
    const names = failed.map((check) => check?.name).join(', ')
    throw new TypeError(`a green check record never holds a failed check: ${names}`)
  }
  const { schema, ...fields } = record
  const file = join(statePaths(dir).checks, `${record.sha}.json`)
  await writeAtomic(file, `${JSON.stringify({ schema: STATE_SCHEMA, ...fields }, null, 2)}\n`)
}

/**
 * True when the record is the green check record of this full SHA (E4): it is for this commit,
 * it holds every check of CHECK_NAMES, and every check passed, except that `generated` may be
 * skipped.
 * @param {CheckRecord | null | undefined} record
 * @param {string} sha
 * @returns {boolean}
 */
export function isGreen(record, sha) {
  if (!record || record.schema !== STATE_SCHEMA) return false
  if (!FULL_SHA.test(sha) || record.sha !== sha) return false
  if (!Array.isArray(record.checks)) return false
  const green = (/** @type {CheckResult | undefined} */ check) =>
    check?.result === 'passed' ||
    (check?.result === 'skipped' && SKIPPABLE_CHECKS.includes(check.name))
  return (
    record.checks.every(green) &&
    CHECK_NAMES.every((name) => record.checks.some((check) => check?.name === name))
  )
}

// sessions/ (contracts 5.3).

/**
 * The last main commit recorded for a worktree, or null.
 * @param {string} dir The git common directory.
 * @param {string} worktree The absolute path of the worktree.
 * @returns {Promise<MainSeen | null>}
 */
export async function readMainSeen(dir, worktree) {
  const path = absoluteWorktree(worktree)
  const record = toMainSeen(await readJson(mainSeenFile(dir, path)))
  return record && record.worktree === path ? pickMainSeen(record) : null
}

/**
 * The main commit recorded last anywhere in this clone, the record with the latest
 * `recorded_at` (7.7 step 6), or null when no worktree has one.
 * @param {string} dir The git common directory.
 * @returns {Promise<MainSeen | null>}
 */
export async function latestMainSeen(dir) {
  const folder = mainSeenDir(dir)
  /** @type {string[]} */
  let names
  try {
    names = await readdir(folder)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  /** @type {{ record: MainSeen, time: number } | null} */
  let latest = null
  for (const name of names.filter((entry) => entry.endsWith('.json')).sort()) {
    const record = toMainSeen(await readJson(join(folder, name)))
    if (!record) continue
    const time = Date.parse(record.recorded_at)
    if (latest === null || time > latest.time) latest = { record: pickMainSeen(record), time }
  }
  return latest?.record ?? null
}

/**
 * Record the main commit seen in a worktree. Each worktree has its own file, so two sessions
 * never write the same file.
 * @param {string} dir The git common directory.
 * @param {string} worktree The absolute path of the worktree.
 * @param {string} sha The main commit.
 * @param {Date | string} time
 * @returns {Promise<void>}
 */
export async function writeMainSeen(dir, worktree, sha, time) {
  if (!FULL_SHA.test(sha)) throw new TypeError('writeMainSeen needs the full SHA of the commit')
  const path = absoluteWorktree(worktree)
  const record = { schema: STATE_SCHEMA, worktree: path, main_sha: sha, recorded_at: isoTime(time) }
  await writeAtomic(mainSeenFile(dir, path), `${JSON.stringify(record, null, 2)}\n`)
}

/**
 * The time of the member's last `status` call, or null.
 * @param {string} dir The git common directory.
 * @returns {Promise<string | null>}
 */
export async function readLastStatus(dir) {
  const record = await readJson(statusFile(dir))
  if (!isRecord(record) || !isTime(record.last_status_at)) return null
  return record.last_status_at
}

/**
 * Record the time of the member's `status` call.
 * @param {string} dir The git common directory.
 * @param {Date | string} time
 * @returns {Promise<void>}
 */
export async function writeLastStatus(dir, time) {
  const record = { schema: STATE_SCHEMA, last_status_at: isoTime(time) }
  await writeAtomic(statusFile(dir), `${JSON.stringify(record, null, 2)}\n`)
}

// prompts/, gate/ and logs/ (contracts 5.6): only their paths; the lanes own the content.

/**
 * The path of the prompt file of a task: `prompts/<issue>.md`. Lane B (`take`) writes it.
 * @param {string} dir The git common directory.
 * @param {number} issue
 * @returns {string}
 */
export function promptPath(dir, issue) {
  if (!Number.isInteger(issue) || issue < 1) {
    throw new TypeError(`promptPath needs an issue number, not ${issue}`)
  }
  return join(statePaths(dir).prompts, `${issue}.md`)
}

/**
 * The directory of the Gate's local files: `gate/`. Lane C owns its content.
 * @param {string} dir The git common directory.
 * @returns {string}
 */
export function gateDir(dir) {
  return statePaths(dir).gate
}

/**
 * The log of one step of `ship` for a task: `logs/ship/<issue>/<step>.log`, for example
 * `check.log`. Lane B (`ship`) writes it and replaces it on each run.
 * @param {string} dir The git common directory.
 * @param {number} issue
 * @param {string} step The name of the check, such as `check` or `acceptance`.
 * @returns {string}
 */
export function shipLogPath(dir, issue, step) {
  if (!Number.isInteger(issue) || issue < 1) {
    throw new TypeError(`shipLogPath needs an issue number, not ${issue}`)
  }
  if (!/^[a-z][a-z0-9-]*$/.test(step)) throw new TypeError(`not a step name: ${step}`)
  return join(statePaths(dir).logs, 'ship', String(issue), `${step}.log`)
}

// File helpers, also for the lanes' own files under the git common directory.

/**
 * The text of a file, or null when it does not exist (also when a directory on its path is a
 * file) or is a directory.
 * @param {string} file
 * @returns {Promise<string | null>}
 */
export async function readText(file) {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR' || error.code === 'ENOTDIR') return null
    throw error
  }
}

/**
 * The parsed JSON of a text, or null when it is not JSON.
 * @param {string} text
 * @returns {unknown}
 */
export function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Write a file atomically: a temporary file in the same directory, then a rename. The directory
 * is created when it is missing.
 * @param {string} file
 * @param {string} text
 * @returns {Promise<void>}
 */
export async function writeAtomic(file, text) {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temporary, text)
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

// Helpers.

/**
 * @param {string} dir
 * @returns {string}
 */
function mainSeenDir(dir) {
  return join(statePaths(dir).sessions, 'main-seen')
}

/**
 * `main-seen/<key>.json`, the key being the first 16 hex digits of the SHA-256 of the path.
 * @param {string} dir
 * @param {string} worktree An absolute path.
 * @returns {string}
 */
function mainSeenFile(dir, worktree) {
  const key = createHash('sha256').update(worktree).digest('hex').slice(0, 16)
  return join(mainSeenDir(dir), `${key}.json`)
}

/**
 * @param {string} dir
 * @returns {string}
 */
function statusFile(dir) {
  return join(statePaths(dir).sessions, 'status.json')
}

/**
 * @param {string} worktree
 * @returns {string}
 */
function absoluteWorktree(worktree) {
  if (typeof worktree !== 'string' || !isAbsolute(worktree)) {
    throw new TypeError(`the worktree path must be absolute, not ${worktree}`)
  }
  return resolve(worktree)
}

/**
 * @param {unknown} record
 * @returns {(MainSeen & { worktree: string }) | null}
 */
function toMainSeen(record) {
  if (!isRecord(record)) return null
  if (typeof record.worktree !== 'string' || typeof record.main_sha !== 'string') return null
  if (!isTime(record.recorded_at)) return null
  return /** @type {MainSeen & { worktree: string }} */ (record)
}

/**
 * @param {MainSeen} record
 * @returns {MainSeen}
 */
function pickMainSeen(record) {
  return { main_sha: record.main_sha, recorded_at: record.recorded_at }
}

/**
 * An ISO 8601 time: a Date is written in UTC; a string must already be a valid time.
 * @param {Date | string} time
 * @returns {string}
 */
function isoTime(time) {
  if (time instanceof Date && !Number.isNaN(time.getTime())) return time.toISOString()
  if (isTime(time)) return /** @type {string} */ (time)
  throw new TypeError(`not a time: ${time}`)
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isTime(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * A parsed record of the current schema.
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isRecord(value) {
  return isObject(value) && value.schema === STATE_SCHEMA
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function sameLogin(a, b) {
  return a.toLowerCase() === b.toLowerCase()
}

/**
 * The parsed JSON of a file, or null when it does not exist or is not JSON.
 * @param {string} file
 * @returns {Promise<unknown>}
 */
async function readJson(file) {
  const text = await readText(file)
  return text === null ? null : parseJson(text)
}

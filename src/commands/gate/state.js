// The Gate's local files under `<git-common-dir>/hackwin/gate/` (6.4): the state file
// `state.json` of 9.6 (G4), the heartbeat (G5) and the id of this clone's Gate. They are written
// atomically with `writeAtomic` of `src/core/state`: a temporary file in the same directory, then
// a rename, so a crash never leaves half a file behind.

import { randomBytes } from 'node:crypto'
import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import { gateDir, parseJson, readText, writeAtomic } from '../../core/state/index.js'

/** The schema of every file the Gate writes. */
export const GATE_SCHEMA = 1

/**
 * @typedef {object} GateFiles
 * @property {string} root `gate/`
 * @property {string} state `state.json`, the state file (9.6).
 * @property {string} heartbeat `heartbeat`, renewed at every poll and stage change (G5).
 * @property {string} digest `digest.log`, one line per pull request run (9.6).
 * @property {string} lock `gate.lock`, held by the running Gate (7.5 step 2).
 * @property {string} id `gate-id`, the id of this clone's Gate, which the status issue shows.
 * @property {string} logs `logs/`, the full logs of the stage commands.
 * @property {string} cache `cache/`, the dependency install cache (A11).
 * @property {string} worktrees `worktrees/`, the scratch worktrees.
 */

/**
 * The paths of the Gate's files in a clone (6.4).
 * @param {string} gitCommonDir
 * @returns {GateFiles}
 */
export function gateFiles(gitCommonDir) {
  const root = gateDir(gitCommonDir)
  return {
    root,
    state: join(root, 'state.json'),
    heartbeat: join(root, 'heartbeat'),
    digest: join(root, 'digest.log'),
    lock: join(root, 'gate.lock'),
    id: join(root, 'gate-id'),
    logs: join(root, 'logs'),
    cache: join(root, 'cache'),
    worktrees: join(root, 'worktrees'),
  }
}

/**
 * The state file of 9.6. The keys `hotspots` and, per pull request, `pushed_by_gate`,
 * `script_fixes` and `resolver` belong to Phase 3 and stay empty in Phase 1.
 * @typedef {object} GateState
 * @property {number} schema
 * @property {number} starts How often a Gate started; every start after the first is a restart (M7).
 * @property {string | null} main_sha
 * @property {string | null} last_poll_at
 * @property {string | null} last_github_ok_at
 * @property {{ main_sha: string | null, result: 'passed' | 'failed' | null }} last_smoke
 * @property {Array<{ from: string, to: string }>} heartbeat_gaps
 * @property {{ number: number | null, last_edit_at: string | null }} status_issue
 * @property {number[]} queue Pull request numbers, the head of the queue first.
 * @property {Record<string, PullRecord>} prs By pull request number.
 * @property {AttentionItem[]} attention
 * @property {unknown[]} hotspots Phase 3.
 * @property {Streaks} streaks The failures in a row that make a repeated failure (G23, A24):
 *   a key of this Gate beside those of 9.6.
 */

/**
 * Runs in a row that failed the same stage (G23), with the newest last.
 * @typedef {object} Streak
 * @property {string} stage
 * @property {Array<{ pr: number, sha: string, at: string }>} runs
 */

/**
 * @typedef {object} Streaks
 * @property {Streak | null} queue The queue items in a row whose runs failed the same stage.
 * @property {Record<string, Streak>} prs By pull request: its head SHAs in a row whose runs failed
 *   the same stage.
 */

/**
 * @typedef {object} PullRecord
 * @property {string} head_sha
 * @property {string} first_seen_at
 * @property {string | null} secret_scanned_sha
 * @property {string | null} stage
 * @property {string | null} result
 * @property {string | null} tested_main_sha
 * @property {string[]} gated
 * @property {number} ci_reruns
 * @property {string[]} pushed_by_gate Phase 3.
 * @property {string[]} script_fixes Phase 3.
 * @property {unknown[]} resolver Phase 3.
 * @property {Array<{ stage: string, sha: string, at: string }>} failures
 * @property {Record<string, number>} stage_times Seconds per stage.
 * @property {boolean} [merge_unknown] True when the run of this head ended failed or was given
 *   up at stage 10 without a readable answer whether GitHub merged it: a fault of the Gate, not a
 *   refusal of the merge. Intake then takes a later merge of the head as the Gate's own. A key of
 *   this Gate beside those of 9.6.
 */

/**
 * @typedef {object} AttentionItem
 * @property {string} type `migration`, `production-config`, `scope-violation`, `repeated-failure` or `secret`.
 * @property {number} pr
 * @property {string} since
 * @property {string} todo
 * @property {string | null} resolved_at
 * @property {string | null} [stage] For a repeated failure: the stage whose pass closes it
 *   (9.6). A key of this Gate beside those of 9.6.
 * @property {boolean} [across] For a repeated failure across queue items: the pass of any queue
 *   item closes it, not only one of its own pull request.
 */

/**
 * The state of a Gate that never ran.
 * @returns {GateState}
 */
export function emptyState() {
  return {
    schema: GATE_SCHEMA,
    starts: 0,
    main_sha: null,
    last_poll_at: null,
    last_github_ok_at: null,
    last_smoke: { main_sha: null, result: null },
    heartbeat_gaps: [],
    status_issue: { number: null, last_edit_at: null },
    queue: [],
    prs: {},
    attention: [],
    hotspots: [],
    streaks: { queue: null, prs: {} },
  }
}

/**
 * The record of a pull request whose head SHA the Gate sees for the first time, for intake.
 * @param {string} headSha The full SHA.
 * @param {string} time ISO 8601.
 * @returns {PullRecord}
 */
export function pullRecord(headSha, time) {
  return {
    head_sha: headSha,
    first_seen_at: time,
    secret_scanned_sha: null,
    stage: null,
    result: null,
    tested_main_sha: null,
    gated: [],
    ci_reruns: 0,
    pushed_by_gate: [],
    script_fixes: [],
    resolver: [],
    failures: [],
    stage_times: {},
  }
}

/**
 * True when the secret scan failed the record's head SHA, at intake or at stage 4: `retry` never
 * queues that head SHA again, a new head SHA without the secret joins the queue.
 * @param {PullRecord} record
 * @returns {boolean}
 */
export function addsSecret(record) {
  return record.failures.some(
    (failure) => failure.stage === 'secrets' && failure.sha === record.head_sha,
  )
}

/**
 * Load the state file. A missing file is the state of a Gate that never ran. A file that is not
 * a state of this schema is kept beside it under another name, so nothing is lost, and the Gate
 * starts from an empty state; `kept` names that file.
 * @param {string} file
 * @param {Date} now For the name of a kept file.
 * @returns {Promise<{ state: GateState, kept: string | null }>}
 */
export async function loadState(file, now) {
  const text = await readText(file)
  if (text === null) return { state: emptyState(), kept: null }
  const loaded = parseJson(text)
  if (!isObject(loaded) || loaded.schema !== GATE_SCHEMA) {
    const kept = `${file}.unreadable-${now.toISOString().replace(/[:.]/g, '-')}`
    await rename(file, kept)
    return { state: emptyState(), kept }
  }
  const state = emptyState()
  for (const [key, fallback] of Object.entries(state)) {
    if (sameKind(loaded[key], fallback)) /** @type {any} */ (state)[key] = loaded[key]
  }
  state.streaks = cleanStreaks(state.streaks)
  return { state, kept: null }
}

/**
 * The streaks of a loaded state file: anything that is not a streak reads as none.
 * @param {unknown} value
 * @returns {Streaks}
 */
export function cleanStreaks(value) {
  const loaded = isObject(value) ? value : {}
  /** @type {Record<string, Streak>} */
  const prs = {}
  for (const [key, streak] of Object.entries(isObject(loaded.prs) ? loaded.prs : {})) {
    if (/^[1-9]\d*$/.test(key) && isStreak(streak)) prs[key] = streak
  }
  return { queue: isStreak(loaded.queue) ? loaded.queue : null, prs }
}

/**
 * @param {unknown} value
 * @returns {value is Streak}
 */
function isStreak(value) {
  return (
    isObject(value) &&
    typeof value.stage === 'string' &&
    Array.isArray(value.runs) &&
    value.runs.every(
      (/** @type {unknown} */ run) =>
        isObject(run) &&
        Number.isInteger(run.pr) &&
        typeof run.sha === 'string' &&
        typeof run.at === 'string',
    )
  )
}

/**
 * Write the state file.
 * @param {string} file
 * @param {GateState} state
 * @returns {Promise<void>}
 */
export async function saveState(file, state) {
  await writeAtomic(file, `${JSON.stringify(state, null, 2)}\n`)
}

/**
 * The heartbeat file: the loop is alive at `heartbeat_at`, and GitHub last answered at
 * `last_github_ok_at` (7.5, failure behavior). `stopped_at` is set by `quit`.
 * @typedef {object} Heartbeat
 * @property {number} schema
 * @property {number} pid
 * @property {string} heartbeat_at
 * @property {string | null} last_github_ok_at
 * @property {string | null} stopped_at
 */

/**
 * @param {string} file
 * @param {Omit<Heartbeat, 'schema'>} heartbeat
 * @returns {Promise<void>}
 */
export async function writeHeartbeat(file, heartbeat) {
  await writeAtomic(file, `${JSON.stringify({ schema: GATE_SCHEMA, ...heartbeat })}\n`)
}

/**
 * The heartbeat, or null when there is none.
 * @param {string} file
 * @returns {Promise<Heartbeat | null>}
 */
export async function readHeartbeat(file) {
  const text = await readText(file)
  const heartbeat = text === null ? null : parseJson(text)
  if (!isObject(heartbeat) || heartbeat.schema !== GATE_SCHEMA) return null
  if (typeof heartbeat.heartbeat_at !== 'string') return null
  return /** @type {Heartbeat} */ (heartbeat)
}

/** A Gate id: 16 hex digits, random, made once per clone. */
const GATE_ID = /^[0-9a-f]{16}$/

/**
 * The id of this clone's Gate, which tells its heartbeat in the status issue from another
 * clone's. It is random and says nothing about the machine. The first call in a clone makes it;
 * a missing or unreadable file gets a new one, and `created` says so.
 * @param {string} file
 * @param {Date} now
 * @returns {Promise<{ id: string, created: boolean }>}
 */
export async function loadGateId(file, now) {
  const text = await readText(file)
  const record = text === null ? null : parseJson(text)
  if (isObject(record) && record.schema === GATE_SCHEMA && GATE_ID.test(record.gate_id)) {
    return { id: record.gate_id, created: false }
  }
  const id = randomBytes(8).toString('hex')
  await writeAtomic(
    file,
    `${JSON.stringify({ schema: GATE_SCHEMA, gate_id: id, created_at: now.toISOString() })}\n`,
  )
  return { id, created: true }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * True when a loaded value may stand for the default: an array for an array, an object for an
 * object, a number for a number, a string or null for null.
 * @param {unknown} value
 * @param {unknown} fallback
 */
function sameKind(value, fallback) {
  if (Array.isArray(fallback)) return Array.isArray(value)
  if (isObject(fallback)) return isObject(value)
  if (typeof fallback === 'number') return Number.isInteger(value) && Number(value) >= 0
  if (fallback === null) return value === null || typeof value === 'string'
  return typeof value === typeof fallback
}

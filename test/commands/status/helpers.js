// Helpers of the tests of `status`: task issues and a status issue for the fake GitHub's state,
// a clock that stands still, and `hackwin status` run in-process.

import { main } from '../../../src/cli/main.js'
import {
  STATUS_LABEL,
  STATUS_TITLE,
  formatStatusBody,
} from '../../../src/commands/gate/status-issue.js'
import { yaml } from '../../harness/index.js'

/** @typedef {import('../../../src/commands/gate/status-issue.js').GateStatus} GateStatus */
/** @typedef {import('../../../src/core/github/index.js').GhExecutor} GhExecutor */

/**
 * The body of a task issue written by hand from the template (8.1).
 * @param {{ role: string, wave?: number | null, paths?: string[], dependsOn?: number[], deadline?: string | null }} block
 *   A null deadline leaves it out, which makes the block invalid.
 * @returns {string}
 */
export function taskBody({ role, wave = 1, paths, dependsOn = [], deadline }) {
  /** @type {Record<string, unknown>} */
  const data = {
    kind: 'task',
    role,
    wave,
    paths: paths ?? [`src/features/${role}/**`],
    depends_on: dependsOn,
    acceptance_tests: ['test/features.test.js'],
  }
  if (wave === null) delete data.wave
  if (deadline !== null) data.deadline = deadline ?? '2026-10-25T12:00:00+02:00'
  return [
    '```yaml',
    '# hackwin:task',
    yaml(data).trimEnd(),
    '```',
    '',
    '## Problem',
    'Missing.',
  ].join('\n')
}

/**
 * A task issue for the fake GitHub's initial state.
 * @param {number} number
 * @param {{ role: string, title?: string, status?: string | null, assignees?: string[], wave?: number | null, dependsOn?: number[], deadline?: string | null, state?: 'open' | 'closed', labels?: string[], milestone?: number | null }} task
 *   `milestone` is the number of a milestone of the fake's state.
 */
export function taskIssue(number, task) {
  const { status = 'ready', assignees = [], state = 'open', labels = [], milestone = null } = task
  return {
    number,
    title: task.title ?? `Task ${number}`,
    body: taskBody(task),
    state,
    assignees,
    labels: [...(status === null ? [] : [status]), `role:${task.role}`, ...labels],
    milestone,
  }
}

/**
 * The status issue as the Gate writes it (9.6).
 * @param {number} number
 * @param {Partial<GateStatus> & { heartbeat_at: string }} status
 */
export function statusIssue(number, status) {
  /** @type {GateStatus} */
  const full = {
    stopped_at: null,
    starts: 1,
    gate_id: '0123456789abcdef',
    protection: 'full-restricted',
    update_restricted: true,
    queue: [],
    attention: [],
    digest: [],
    ...status,
  }
  return {
    number,
    title: STATUS_TITLE,
    body: formatStatusBody(full).body,
    labels: [STATUS_LABEL],
    pinned: true,
  }
}

/**
 * A clock that stands at one time.
 * @param {string} iso
 */
export function fixedClock(iso) {
  return { now: () => new Date(iso), sleep: async () => {} }
}

/**
 * Run `hackwin status` in-process.
 * @param {{ cwd: string, env: Record<string, string | undefined>, executor: GhExecutor, clock: { now: () => Date, sleep: (ms: number) => Promise<void> }, json?: boolean }} options
 * @returns {Promise<{ code: number, out: string, err: string, lines: string[], json: any }>}
 */
export async function runStatus({ cwd, env, executor, clock, json = false }) {
  let out = ''
  let err = ''
  const code = await main(json ? ['status', '--json'] : ['status'], {
    cwd,
    env,
    stdin: /** @type {any} */ ({ isTTY: false }),
    stdout: { write: (/** @type {string} */ chunk) => ((out += chunk), true) },
    stderr: { write: (/** @type {string} */ chunk) => ((err += chunk), true) },
    clock,
    ghExecutor: executor,
  })
  return {
    code,
    out,
    err,
    lines: out.split('\n').filter((line) => line !== ''),
    json: json ? JSON.parse(out) : null,
  }
}

/**
 * The lines of the sections from `attention` up to the Gate digest: the part of the output that
 * the same GitHub state makes the same on every machine (AC44).
 * @param {string[]} lines
 */
export function sharedSections(lines) {
  const start = lines.findIndex((line) => line.startsWith('attention'))
  const end = lines.findIndex((line) => line.startsWith('gate digest'))
  return lines.slice(start, end)
}

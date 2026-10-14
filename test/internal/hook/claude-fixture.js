// Helpers of the Claude Code hook tests. No test starts a Claude Code session (plan section 9,
// decision 9): the tests feed hook events to the handlers. The events have the fields and the
// form that the hooks reference of Claude Code documents for its command hooks
// (https://code.claude.com/docs/en/hooks, read 2026-10-15): the common fields, `tool_name` and
// `tool_input` for tool events, `tool_response` after a tool, `source` at session start. The
// hooks run as the settings call them: `hackwin internal hook <name>` without --json, the event
// as JSON on stdin, the answer on stdout.

import { Readable } from 'node:stream'
import { main } from '../../../src/cli/main.js'

/** @typedef {import('../../harness/index.js').FakeGitHub} FakeGitHub */
/** @typedef {import('../../../src/core/runtime/clock.js').Clock} Clock */

const SESSION = 'f3b1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d'

/**
 * The fields every hook event carries.
 * @param {string} cwd
 * @param {string} name
 * @param {string} [mode]
 */
function common(cwd, name, mode = 'default') {
  return {
    session_id: SESSION,
    transcript_path: `/Users/member/.claude/projects/app/${SESSION}.jsonl`,
    cwd,
    permission_mode: mode,
    hook_event_name: name,
  }
}

/**
 * A PreToolUse event.
 * @param {string} cwd
 * @param {string} tool
 * @param {Record<string, unknown>} input
 * @param {{ mode?: string }} [options] `bypassPermissions` for a session with bypass permissions.
 */
export function preToolUse(cwd, tool, input, { mode } = {}) {
  return {
    ...common(cwd, 'PreToolUse', mode),
    tool_name: tool,
    tool_input: input,
    tool_use_id: 'toolu_01HackWinTestCall',
  }
}

/**
 * A Bash call before it runs.
 * @param {string} cwd
 * @param {string} command
 * @param {{ mode?: string }} [options]
 */
export function bashCall(cwd, command, options) {
  return preToolUse(
    cwd,
    'Bash',
    { command, description: 'Run a command', timeout: 120000, run_in_background: false },
    options,
  )
}

/**
 * An Edit call before it runs; `file_path` is absolute.
 * @param {string} cwd
 * @param {string} file
 * @param {{ mode?: string }} [options]
 */
export function editCall(cwd, file, options) {
  return preToolUse(
    cwd,
    'Edit',
    { file_path: file, old_string: 'one', new_string: 'two', replace_all: false },
    options,
  )
}

/**
 * A Write call before it runs.
 * @param {string} cwd
 * @param {string} file
 */
export function writeCall(cwd, file) {
  return preToolUse(cwd, 'Write', { file_path: file, content: 'export const value = 1\n' })
}

/**
 * A PostToolUse event after an Edit or a Write.
 * @param {string} cwd
 * @param {'Edit' | 'Write'} tool
 * @param {string} file
 */
export function afterEdit(cwd, tool, file) {
  return {
    ...common(cwd, 'PostToolUse'),
    tool_name: tool,
    tool_input:
      tool === 'Write'
        ? { file_path: file, content: '...' }
        : { file_path: file, old_string: 'one', new_string: 'two', replace_all: false },
    tool_response: { filePath: file, type: tool === 'Write' ? 'create' : 'update' },
    tool_use_id: 'toolu_01HackWinTestCall',
    duration_ms: 12,
  }
}

/**
 * A SessionStart event.
 * @param {string} cwd
 * @param {'startup' | 'resume' | 'clear' | 'compact'} [source]
 */
export function sessionStart(cwd, source = 'startup') {
  return { ...common(cwd, 'SessionStart'), source, model: 'claude-opus-5-5' }
}

/**
 * Run `hackwin internal hook <hook>` in-process with an event on stdin, as the settings call it.
 * `output` is the JSON answer on stdout, or null when the hook printed nothing.
 * @param {string} hook
 * @param {object} options
 * @param {string} options.cwd
 * @param {Record<string, string | undefined>} options.env
 * @param {unknown} options.event
 * @param {FakeGitHub} [options.fake] Answers the GitHub calls, as `login`.
 * @param {string} [options.login]
 * @param {Clock} [options.clock]
 */
export async function runClaudeHook(hook, { cwd, env, event, fake, login, clock }) {
  let stdout = ''
  let stderr = ''
  const code = await main(['internal', 'hook', hook], {
    cwd,
    env,
    stdin: Readable.from([JSON.stringify(event)]),
    stdout: { write: (chunk) => (stdout += chunk) },
    stderr: { write: (chunk) => (stderr += chunk) },
    ...(fake ? { ghExecutor: login ? fake.as(login) : fake.executor } : {}),
    ...(clock ? { clock } : {}),
  })
  const text = stdout.trim()
  const output = text.startsWith('{') ? JSON.parse(text) : null
  return { code, stdout, stderr, output }
}

/**
 * The reason of a PreToolUse decision `deny`, or null when the hook did not refuse the call.
 * @param {{ output: any }} result
 * @returns {string | null}
 */
export function denial(result) {
  const decision = result.output?.hookSpecificOutput
  if (!decision) return null
  if (decision.hookEventName !== 'PreToolUse' || decision.permissionDecision !== 'deny') {
    throw new Error(`not a PreToolUse denial: ${JSON.stringify(result.output)}`)
  }
  return decision.permissionDecisionReason
}

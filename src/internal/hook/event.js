// The Claude Code hook events (10.4). Claude Code passes each event as one JSON object on stdin
// (`hook_event_name`, `cwd`, and for tool events `tool_name` and `tool_input`), and reads the
// hook's answer from stdout and its exit code. A PreToolUse hook that exits 1 does not block the
// tool, so the hooks never block by exit code: a refusal is the JSON decision `deny`, which also
// holds in bypass permissions mode (docs/verification.md, row 2). Exit code 2 stays for errors
// such as an older CLI (CM12); before a tool call it blocks the call as well.

import { isAbsolute } from 'node:path'
import { UsageError } from '../../core/runtime/errors.js'
import { formatError } from '../../core/runtime/output.js'

/** @import { CommandContext, CommandResult } from '../../cli/context.js' */
/** @import { BlockedError } from '../../core/runtime/errors.js' */

/**
 * The fields of a hook event that the hooks read.
 * @typedef {object} HookEvent
 * @property {string} [hook_event_name] `SessionStart`, `PreToolUse` or `PostToolUse`.
 * @property {string} [cwd] The session's current directory.
 * @property {string} [tool_name] For tool events: `Bash`, `Edit`, `Write`, ...
 * @property {Record<string, unknown>} [tool_input] For tool events: the arguments of the call.
 */

/**
 * The tools that change one file, with the field of `tool_input` that names it (absolute).
 * @type {Readonly<Record<string, string>>}
 */
export const EDIT_FIELDS = Object.freeze({
  Edit: 'file_path',
  MultiEdit: 'file_path',
  Write: 'file_path',
  NotebookEdit: 'notebook_path',
})

/**
 * Read the event from stdin. A hook run by hand without an event gets an empty one where
 * `optional` allows it.
 * @param {CommandContext} ctx
 * @param {string} name The event the hook is for.
 * @param {{ optional?: boolean }} [options]
 * @returns {Promise<HookEvent>}
 */
export async function readHookEvent(ctx, name, { optional = false } = {}) {
  const text = (await ctx.readStdin()).trim()
  if (text === '' && optional) return {}
  const usage = `hackwin ${ctx.command} expects the ${name} event of Claude Code as a JSON object on stdin`
  /** @type {unknown} */
  let event
  try {
    event = JSON.parse(text)
  } catch {
    throw new UsageError(usage)
  }
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    throw new UsageError(usage)
  }
  const { hook_event_name: received } = /** @type {HookEvent} */ (event)
  if (received !== undefined && received !== name) {
    throw new UsageError(`${usage}, not the ${received} event`)
  }
  return /** @type {HookEvent} */ (event)
}

/**
 * The directory the event happened in: its `cwd`, or the directory of the hook.
 * @param {CommandContext} ctx
 * @param {HookEvent} event
 * @returns {string}
 */
export function eventDir(ctx, event) {
  return typeof event.cwd === 'string' && isAbsolute(event.cwd) ? event.cwd : ctx.cwd
}

/**
 * The file that an edit tool changes, as the event names it, or null for another tool.
 * @param {HookEvent} event
 * @returns {string | null}
 */
export function editedFile(event) {
  const field = Object.hasOwn(EDIT_FIELDS, event.tool_name ?? '')
    ? EDIT_FIELDS[event.tool_name ?? '']
    : null
  const value = field === null ? undefined : event.tool_input?.[field]
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * The answer of the PreToolUse hook that refuses the tool call: the decision `deny`, with the
 * block as the reason that Claude Code shows the session (CM5).
 * @param {BlockedError} block
 * @returns {CommandResult}
 */
export function denyToolCall(block) {
  const reason = formatError(block).join('\n')
  const output = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }
  return { lines: [JSON.stringify(output)], data: { decision: 'deny', ...block.toJSON() } }
}

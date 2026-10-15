// The Claude Code settings (6.4, 10.4): `.claude/settings.json` holds HackWin's three hooks, each
// a single call to `hackwin internal hook <name>`, and the deny rules for reading env files, for
// `gh pr merge`, for a merge through `gh api` and for pushes to the default branch. The file
// belongs to the Lead, so it is not a generated file: HackWin adds or replaces only its own keys
// and list entries and keeps everything else (6.5).
//
// The deny rules use the patterns of docs/verification.md, row 2: they match the usual
// spellings of a merge through `gh api`, not every spelling (the gap of 10.6). The PreToolUse
// hook refuses the same commands, also in bypass permissions mode.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PreconditionError } from '../core/runtime/errors.js'

/** The path of the settings file, relative to the repository root. */
export const SETTINGS_PATH = '.claude/settings.json'

/** The tools whose calls the PreToolUse hook checks: commands and file edits. */
export const CHECKED_TOOLS = Object.freeze(['Bash', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

/** The tools after which the PostToolUse hook formats the changed file. */
export const FORMATTED_TOOLS = Object.freeze(['Edit', 'MultiEdit', 'Write'])

/**
 * HackWin's Claude Code hooks: the event, the hook of `hackwin internal hook`, and the tools it
 * runs for (null: every call of the event).
 * @type {ReadonlyArray<{ event: string, hook: string, tools: readonly string[] | null }>}
 */
export const CLAUDE_HOOKS = Object.freeze([
  { event: 'SessionStart', hook: 'session-start', tools: null },
  { event: 'PreToolUse', hook: 'pre-tool-use', tools: CHECKED_TOOLS },
  { event: 'PostToolUse', hook: 'post-tool-use', tools: FORMATTED_TOOLS },
])

/** The deny rules for reading env files (E6), as the template has them. */
export const ENV_READ_RULES = Object.freeze([
  'Read(./.env)',
  'Read(./.env.local)',
  'Read(./.env.*.local)',
])

/** The deny rules for a merge by an agent session (E3, D2): docs/verification.md, row 2. */
export const MERGE_RULES = Object.freeze([
  'Bash(gh pr merge *)',
  'Bash(gh api *pulls/*/merge*)',
  'Bash(gh api *mergePullRequest*)',
])

/**
 * What the settings are rendered from.
 * @typedef {object} SettingsInput
 * @property {string} defaultBranch `project.default_branch` of hackwin.yml.
 */

/**
 * The deny rules for a push to the default branch (E2, E18): the branch as a refspec of its own,
 * as the destination of `<src>:<dst>`, forced with `+`, or spelled `refs/heads/<branch>`, and a
 * push of every branch.
 * @param {string} branch
 * @returns {string[]}
 */
export function pushRules(branch) {
  if (!branch) throw new TypeError('the push rules need the default branch')
  return [
    `Bash(git push * ${branch})`,
    `Bash(git push * ${branch} *)`,
    `Bash(git push *:${branch})`,
    `Bash(git push *:${branch} *)`,
    `Bash(git push *+${branch})`,
    `Bash(git push *+${branch} *)`,
    `Bash(git push *refs/heads/${branch})`,
    `Bash(git push *refs/heads/${branch} *)`,
    'Bash(git push *--all*)',
    'Bash(git push *--branches*)',
    'Bash(git push *--mirror*)',
  ]
}

/**
 * HackWin's entries of `permissions.deny`.
 * @param {SettingsInput} input
 * @returns {string[]}
 */
export function denyRules({ defaultBranch }) {
  return [...ENV_READ_RULES, ...MERGE_RULES, ...pushRules(defaultBranch)]
}

/**
 * The command of a HackWin hook.
 * @param {string} hook
 * @returns {string}
 */
export function hookCommand(hook) {
  return `hackwin internal hook ${hook}`
}

/**
 * Merge HackWin's keys and list entries into the text of an existing settings file (6.5):
 * every missing HackWin deny rule is appended to `permissions.deny`, and every HackWin hook
 * handler, a command that starts with `hackwin internal hook`, is replaced by the current one,
 * in the place of the first one it replaces. Every other key, rule and hook stays as it is.
 * @param {string | null} text The existing file, or null when there is none.
 * @param {SettingsInput} input
 * @returns {string} The new file, formatted with two spaces.
 */
export function mergeClaudeSettings(text, input) {
  const settings = parseSettings(text)
  const permissions = objectAt(settings, 'permissions')
  const deny = arrayAt(permissions, 'deny', 'permissions.deny')
  const missing = denyRules(input).filter((rule) => !deny.includes(rule))
  const merged = {
    ...settings,
    permissions: { ...permissions, deny: [...deny, ...missing] },
    hooks: mergeHooks(objectAt(settings, 'hooks')),
  }
  return `${JSON.stringify(merged, null, 2)}\n`
}

/**
 * Write the settings into a checkout, keeping what the existing file holds.
 * @param {string} root The top-level directory of the checkout.
 * @param {SettingsInput} input
 * @returns {Promise<{ path: string, content: string, changed: boolean }>}
 */
export async function writeClaudeSettings(root, input) {
  const file = join(root, SETTINGS_PATH)
  /** @type {string | null} */
  let existing = null
  try {
    existing = await readFile(file, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const content = mergeClaudeSettings(existing, input)
  if (content !== existing) {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, content)
  }
  return { path: SETTINGS_PATH, content, changed: content !== existing }
}

/**
 * True for a hook handler that HackWin wrote: a command that calls `hackwin internal hook`.
 * @param {unknown} handler
 * @returns {boolean}
 */
export function isHackwinHandler(handler) {
  return (
    isObject(handler) &&
    typeof handler.command === 'string' &&
    handler.command.trim().startsWith(hookCommand(''))
  )
}

/**
 * @param {Record<string, unknown>} existing The `hooks` object of the settings.
 * @returns {Record<string, unknown>}
 */
function mergeHooks(existing) {
  /** @type {Record<string, unknown>} */
  const hooks = { ...existing }
  /** @type {Map<string, number>} Where the first HackWin handler of each event stood. */
  const places = new Map()
  for (const [event, groups] of Object.entries(existing)) {
    if (!Array.isArray(groups)) continue
    /** @type {unknown[]} */
    const kept = []
    for (const group of groups) {
      const handlers = isObject(group) && Array.isArray(group.hooks) ? group.hooks : null
      if (handlers === null || !handlers.some(isHackwinHandler)) {
        kept.push(group)
        continue
      }
      if (!places.has(event)) places.set(event, kept.length)
      const others = handlers.filter((handler) => !isHackwinHandler(handler))
      if (others.length > 0) kept.push({ ...group, hooks: others })
    }
    if (kept.length === 0 && !CLAUDE_HOOKS.some((hook) => hook.event === event)) delete hooks[event]
    else hooks[event] = kept
  }
  for (const { event, hook, tools } of CLAUDE_HOOKS) {
    const groups = /** @type {unknown[]} */ (arrayAt(hooks, event, `hooks.${event}`))
    const group = {
      ...(tools === null ? {} : { matcher: tools.join('|') }),
      hooks: [{ type: 'command', command: hookCommand(hook) }],
    }
    groups.splice(places.get(event) ?? groups.length, 0, group)
    hooks[event] = groups
  }
  return hooks
}

/**
 * @param {string | null} text
 * @returns {Record<string, unknown>}
 */
function parseSettings(text) {
  if (text === null || text.trim() === '') return {}
  /** @type {unknown} */
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw invalid(`is not valid JSON: ${error.message}`)
  }
  if (!isObject(value)) throw invalid('must hold a JSON object')
  return value
}

/**
 * The object at a key, or an empty one when the key is absent.
 * @param {Record<string, unknown>} object
 * @param {string} key
 * @returns {Record<string, unknown>}
 */
function objectAt(object, key) {
  const value = object[key]
  if (value === undefined) return {}
  if (!isObject(value)) throw invalid(`${key} must be an object`)
  return value
}

/**
 * A copy of the list at a key, or an empty list when the key is absent.
 * @param {Record<string, unknown>} object
 * @param {string} key
 * @param {string} name The dotted name for the message.
 * @returns {unknown[]}
 */
function arrayAt(object, key, name) {
  const value = object[key]
  if (value === undefined) return []
  if (!Array.isArray(value)) throw invalid(`${name} must be a list`)
  return [...value]
}

/**
 * @param {string} reason
 * @returns {PreconditionError}
 */
function invalid(reason) {
  return new PreconditionError(`${SETTINGS_PATH} ${reason}`, {
    resolve: `correct ${SETTINGS_PATH}, keeping your own settings, and run the command again`,
  })
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

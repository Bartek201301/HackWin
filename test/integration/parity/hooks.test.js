// The Claude Code hooks and deny rules that setup commits, against the wrappers' command lines
// (AC14/hooks), offline. In a session a wrapper has Claude run its one command line with the Bash
// tool (src/generate/wrappers.js), so before the command runs Claude Code matches it against the
// deny rules of `.claude/settings.json` and runs the PreToolUse hooks whose matcher names Bash.
// If either refused a wrapper's command line, every wrapper would fail in a session while the
// parity flow stays green. No test starts a Claude Code session (plan section 9, decision 9): the
// tests read the settings and the wrappers from the bootstrap commit, run each hook command with
// the event that Claude Code would send, and match each command line against the rules, as Claude
// Code's documentation describes both:
//
// - https://code.claude.com/docs/en/hooks, read 2026-10-20. The event is one JSON object on stdin;
//   the page's example input of a Bash PreToolUse call has `session_id`, `prompt_id`,
//   `transcript_path`, `cwd`, `scratchpad_dir`, `permission_mode`, `hook_event_name`,
//   `tool_name`, `tool_input` (`command`, `description`, `timeout`, `run_in_background`) and
//   `tool_use_id`. A command hook without `args` runs with `sh -c`, in the current directory, with
//   CLAUDE_PROJECT_DIR set to the project root. A matcher of only letters, digits, `_`, `-`,
//   spaces, `,` and `|` is a list of exact tool names; any other is a JavaScript regular
//   expression, unanchored; `""`, `"*"` or none matches every tool. A PreToolUse hook refuses with
//   `hookSpecificOutput.permissionDecision: "deny"` or with exit code 2; exit 0 with no output is
//   no decision, and the call goes on through the permission flow.
// - https://code.claude.com/docs/en/permissions, read 2026-10-20, "Wildcard patterns" and
//   "Compound commands". A `*` in a Bash rule matches any text; a trailing ` *` that is the rule's
//   only wildcard also matches the bare command. A command is split at `&&`, `||`, `;`, `|`,
//   `|&`, `&` and newlines, and a deny rule refuses it when it matches any part. A deny rule
//   matches past any leading variable assignment, an allow rule only as written. The page does
//   not say whether a `*` matches empty text (docs/verification.md, question 8), so a command that
//   must pass is checked with both readings and one that must be refused without the empty match.
//
// The SessionStart hook runs once per session, not before a tool call, and the PostToolUse hook
// runs after a call; the tests check that no PostToolUse hook is set for Bash.

import { afterEach, describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { COMMANDS } from '../../../src/cli/registry.js'
import { exec } from '../../../src/core/runtime/index.js'
import { SETTINGS_PATH } from '../../../src/generate/claude-settings.js'
import { WRAPPER_TIMEOUT_MS, wrapperPath } from '../../../src/generate/wrappers.js'
import { wrapperCommandLineOf } from './world.js'
import { createOfflineWorld } from './world-offline.js'

/** @import { World } from './world.js' */

/** Each test runs `setup` and a child process per hook call. */
const TIMEOUT_MS = 120_000

/** The issue number of the task worktree, as `/take 7` names it. */
const ISSUE = 7

const SESSION = 'f3b1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d'

/** @type {Array<() => Promise<void>>} */
const cleanups = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

/**
 * An offline world with a solo team, configured by `setup`, and a task worktree beside its main
 * checkout: the two places a member runs a wrapper.
 */
async function configured() {
  const scene = await createOfflineWorld()
  cleanups.push(scene.cleanup)
  const setup = await scene.setup()
  expect(setup.code, setup.stderr).toBe(0)
  const { world } = scene
  const worktree = join(`${world.main}.worktrees`, `${ISSUE}-counter-reset`)
  await world
    .git()
    .run([
      'worktree',
      'add',
      '--quiet',
      '-b',
      `task/${ISSUE}-counter-reset`,
      worktree,
      'origin/main',
    ])
  return { world, dirs: [world.main, worktree] }
}

/**
 * What a member types after a wrapper's command: nothing and `--help`, and for `/take` an issue.
 * @param {string} command
 */
function typedFor(command) {
  return command === 'take' ? ['', '--help', String(ISSUE)] : ['', '--help']
}

/**
 * The command lines Claude runs for a wrapper: `$ARGUMENTS` replaced by what was typed, as
 * Claude Code does, and also without the space that an empty `$ARGUMENTS` leaves at the end.
 * @param {string} line The wrapper's command line.
 * @param {string} typed
 */
function commandLinesOf(line, typed) {
  const replaced = line.replace('$ARGUMENTS', () => typed)
  return [...new Set([replaced, replaced.trimEnd()])]
}

/**
 * The PreToolUse event of a Bash call, in the form of the hooks page's example input.
 * @param {string} cwd
 * @param {string} command
 */
function bashEvent(cwd, command) {
  return {
    session_id: SESSION,
    prompt_id: '550e8400-e29b-41d4-a716-446655440000',
    transcript_path: `/Users/member/.claude/projects/app/${SESSION}.jsonl`,
    cwd,
    scratchpad_dir: `/tmp/claude-501/app/${SESSION}/scratchpad`,
    permission_mode: 'default',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: {
      command,
      description: 'Run the wrapper command',
      timeout: WRAPPER_TIMEOUT_MS,
      run_in_background: false,
    },
    tool_use_id: 'toolu_01HackWinWrapperCall',
  }
}

/**
 * Whether a hook matcher selects a tool, by the rules of the hooks page.
 * @param {string | undefined} matcher
 * @param {string} tool
 */
function selects(matcher, tool) {
  if (matcher === undefined || matcher === '' || matcher === '*') return true
  if (/^[\w\- ,|]*$/.test(matcher)) {
    return matcher
      .split(/[|,]/)
      .map((name) => name.trim())
      .includes(tool)
  }
  return new RegExp(matcher).test(tool)
}

/**
 * The handlers of an event of the settings that Claude Code runs for a tool.
 * @param {any} settings
 * @param {string} event
 * @param {string} tool
 * @returns {Array<{ type: string, command: string, args?: string[], timeout?: number }>}
 */
function handlersFor(settings, event, tool) {
  return (settings.hooks?.[event] ?? [])
    .filter((/** @type {any} */ group) => selects(group.matcher, tool))
    .flatMap((/** @type {any} */ group) => group.hooks)
}

/**
 * Run a command hook as Claude Code runs one without `args`: `sh -c` in the event's directory,
 * the event on stdin, CLAUDE_PROJECT_DIR set, in the environment of a session of this world.
 * @param {World} world
 * @param {{ type: string, command: string, args?: string[], timeout?: number }} handler
 * @param {ReturnType<typeof bashEvent>} event
 */
async function runHook(world, handler, event) {
  expect(handler.type).toBe('command')
  expect(handler.args).toBeUndefined()
  const result = await exec('/bin/sh', ['-c', handler.command], {
    cwd: event.cwd,
    env: { ...world.wrapperEnv, CLAUDE_PROJECT_DIR: event.cwd },
    input: JSON.stringify(event),
    timeoutMs: (handler.timeout ?? 60) * 1000,
  })
  return { code: result.code, stdout: result.stdout, stderr: result.stderr }
}

/**
 * The PreToolUse decision of a hook's answer: `deny` for exit code 2 or that JSON decision, the
 * JSON decision otherwise, null for none.
 * @param {{ code: number | null, stdout: string }} answer
 * @returns {string | null}
 */
function decisionOf({ code, stdout }) {
  if (code === 2) return 'deny'
  const text = stdout.trim()
  if (text === '') return null
  return JSON.parse(text).hookSpecificOutput?.permissionDecision ?? null
}

/**
 * Whether a Bash rule of the permissions page matches a command text as a whole.
 * @param {string} rule
 * @param {string} text
 * @param {boolean} emptyMatch Whether a `*` also matches empty text.
 */
function ruleMatches(rule, text, emptyMatch) {
  const written = /^Bash\((.*)\)$/s.exec(rule)?.[1]
  if (written === undefined) return false
  const pattern = written.replace(/:\*$/, ' *')
  const parts = pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const regex = new RegExp(`^${parts.join(emptyMatch ? '.*' : '.+')}$`, 's')
  const bare = pattern.endsWith(' *') && parts.length === 2 ? pattern.slice(0, -2) : null
  return regex.test(text) || text === bare
}

/**
 * The deny rules that refuse a command: a rule refuses it when it matches one of its parts, as
 * written or past the part's leading variable assignments.
 * @param {readonly string[]} rules
 * @param {string} command
 * @param {{ emptyMatch: boolean }} reading
 */
function deniedBy(rules, command, { emptyMatch }) {
  const parts = command
    .split(/&&|\|\||\|&|;|\||&|\n/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
  const texts = parts.flatMap((part) => [part, part.replace(/^(?:[A-Za-z_]\w*=\S*\s+)+/, '')])
  return rules.filter((rule) => texts.some((text) => ruleMatches(rule, text, emptyMatch)))
}

/**
 * The rules of a wrapper's `allowed-tools`, which let its command line run without a prompt.
 * @param {string} skill The wrapper's SKILL.md.
 * @returns {string[]}
 */
function allowedToolsOf(skill) {
  const value = /^allowed-tools: (.*)$/m.exec(skill)?.[1]
  if (value === undefined) throw new Error(`the wrapper has no allowed-tools:\n${skill}`)
  return JSON.parse(value).split(/,\s*(?=Bash\()/)
}

/** The six commands of Phase 1, each with its wrapper. */
const WRAPPED = COMMANDS.map((entry) => entry.name)

describe('AC14/hooks: the hooks and deny rules that setup commits, fed the events of the wrappers', () => {
  test(
    "AC14/hooks: the PreToolUse hooks and the deny rules that setup committed let each wrapper's command line run, in the main checkout and in a task worktree",
    async () => {
      const { world, dirs } = await configured()
      expect(WRAPPED).toEqual(['setup', 'join', 'take', 'ship', 'status', 'gate'])

      for (const cwd of dirs) {
        const settings = JSON.parse(readFileSync(join(cwd, SETTINGS_PATH), 'utf8'))
        const deny = settings.permissions.deny
        const hooks = handlersFor(settings, 'PreToolUse', 'Bash')
        expect(hooks.length, 'the PreToolUse hooks for Bash').toBeGreaterThan(0)
        expect(handlersFor(settings, 'PostToolUse', 'Bash'), 'PostToolUse hooks for Bash').toEqual(
          [],
        )

        for (const name of WRAPPED) {
          const skill = readFileSync(join(cwd, wrapperPath(name)), 'utf8')
          const line = wrapperCommandLineOf(skill)
          const allowed = allowedToolsOf(skill)
          for (const typed of typedFor(name)) {
            for (const command of commandLinesOf(line, typed)) {
              for (const emptyMatch of [false, true]) {
                expect(
                  deniedBy(deny, command, { emptyMatch }),
                  `deny rules for ${command}`,
                ).toEqual([])
              }
              for (const handler of hooks) {
                const answer = await runHook(world, handler, bashEvent(cwd, command))
                expect({ command, cwd, ...answer }).toEqual({
                  command,
                  cwd,
                  code: 0,
                  stdout: '',
                  stderr: '',
                })
              }
            }
            const command = commandLinesOf(line, typed).at(-1) ?? ''
            const allows = allowed.filter((rule) => ruleMatches(rule, command, false))
            expect(allows.length, `allowed-tools of /${name} for ${command}`).toBeGreaterThan(0)
          }
        }
      }
      // The hooks stay offline: no gh call of theirs reached the bridge.
      expect(world.bridgeCalls).toEqual([])
    },
    TIMEOUT_MS,
  )

  test(
    "AC14/hooks: the same hooks and deny rules refuse a merge and a push to main, also chained to a wrapper's command line",
    async () => {
      const { world, dirs } = await configured()
      const ship = wrapperCommandLineOf(readFileSync(join(world.main, wrapperPath('ship')), 'utf8'))
      const refused = [
        'gh pr merge 12 --merge',
        `${commandLinesOf(ship, '').at(-1)} && git push origin main`,
      ]

      for (const cwd of dirs) {
        const settings = JSON.parse(readFileSync(join(cwd, SETTINGS_PATH), 'utf8'))
        const hooks = handlersFor(settings, 'PreToolUse', 'Bash')
        expect(hooks.length).toBeGreaterThan(0)
        for (const command of refused) {
          expect(
            deniedBy(settings.permissions.deny, command, { emptyMatch: false }).length,
            `deny rules for ${command}`,
          ).toBeGreaterThan(0)
          for (const handler of hooks) {
            const answer = await runHook(world, handler, bashEvent(cwd, command))
            expect(answer.code, answer.stderr).toBe(0)
            expect({ command, cwd, decision: decisionOf(answer) }).toEqual({
              command,
              cwd,
              decision: 'deny',
            })
            expect(JSON.parse(answer.stdout).hookSpecificOutput.permissionDecisionReason).toMatch(
              /\S/,
            )
          }
        }
      }
    },
    TIMEOUT_MS,
  )
})

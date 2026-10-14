// The Claude Code command wrappers (6.4, 5.5, CM1): one project skill per command of the CLI,
// `.claude/skills/<command>/SKILL.md`, which Claude Code offers as `/<command>`
// (docs/verification.md, row 1). A wrapper only runs `hackwin <command>` with
// HACKWIN_CALLER=claude-code set and passes the output on to the session; all logic lives in the
// CLI, so `/take 42` and `hackwin take 42` behave identically. Wrappers exist only for the
// commands of the registry, never for the plumbing namespace (AC67, I13, A10).

import { COMMANDS } from '../cli/registry.js'
import { CALLER_ENV } from '../core/runtime/caller.js'
import { generatedBy } from './header.js'

/** @import { CommandEntry } from '../cli/registry.js' */
/** @import { GeneratedFileSpec, GenerateInput } from './manifest.js' */

/** The longest timeout the Bash tool of Claude Code accepts, in milliseconds. */
export const WRAPPER_TIMEOUT_MS = 600000

/**
 * The path of a command's wrapper, relative to the repository root.
 * @param {string} command
 * @returns {string}
 */
export function wrapperPath(command) {
  return `.claude/skills/${command}/SKILL.md`
}

/**
 * The command line a wrapper runs. Claude Code replaces `$ARGUMENTS` with the words typed after
 * `/<command>`.
 * @param {string} command
 * @returns {string}
 */
export function wrapperCommandLine(command) {
  return `${CALLER_ENV}=claude-code hackwin ${command} $ARGUMENTS`
}

/**
 * The wrapper of a command. Only the human starts it (`disable-model-invocation`), and it
 * allows exactly its own command line, so it runs without a permission prompt; deny rules still
 * apply. The header names the CLI version, as in every generated file (E19).
 * @param {CommandEntry} entry
 * @param {GenerateInput} input
 * @returns {string}
 */
export function renderWrapper(entry, { version }) {
  const run = `${CALLER_ENV}=claude-code hackwin ${entry.name}`
  const hint = entry.usage.replace(`hackwin ${entry.name}`, '').trim()
  return [
    '---',
    `# ${generatedBy(version)}`,
    `name: ${entry.name}`,
    `description: ${JSON.stringify(`${entry.summary}. Runs \`hackwin ${entry.name}\`, exactly as in a terminal.`)}`,
    ...(hint === '' ? [] : [`argument-hint: ${JSON.stringify(hint)}`]),
    'disable-model-invocation: true',
    `allowed-tools: ${JSON.stringify(`Bash(${run}), Bash(${run} *)`)}`,
    '---',
    '',
    `Run this one command with the Bash tool, in the current directory, in the foreground, with a timeout of ${WRAPPER_TIMEOUT_MS} milliseconds:`,
    '',
    '```sh',
    wrapperCommandLine(entry.name),
    '```',
    '',
    `Then give the user the output of the command unchanged, and its exit code when it is not 0. Do nothing else: run no other command, change no file, do not change the directory and do not run the command again. \`hackwin ${entry.name}\` does all the work, and its output names the next step and the directory to run it in.`,
    '',
  ].join('\n')
}

/** The entries of the wrappers in the generated file manifest, one per command of the registry. */
export const WRAPPER_FILES = Object.freeze(
  COMMANDS.map(
    (entry) =>
      /** @type {GeneratedFileSpec} */ ({
        path: wrapperPath(entry.name),
        mode: 0o644,
        render: (input) => renderWrapper(entry, input),
      }),
  ),
)

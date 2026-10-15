// `hackwin internal hook post-tool-use` (10.4, E14): after a Claude Code tool changed a file,
// format only that file with `commands.format` of hackwin.yml on the local origin/main, in the
// checkout that holds it. A file outside every checkout of this clone, an ignored file and a
// file that no longer exists are left alone. It stays offline and applies CM12 as the git hooks
// do (config.js). When the formatter fails, the session gets its output as feedback, because
// the file stays unformatted; the edit itself already happened.

import { lstat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { execShell, quoteShellArg } from '../../core/runtime/exec.js'
import { FORMATTED_TOOLS } from '../../generate/index.js'
import { loadHookConfig } from './config.js'
import { editedFile, eventDir, readHookEvent } from './event.js'
import { isIgnored, locateFile } from './files.js'

/** @import { CommandContext, CommandResult } from '../../cli/context.js' */

/** How long the formatter may take for one file. */
export const FORMAT_TIMEOUT_MS = 120000

/**
 * @param {CommandContext} ctx
 * @returns {Promise<CommandResult | void>}
 */
export async function run(ctx) {
  const event = await readHookEvent(ctx, 'PostToolUse')
  const file = FORMATTED_TOOLS.includes(event.tool_name ?? '') ? editedFile(event) : null
  if (file === null) return
  const located = await locateFile(ctx.git, resolve(eventDir(ctx, event), file))
  if (located === null || !(await isFile(join(located.root, located.path)))) return
  if (await isIgnored(ctx.git, located)) return

  const config = await loadHookConfig(ctx)
  const command = `${config.hackwin.commands.format} ${quoteShellArg(located.path)}`
  const result = await execShell(command, {
    cwd: located.root,
    env: ctx.env,
    timeoutMs: FORMAT_TIMEOUT_MS,
  })
  const data = { file: located.path, dir: located.root, command, code: result.code }
  if (result.code === 0 && !result.timedOut) return { data: { formatted: true, ...data } }

  const why = result.timedOut
    ? `did not finish within ${FORMAT_TIMEOUT_MS / 1000} seconds`
    : `exited ${result.code ?? `after the signal ${result.signal}`}`
  const reason = [
    `hackwin: ${located.path} is not formatted: \`${command}\` in ${located.root} ${why}.`,
    ...result.tail.map((line) => `  ${line}`),
    'Fix what the formatter reports in this file, or leave the file for the format check of hackwin ship.',
  ].join('\n')
  return {
    lines: [JSON.stringify({ decision: 'block', reason })],
    data: { formatted: false, ...data, tail: result.tail },
  }
}

/**
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function isFile(path) {
  try {
    return (await lstat(path)).isFile()
  } catch {
    return false
  }
}

// What the Lead types in the Gate terminal while the loop runs (7.5 step 9): `retry <PR>`,
// `ack <PR>` and `quit`.

import { createInterface } from 'node:readline'

/** The help line for anything else. */
export const INPUT_HELP = 'type `retry <PR>`, `ack <PR>` or `quit`'

/**
 * @typedef {{ name: 'quit' } | { name: 'retry' | 'ack', pr: number } | { name: 'unknown', text: string }} TypedCommand
 */

/**
 * The command of one typed line, or null for an empty line. A pull request may be written as
 * `12` or `#12`.
 * @param {string} line
 * @returns {TypedCommand | null}
 */
export function parseCommand(line) {
  const text = line.trim()
  if (text === '') return null
  const [name, arg, ...rest] = text.split(/\s+/)
  if (name === 'quit' && arg === undefined) return { name: 'quit' }
  if ((name === 'retry' || name === 'ack') && rest.length === 0 && /^#?[1-9]\d*$/.test(arg ?? '')) {
    return { name, pr: Number(arg.replace('#', '')) }
  }
  return { name: 'unknown', text }
}

/**
 * Read typed lines from the terminal until close() is called.
 * @param {NodeJS.ReadableStream} input
 * @param {(command: TypedCommand) => void} onCommand
 * @returns {{ close: () => void }}
 */
export function readCommands(input, onCommand) {
  const lines = createInterface({ input, terminal: false })
  lines.on('line', (line) => {
    const command = parseCommand(line)
    if (command !== null) onCommand(command)
  })
  return { close: () => lines.close() }
}

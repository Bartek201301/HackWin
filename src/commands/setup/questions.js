// Where the answers of `setup` come from (CM11, A61): the answers file of `--answers <file>`,
// then the interactive terminal, then what setup detected or proposes. The answers file uses the
// keys of hackwin.yml for everything stored there, `roles` and `open` in the form of owners.yml,
// and `invite` for the invitation question; `language` and `explanation_style` are the answers of
// `join`, which `setup` runs for the Lead's machine.

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { parse as parseYaml } from 'yaml'
import { ConfigError, PreconditionError, runIn } from '../../core/runtime/index.js'

/** @import { CommandContext } from '../../cli/context.js' */

/** The top-level keys of a `setup` answers file. */
export const ANSWER_KEYS = Object.freeze([
  'project',
  'team',
  'commands',
  'paths',
  'tasks',
  'gate',
  'roles',
  'open',
  'invite',
  'language',
  'explanation_style',
])

/** The answer that accepts a proposal. */
export const YES = 'yes'

/**
 * @typedef {object} AskOptions
 * @property {string} [fallback] The answer of an empty line, shown in brackets.
 * @property {(answer: string) => string | null} [check] Why an answer is not accepted, or null;
 *   a refused answer prints the reason and asks again.
 */

/** The answers of one run of `setup`. */
export class Questions {
  /**
   * @param {CommandContext} ctx
   * @param {string | null} file The absolute path of the answers file, or null.
   * @param {Record<string, unknown>} answers The answers file's content; empty without one.
   */
  constructor(ctx, file, answers) {
    this.ctx = ctx
    this.file = file
    this.answers = answers
    /** True when questions without an answer in the file are asked in the terminal. */
    this.interactive = ctx.caller === 'terminal'
    /** @type {import('node:readline').Interface | null} */
    this.reader = null
    /** @type {AsyncIterator<string> | null} */
    this.lines = null
  }

  /**
   * The answer at a dotted key of the answers file, or undefined when the file has none there.
   * A null answer counts as given: it clears an optional setting.
   * @param {string} key For example `team` or `commands.smoke`.
   * @returns {unknown}
   */
  given(key) {
    /** @type {unknown} */
    let value = this.answers
    for (const part of key.split('.')) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
      value = /** @type {Record<string, unknown>} */ (value)[part]
    }
    return value
  }

  /**
   * @param {string} key
   * @returns {boolean}
   */
  has(key) {
    return this.given(key) !== undefined
  }

  /**
   * A ConfigError for an answer of the answers file, naming its key.
   * @param {string} key
   * @param {string} message The rest of a sentence that starts with the key.
   * @returns {ConfigError}
   */
  error(key, message) {
    return new ConfigError(`the answers file ${this.file}: ${key} ${message}`, {
      key,
      details: { file: this.file },
      resolve: `correct ${key} in ${this.file}, then ${this.rerun()}`,
    })
  }

  /**
   * The error for a question that neither the answers file nor a terminal answers.
   * @param {string} key
   * @param {string} what What the answer is, for the message.
   * @returns {PreconditionError}
   */
  missing(key, what) {
    return new PreconditionError(`the answers file ${this.file} has no ${key}: ${what}`, {
      resolve: `add ${key} to ${this.file}, or ${runIn('hackwin setup', this.ctx.repoRoot)} in an interactive terminal`,
    })
  }

  /**
   * How to run setup again, with the directory (CM4).
   * @returns {string}
   */
  rerun() {
    return runIn(
      this.file === null ? 'hackwin setup' : `hackwin setup --answers ${this.file}`,
      this.ctx.repoRoot,
    )
  }

  /**
   * Print a line of the conversation.
   * @param {string} text
   */
  say(text) {
    this.ctx.out.line(text)
  }

  /**
   * Ask one question in the terminal and return the answer, without surrounding white space.
   * @param {string} question
   * @param {AskOptions} [options]
   * @returns {Promise<string>}
   */
  async ask(question, { fallback, check } = {}) {
    if (!this.interactive) throw new Error(`setup asked "${question}" outside a terminal`)
    for (;;) {
      const shown = fallback === undefined || fallback === '' ? '' : ` [${fallback}]`
      this.ctx.out.write(`${question}${shown}: `)
      const typed = (await this.readLine()).trim()
      const answer = typed === '' ? (fallback ?? '') : typed
      const problem = check ? check(answer) : answer === '' ? 'an answer is needed' : null
      if (problem === null) return answer
      this.say(`  ${problem}`)
    }
  }

  /**
   * Ask for a confirmation of a proposal: an empty line or `yes` keeps it, `edit` changes it.
   * @param {string} question
   * @returns {Promise<boolean>} True to keep the proposal.
   */
  async keep(question) {
    const answer = await this.ask(`${question} Type yes, or edit`, {
      fallback: YES,
      check: (value) => ([YES, 'edit'].includes(value.toLowerCase()) ? null : 'answer yes or edit'),
    })
    return answer.toLowerCase() === YES
  }

  /**
   * @returns {Promise<string>}
   */
  async readLine() {
    if (this.lines === null) {
      this.reader = createInterface({ input: this.ctx.stdin, crlfDelay: Infinity, terminal: false })
      this.lines = this.reader[Symbol.asyncIterator]()
    }
    const { value, done } = await this.lines.next()
    if (done) {
      throw new PreconditionError('the terminal input ended before setup had all its answers', {
        resolve: runIn('hackwin setup', this.ctx.repoRoot),
      })
    }
    return value
  }

  close() {
    this.reader?.close()
  }
}

/**
 * The questions of this run: the answers file of `--answers`, read and checked, and the
 * terminal. Without a terminal, setup needs an answers file (CM11).
 * @param {CommandContext} ctx
 * @returns {Promise<Questions>}
 */
export async function openQuestions(ctx) {
  const name = ctx.flags.answers
  if (typeof name !== 'string') {
    if (ctx.caller !== 'terminal') {
      throw new PreconditionError(
        'setup asks its questions in an interactive terminal, and this is none',
        {
          resolve: `${runIn('hackwin setup', ctx.repoRoot)} in an interactive terminal, or give the answers in a file: ${runIn('hackwin setup --answers <file>', ctx.repoRoot)}`,
        },
      )
    }
    return new Questions(ctx, null, {})
  }
  const file = resolve(ctx.cwd, name)
  return new Questions(ctx, file, await readAnswersFile(file))
}

/**
 * The content of an answers file: a YAML mapping with the keys of ANSWER_KEYS.
 * @param {string} file An absolute path.
 * @returns {Promise<Record<string, unknown>>}
 */
export async function readAnswersFile(file) {
  const fix = `correct the answers file ${file}: a YAML mapping with the keys of hackwin.yml, roles and open as in owners.yml, and invite`
  /** @type {string} */
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    throw new PreconditionError(`cannot read the answers file ${file}: ${error.code ?? error}`, {
      resolve: fix,
    })
  }
  /** @type {unknown} */
  let data
  try {
    data = parseYaml(text)
  } catch (error) {
    throw new PreconditionError(`the answers file ${file} is not YAML: ${error.message}`, {
      resolve: fix,
    })
  }
  if (data === null || data === undefined) data = {}
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new PreconditionError(`the answers file ${file} is not a mapping of keys to answers`, {
      resolve: fix,
    })
  }
  const answers = /** @type {Record<string, unknown>} */ (data)
  const unknown = Object.keys(answers).find((key) => !ANSWER_KEYS.includes(key))
  if (unknown !== undefined) {
    throw new ConfigError(
      `the answers file ${file}: ${unknown} is not a known key; the keys are ${ANSWER_KEYS.join(', ')}`,
      { key: unknown, details: { file }, resolve: fix },
    )
  }
  return answers
}

/**
 * A list of words from one typed line: separated by commas or spaces; `none` or an empty line is
 * an empty list.
 * @param {string} text
 * @returns {string[]}
 */
export function wordsOf(text) {
  const words = text
    .split(/[,\s]+/)
    .map((word) => word.trim())
    .filter(Boolean)
  return words.length === 1 && words[0].toLowerCase() === 'none' ? [] : words
}

/**
 * A list for display: the items separated by commas, or `none`.
 * @param {readonly string[]} items
 * @returns {string}
 */
export function listText(items) {
  return items.length === 0 ? 'none' : items.join(', ')
}

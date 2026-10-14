// The personal settings of `join` (7.2 step 6): the answer language and the explanation style,
// asked in an interactive terminal or read from `--answers <file>` (CM11, A61), and written to
// `local.yml` and to HackWin's own block of `CLAUDE.local.md` in the main checkout. Both files
// stay on this machine and never enter the repository.

import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { parse as parseYaml } from 'yaml'
import { PreconditionError } from '../../core/runtime/index.js'

/** @import { CommandContext } from '../../cli/context.js' */
/** @import { LocalRecord } from '../../core/state/index.js' */

/** The keys of the answers file that `join` reads (CM11). */
export const ANSWER_KEYS = Object.freeze(/** @type {const} */ (['language', 'explanation_style']))

/** @typedef {typeof ANSWER_KEYS[number]} AnswerKey */

/** @typedef {Record<AnswerKey, string | null>} Answers Null where no answer was given. */

/** The file of the settings for Claude Code, in the main checkout (6.4). */
export const CLAUDE_LOCAL_FILE = 'CLAUDE.local.md'

const BEGIN = '<!-- hackwin:begin -->'
const END = '<!-- hackwin:end -->'

/** The explanation style offered when the member has none yet. */
const DEFAULT_STYLE = 'concise'

const QUESTIONS = Object.freeze({
  language: 'Answer language of your agent sessions',
  explanation_style: 'Explanation style, for example concise or step by step',
})

/**
 * The answers of this run: from the answers file; for a key it lacks, asked in an interactive
 * terminal, where Enter keeps the member's earlier answer or the default; otherwise the member's
 * earlier answer from local.yml, or null.
 * @param {CommandContext} ctx
 * @param {object} options
 * @param {LocalRecord | null} options.previous The member's own record of local.yml, if any.
 * @param {string} options.projectLanguage `project.language`, the default answer language.
 * @returns {Promise<Answers>}
 */
export async function resolveAnswers(ctx, { previous, projectLanguage }) {
  const file = typeof ctx.flags.answers === 'string' ? resolve(ctx.cwd, ctx.flags.answers) : null
  const given = file === null ? {} : await readAnswersFile(file)
  const missing = ANSWER_KEYS.filter((key) => given[key] === undefined)

  /** @type {Answers} */
  const answers = { language: null, explanation_style: null }
  for (const key of ANSWER_KEYS) answers[key] = given[key] ?? previous?.[key] ?? null
  if (missing.length === 0 || ctx.caller !== 'terminal') return answers

  const defaults = { language: projectLanguage, explanation_style: DEFAULT_STYLE }
  const lines = createInterface({ input: ctx.stdin, crlfDelay: Infinity, terminal: false })
  const next = lines[Symbol.asyncIterator]()
  try {
    for (const key of missing) {
      const fallback = previous?.[key] ?? defaults[key]
      ctx.out.write(`${QUESTIONS[key]} [${fallback}]: `)
      const { value, done } = await next.next()
      answers[key] = (done ? '' : normalize(value)) || fallback
    }
  } finally {
    lines.close()
  }
  return answers
}

/**
 * The answers of `join` in an answers file. Other keys, such as those of `setup`, are left alone.
 * @param {string} file An absolute path.
 * @returns {Promise<Partial<Record<AnswerKey, string>>>}
 */
export async function readAnswersFile(file) {
  const resolveFile = `give \`language\` and \`explanation_style\` as text in the answers file ${file}`
  /** @type {string} */
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    throw new PreconditionError(`cannot read the answers file ${file}: ${error.code ?? error}`, {
      resolve: resolveFile,
    })
  }
  /** @type {unknown} */
  let data
  try {
    data = parseYaml(text)
  } catch (error) {
    throw new PreconditionError(`the answers file ${file} is not YAML: ${error.message}`, {
      resolve: resolveFile,
    })
  }
  if (data === null || data === undefined) data = {}
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new PreconditionError(`the answers file ${file} is not a mapping of keys to answers`, {
      resolve: resolveFile,
    })
  }
  const record = /** @type {Record<string, unknown>} */ (data)
  /** @type {Partial<Record<AnswerKey, string>>} */
  const answers = {}
  for (const key of ANSWER_KEYS) {
    const raw = record[key]
    if (raw === undefined || raw === null) continue
    const value = typeof raw === 'string' ? normalize(raw) : ''
    if (value === '') {
      throw new PreconditionError(`${key} in the answers file ${file} must be a non-empty text`, {
        resolve: resolveFile,
      })
    }
    answers[key] = value
  }
  return answers
}

/**
 * The text of `CLAUDE.local.md` with HackWin's block for these settings: the block replaces an
 * earlier one, and the member's own lines stay as they are.
 * @param {string | null} existing The current file, or null when there is none.
 * @param {{ language: string, explanation_style: string }} settings
 * @returns {string}
 */
export function withSettingsBlock(existing, { language, explanation_style }) {
  const block = [
    BEGIN,
    '# Personal settings',
    '',
    'Written by `hackwin join` for this machine only; this file is never committed.',
    '',
    `- Answer language: ${language}. Answer the human in this language.`,
    `- Explanation style: ${explanation_style}.`,
    END,
  ].join('\n')
  if (existing === null || existing.trim() === '') return `${block}\n`
  const begin = existing.indexOf(BEGIN)
  const end = begin === -1 ? -1 : existing.indexOf(END, begin)
  if (end === -1) return `${existing.replace(/\n*$/, '\n\n')}${block}\n`
  return `${existing.slice(0, begin)}${block}${existing.slice(end + END.length)}`
}

/**
 * Write the settings block into `CLAUDE.local.md` of the main checkout. A file that already holds
 * this block is not touched.
 * @param {string} main The main checkout.
 * @param {{ language: string, explanation_style: string }} settings
 * @returns {Promise<string>} The path of the file.
 */
export async function writeClaudeLocal(main, settings) {
  const file = join(main, CLAUDE_LOCAL_FILE)
  /** @type {string | null} */
  let existing = null
  try {
    existing = await readFile(file, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const text = withSettingsBlock(existing, settings)
  if (text !== existing) await writeFile(file, text)
  return file
}

/**
 * One line of text: runs of white space become one space.
 * @param {string} value
 * @returns {string}
 */
function normalize(value) {
  return value.replace(/\s+/g, ' ').trim()
}

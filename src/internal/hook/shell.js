// What a Bash command line of an agent session does, as far as the PreToolUse hook needs it: a
// merge of a pull request (`gh pr merge`, or a merge through `gh api`) and a `git push`. The
// line is split into simple commands at `;`, `&&`, `||`, `|`, `&` and newlines, as Claude Code
// splits it for its deny rules, and the commands inside `$(...)`, backquotes, `sh -c` and `eval`
// count as well. Quoting is resolved, here documents and redirections are skipped, and leading
// variable assignments and wrappers such as `env` or `sudo` are dropped. Like the deny rules,
// this covers the usual spellings and not every one (docs/verification.md, row 2; 10.6).

import { basename } from 'node:path'

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/**
 * Programs that run the rest of their words as a command, with their options that take a value.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
const WRAPPERS = Object.freeze({
  env: ['-u', '--unset', '-C', '--chdir'],
  command: [],
  builtin: [],
  exec: ['-a'],
  nohup: [],
  time: ['-o', '-f'],
  sudo: ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U'],
  nice: ['-n'],
  timeout: ['-s', '-k', '--signal', '--kill-after'],
  xargs: ['-I', '-n', '-L', '-P', '-d', '-E', '-s', '-a'],
})

const SHELLS = Object.freeze(['sh', 'bash', 'zsh', 'dash', 'ksh'])

/** git options that take the next word as their value. */
const GIT_VALUE_OPTIONS = Object.freeze([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--config-env',
])

/** `git push` options that take the next word as their value. */
const PUSH_VALUE_OPTIONS = Object.freeze([
  '--repo',
  '-o',
  '--push-option',
  '--receive-pack',
  '--exec',
])

/** `git push` options that push every branch, the default branch included. */
const PUSH_ALL_OPTIONS = Object.freeze(['--all', '--branches', '--mirror'])

/**
 * The simple commands of a command line, each as its words without assignments and wrappers.
 * @param {string} line
 * @returns {string[][]}
 */
export function commandsOf(line) {
  /** @type {string[][]} */
  const raw = []
  lex(line, raw)
  /** @type {string[][]} */
  const commands = []
  for (const words of raw) {
    const command = unwrap(words)
    if (command.length === 0) continue
    const name = basename(command[0])
    const script = SHELLS.includes(name) ? shellScript(command) : null
    if (script !== null) commands.push(...commandsOf(script))
    else if (name === 'eval') commands.push(...commandsOf(command.slice(1).join(' ')))
    else commands.push(command)
  }
  return commands
}

/**
 * True when a simple command merges a pull request: `gh pr merge`, or a `gh api` call that names
 * the REST merge endpoint `pulls/<N>/merge` or the GraphQL mutation `mergePullRequest`, the forms
 * of the deny rules.
 * @param {string[]} words
 * @returns {boolean}
 */
export function isMerge(words) {
  if (basename(words[0] ?? '') !== 'gh') return false
  if (words[1] === 'pr' && words[2] === 'merge') return true
  if (words[1] !== 'api') return false
  const rest = words.slice(2).join(' ')
  return /pulls\/.*\/merge/.test(rest) || rest.includes('mergePullRequest')
}

/**
 * A `git push` and what it pushes, or null for any other command.
 * @typedef {object} Push
 * @property {string[]} dirs The directories of `git -C`, in order.
 * @property {boolean} all It pushes every branch (`--all`, `--branches`, `--mirror`).
 * @property {string | null} remote
 * @property {string[]} refspecs
 */

/**
 * @param {string[]} words
 * @returns {Push | null}
 */
export function pushOf(words) {
  if (basename(words[0] ?? '') !== 'git') return null
  /** @type {string[]} */
  const dirs = []
  let at = 1
  while (at < words.length && words[at].startsWith('-')) {
    const option = words[at]
    if (GIT_VALUE_OPTIONS.includes(option)) {
      if (option === '-C' && words[at + 1] !== undefined) dirs.push(words[at + 1])
      at += 2
    } else at += 1
  }
  if (words[at] !== 'push') return null

  let all = false
  /** @type {string[]} */
  const positional = []
  const args = words.slice(at + 1)
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--') {
      positional.push(...args.slice(i + 1))
      break
    }
    if (PUSH_VALUE_OPTIONS.includes(arg)) i += 1
    else if (PUSH_ALL_OPTIONS.includes(arg)) all = true
    else if (!arg.startsWith('-')) positional.push(arg)
  }
  return { dirs, all, remote: positional[0] ?? null, refspecs: positional.slice(1) }
}

/**
 * The branch a refspec pushes to: the destination of `<src>:<dst>`, or the source itself,
 * without `+` and `refs/heads/`. `HEAD` stands for the current branch.
 * @param {string} refspec
 * @returns {string}
 */
export function destinationOf(refspec) {
  const spec = refspec.replace(/^\+/, '')
  const colon = spec.indexOf(':')
  const destination = colon === -1 ? spec : spec.slice(colon + 1) || spec.slice(0, colon)
  return destination.replace(/^refs\/heads\//, '')
}

/**
 * Split shell text into simple commands of words, appending them to `out`. The commands of a
 * command substitution are appended before the command that holds it.
 * @param {string} text
 * @param {string[][]} out
 */
function lex(text, out) {
  /** @type {string[]} */
  let words = []
  /** @type {string | null} */
  let word = null
  let redirected = false
  /** @type {Array<{ delimiter: string, tabs: boolean }>} */
  const heredocs = []

  const endWord = () => {
    if (word === null) return
    if (redirected) redirected = false
    else words.push(word)
    word = null
  }
  const endCommand = () => {
    endWord()
    if (words.length > 0) out.push(words)
    words = []
  }
  /** @param {string} part */
  const add = (part) => {
    word = (word ?? '') + part
  }

  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '\\') {
      if (text[i + 1] !== '\n') add(text[i + 1] ?? '')
      i += 2
    } else if (c === "'") {
      const end = indexOrEnd(text, "'", i + 1)
      add(text.slice(i + 1, end))
      i = end + 1
    } else if (c === '"') {
      i = doubleQuoted(text, i + 1, add, out)
    } else if (c === '$' && text[i + 1] === '(') {
      const end = closingParen(text, i + 1)
      lex(text.slice(i + 2, end), out)
      add(text.slice(i, end + 1))
      i = end + 1
    } else if (c === '`') {
      const end = indexOrEnd(text, '`', i + 1)
      lex(text.slice(i + 1, end), out)
      i = end + 1
    } else if (c === '#' && word === null) {
      i = indexOrEnd(text, '\n', i)
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endWord()
      i += 1
    } else if (text.startsWith('<<<', i)) {
      endWord()
      redirected = true
      i += 3
    } else if (text.startsWith('<<', i)) {
      endWord()
      i += 2
      const tabs = text[i] === '-'
      if (tabs) i += 1
      while (text[i] === ' ' || text[i] === '\t') i += 1
      let delimiter = ''
      while (i < text.length && !/[\s;&|<>()]/.test(text[i])) {
        if (text[i] !== "'" && text[i] !== '"' && text[i] !== '\\') delimiter += text[i]
        i += 1
      }
      heredocs.push({ delimiter, tabs })
    } else if (c === '<' || c === '>' || (c === '&' && text[i + 1] === '>')) {
      // A file descriptor number before the operator is part of it, as in `2>&1`.
      if (word !== null && /^\d+$/.test(word)) word = null
      else endWord()
      i += 1
      while (i < text.length && /[<>&|]/.test(text[i])) i += 1
      redirected = true
    } else if (c === '\n') {
      endCommand()
      i += 1
      for (const { delimiter, tabs } of heredocs.splice(0)) {
        while (i < text.length) {
          const end = indexOrEnd(text, '\n', i)
          const body = text.slice(i, end)
          i = end + 1
          if ((tabs ? body.replace(/^\t+/, '') : body) === delimiter) break
        }
      }
    } else if (';&|()'.includes(c)) {
      endCommand()
      i += 1
    } else {
      add(c)
      i += 1
    }
  }
  endCommand()
}

/**
 * Read a double-quoted string that starts at `start`, after the quote; the commands of its
 * substitutions go to `out`. Returns the index after the closing quote.
 * @param {string} text
 * @param {number} start
 * @param {(part: string) => void} add
 * @param {string[][]} out
 * @returns {number}
 */
function doubleQuoted(text, start, add, out) {
  let part = ''
  let i = start
  while (i < text.length && text[i] !== '"') {
    if (text[i] === '\\' && i + 1 < text.length && '"\\$`\n'.includes(text[i + 1])) {
      if (text[i + 1] !== '\n') part += text[i + 1]
      i += 2
    } else if (text[i] === '$' && text[i + 1] === '(') {
      const end = closingParen(text, i + 1)
      lex(text.slice(i + 2, end), out)
      part += text.slice(i, end + 1)
      i = end + 1
    } else if (text[i] === '`') {
      const end = indexOrEnd(text, '`', i + 1)
      lex(text.slice(i + 1, end), out)
      i = end + 1
    } else {
      part += text[i]
      i += 1
    }
  }
  add(part)
  return i + 1
}

/**
 * The index of the `)` that closes the `(` at `open`, skipping quoted text; the end of the text
 * when it is not closed.
 * @param {string} text
 * @param {number} open
 * @returns {number}
 */
function closingParen(text, open) {
  let depth = 0
  for (let i = open; i < text.length; i += 1) {
    const c = text[i]
    if (c === '\\') i += 1
    else if (c === "'") i = indexOrEnd(text, "'", i + 1)
    else if (c === '"') {
      i += 1
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
    } else if (c === '(') depth += 1
    else if (c === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return text.length
}

/**
 * @param {string} text
 * @param {string} search
 * @param {number} from
 * @returns {number}
 */
function indexOrEnd(text, search, from) {
  const index = text.indexOf(search, from)
  return index === -1 ? text.length : index
}

/**
 * The words of a simple command without leading assignments and wrapper programs.
 * @param {string[]} words
 * @returns {string[]}
 */
function unwrap(words) {
  let rest = words
  for (;;) {
    while (rest.length > 0 && ASSIGNMENT.test(rest[0])) rest = rest.slice(1)
    const name = rest.length > 0 ? basename(rest[0]) : ''
    if (!Object.hasOwn(WRAPPERS, name)) return rest
    const valued = WRAPPERS[name]
    rest = rest.slice(1)
    while (rest.length > 0 && rest[0].startsWith('-')) {
      const option = rest[0]
      rest = rest.slice(valued.includes(option) ? 2 : 1)
      if (option === '--') break
    }
    // `timeout` takes the duration before the command.
    if (name === 'timeout') rest = rest.slice(1)
  }
}

/**
 * The script of `sh -c <script>`, also with combined flags such as `-lc`, or null.
 * @param {string[]} words
 * @returns {string | null}
 */
function shellScript(words) {
  for (let i = 1; i < words.length; i += 1) {
    const word = words[i]
    if (!word.startsWith('-') || word === '--') return null
    if (!word.startsWith('--') && word.includes('c')) return words[i + 1] ?? null
  }
  return null
}

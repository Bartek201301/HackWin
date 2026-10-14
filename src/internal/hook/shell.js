// What a Bash command line of an agent session does, as far as the PreToolUse hook needs it: a
// merge of a pull request (`gh pr merge`, or a merge through `gh api`), a `gh api` call that
// updates a branch without a pull request, and a `git push`. The line is split into simple
// commands at `;`, `&&`, `||`, `|`, `&` and newlines, as Claude Code splits it for its deny
// rules; the commands inside `$(...)`, `<(...)`, `>(...)`, backquotes, subshells, control-flow
// bodies, `sh -c` and `eval` count as well. Quoting is resolved, here documents and redirections
// are skipped, and leading variable assignments and the wrappers that Claude Code strips (and a
// few more, such as `env` and `sudo`) are dropped. It reads the text only: a git or gh alias,
// a shell variable or function, a script file or text piped into `sh` is not seen. Like the deny
// rules, it covers the usual spellings, not every one (docs/verification.md, row 2; 10.6).

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
  stdbuf: ['-i', '-o', '-e', '--input', '--output', '--error'],
  noglob: [],
})

/** Reserved words before a command, such as `then` in `if x; then git push; fi`. */
const KEYWORDS = Object.freeze([
  'if',
  'then',
  'elif',
  'else',
  'fi',
  'do',
  'done',
  'while',
  'until',
  'esac',
  '!',
  '{',
  '}',
  'coproc',
])

/** Reserved words whose words are no command: a loop header, the word of a `case`. */
const HEADERS = Object.freeze(['for', 'select', 'case'])

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

/** `gh api` options that take the next word as their value, besides the method and the fields. */
const API_VALUE_OPTIONS = Object.freeze([
  '-H',
  '--header',
  '-q',
  '--jq',
  '-t',
  '--template',
  '--hostname',
  '--cache',
  '-p',
  '--preview',
])

/** `gh api` options that add a field, which makes the default method POST. */
const API_FIELD_OPTIONS = Object.freeze(['-f', '-F', '--field', '--raw-field'])

/** GraphQL mutations that merge a pull request outside the queue (E3). */
const MERGE_MUTATIONS = /\b(?:mergePullRequest|enablePullRequestAutoMerge)\b/

/** GraphQL mutations that update a branch without a pull request, any branch (E2). */
const BRANCH_MUTATIONS = /\b(mergeBranch|updateRefs?)\b/

/**
 * The simple commands of a command line, each as its words without keywords, assignments and
 * wrappers.
 * @param {string} line
 * @returns {string[][]}
 */
export function commandsOf(line) {
  /** @type {string[][]} */
  const raw = []
  lex(line, 0, raw, false)
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
 * True when a simple command merges a pull request outside the queue: `gh pr merge`, or a
 * `gh api` call that names the REST merge endpoint `pulls/<N>/merge` (the form of the deny
 * rule) or the GraphQL mutation `mergePullRequest` or `enablePullRequestAutoMerge`.
 * @param {string[]} words
 * @returns {boolean}
 */
export function isMerge(words) {
  if (basename(words[0] ?? '') !== 'gh') return false
  if (words[1] === 'pr' && words[2] === 'merge') return true
  const call = apiCallOf(words)
  return call !== null && (/pulls\/.*\/merge/.test(call.text) || MERGE_MUTATIONS.test(call.text))
}

/**
 * A `gh api` call that updates a branch without a pull request.
 * @typedef {object} BranchUpdate
 * @property {string} via How: the endpoint or the mutation.
 * @property {string | null} branch The branch it updates; null when the command does not say.
 */

/**
 * The branch that a `gh api` call updates without a pull request, or null for any other command:
 * a merge through the REST endpoint `merges` into its `base`, a change of `git/refs/heads/<branch>`
 * or the creation of such a ref, and the GraphQL mutations `mergeBranch`, `updateRef` and
 * `updateRefs`, whose branch the command line does not name.
 * @param {string[]} words
 * @returns {BranchUpdate | null}
 */
export function branchUpdateOf(words) {
  const call = apiCallOf(words)
  if (call === null) return null
  const mutation = BRANCH_MUTATIONS.exec(call.text)
  if (mutation) return { via: `the GraphQL mutation ${mutation[1]}`, branch: null }
  if (call.method === 'GET') return null
  const endpoint = call.endpoint.replace(/[?#].*$/, '').replace(/\/+$/, '')
  if (/(?:^|\/)merges$/.test(endpoint)) {
    return { via: `${call.method} ${endpoint}`, branch: call.fields.get('base') ?? null }
  }
  const ref = /(?:^|\/)git\/refs\/heads\/(.+)$/.exec(endpoint)
  if (ref) return { via: `${call.method} ${endpoint}`, branch: decodeURIComponent(ref[1]) }
  const created = call.fields.get('ref')
  if (/(?:^|\/)git\/refs$/.test(endpoint) && created?.startsWith('refs/heads/')) {
    return { via: `${call.method} ${endpoint}`, branch: created.slice('refs/heads/'.length) }
  }
  return null
}

/**
 * A `git push` and what it pushes, or null for any other command.
 * @typedef {object} Push
 * @property {string[]} dirs The directories of `git -C`, in order.
 * @property {Map<string, string>} config The settings of `git -c <key>=<value>`, keys in lower case.
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
  /** @type {Map<string, string>} */
  const config = new Map()
  let at = 1
  while (at < words.length && words[at].startsWith('-')) {
    const option = words[at]
    const value = words[at + 1]
    if (GIT_VALUE_OPTIONS.includes(option)) {
      if (option === '-C' && value !== undefined) dirs.push(value)
      if (option === '-c' && value !== undefined && value.includes('=')) {
        const equals = value.indexOf('=')
        config.set(value.slice(0, equals).toLowerCase(), value.slice(equals + 1))
      }
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
  return { dirs, config, all, remote: positional[0] ?? null, refspecs: positional.slice(1) }
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
 * The parts of a `gh api` call: its method (`-X`, or POST when it sends fields or input, as gh
 * does), its endpoint, its fields and all its arguments as one text. Null for another command.
 * @param {string[]} words
 * @returns {{ method: string, endpoint: string, fields: Map<string, string>, text: string } | null}
 */
function apiCallOf(words) {
  if (basename(words[0] ?? '') !== 'gh' || words[1] !== 'api') return null
  const args = words.slice(2)
  /** @type {string | null} */
  let method = null
  let sends = false
  /** @type {Map<string, string>} */
  const fields = new Map()
  /** @type {string[]} */
  const positional = []
  /** @param {string} field */
  const addField = (field) => {
    sends = true
    const equals = field.indexOf('=')
    if (equals > 0) fields.set(field.slice(0, equals), field.slice(equals + 1))
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    const long = arg.startsWith('--') && arg.includes('=')
    const flag = long ? arg.slice(0, arg.indexOf('=')) : arg
    const inline = long ? arg.slice(arg.indexOf('=') + 1) : null
    if (flag === '-X' || flag === '--method') {
      method = inline ?? args[(i += 1)] ?? ''
    } else if (/^-X./.test(arg)) {
      method = arg.slice(2)
    } else if (API_FIELD_OPTIONS.includes(flag)) {
      addField(inline ?? args[(i += 1)] ?? '')
    } else if (/^-[fF]./.test(arg)) {
      addField(arg.slice(2))
    } else if (flag === '--input') {
      sends = true
      if (inline === null) i += 1
    } else if (API_VALUE_OPTIONS.includes(flag)) {
      if (inline === null) i += 1
    } else if (!arg.startsWith('-')) {
      positional.push(arg)
    }
  }
  return {
    method: (method ?? (sends ? 'POST' : 'GET')).toUpperCase(),
    endpoint: positional[0] ?? '',
    fields,
    text: args.join(' '),
  }
}

/**
 * Split shell text into simple commands of words, from `start`, appending them to `out`. The
 * commands of a substitution are appended before the command that holds it. With `nested` the
 * text is the inside of `$(`, `<(` or `>(`: the scan stops at the `)` that closes it.
 * @param {string} text
 * @param {number} start
 * @param {string[][]} out
 * @param {boolean} nested
 * @returns {number} The index of the closing `)`, or the length of the text.
 */
function lex(text, start, out, nested) {
  /** @type {string[]} */
  let words = []
  /** @type {string | null} */
  let word = null
  let redirected = false
  let depth = 0
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
    redirected = false
    if (words.length > 0) out.push(words)
    words = []
  }
  /** @param {string} part */
  const add = (part) => {
    word = (word ?? '') + part
  }

  let i = start
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
    } else if ((c === '$' || c === '<' || c === '>') && text[i + 1] === '(') {
      // A command or process substitution: its commands run as well.
      const end = lex(text, i + 2, out, true)
      add(text.slice(i, end + 1))
      i = end + 1
    } else if (c === '`') {
      const end = indexOrEnd(text, '`', i + 1)
      lex(text.slice(i + 1, end), 0, out, false)
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
      while (i < text.length && /[<>&|]/.test(text[i]) && text[i + 1] !== '(') i += 1
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
    } else if (c === '(') {
      endCommand()
      depth += 1
      i += 1
    } else if (c === ')') {
      endCommand()
      if (nested && depth === 0) return i
      depth = Math.max(0, depth - 1)
      i += 1
    } else if (';&|'.includes(c)) {
      endCommand()
      i += 1
    } else {
      add(c)
      i += 1
    }
  }
  endCommand()
  return text.length
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
      const end = lex(text, i + 2, out, true)
      part += text.slice(i, end + 1)
      i = end + 1
    } else if (text[i] === '`') {
      const end = indexOrEnd(text, '`', i + 1)
      lex(text.slice(i + 1, end), 0, out, false)
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
 * The words of a simple command without leading reserved words, assignments and wrapper
 * programs. The words of a loop header or a `case` are no command: empty.
 * @param {string[]} words
 * @returns {string[]}
 */
function unwrap(words) {
  let rest = words
  for (;;) {
    const before = rest.length
    while (rest.length > 0 && KEYWORDS.includes(rest[0])) rest = rest.slice(1)
    if (rest[0] === 'function') rest = rest.slice(2)
    if (rest.length > 0 && HEADERS.includes(rest[0])) return []
    while (rest.length > 0 && ASSIGNMENT.test(rest[0])) rest = rest.slice(1)
    const name = rest.length > 0 ? basename(rest[0]) : ''
    if (Object.hasOwn(WRAPPERS, name)) {
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
    if (rest.length === before) return rest
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

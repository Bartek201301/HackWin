// Path globs: the role paths and the `open` list of owners.yml, the path groups of hackwin.yml
// and the allowed paths of a task. A path is matched with picomatch, dot files included.
// Questions about sets of paths (do two globs share a path, does a glob reach a path outside a
// list of globs) are answered on finite automata built from the same globs. Both readings agree
// on the syntax that globError accepts: literal characters, `\` escapes, `?`, `*`, `**` and
// brace lists such as `{src,lib}`.

import picomatch from 'picomatch'

const PICOMATCH_OPTIONS = Object.freeze({ dot: true })

/** More alternatives than this from brace lists is an error, not a slow check. */
const MAX_ALTERNATIVES = 256

/** A search for a sample path gives up after this many automaton states. */
const MAX_SEARCH_STATES = 200_000

/**
 * Why a glob is not supported, or null when it is.
 * @param {unknown} glob
 * @returns {string | null}
 */
export function globError(glob) {
  if (typeof glob !== 'string' || glob === '') return 'must be a non-empty string'
  if (glob.startsWith('!')) return 'negated globs are not supported'
  let depth = 0
  /** @type {number[]} */
  const commas = []
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]
    if (ch === '\\') {
      if (i === glob.length - 1) return 'ends with a lone backslash'
      i += 1
    } else if ('[]()|'.includes(ch)) {
      return `"${ch}" is not supported: character classes, groups and extglobs are not; write \\${ch} for the character itself`
    } else if (ch === '{') {
      depth += 1
      commas[depth] = 0
    } else if (ch === '}') {
      if (depth === 0) return 'has a "}" without a "{"'
      if (commas[depth] === 0) {
        return 'has a brace group without a comma; write {a,b} for alternatives'
      }
      depth -= 1
    } else if (ch === ',' && depth > 0) {
      commas[depth] += 1
    }
  }
  if (depth > 0) return 'has a "{" without a "}"'
  const alternatives = expandBraces(glob)
  if (alternatives.length > MAX_ALTERNATIVES) {
    return `expands to more than ${MAX_ALTERNATIVES} alternatives`
  }
  for (const alternative of alternatives) {
    if (alternative.startsWith('/')) return 'must be relative to the repository root'
    const segments = splitSegments(alternative)
    if (segments.at(-1) === '') return 'must not end with "/"; write dir/** for a directory'
    if (segments.includes('')) return 'has an empty path segment'
    if (segments.some((segment) => segment === '.' || segment === '..')) {
      return 'must not contain "." or ".." segments'
    }
  }
  return null
}

/**
 * A matcher for paths against any of these globs. Paths are relative to the repository root,
 * with `/` as separator.
 * @param {string[]} globs
 * @returns {(path: string) => boolean}
 */
export function createMatcher(globs) {
  if (globs.length === 0) return () => false
  return picomatch(globs, PICOMATCH_OPTIONS)
}

/**
 * A path relative to the repository root, without a leading `./`.
 * @param {string} path
 * @returns {string}
 */
export function normalizePath(path) {
  return path.replace(/^(?:\.\/)+/, '')
}

/**
 * A sample path that matches a glob of `inside`, also a glob of `alsoInside` when given, and no
 * glob of `outside`; or null when no such path exists. Only real file paths count: no empty
 * segment, no `.` or `..` segment, no leading or trailing `/`. Every glob must pass globError.
 *
 * - Two globs share a path: `samplePath({ inside: [a], alsoInside: [b] })`.
 * - A glob reaches a path outside a list: `samplePath({ inside: [a], outside: list })`.
 * @param {object} sets
 * @param {string[]} sets.inside
 * @param {string[]} [sets.alsoInside]
 * @param {string[]} [sets.outside]
 * @returns {string | null}
 */
export function samplePath({ inside, alsoInside, outside = [] }) {
  const all = [...inside, ...(alsoInside ?? []), ...outside]
  const alphabet = alphabetOf(all)
  const a = buildAutomaton(inside)
  const b = alsoInside ? buildAutomaton(alsoInside) : null
  const c = buildAutomaton(outside)

  /** @typedef {{ sa: number[], sb: number[] | null, sc: number[], v: number }} SearchState */
  /** @type {SearchState} */
  const start = {
    sa: a.closure([a.start]),
    sb: b ? b.closure([b.start]) : null,
    sc: c.closure([c.start]),
    v: VALID_START,
  }
  /** @param {SearchState} s */
  const keyOf = (s) => `${s.sa.join(',')}|${s.sb?.join(',') ?? '*'}|${s.sc.join(',')}|${s.v}`
  /** @type {Map<string, { from: string | null, ch: string }>} */
  const parents = new Map([[keyOf(start), { from: null, ch: '' }]])
  /** @type {SearchState[]} */
  const queue = [start]
  for (let head = 0; head < queue.length; head += 1) {
    const state = queue[head]
    const key = keyOf(state)
    if (
      state.v === VALID_IN_SEGMENT &&
      a.accepts(state.sa) &&
      (b === null || (state.sb !== null && b.accepts(state.sb))) &&
      !c.accepts(state.sc)
    ) {
      return pathTo(parents, key)
    }
    for (const ch of alphabet) {
      const v = validStep(state.v, ch)
      if (v === VALID_DEAD) continue
      const sa = a.step(state.sa, ch)
      if (sa.length === 0) continue
      const sb = b && state.sb ? b.step(state.sb, ch) : null
      if (b && (sb === null || sb.length === 0)) continue
      const next = { sa, sb, sc: c.step(state.sc, ch), v }
      const nextKey = keyOf(next)
      if (parents.has(nextKey)) continue
      parents.set(nextKey, { from: key, ch })
      queue.push(next)
    }
    if (queue.length > MAX_SEARCH_STATES) {
      throw new Error(`the globs ${all.join(', ')} are too complex to compare`)
    }
  }
  return null
}

/**
 * Every alternative of a glob's brace lists, for example `{src,lib}/**` gives `src/**` and
 * `lib/**`. Escapes stay in place.
 * @param {string} glob
 * @returns {string[]}
 */
export function expandBraces(glob) {
  const open = indexOfUnescaped(glob, '{', 0)
  if (open === -1) return [glob]
  const close = matchingBrace(glob, open)
  if (close === -1) return [glob]
  const prefix = glob.slice(0, open)
  const suffix = glob.slice(close + 1)
  /** @type {string[]} */
  const result = []
  for (const option of splitTopLevel(glob.slice(open + 1, close))) {
    for (const expanded of expandBraces(prefix + option + suffix)) {
      result.push(expanded)
      if (result.length > MAX_ALTERNATIVES) return result
    }
  }
  return result
}

// The automaton of a list of globs: states with epsilon moves and moves on one character.

/** @typedef {{ kind: 'char', ch: string } | { kind: 'segment' } | { kind: 'any' }} CharTest */

class Automaton {
  constructor() {
    /** @type {number[][]} */
    this.eps = []
    /** @type {Array<Array<{ test: CharTest, to: number }>>} */
    this.moves = []
    /** @type {Set<number>} */
    this.final = new Set()
    this.start = this.state()
  }

  /** @returns {number} */
  state() {
    this.eps.push([])
    this.moves.push([])
    return this.eps.length - 1
  }

  /**
   * @param {number[]} states
   * @returns {number[]} The states and every state reachable from them by epsilon moves, sorted.
   */
  closure(states) {
    const seen = new Set(states)
    const stack = [...states]
    while (stack.length > 0) {
      const state = /** @type {number} */ (stack.pop())
      for (const to of this.eps[state]) {
        if (!seen.has(to)) {
          seen.add(to)
          stack.push(to)
        }
      }
    }
    return [...seen].sort((x, y) => x - y)
  }

  /**
   * @param {number[]} states A closed set of states.
   * @param {string} ch
   * @returns {number[]}
   */
  step(states, ch) {
    /** @type {number[]} */
    const next = []
    for (const state of states) {
      for (const { test, to } of this.moves[state]) {
        if (passes(test, ch)) next.push(to)
      }
    }
    return next.length === 0 ? next : this.closure(next)
  }

  /** @param {number[]} states */
  accepts(states) {
    return states.some((state) => this.final.has(state))
  }
}

/**
 * @param {CharTest} test
 * @param {string} ch
 */
function passes(test, ch) {
  if (test.kind === 'char') return test.ch === ch
  if (test.kind === 'segment') return ch !== '/'
  return true
}

/**
 * One automaton for the union of the globs.
 * @param {string[]} globs
 * @returns {Automaton}
 */
function buildAutomaton(globs) {
  const automaton = new Automaton()
  for (const glob of globs) {
    for (const alternative of expandBraces(glob)) {
      const [from, to] = addParts(automaton, partsOf(alternative))
      automaton.eps[automaton.start].push(from)
      automaton.final.add(to)
    }
  }
  return automaton
}

/**
 * @typedef {{ type: 'test', test: CharTest } | { type: 'star', test: CharTest } | { type: 'optional', parts: Part[] }} Part
 */

/** @type {CharTest} */
const SEGMENT_CHAR = Object.freeze({ kind: 'segment' })
/** @type {CharTest} */
const ANY_CHAR = Object.freeze({ kind: 'any' })

/**
 * @param {string} ch
 * @returns {Part}
 */
const literal = (ch) => ({ type: 'test', test: { kind: 'char', ch } })

/**
 * The parts of one alternative (no braces left), with picomatch's reading of `**`: a whole
 * segment `**` matches any number of segments, also none; inside a segment it is `*`.
 * @param {string} alternative
 * @returns {Part[]}
 */
function partsOf(alternative) {
  /** @type {string[]} */
  const segments = []
  for (const segment of splitSegments(alternative)) {
    if (!(segment === '**' && segments.at(-1) === '**')) segments.push(segment)
  }
  const last = segments.length - 1
  /** @type {Part[]} */
  const parts = []
  /** @type {Part} */
  const anyRun = { type: 'star', test: ANY_CHAR }
  segments.forEach((segment, i) => {
    if (segment === '**') {
      if (last === 0) parts.push(anyRun)
      else if (i === 0) parts.push({ type: 'optional', parts: [anyRun, literal('/')] })
      else if (i === last) parts.push({ type: 'optional', parts: [literal('/'), anyRun] })
      else parts.push(literal('/'), { type: 'optional', parts: [anyRun, literal('/')] })
      return
    }
    // A globstar before this segment already ends with its separator.
    if (i > 0 && segments[i - 1] !== '**') parts.push(literal('/'))
    for (let j = 0; j < segment.length; j += 1) {
      const ch = segment[j]
      if (ch === '\\') {
        j += 1
        parts.push(literal(segment[j]))
      } else if (ch === '*') {
        while (segment[j + 1] === '*') j += 1
        parts.push({ type: 'star', test: SEGMENT_CHAR })
      } else if (ch === '?') {
        parts.push({ type: 'test', test: SEGMENT_CHAR })
      } else {
        parts.push(literal(ch))
      }
    }
  })
  return parts
}

/**
 * Add a sequence of parts to the automaton.
 * @param {Automaton} automaton
 * @param {Part[]} parts
 * @returns {[number, number]} The entry and exit states.
 */
function addParts(automaton, parts) {
  const entry = automaton.state()
  let current = entry
  for (const part of parts) {
    if (part.type === 'test') {
      const next = automaton.state()
      automaton.moves[current].push({ test: part.test, to: next })
      current = next
    } else if (part.type === 'star') {
      const loop = automaton.state()
      automaton.eps[current].push(loop)
      automaton.moves[loop].push({ test: part.test, to: loop })
      current = loop
    } else {
      const [from, to] = addParts(automaton, part.parts)
      const next = automaton.state()
      automaton.eps[current].push(from, next)
      automaton.eps[to].push(next)
      current = next
    }
  }
  return [entry, current]
}

// Real file paths: segments that are not empty, `.` or `..`, separated by single slashes.
const VALID_DEAD = -1
const VALID_START = 0
const VALID_DOT = 1
const VALID_DOT_DOT = 2
const VALID_IN_SEGMENT = 3

/**
 * @param {number} state
 * @param {string} ch
 * @returns {number}
 */
function validStep(state, ch) {
  if (ch === '/') return state === VALID_IN_SEGMENT ? VALID_START : VALID_DEAD
  if (ch === '.' && state === VALID_START) return VALID_DOT
  if (ch === '.' && state === VALID_DOT) return VALID_DOT_DOT
  return VALID_IN_SEGMENT
}

/**
 * The characters a search tries: every literal of the globs, `/`, `.`, `,`, and one character
 * that no glob names, which stands for all the others.
 * @param {string[]} globs
 * @returns {string[]}
 */
function alphabetOf(globs) {
  /** @type {Set<string>} */
  const chars = new Set()
  for (const glob of globs) {
    for (let i = 0; i < glob.length; i += 1) {
      if (glob[i] === '\\') i += 1
      else if ('*?{}'.includes(glob[i])) continue
      chars.add(glob[i])
    }
  }
  const other = [...'xyzqkwjv0123456789'].find((ch) => !chars.has(ch)) ?? 'é'
  // The other character first, so that sample paths read like paths.
  return [...new Set([other, ...chars, '.', '/', ','])]
}

/**
 * @param {Map<string, { from: string | null, ch: string }>} parents
 * @param {string} key
 * @returns {string}
 */
function pathTo(parents, key) {
  /** @type {string[]} */
  const chars = []
  /** @type {string | null} */
  let current = key
  while (current !== null) {
    const entry = /** @type {{ from: string | null, ch: string }} */ (parents.get(current))
    chars.push(entry.ch)
    current = entry.from
  }
  return chars.reverse().join('')
}

/**
 * Split at every `/` that is not escaped.
 * @param {string} text
 * @returns {string[]}
 */
function splitSegments(text) {
  /** @type {string[]} */
  const segments = []
  let current = ''
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\\') {
      current += text.slice(i, i + 2)
      i += 1
    } else if (text[i] === '/') {
      segments.push(current)
      current = ''
    } else {
      current += text[i]
    }
  }
  segments.push(current)
  return segments
}

/**
 * @param {string} text
 * @param {string} ch
 * @param {number} from
 * @returns {number}
 */
function indexOfUnescaped(text, ch, from) {
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === '\\') i += 1
    else if (text[i] === ch) return i
  }
  return -1
}

/**
 * @param {string} text
 * @param {number} open The index of a `{`.
 * @returns {number} The index of its `}`, or -1.
 */
function matchingBrace(text, open) {
  let depth = 0
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '\\') i += 1
    else if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * Split the inside of a brace group at its own commas.
 * @param {string} text
 * @returns {string[]}
 */
function splitTopLevel(text) {
  /** @type {string[]} */
  const options = []
  let depth = 0
  let current = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '\\') {
      current += text.slice(i, i + 2)
      i += 1
      continue
    }
    if (ch === '{') depth += 1
    if (ch === '}') depth -= 1
    if (ch === ',' && depth === 0) {
      options.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  options.push(current)
  return options
}

// A trace of a Node process, for AC35: loaded with `node --import` before any other module, it
// wraps the functions of Node that write a file, start a process or open a connection, and writes
// one JSON line per call into the file that HACKWIN_TEST_TRACE names:
//
//   {"kind":"write","op":"writeFile","path":"/abs/file"}
//   {"kind":"spawn","op":"spawn","file":"git","args":["fetch"],"shell":false}
//   {"kind":"net","op":"fetch","target":"https://..."}
//
// It wraps the CommonJS exports of `fs`, `fs/promises`, `child_process`, `net`, `http` and `https`
// and then updates the ES module bindings of the built-in modules from them
// (`syncBuiltinESMExports`), so a module that imports `writeFile` from `node:fs/promises` calls
// the wrapper. The trace sees what the process itself does; what its child processes do, such as
// the writes of git into the clone, it records only as the start of that child.

import { createRequire, syncBuiltinESMExports } from 'node:module'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
const fs = require('node:fs')
const file = process.env.HACKWIN_TEST_TRACE
// Opened before anything is wrapped, and written with `writeSync`, which nothing wraps.
const out = file ? fs.openSync(file, 'a') : null
let recording = false

/** @param {Record<string, unknown>} entry */
function record(entry) {
  if (out === null || recording) return
  recording = true
  try {
    fs.writeSync(out, `${JSON.stringify(entry)}\n`)
  } finally {
    recording = false
  }
}

/** @param {unknown} target */
function pathOf(target) {
  if (target instanceof URL) return target.pathname
  if (typeof target === 'string') return resolve(target)
  if (Buffer.isBuffer(target)) return resolve(target.toString())
  return null
}

/**
 * Wrap a function of a module's exports so that each call is recorded first.
 * @param {any} exports
 * @param {string} name
 * @param {(args: any[]) => Record<string, unknown> | null} describe
 */
function wrap(exports, name, describe) {
  const original = exports?.[name]
  if (typeof original !== 'function') return
  exports[name] = function (/** @type {any[]} */ ...args) {
    const entry = describe(args)
    if (entry !== null) record(entry)
    return original.apply(this, args)
  }
}

/** Writes with the target path first: the second path of a rename, link or copy is recorded too. */
const ONE_PATH = [
  'writeFile',
  'appendFile',
  'mkdir',
  'rm',
  'rmdir',
  'unlink',
  'truncate',
  'mkdtemp',
]
const TWO_PATHS = ['rename', 'link', 'symlink', 'copyFile', 'cp']

/** @param {unknown} flags */
function writes(flags) {
  if (typeof flags === 'number')
    return (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) !== 0
  return typeof flags === 'string' && /[wa+]/.test(flags)
}

for (const [exports, suffix] of [
  [fs, ''],
  [fs, 'Sync'],
  [fs.promises, ''],
]) {
  for (const name of ONE_PATH) {
    wrap(exports, `${name}${suffix}`, (args) => ({
      kind: 'write',
      op: `${name}${suffix}`,
      path: pathOf(args[0]),
    }))
  }
  for (const name of TWO_PATHS) {
    wrap(exports, `${name}${suffix}`, (args) => ({
      kind: 'write',
      op: `${name}${suffix}`,
      path: pathOf(args[1]),
      from: pathOf(args[0]),
    }))
  }
  wrap(exports, `open${suffix}`, (args) =>
    writes(args[1]) ? { kind: 'write', op: `open${suffix}`, path: pathOf(args[0]) } : null,
  )
}
wrap(fs, 'createWriteStream', (args) => ({
  kind: 'write',
  op: 'createWriteStream',
  path: pathOf(args[0]),
}))

const childProcess = require('node:child_process')
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']) {
  wrap(childProcess, name, (args) => ({
    kind: 'spawn',
    op: name,
    file: String(args[0]),
    args: Array.isArray(args[1]) ? args[1].map(String) : [],
    shell: Boolean((Array.isArray(args[1]) ? args[2] : args[1])?.shell),
  }))
}
for (const name of ['exec', 'execSync']) {
  wrap(childProcess, name, (args) => ({
    kind: 'spawn',
    op: name,
    file: String(args[0]),
    args: [],
    shell: true,
  }))
}

for (const [module, names] of /** @type {const} */ ([
  ['node:net', ['connect', 'createConnection']],
  ['node:http', ['request', 'get']],
  ['node:https', ['request', 'get']],
])) {
  const exports = require(module)
  for (const name of names) {
    wrap(exports, name, (args) => ({
      kind: 'net',
      op: `${module}.${name}`,
      target: describe(args[0]),
    }))
  }
}
if (typeof globalThis.fetch === 'function') {
  const original = globalThis.fetch
  globalThis.fetch = (input, init) => {
    record({ kind: 'net', op: 'fetch', target: describe(input) })
    return original(input, init)
  }
}

/** @param {unknown} target */
function describe(target) {
  if (typeof target === 'string' || target instanceof URL) return String(target)
  if (target && typeof target === 'object') return JSON.stringify(target)
  return String(target)
}

syncBuiltinESMExports()
record({ kind: 'start', pid: process.pid })

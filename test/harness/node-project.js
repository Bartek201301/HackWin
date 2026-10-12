// The Node fixture: the tree of the fixture repositories' reset commit, a Node, Vite, Tailwind and
// TypeScript project with the HackWin template, for offline tests of command detection (AC3),
// installs and the template's files.
//
// The tree is kept as one text file, node-project.yml, and written out only into a test's own
// temporary directory. As a working copy inside this repository its CLAUDE.md, AGENTS.md,
// .claude/ and .agents/ would act as agent instructions, settings and skills for any session that
// opens a file there: Claude Code loads a nested CLAUDE.md or AGENTS.md, and the skills of a
// nested .claude/skills/, once it reads a file in that directory.
//
// To regenerate the file from a checkout of a new reset commit (after RESET_SHA and RESET_TREE
// changed): node test/harness/node-project.js <directory> > test/harness/node-project.yml

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse, stringify } from 'yaml'
import { RESET_SHA, RESET_TREE } from './fixture-repos.js'

/** The text file that holds the Node fixture. */
export const NODE_PROJECT_FILE = fileURLToPath(new URL('./node-project.yml', import.meta.url))

const HEADER = `# The Node fixture of the test harness (test/harness/node-project.js): every file of the tree
# of the fixture repositories' reset commit, as text. Tests write it out with writeNodeProject()
# into their own directory; kept as one file here, none of its files acts as agent instructions,
# settings or skills in this repository. Do not edit or format it by hand.
`

/** @type {Readonly<Record<string, string>> | undefined} */
let cache

/**
 * The files of the Node fixture: each path, relative to the project root, and its content.
 * @returns {Readonly<Record<string, string>>}
 */
export function nodeProjectFiles() {
  if (!cache) {
    const stored = parse(readFileSync(NODE_PROJECT_FILE, 'utf8'))
    if (stored.commit !== RESET_SHA || stored.tree !== RESET_TREE) {
      throw new Error(
        `${NODE_PROJECT_FILE} holds tree ${stored.tree} of ${stored.commit}, not ${RESET_TREE} of ${RESET_SHA}`,
      )
    }
    cache = Object.freeze({ ...stored.files })
  }
  return cache
}

/**
 * Write every file of the Node fixture into a directory, a test's own one.
 * @param {string} dir
 */
export function writeNodeProject(dir) {
  for (const [path, content] of Object.entries(nodeProjectFiles())) {
    if (isAbsolute(path) || normalize(path).split(/[\\/]/).includes('..')) {
      throw new Error(`the Node fixture holds a path outside its directory: ${path}`)
    }
    const file = join(dir, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
}

/**
 * The text of node-project.yml for the files of a directory, which must all be UTF-8 text.
 * @param {string} dir
 * @returns {string}
 */
export function packNodeProject(dir) {
  /** @type {Array<[string, string]>} */
  const files = []
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const path = relative(dir, join(entry.parentPath, entry.name)).split(/[\\/]/).join('/')
    if (path === '.git' || path.startsWith('.git/')) continue
    const bytes = readFileSync(join(dir, path))
    const text = bytes.toString('utf8')
    if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error(`not UTF-8 text: ${path}`)
    files.push([path, text])
  }
  files.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const body = stringify(
    { commit: RESET_SHA, tree: RESET_TREE, files: Object.fromEntries(files) },
    { lineWidth: 0, blockQuote: 'literal' },
  )
  return `${HEADER}${body}`
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error('usage: node test/harness/node-project.js <directory>')
  process.stdout.write(packNodeProject(process.argv[2]))
}

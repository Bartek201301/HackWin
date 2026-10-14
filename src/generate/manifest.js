// The generated file manifest: every committed file that HackWin generates (6.4), with the
// function that renders it for a CLI version. `setup` writes these files and overwrites existing
// copies (6.5), `setup --regenerate` rewrites them, and CI fails when a committed copy differs
// from what the pinned version renders (E19, A48). Each generator adds its entries here: the hook
// shims (1.4a), the CI workflow (1.4b), the Claude Code wrappers (1.4c).

import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { SHIM_FILES } from './githooks.js'
import { WORKFLOW_FILE } from './workflow.js'
import { WRAPPER_FILES } from './wrappers.js'

/**
 * What a generator renders from. A later generator that needs more adds a field here.
 * @typedef {object} GenerateInput
 * @property {string} version The CLI version; the header of every generated file names it.
 */

/**
 * @typedef {object} GeneratedFileSpec
 * @property {string} path Relative to the repository root.
 * @property {number} mode 0o755 for an executable file, 0o644 otherwise.
 * @property {(input: GenerateInput) => string} render
 */

/**
 * @typedef {object} GeneratedFile
 * @property {string} path
 * @property {number} mode
 * @property {string} content
 */

/**
 * A difference between a checkout and the generator output: the file is missing, its content
 * differs, or its executable bit does.
 * @typedef {{ path: string, problem: 'missing' | 'changed' | 'mode' }} StaleFile
 */

/** Every generated file, in the order `setup` writes them. */
export const MANIFEST = Object.freeze(
  /** @type {GeneratedFileSpec[]} */ ([...SHIM_FILES, WORKFLOW_FILE, ...WRAPPER_FILES]),
)

/**
 * The generated files of a CLI version.
 * @param {GenerateInput} input
 * @returns {GeneratedFile[]}
 */
export function generatedFiles(input) {
  return MANIFEST.map(({ path, mode, render }) => ({ path, mode, content: render(input) }))
}

/**
 * Write every generated file into a checkout, replacing existing copies (6.5).
 * @param {string} root The top-level directory of the checkout.
 * @param {GenerateInput} input
 * @returns {Promise<GeneratedFile[]>} The files written.
 */
export async function writeGeneratedFiles(root, input) {
  const files = generatedFiles(input)
  for (const { path, mode, content } of files) {
    const file = join(root, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, content)
    await chmod(file, mode)
  }
  return files
}

/**
 * The generated files of a checkout that differ from the output of this version (E19).
 * @param {string} root The top-level directory of the checkout.
 * @param {GenerateInput} input
 * @returns {Promise<StaleFile[]>} Empty when every file equals the generator output.
 */
export async function staleGeneratedFiles(root, input) {
  /** @type {StaleFile[]} */
  const stale = []
  for (const { path, mode, content } of generatedFiles(input)) {
    const file = join(root, path)
    /** @type {string} */
    let actual
    try {
      actual = await readFile(file, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      stale.push({ path, problem: 'missing' })
      continue
    }
    if (actual !== content) stale.push({ path, problem: 'changed' })
    else if (isExecutable((await stat(file)).mode) !== isExecutable(mode)) {
      stale.push({ path, problem: 'mode' })
    }
  }
  return stale
}

/**
 * @param {number} mode
 * @returns {boolean}
 */
function isExecutable(mode) {
  return (mode & 0o111) !== 0
}

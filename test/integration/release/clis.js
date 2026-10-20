// CLIs of other versions for the scenarios of a bug fix release (20.6, AC76, AC77). The versions
// follow the scheme of docs/build/contracts.md 6.2: a build `<phase>.0-pre.<n>`, its bug fix
// `<phase>.1-pre.<n>` of the same phase, and `<next phase>.0-pre.<n>` of another phase.
//
// - `buildCli` makes a CLI of a version from this checkout, as the pre-releases are packed: the
//   same commit with only the version in package.json changed. It copies what the package ships
//   (bin/ and src/) and package.json, and links the dependencies of this checkout.
// - `installCli` installs a GitHub pre-release by its URL with npm, as a member does with the
//   install command of CM12, into a prefix of its own.
//
// Both load the CLI's own `main` in-process, so a scenario runs it against the fake GitHub or
// through the guard of a fixture repository, and both give a directory with a `hackwin` of that
// version for PATH, where the git hooks and the wrappers find it.

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import semver from 'semver'
import { REPOSITORY_URL, VERSION } from '../../../src/cli/context.js'
import { installCommand } from '../../../src/core/config/index.js'
import { exec, quoteShellArg } from '../../../src/core/runtime/index.js'

/** @import { GhExecutor } from '../../../src/core/github/index.js' */
/** @import { Clock } from '../../../src/core/runtime/index.js' */

const CHECKOUT = fileURLToPath(new URL('../../../', import.meta.url))

const running = /** @type {semver.SemVer} */ (semver.parse(VERSION))

/**
 * The three versions of a scenario, for build `n`: `old`, the release the project starts with;
 * `fix`, its bug fix release of the same phase; `other`, a release of the next phase. The phase
 * is that of this checkout, so the scenarios follow it into a later phase (AC77).
 * @param {number | string} n
 */
export function releasesOf(n) {
  const { major, minor } = running
  return Object.freeze({
    old: `${major}.${minor}.0-pre.${n}`,
    fix: `${major}.${minor}.1-pre.${n}`,
    other: `${major}.${minor + 1}.0-pre.${n}`,
  })
}

/**
 * @typedef {object} Cli
 * @property {string} version What `hackwin --version` of this CLI prints.
 * @property {string} root The package root.
 * @property {string} bin A directory with an executable `hackwin` of this CLI, for PATH.
 * @property {(argv: string[], options?: object) => Promise<number>} main Its `main` (contracts
 *   3.6), loaded from its own package.
 */

/**
 * A CLI of `version`, built from this checkout as the pre-releases are packed.
 * @param {string} dir A directory of the test; the CLI goes to `<dir>/hackwin-<version>`.
 * @param {string} version
 * @returns {Promise<Cli>}
 */
export async function buildCli(dir, version) {
  const root = join(dir, `hackwin-${version}`)
  mkdirSync(root, { recursive: true })
  for (const part of ['bin', 'src']) {
    cpSync(join(CHECKOUT, part), join(root, part), { recursive: true })
  }
  const manifest = JSON.parse(readFileSync(join(CHECKOUT, 'package.json'), 'utf8'))
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ ...manifest, version }, null, 2)}\n`,
  )
  symlinkSync(join(CHECKOUT, 'node_modules'), join(root, 'node_modules'), 'dir')
  const bin = join(root, 'path')
  mkdirSync(bin)
  writeScript(join(bin, 'hackwin'), join(root, 'bin', 'hackwin.js'))
  return loadCli(root, bin)
}

/**
 * The CLI of this checkout, with a `hackwin` for PATH in `dir`.
 * @param {string} dir
 * @returns {Promise<Cli>}
 */
export async function checkoutCli(dir) {
  const bin = join(dir, 'checkout-path')
  mkdirSync(bin, { recursive: true })
  writeScript(join(bin, 'hackwin'), join(CHECKOUT, 'bin', 'hackwin.js'))
  return loadCli(CHECKOUT, bin)
}

/**
 * Install the GitHub pre-release of `version` with the install command that CM12 prints
 * (contracts 6.3), into the prefix `<dir>/npm-<version>`.
 * @param {string} dir
 * @param {string} version
 * @param {Record<string, string | undefined>} env The environment of npm.
 * @returns {Promise<Cli & { command: string, log: string[] }>} `command` is the install command
 *   as CM12 prints it; `log` the tail of npm's output.
 */
export async function installCli(dir, version, env) {
  const command = installCommand(version, REPOSITORY_URL)
  const prefix = join(dir, `npm-${version}`)
  mkdirSync(prefix, { recursive: true })
  const args = [...command.split(' ').slice(1), '--prefix', prefix, '--no-fund', '--no-audit']
  const result = await exec('npm', args, { cwd: dir, env, timeoutMs: 10 * 60_000 })
  if (result.code !== 0) {
    throw new Error(
      `${command} --prefix ${prefix} exited ${result.code}:\n${result.tail.join('\n')}`,
    )
  }
  const root = join(prefix, 'lib', 'node_modules', 'hackwin')
  const cli = await loadCli(root, join(prefix, 'bin'))
  if (cli.version !== version) {
    throw new Error(`${command} installed hackwin ${cli.version}, not ${version}`)
  }
  return { ...cli, command, log: result.tail }
}

/**
 * Write an executable `hackwin` that runs a CLI's entry with this Node.
 * @param {string} file
 * @param {string} entry `bin/hackwin.js` of the package.
 */
function writeScript(file, entry) {
  writeFileSync(
    file,
    `#!/bin/sh\nexec ${quoteShellArg(process.execPath)} ${quoteShellArg(entry)} "$@"\n`,
  )
  chmodSync(file, 0o755)
}

/**
 * Load the CLI of a package root.
 * @param {string} root
 * @param {string} bin
 * @returns {Promise<Cli>}
 */
async function loadCli(root, bin) {
  if (!existsSync(join(bin, 'hackwin'))) throw new Error(`${bin} holds no hackwin`)
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const module = await import(pathToFileURL(join(root, 'src', 'cli', 'main.js')).href)
  return { version, root, bin, main: module.main }
}

/**
 * @typedef {object} RunOptions
 * @property {string} cwd
 * @property {Record<string, string | undefined>} env The whole environment of the command.
 * @property {GhExecutor} ghExecutor
 * @property {Clock} [clock]
 */

/**
 * Run a command of this CLI in-process, as `hackwin <argv>` in a script: stdin and stdout are no
 * terminals, so the caller kind is `non-interactive` (contracts 3.5).
 * @param {Cli} cli
 * @param {string[]} argv
 * @param {RunOptions} options
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export async function runCli(cli, argv, { cwd, env, ghExecutor, clock }) {
  let stdout = ''
  let stderr = ''
  const code = await cli.main(argv, {
    cwd,
    env,
    stdin: Object.assign(Readable.from([]), { isTTY: false }),
    stdout: { write: (/** @type {string} */ chunk) => (stdout += chunk), isTTY: false },
    stderr: { write: (/** @type {string} */ chunk) => (stderr += chunk) },
    ghExecutor,
    ...(clock ? { clock } : {}),
  })
  return { code, stdout, stderr }
}

/**
 * The environment `env` with this CLI first on PATH.
 * @param {Cli} cli
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string | undefined>}
 */
export function withCli(cli, env) {
  return { ...env, PATH: `${cli.bin}:${env.PATH}` }
}

/** The install command that CM12 prints for a version, with `repository.url` of this package. */
export function installOf(/** @type {string} */ version) {
  return installCommand(version, REPOSITORY_URL)
}

// Step 5 of `setup` (7.1): the stack commands, detected from the project files and confirmed by
// the Lead, the optional smoke test command, and the path groups of `paths` that are known before
// planning (I16): manifests and lockfiles of the detected stack, migration directories,
// production config files and the ledger. In a terminal setup shows all of them as one block, which
// the Lead keeps with one answer or goes through to change any of them. Detection is required for
// Node projects; for another stack setup asks for each command it could not detect.
// `paths.manifests` must name at least one manifest (A62).

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { listText, wordsOf } from './questions.js'

/** @import { HackwinConfig } from '../../core/config/index.js' */
/** @import { Questions } from './questions.js' */

/** @typedef {HackwinConfig['commands']} Commands */
/** @typedef {HackwinConfig['paths']} Paths */

/** The commands of `commands` that setup detects, in the order it shows them. */
export const DETECTED_COMMANDS = Object.freeze([
  'install',
  'check',
  'test',
  'format',
  'generate',
  'lockfile_regen',
])

/** The commands that must not be empty (6.1). */
const REQUIRED_COMMANDS = Object.freeze(['install', 'check', 'test', 'format', 'lockfile_regen'])

/** The path groups that setup proposes, as dotted keys of `paths`, in the order it shows them. */
export const PATH_GROUPS = Object.freeze([
  'manifests',
  'lockfiles',
  'gated.migrations',
  'gated.production_config',
])

/** Directories that hold migrations in common stacks. */
const MIGRATION_DIRS = Object.freeze([
  'migrations',
  'db/migrations',
  'database/migrations',
  'src/db/migrations',
  'prisma/migrations',
  'supabase/migrations',
  'drizzle',
])

/** Production configuration files of common hosting platforms. */
const PRODUCTION_CONFIG_FILES = Object.freeze([
  'vercel.json',
  'netlify.toml',
  'fly.toml',
  'render.yaml',
  'railway.json',
  'railway.toml',
  'wrangler.toml',
  'wrangler.json',
  'app.yaml',
  'Procfile',
])

/**
 * A Node package manager: its lockfiles and its commands. `script` runs a script of
 * package.json; `withFiles` runs one so that the files appended to the command reach it.
 * @typedef {object} PackageManager
 * @property {string} name
 * @property {string[]} lockfiles
 * @property {(locked: boolean, root: Set<string>) => string} install
 * @property {(script: string) => string} script
 * @property {(script: string) => string} withFiles
 * @property {(root: Set<string>) => string} lockfileRegen
 */

/** @type {ReadonlyArray<PackageManager>} The managers in the order their lockfiles are looked for. */
const MANAGERS = Object.freeze([
  {
    name: 'pnpm',
    lockfiles: ['pnpm-lock.yaml'],
    install: (locked) => (locked ? 'pnpm install --frozen-lockfile' : 'pnpm install'),
    script: (script) => `pnpm run ${script}`,
    withFiles: (script) => `pnpm run ${script}`,
    lockfileRegen: () => 'pnpm install --lockfile-only',
  },
  {
    name: 'yarn',
    lockfiles: ['yarn.lock'],
    install: (locked, root) =>
      !locked
        ? 'yarn install'
        : root.has('.yarnrc.yml')
          ? 'yarn install --immutable'
          : 'yarn install --frozen-lockfile',
    script: (script) => `yarn run ${script}`,
    withFiles: (script) => `yarn run ${script}`,
    lockfileRegen: (root) =>
      root.has('.yarnrc.yml') ? 'yarn install --mode=update-lockfile' : 'yarn install',
  },
  {
    name: 'bun',
    lockfiles: ['bun.lock', 'bun.lockb'],
    install: (locked) => (locked ? 'bun install --frozen-lockfile' : 'bun install'),
    script: (script) => `bun run ${script}`,
    withFiles: (script) => `bun run ${script}`,
    lockfileRegen: () => 'bun install',
  },
  {
    name: 'npm',
    lockfiles: ['package-lock.json', 'npm-shrinkwrap.json'],
    install: (locked) => (locked ? 'npm ci' : 'npm install'),
    script: (script) => (script === 'test' ? 'npm test' : `npm run ${script}`),
    withFiles: (script) => (script === 'test' ? 'npm test --' : `npm run ${script} --`),
    lockfileRegen: () => 'npm install --package-lock-only',
  },
])

/** The scripts that make up the full check when package.json has no `check` script. */
const CHECK_PARTS = Object.freeze(['lint', 'typecheck', 'test', 'build'])

/**
 * What setup found in the project files.
 * @typedef {object} Detection
 * @property {string | null} stack `node`, or null for a stack setup does not know.
 * @property {string | null} manager The Node package manager.
 * @property {string[]} sources The files the commands were detected from.
 * @property {Partial<Record<keyof Commands, string | null>>} commands
 * @property {{ manifests: string[], lockfiles: string[], gated: { migrations: string[], production_config: string[] }, ledger: string | null }} paths
 */

/**
 * Detect the stack commands and the path groups from the files at the root of the checkout and
 * the tracked directories.
 * @param {string} root
 * @param {object} tree
 * @param {ReadonlySet<string>} tree.files Every tracked file, relative.
 * @param {ReadonlySet<string>} tree.directories Every directory with a tracked file, relative.
 * @returns {Promise<Detection>}
 */
export async function detectStack(root, { files, directories }) {
  const top = new Set([...files].filter((path) => !path.includes('/')))
  const paths = {
    manifests: /** @type {string[]} */ ([]),
    lockfiles: /** @type {string[]} */ ([]),
    gated: {
      migrations: MIGRATION_DIRS.filter((dir) => directories.has(dir)).map((dir) => `${dir}/**`),
      production_config: PRODUCTION_CONFIG_FILES.filter((file) => top.has(file)),
    },
    ledger: null,
  }
  const manifest = top.has('package.json') ? await readPackageJson(root) : null
  if (manifest === null) return { stack: null, manager: null, sources: [], commands: {}, paths }

  const declared = /^(npm|pnpm|yarn|bun)@/.exec(manifest.packageManager ?? '')?.[1]
  const manager =
    MANAGERS.find((entry) => entry.lockfiles.some((file) => top.has(file))) ??
    MANAGERS.find((entry) => entry.name === declared) ??
    /** @type {PackageManager} */ (MANAGERS.find((entry) => entry.name === 'npm'))
  const lockfiles = manager.lockfiles.filter((file) => top.has(file))
  const scripts = manifest.scripts ?? {}
  const has = (/** @type {string} */ name) => typeof scripts[name] === 'string'
  const parts = CHECK_PARTS.filter(has)
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies }

  /** @type {Detection['commands']} */
  const commands = {
    install: manager.install(lockfiles.length > 0, top),
    check: has('check')
      ? manager.script('check')
      : parts.length > 0
        ? parts.map((part) => manager.script(part)).join(' && ')
        : null,
    test: has('test') ? manager.withFiles('test') : null,
    format: has('format')
      ? manager.withFiles('format')
      : 'prettier' in dependencies
        ? 'npx prettier --write'
        : null,
    generate: has('generate') ? manager.script('generate') : null,
    lockfile_regen: manager.lockfileRegen(top),
  }
  paths.manifests = ['package.json']
  paths.lockfiles = lockfiles
  return {
    stack: 'node',
    manager: manager.name,
    sources: ['package.json', ...lockfiles],
    commands,
    paths,
  }
}

/**
 * @param {string} root
 * @returns {Promise<{ scripts?: Record<string, unknown>, packageManager?: string, dependencies?: Record<string, unknown>, devDependencies?: Record<string, unknown> } | null>}
 */
async function readPackageJson(root) {
  try {
    const value = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

/** What the questions of step 5 decide, in the words of the team. */
export const STACK_INTRO =
  'Commands and files: how HackWin installs, checks, tests and formats this project, a smoke test, which is a quick command that the Gate runs after each merge to see that the app still works, and the files that only the Lead changes.'

/** The commands of `commands` that setup shows, in the order it shows them. */
const COMMANDS = Object.freeze([...DETECTED_COMMANDS, 'smoke'])

/** What each command and path group is, in the words of the team, for the questions. */
const LABELS = Object.freeze({
  install: 'install the dependencies',
  check: 'full check',
  test: 'run the tests a task names',
  format: 'format files',
  generate: 'rebuild generated files',
  lockfile_regen: 'rebuild the lockfile',
  smoke: 'smoke test after each merge',
  manifests: 'dependency files',
  lockfiles: 'lockfiles',
  'gated.migrations': 'database migrations',
  'gated.production_config': 'production config',
})

/**
 * Step 5 in the answers file or the terminal: the commands, the smoke test command and the path
 * groups. An answer of the file wins over a detected value. In a terminal setup shows every value
 * as one block, and the Lead keeps all of them with one answer, or goes through the ones the file
 * does not give and changes any of them; a missing required value makes setup go through them.
 * Without a terminal a required command that neither gives is missing.
 * @param {Questions} questions
 * @param {Detection} detection
 * @returns {Promise<{ commands: Commands, paths: Paths }>}
 */
export async function askStack(questions, detection) {
  /** @type {Record<string, string | null | undefined>} */
  const values = {}
  for (const key of COMMANDS) {
    const given = questions.given(`commands.${key}`)
    values[key] =
      given !== undefined
        ? /** @type {string | null} */ (given)
        : detection.commands[/** @type {keyof Commands} */ (key)]
  }
  const proposed = detection.paths
  /** @type {Record<string, string[]>} */
  const groups = {
    manifests: proposed.manifests,
    lockfiles: proposed.lockfiles,
    'gated.migrations': proposed.gated.migrations,
    'gated.production_config': proposed.gated.production_config,
  }
  for (const key of PATH_GROUPS) {
    const given = questions.given(`paths.${key}`)
    if (given !== undefined) groups[key] = /** @type {string[]} */ (given)
  }
  const askedCommands = COMMANDS.filter((key) => !questions.has(`commands.${key}`))
  const askedGroups = PATH_GROUPS.filter((key) => !questions.has(`paths.${key}`))
  const undecided = askedCommands.filter((key) => values[key] == null && isRequired(key))

  if (questions.interactive && askedCommands.length + askedGroups.length > 0) {
    showStack(questions, detection, values, groups)
    const missing = undecided.map((key) => LABELS[key])
    if (askedGroups.includes('manifests') && groups.manifests.length === 0) {
      missing.push(LABELS.manifests)
    }
    if (missing.length > 0) questions.say(`Required and missing: ${missing.join(', ')}.`)
    if (missing.length > 0 || !(await questions.keep('Keep all of these?'))) {
      questions.say('Type a new value, or press Enter to keep the one in brackets.')
      for (const key of askedCommands) {
        values[key] = await askCommand(questions, key, values[key] ?? null)
      }
      for (const key of askedGroups) groups[key] = await askGroup(questions, key, groups[key])
    }
  } else if (undecided.length > 0) {
    throw questions.missing(
      `commands.${undecided[0]}`,
      `setup could not detect the ${undecided[0]} command of this project`,
    )
  }

  const given = (/** @type {string} */ key, /** @type {unknown} */ fallback) =>
    questions.has(`paths.${key}`) ? questions.given(`paths.${key}`) : fallback
  return {
    commands: /** @type {Commands} */ ({
      install: values.install,
      check: values.check,
      test: values.test,
      format: values.format,
      generate: values.generate ?? null,
      lockfile_regen: values.lockfile_regen,
      smoke: values.smoke ?? null,
    }),
    paths: /** @type {Paths} */ ({
      contracts: given('contracts', []),
      generated: given('generated', []),
      manifests: groups.manifests,
      lockfiles: groups.lockfiles,
      gated: {
        migrations: groups['gated.migrations'],
        production_config: groups['gated.production_config'],
      },
      ledger: given('ledger', proposed.ledger),
    }),
  }
}

/**
 * The block of step 5: what it decides, then every command and path group with its value.
 * @param {Questions} questions
 * @param {Detection} detection
 * @param {Record<string, string | null | undefined>} values
 * @param {Record<string, string[]>} groups
 */
function showStack(questions, detection, values, groups) {
  const from =
    detection.sources.length > 0
      ? `detected from ${detection.sources.join(' and ')} (${detection.manager})`
      : 'none detected: this is not a Node project'
  questions.say(STACK_INTRO)
  questions.say(`Commands, ${from}:`)
  for (const key of COMMANDS) questions.say(`  ${LABELS[key]}: ${values[key] ?? 'none'}`)
  questions.say(
    'Files that only the Lead changes; other kinds can be added later through a pull request:',
  )
  for (const key of PATH_GROUPS) questions.say(`  ${LABELS[key]}: ${listText(groups[key])}`)
}

/**
 * @param {Questions} questions
 * @param {string} key
 * @param {string | null} current
 * @returns {Promise<string | null>}
 */
async function askCommand(questions, key, current) {
  const required = isRequired(key)
  const label = capitalized(LABELS[key])
  const answer = await questions.ask(required ? label : `${label}, or none`, {
    fallback: current ?? (required ? '' : 'none'),
    check: (value) =>
      required && nullWhenNone(value) === null ? 'this command is required' : null,
  })
  return nullWhenNone(answer)
}

/**
 * @param {Questions} questions
 * @param {string} key
 * @param {string[]} current
 * @returns {Promise<string[]>}
 */
async function askGroup(questions, key, current) {
  const required = key === 'manifests'
  const label = capitalized(LABELS[key])
  const answer = await questions.ask(
    required
      ? `${label}, paths separated by commas, at least the one of the planned stack, such as package.json`
      : `${label}, paths separated by commas, or none`,
    {
      fallback: current.length > 0 ? current.join(', ') : required ? '' : 'none',
      check: (value) =>
        required && wordsOf(value).length === 0 ? 'name at least one dependency file' : null,
    },
  )
  return wordsOf(answer)
}

/**
 * @param {string} key
 * @returns {boolean}
 */
function isRequired(key) {
  return REQUIRED_COMMANDS.includes(key)
}

/**
 * @param {string} text
 * @returns {string}
 */
function capitalized(text) {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * @param {string} value
 * @returns {string | null}
 */
function nullWhenNone(value) {
  const trimmed = value.trim()
  return trimmed === '' || trimmed.toLowerCase() === 'none' ? null : trimmed
}

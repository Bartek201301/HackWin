// Step 5 of `setup` (7.1): the stack commands, detected from the project files and confirmed by
// the Lead, the optional smoke test command, and the path groups of `paths` that are known before
// planning (I16): manifests and lockfiles of the detected stack, migration directories,
// production config files and the ledger. Detection is required for Node projects; for another
// stack setup asks for each command it could not detect. `paths.manifests` must name at least
// one manifest (A62).

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

/**
 * Step 5 in the answers file or the terminal: the commands, the smoke test command and the path
 * groups. An answer of the file wins over a detected value; a value that neither gives is asked
 * in the terminal, and is missing otherwise.
 * @param {Questions} questions
 * @param {Detection} detection
 * @returns {Promise<{ commands: Commands, paths: Paths }>}
 */
export async function askStack(questions, detection) {
  const commands = await askCommands(questions, detection)
  const paths = await askPaths(questions, detection)
  return { commands, paths }
}

/**
 * @param {Questions} questions
 * @param {Detection} detection
 * @returns {Promise<Commands>}
 */
async function askCommands(questions, detection) {
  /** @type {Record<string, string | null | undefined>} */
  const values = {}
  for (const key of DETECTED_COMMANDS) {
    const given = questions.given(`commands.${key}`)
    values[key] =
      given !== undefined ? /** @type {string | null} */ (given) : detection.commands[key]
  }
  const undecided = DETECTED_COMMANDS.filter(
    (key) => !questions.has(`commands.${key}`) && values[key] == null && isRequired(key),
  )
  const asked = DETECTED_COMMANDS.filter((key) => !questions.has(`commands.${key}`))

  if (questions.interactive && asked.length > 0) {
    const from =
      detection.sources.length > 0
        ? `detected from ${detection.sources.join(' and ')} (${detection.manager})`
        : 'none detected: this is not a Node project'
    questions.say(`Stack commands, ${from}:`)
    for (const key of DETECTED_COMMANDS) questions.say(`  ${key}: ${values[key] ?? 'none'}`)
    const edit = undecided.length > 0 || !(await questions.keep('Keep these commands?'))
    if (edit) {
      for (const key of asked) values[key] = await askCommand(questions, key, values[key] ?? null)
    }
  } else if (undecided.length > 0) {
    throw questions.missing(
      `commands.${undecided[0]}`,
      `setup could not detect the ${undecided[0]} command of this project`,
    )
  }

  /** @type {string | null} */
  let smoke = null
  if (questions.has('commands.smoke')) {
    smoke = /** @type {string | null} */ (questions.given('commands.smoke'))
  } else if (questions.interactive) {
    smoke = nullWhenNone(
      await questions.ask('Smoke test command to run after each merge, or none', {
        fallback: 'none',
        check: () => null,
      }),
    )
  }
  return /** @type {Commands} */ ({
    install: values.install,
    check: values.check,
    test: values.test,
    format: values.format,
    generate: values.generate ?? null,
    lockfile_regen: values.lockfile_regen,
    smoke,
  })
}

/**
 * @param {Questions} questions
 * @param {string} key
 * @param {string | null} detected
 * @returns {Promise<string | null>}
 */
async function askCommand(questions, key, detected) {
  const required = isRequired(key)
  const answer = await questions.ask(required ? `Command ${key}` : `Command ${key}, or none`, {
    fallback: detected ?? (required ? '' : 'none'),
    check: (value) => (required && nullWhenNone(value) === null ? `${key} is required` : null),
  })
  return nullWhenNone(answer)
}

/**
 * @param {Questions} questions
 * @param {Detection} detection
 * @returns {Promise<Paths>}
 */
async function askPaths(questions, detection) {
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
  const asked = PATH_GROUPS.filter((key) => !questions.has(`paths.${key}`))
  if (questions.interactive && asked.length > 0) {
    questions.say(
      'Path groups known before planning; the others are set later through a pull request:',
    )
    for (const key of PATH_GROUPS) questions.say(`  ${key}: ${listText(groups[key])}`)
    const edit = groups.manifests.length === 0 || !(await questions.keep('Keep these path groups?'))
    if (edit) {
      for (const key of asked) {
        const required = key === 'manifests'
        groups[key] = wordsOf(
          await questions.ask(
            required
              ? 'Dependency manifests, globs separated by commas, at least the manifest of the planned stack'
              : `Globs of ${key}, separated by commas, or none`,
            {
              fallback: groups[key].length > 0 ? groups[key].join(', ') : required ? '' : 'none',
              check: (value) =>
                required && wordsOf(value).length === 0 ? 'name at least one manifest' : null,
            },
          ),
        )
      }
    }
  }
  const given = (/** @type {string} */ key, /** @type {unknown} */ fallback) =>
    questions.has(`paths.${key}`) ? questions.given(`paths.${key}`) : fallback
  return /** @type {Paths} */ ({
    contracts: given('contracts', []),
    generated: given('generated', []),
    manifests: groups.manifests,
    lockfiles: groups.lockfiles,
    gated: {
      migrations: groups['gated.migrations'],
      production_config: groups['gated.production_config'],
    },
    ledger: given('ledger', proposed.ledger),
  })
}

/**
 * @param {string} key
 * @returns {boolean}
 */
function isRequired(key) {
  return REQUIRED_COMMANDS.includes(key)
}

/**
 * @param {string} value
 * @returns {string | null}
 */
function nullWhenNone(value) {
  const trimmed = value.trim()
  return trimmed === '' || trimmed.toLowerCase() === 'none' ? null : trimmed
}

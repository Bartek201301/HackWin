// The command registry: every command of Phase 1 and the plumbing namespace `hackwin internal`
// (A10), each mapped to a fixed module path in its owner's directory (docs/build/plan.md
// section 2). Modules load lazily, so a lane adds a command by creating its module; no lane
// edits this file.

import { UsageError } from '../core/runtime/errors.js'

/**
 * A flag of a command, in the form of util.parseArgs.
 * @typedef {{ type: 'boolean' | 'string', short?: string }} FlagSpec
 */

/**
 * @typedef {object} CommandEntry
 * @property {string} name The words after `hackwin`, for example `take` or `internal hook pre-push`.
 * @property {string} module The entry module, relative to the package root.
 * @property {'lane-a' | 'lane-b' | 'lane-c'} owner The role that writes the module.
 * @property {string} usage
 * @property {string} summary
 * @property {Record<string, FlagSpec>} flags The command's own flags. Global flags come on top.
 * @property {number} maxArgs How many positional arguments the command takes at most.
 * @property {boolean} plumbing True for `hackwin internal ...`, which --help does not list.
 */

/** The commands of Phase 1, in the order --help lists them (AC67). */
export const COMMANDS = Object.freeze(
  /** @type {CommandEntry[]} */ ([
    {
      name: 'setup',
      module: 'src/commands/setup/index.js',
      owner: 'lane-a',
      usage: 'hackwin setup [--resume | --regenerate] [--answers <file>]',
      summary:
        'Configure the repository once: team, ownership, stack commands, generated files, labels, branch rules',
      flags: {
        resume: { type: 'boolean' },
        regenerate: { type: 'boolean' },
        answers: { type: 'string' },
      },
      maxArgs: 0,
      plumbing: false,
    },
    {
      name: 'join',
      module: 'src/commands/join/index.js',
      owner: 'lane-a',
      usage: 'hackwin join [--answers <file>]',
      summary: 'Prepare this machine: checks, hooks, personal settings',
      flags: { answers: { type: 'string' } },
      maxArgs: 0,
      plumbing: false,
    },
    {
      name: 'take',
      module: 'src/commands/take/index.js',
      owner: 'lane-b',
      usage: 'hackwin take [N] [--release]',
      summary: 'Check a task, create its worktree and start your agent with a composed prompt',
      flags: { release: { type: 'boolean' } },
      maxArgs: 1,
      plumbing: false,
    },
    {
      name: 'ship',
      module: 'src/commands/ship/index.js',
      owner: 'lane-b',
      usage: 'hackwin ship',
      summary:
        'Merge main into the branch, run every check, open the pull request, report in the issue and stop',
      flags: {},
      maxArgs: 0,
      plumbing: false,
    },
    {
      name: 'status',
      module: 'src/commands/status/index.js',
      owner: 'lane-c',
      usage: 'hackwin status',
      summary: 'Show who does what, the merge queue, what is blocked and what the Gate did',
      flags: {},
      maxArgs: 0,
      plumbing: false,
    },
    {
      name: 'gate',
      module: 'src/commands/gate/index.js',
      owner: 'lane-c',
      usage: 'hackwin gate',
      summary: 'Start the Gate, which tests and merges pull requests one at a time without a model',
      flags: {},
      maxArgs: 0,
      plumbing: false,
    },
  ]),
)

/** The hooks behind `hackwin internal hook <name>`: git hooks (10.3) and Claude Code hooks (10.4). */
export const HOOK_NAMES = Object.freeze([
  'pre-commit',
  'pre-push',
  'session-start',
  'pre-tool-use',
  'post-tool-use',
])

/** The plumbing commands that hooks and CI call (A10). */
export const PLUMBING = Object.freeze(
  /** @type {CommandEntry[]} */ ([
    ...HOOK_NAMES.map((hook) => ({
      name: `internal hook ${hook}`,
      module: `src/internal/hook/${hook}.js`,
      owner: /** @type {const} */ ('lane-a'),
      usage: `hackwin internal hook ${hook}`,
      summary: `The ${hook} hook`,
      flags: {},
      // git passes the remote name and URL to pre-push; the other hooks read stdin.
      maxArgs: hook === 'pre-push' ? 2 : 0,
      plumbing: true,
    })),
    {
      name: 'internal ci',
      module: 'src/internal/ci/index.js',
      owner: 'lane-a',
      usage: 'hackwin internal ci',
      summary: 'The checks of the hackwin CI workflow',
      flags: {},
      maxArgs: 0,
      plumbing: true,
    },
  ]),
)

/** Flags that every command accepts. @type {Readonly<Record<string, FlagSpec>>} */
export const GLOBAL_FLAGS = Object.freeze({
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
})

/**
 * Find the command named by the leading words of the command line.
 * @param {string[]} words The command line without global flags.
 * @returns {{ entry: CommandEntry, rest: string[] }} The entry and the words after its name.
 */
export function resolveCommand(words) {
  const [first, second, third] = words
  if (first === undefined) {
    throw new UsageError('no command given', {
      resolve: { command: 'hackwin --help', dir: 'any directory' },
    })
  }
  if (first === 'internal') {
    if (second === 'ci') return { entry: findPlumbing('internal ci'), rest: words.slice(2) }
    if (second === 'hook') {
      if (third === undefined) {
        throw new UsageError(`missing hook name; hooks: ${HOOK_NAMES.join(', ')}`)
      }
      if (!HOOK_NAMES.includes(third)) {
        throw new UsageError(`unknown hook: ${third}; hooks: ${HOOK_NAMES.join(', ')}`)
      }
      return { entry: findPlumbing(`internal hook ${third}`), rest: words.slice(3) }
    }
    throw new UsageError(`unknown command: internal${second === undefined ? '' : ` ${second}`}`)
  }
  const entry = COMMANDS.find((command) => command.name === first)
  if (!entry) {
    throw new UsageError(`unknown command: ${first}`, {
      resolve: { command: 'hackwin --help', dir: 'any directory' },
    })
  }
  return { entry, rest: words.slice(1) }
}

/**
 * @param {string} name
 * @returns {CommandEntry}
 */
function findPlumbing(name) {
  const entry = PLUMBING.find((command) => command.name === name)
  if (!entry) throw new Error(`no plumbing entry ${name}`)
  return entry
}

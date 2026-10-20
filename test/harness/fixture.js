// Offline fixtures: a temporary bare origin and its main checkout, isolated from the user's git
// and gh configuration (own HOME, own global git config, no system config, no global hooks, an
// empty gh config), and scripted states built with the shared modules: files, commits, branches,
// task worktrees, a team configuration and a joined clone with the join record.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { VERSION } from '../../src/cli/context.js'
import { createGit } from '../../src/core/git/index.js'
import { writeLocal } from '../../src/core/state/index.js'
import { branchName, slugOf } from '../../src/core/tasks/index.js'
import { repairHooksPath, taskWorktreePath } from '../../src/core/worktrees/index.js'
import { TOKEN_VARIABLE, accounts } from './accounts.js'
import { writeNodeProject } from './node-project.js'
import { teamConfig, yaml } from './team.js'

/** @import { Git } from '../../src/core/git/index.js' */
/** @import { TeamConfig } from './team.js' */

/** The author of every commit a fixture makes. */
export const FIXTURE_IDENTITY = Object.freeze({
  name: 'HackWin Test',
  email: 'test@example.invalid',
})

/** Variables that would tie a child process to the user's GitHub login, repository or session. */
const DROPPED_VARIABLES = [
  'GH_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GH_HOST',
  'GH_REPO',
  'GH_CONFIG_DIR',
  'HACKWIN_CALLER',
  'CI',
  TOKEN_VARIABLE,
]

/**
 * Prefixes of variables that are dropped as well: `GIT_*` of the user's git, and `GITHUB_*` and
 * `RUNNER_*` of a GitHub Actions runner, such as `GITHUB_EVENT_PATH`, which names the event of
 * the run that tests this repository, and `GITHUB_TOKEN`.
 */
const DROPPED_PREFIXES = ['GIT_', 'GITHUB_', 'RUNNER_']

const ACTIVE = Symbol.for('hackwin.harness.fixtures')

/** @returns {Set<{ cleanup: () => void }>} */
function activeFixtures() {
  const store = /** @type {any} */ (globalThis)
  store[ACTIVE] ??= new Set()
  return store[ACTIVE]
}

/** Remove every fixture that a test file left behind. test/harness/setup.js calls it. */
export function cleanupFixtures() {
  for (const fixture of [...activeFixtures()]) fixture.cleanup()
}

/**
 * An environment for child processes with this HOME: no inherited GIT_* variable, a global git
 * config of its own, no system git config, an empty gh config, no GitHub token, and none of the
 * variables of a CI runner (`GITHUB_*`, `RUNNER_*`, `CI`), so that no test reads the run that tests
 * this repository.
 * @param {string} home
 * @param {Record<string, string | undefined>} [base]
 * @returns {Record<string, string | undefined>}
 */
export function isolatedEnv(home, base = process.env) {
  /** @type {Record<string, string | undefined>} */
  const env = {}
  for (const [key, value] of Object.entries(base)) {
    const dropped =
      DROPPED_VARIABLES.includes(key) || DROPPED_PREFIXES.some((prefix) => key.startsWith(prefix))
    if (!dropped) env[key] = value
  }
  return Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GH_CONFIG_DIR: join(home, '.config', 'gh'),
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
  })
}

/**
 * Write the global git config of an isolated HOME: the fixture identity, `main` as the initial
 * branch, no signing. No hooks path, so no global hook runs.
 *
 * No automatic maintenance either. After every push, `receive-pack` starts `git maintenance run
 * --auto --detach` in the origin without waiting for it. Since git 2.54 its default `geometric`
 * strategy repacks as soon as `objects/17` holds two loose objects, and deletes the loose objects
 * it packed, so a local clone that copies them one by one can fail (#129).
 * @param {string} home
 * @param {string} [extra] More lines of git config.
 */
export function writeGitConfig(home, extra = '') {
  mkdirSync(join(home, '.config', 'gh'), { recursive: true })
  writeFileSync(
    join(home, '.gitconfig'),
    `[user]\n\tname = ${FIXTURE_IDENTITY.name}\n\temail = ${FIXTURE_IDENTITY.email}\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n[maintenance]\n\tauto = false\n${extra}`,
  )
}

/**
 * @typedef {Record<string, string | Buffer | object>} FileMap Paths relative to a checkout, and
 *   their content: text, bytes, or an object written as YAML.
 */

/**
 * @typedef {object} FixtureOptions
 * @property {FileMap} [files] The files of the first commit on main; `README.md` by default.
 * @property {boolean} [nodeProject] Start main from the Node fixture (node-project.js), the tree of
 *   the fixture repositories' reset commit; `files` are added to it.
 * @property {1 | 3 | 4} [team] Commit hackwin.yml and owners.yml of a team of this size.
 * @property {{ hackwin: unknown, owners: unknown }} [config] Commit these instead of a team's:
 *   objects, written as YAML, or text.
 * @property {string} [name] The directory of the main checkout; `app` by default. Task
 *   worktrees go to `<name>.worktrees/` beside it (A9).
 */

/**
 * @typedef {object} Clone
 * @property {string} path
 * @property {Git} git
 */

/**
 * @typedef {Clone & { commonDir: string, login: string }} JoinedClone
 */

/**
 * @typedef {object} TaskWorktreeFixture
 * @property {number} issue
 * @property {string} branch
 * @property {string} path
 * @property {Git} git
 */

/**
 * Create an offline fixture. Call `cleanup()` when done; test/harness/setup.js removes the
 * fixtures a test file leaves behind.
 * @param {FixtureOptions} [options]
 */
export async function createFixture(options = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hackwin-fixture-')))
  const home = join(dir, 'home')
  writeGitConfig(home)
  const env = isolatedEnv(home)
  const origin = join(dir, 'origin.git')
  const main = join(dir, options.name ?? 'app')

  /** @param {string} cwd */
  const gitAt = (cwd) => createGit({ cwd, env })
  /** @type {Clone | null} */
  let publisher = null

  /**
   * @param {FileMap} files
   * @param {string} [root]
   */
  const write = (files, root = main) => {
    for (const [path, content] of Object.entries(files)) {
      const file = join(root, path)
      mkdirSync(dirname(file), { recursive: true })
      const data = typeof content === 'string' || Buffer.isBuffer(content) ? content : yaml(content)
      writeFileSync(file, data)
    }
  }

  /**
   * Commit every change of a checkout, after writing `files`.
   * @param {string} message
   * @param {{ dir?: string, files?: FileMap, push?: boolean }} [commitOptions]
   * @returns {Promise<string>} The new commit.
   */
  const commit = async (message, { dir: root = main, files = {}, push = false } = {}) => {
    write(files, root)
    const git = gitAt(root)
    await git.run(['add', '--all'])
    await git.run(['commit', '--quiet', '--allow-empty', '-m', message])
    if (push) {
      const branch = await git.currentBranch()
      if (branch === null) throw new Error(`${root} is on a detached HEAD; nothing to push`)
      await git.push({ refspecs: [`HEAD:refs/heads/${branch}`], setUpstream: true })
    }
    return git.revParse('HEAD')
  }

  /**
   * A clone of the origin.
   * @param {string} name A directory name inside the fixture.
   * @returns {Promise<Clone>}
   */
  const clone = async (name) => {
    const path = join(dir, name)
    await gitAt(dir).run(['clone', '--quiet', origin, path])
    return { path, git: gitAt(path) }
  }

  /**
   * Push a commit to a branch of the origin from a separate clone, as another member would.
   * @param {FileMap} files
   * @param {{ message?: string, branch?: string, from?: string }} [publishOptions] `from` is the
   *   branch a new branch starts from; `main` by default.
   * @returns {Promise<string>} The new commit.
   */
  const publish = async (files, { message = 'change', branch = 'main', from = 'main' } = {}) => {
    publisher ??= await clone('publisher')
    const { path, git } = publisher
    await git.fetch({ prune: true })
    const exists = (await git.tryRevParse(`refs/remotes/origin/${branch}`)) !== null
    await git.run(['checkout', '--quiet', '-B', branch, `origin/${exists ? branch : from}`])
    write(files, path)
    await git.run(['add', '--all'])
    await git.run(['commit', '--quiet', '--allow-empty', '-m', message])
    await git.push({ refspecs: [`HEAD:refs/heads/${branch}`] })
    return git.revParse('HEAD')
  }

  /**
   * Write the join record (contracts 5.1) in a clone and point core.hooksPath at `.githooks`, as
   * a completed `join` leaves them.
   * @param {string} [path] A checkout of the clone; the main checkout by default.
   * @param {{ login?: string, language?: string, explanation_style?: string, at?: Date }} [joinOptions]
   * @returns {Promise<JoinedClone>}
   */
  const join_ = async (path = main, joinOptions = {}) => {
    const {
      login = accounts.lead.login,
      language = 'en',
      explanation_style = 'concise',
      at = new Date(),
    } = joinOptions
    const git = gitAt(path)
    const commonDir = await git.commonDir()
    await writeLocal(commonDir, {
      login,
      language,
      explanation_style,
      join: { completed_at: at.toISOString(), cli_version: VERSION },
    })
    await repairHooksPath(git)
    return { path, git, commonDir, login }
  }

  const fixture = {
    /** The temporary directory that holds everything below. */
    dir,
    /** The HOME of every git and gh call of the fixture. */
    home,
    /** The environment for git, gh and hackwin in this fixture. */
    env,
    /** The bare origin. */
    origin,
    /** The main checkout. */
    main,
    /** Git in the main checkout. */
    git: gitAt(main),
    /** @type {TeamConfig | null} The team configuration on main, when `team` was given. */
    team: /** @type {TeamConfig | null} */ (null),
    gitAt,
    write,
    commit,
    publish,
    clone,

    /**
     * A branch on the origin, from `from`, with one commit of `files` when given.
     * @param {string} name
     * @param {{ from?: string, files?: FileMap, message?: string }} [branchOptions]
     * @returns {Promise<string>} The commit the branch points to.
     */
    async branch(name, { from = 'main', files, message = `change on ${name}` } = {}) {
      if (files) return publish(files, { message, branch: name, from })
      await fixture.git.fetch()
      await fixture.git.push({ refspecs: [`refs/remotes/origin/${from}:refs/heads/${name}`] })
      return fixture.git.revParse(`refs/remotes/origin/${from}`)
    },

    /**
     * The worktree of a task at its path of A9, on `task/<N>-<slug>` from the current
     * `origin/main`, as `take` creates it. With `files` it holds one commit of them; with `push`
     * the branch is pushed with its upstream.
     * @param {{ issue: number, title?: string, base?: string, files?: FileMap, message?: string, push?: boolean }} task
     * @returns {Promise<TaskWorktreeFixture>}
     */
    async worktree({ issue, title = 'Task', base = 'origin/main', files, message, push = false }) {
      await fixture.git.fetch()
      const branch = branchName(issue, title)
      const path = taskWorktreePath(main, issue, slugOf(title))
      await fixture.git.worktreeAdd(path, { branch, createBranch: true, startPoint: base })
      if (files) await commit(message ?? `Work on #${issue}`, { dir: path, files, push })
      else if (push)
        await gitAt(path).push({ refspecs: [`HEAD:refs/heads/${branch}`], setUpstream: true })
      return { issue, branch, path, git: gitAt(path) }
    },

    join: join_,

    /**
     * A new clone of the origin on which `join` completed: the join record and core.hooksPath.
     * @param {{ name?: string, login?: string, language?: string, explanation_style?: string, at?: Date }} [joinOptions]
     * @returns {Promise<JoinedClone>}
     */
    async joinedClone({ name = 'joined', ...joinOptions } = {}) {
      const { path } = await clone(name)
      return join_(path, joinOptions)
    },

    /** Remove the fixture's directory, with its origin, clones and worktrees. */
    cleanup() {
      activeFixtures().delete(fixture)
      rmSync(dir, { recursive: true, force: true })
    },
  }
  activeFixtures().add(fixture)

  try {
    await gitAt(dir).run(['init', '--quiet', '--bare', origin])
    await gitAt(dir).run(['clone', '--quiet', origin, main])
    if (options.nodeProject) writeNodeProject(main)
    const files = options.files ?? (options.nodeProject ? {} : { 'README.md': '# Fixture\n' })
    await commit('Initial commit', { files, push: true })
    if (options.team !== undefined || options.config !== undefined) {
      const config = options.config ?? teamConfig(/** @type {number} */ (options.team))
      if (options.config === undefined) fixture.team = /** @type {TeamConfig} */ (config)
      const text = (/** @type {unknown} */ value) =>
        typeof value === 'string' ? value : yaml(value)
      await commit('Configure hackwin', {
        files: { 'hackwin.yml': text(config.hackwin), 'owners.yml': text(config.owners) },
        push: true,
      })
    }
  } catch (error) {
    fixture.cleanup()
    throw error
  }
  return fixture
}

/** @typedef {Awaited<ReturnType<typeof createFixture>>} Fixture */

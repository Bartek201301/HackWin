// The fixture repository driver: runs a scenario on one of the fixture repositories of
// docs/build/contracts.md section 6.4, under the repository's lock and after its reset, as the
// Lead (the gh login of the machine) or as the machine account `builder1`.
//
// Every gh call goes through the guard (guard.js) and into the run log
// `<git common dir>/hackwin-test/logs/<repository>.log`, with the token of `builder1` redacted.
// Tests on fixture repositories are `*.fixture.test.js` and run only through `npm run test:ac`;
// a missing repository, account or variable fails the test and names it.

import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createGit } from '../../src/core/git/index.js'
import { createGhExecutor, createGitHub } from '../../src/core/github/index.js'
import { HackwinError } from '../../src/core/runtime/errors.js'
import { TOKEN_VARIABLE, accounts, redact, requireBuilderToken } from './accounts.js'
import { fixtureRepo } from './fixture-repos.js'
import { guardExecutor } from './guard.js'
import { acquireLock, describeHolder, harnessStateDir } from './lock.js'
import { problemsOf, readFixtureRepoState, resetFixtureRepo } from './reset.js'

/** @import { GhExecutor, GitHub } from '../../src/core/github/index.js' */
/** @import { Git } from '../../src/core/git/index.js' */
/** @import { GuardedCall } from './guard.js' */
/** @import { FixtureRepoState, ResetReport } from './reset.js' */

/** The accounts a scenario may act as on real GitHub. `solo` is the Lead's account. */
const LIVE_ACCOUNTS = ['lead', 'solo', 'builder1']

/**
 * @typedef {object} FixtureRepoContext
 * @property {string} name The repository name, for example `hackwin-fixture-a`.
 * @property {string} repo `owner/name`.
 * @property {string} url The HTTPS URL to clone.
 * @property {string} resetSha
 * @property {'public' | 'private'} visibility
 * @property {{ lead: string, builder1: string, builder2: string, solo: string }} logins The
 *   Lead's login is read from gh.
 * @property {string} tempDir A directory for the scenario, removed afterwards.
 * @property {string} logFile The run log.
 * @property {GuardedCall[]} calls Every gh call of the run, the refused ones included.
 * @property {ResetReport} report The reset before the scenario.
 * @property {(account?: string) => GitHub} github A client for the repository, as this account.
 * @property {(account?: string) => GhExecutor} executor The guarded executor of this account,
 *   for example for `main(argv, { ghExecutor })`.
 * @property {(account?: string) => Record<string, string | undefined>} env The environment for a
 *   child process (git, gh, hackwin) as this account: its own git config with gh as credential
 *   helper, no system git config and, for `builder1`, its token as GH_TOKEN.
 * @property {(account?: string, options?: { name?: string }) => Promise<{ path: string, git: Git, env: Record<string, string | undefined> }>} clone
 *   A clone of the repository in tempDir, as this account.
 * @property {() => Promise<ResetReport>} reset Reset the repository again.
 * @property {(line: string) => void} log Add a line to the run log.
 */

/**
 * @typedef {object} FixtureRepoOptions
 * @property {number} [lockTimeoutMs] How long to wait for another session's lock.
 * @property {string} [stateDir] Where the locks and logs live; for the harness's own tests.
 * @property {string} [logFile] The run log, in place of `<stateDir>/logs/<repository>.log`.
 * @property {{ lead?: GhExecutor, builder1?: GhExecutor }} [executors] Executors in place of
 *   the real gh, for the harness's own tests against the fake GitHub.
 */

/**
 * Run a scenario on a fixture repository: take its lock, check the accounts, reset it, run the
 * scenario, release the lock. The scenario's result is returned.
 * @template T
 * @param {string} name `hackwin-fixture-a`, `-b`, `-c` or `hackwin-fixture-private`.
 * @param {(repo: FixtureRepoContext) => Promise<T>} scenario
 * @param {FixtureRepoOptions} [options]
 * @returns {Promise<T>}
 */
export async function withFixtureRepo(name, scenario, options = {}) {
  const info = fixtureRepo(name)
  const stateDir = options.stateDir ?? harnessStateDir()
  const release = await acquireLock(info.name, {
    dir: join(stateDir, 'locks'),
    timeoutMs: options.lockTimeoutMs,
    onWait: (holder) =>
      process.stderr.write(
        `waiting for the lock of ${info.name}, held by ${describeHolder(holder)}\n`,
      ),
  })
  try {
    return await runLocked(info, stateDir, scenario, options)
  } finally {
    release()
  }
}

/**
 * The part of withFixtureRepo that runs under the lock.
 * @template T
 * @param {import('./fixture-repos.js').FixtureRepoInfo} info
 * @param {string} stateDir
 * @param {(repo: FixtureRepoContext) => Promise<T>} scenario
 * @param {FixtureRepoOptions} options
 * @returns {Promise<T>}
 */
async function runLocked(info, stateDir, scenario, options) {
  // The run log holds the last run on the repository; only the lock's holder writes it.
  const logFile = options.logFile ?? join(stateDir, 'logs', `${info.name}.log`)
  mkdirSync(dirname(logFile), { recursive: true })
  writeFileSync(logFile, '')
  /** @param {string} line */
  const log = (line) =>
    appendFileSync(logFile, `${redact(`${new Date().toISOString()} ${line}`)}\n`)
  log(`lock of ${info.name} taken by process ${process.pid}`)
  const tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'hackwin-fixture-repo-')))
  try {
    /** @type {GuardedCall[]} */
    const calls = []
    /** @type {Record<string, Record<string, string | undefined>>} */
    const envs = {}
    /** @type {Record<string, GhExecutor>} */
    const executors = {}
    /** @type {Record<string, GitHub>} */
    const clients = {}

    /** @param {string} account */
    const keyOf = (account = 'lead') => {
      if (account === 'builder2') {
        throw new Error(
          `builder2 (${accounts.builder2.login}) acts only against the fake GitHub; a live scenario that needs a second builder is named in the pull request instead`,
        )
      }
      if (!LIVE_ACCOUNTS.includes(account)) {
        throw new Error(`a live scenario acts as ${LIVE_ACCOUNTS.join(', ')}, not ${account}`)
      }
      return account === 'solo' ? 'lead' : account
    }

    /** @param {string} key */
    const envOf = (key) => (envs[key] ??= liveEnv(key, tempDir))

    /** @param {string} key */
    const executorOf = (key) =>
      (executors[key] ??= guardExecutor(
        options.executors?.[/** @type {'lead' | 'builder1'} */ (key)] ??
          createGhExecutor({ env: envOf(key) }),
        {
          repo: info.repo,
          account: key,
          calls,
          onCall: (call, stderr) =>
            log(
              `${call.account} gh ${call.args.join(' ')} -> ${call.refused ? `refused: ${call.refused}` : `exit ${call.code}`}${
                call.code !== 0 && !call.refused ? `: ${stderr.trim().split('\n')[0] ?? ''}` : ''
              }`,
            ),
        },
      ))

    /** @param {string} [account] */
    const github = (account) => {
      const key = keyOf(account)
      return (clients[key] ??= createGitHub({ executor: executorOf(key), repo: info.repo }))
    }

    const logins = await checkAccounts(info, github, log)
    const reset = () => resetFixtureRepo(github('lead'), info, { log })
    const report = await reset()

    /** @type {FixtureRepoContext} */
    const context = {
      name: info.name,
      repo: info.repo,
      url: `https://github.com/${info.repo}.git`,
      resetSha: info.resetSha,
      visibility: info.visibility,
      logins,
      tempDir,
      logFile,
      calls,
      report,
      github,
      executor: (account) => executorOf(keyOf(account)),
      env: (account) => ({ ...envOf(keyOf(account)) }),
      async clone(account, { name: dirName } = {}) {
        const key = keyOf(account)
        const env = envOf(key)
        const path = join(tempDir, dirName ?? `clone-${key}`)
        const git = createGit({ cwd: tempDir, env })
        await git.run(['clone', '--quiet', context.url, path])
        log(`${key} cloned ${info.repo} into ${path}`)
        return { path, git: git.with({ cwd: path }), env: { ...env } }
      },
      reset,
      log,
    }
    log(`scenario on ${info.name} starts`)
    const result = await scenario(context)
    log(`scenario on ${info.name} passed`)
    return result
  } catch (error) {
    log(`run on ${info.name} failed: ${error?.message ?? error}`)
    throw redactError(error)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
    log(`run on ${info.name} ended; the lock is released next`)
  }
}

/**
 * Read the state of a fixture repository as the Lead, under its lock and through the guard,
 * without a reset and without changing anything: for a look after a run.
 * @param {string} name
 * @param {Pick<FixtureRepoOptions, 'lockTimeoutMs' | 'stateDir' | 'executors'>} [options]
 * @returns {Promise<{ state: FixtureRepoState, problems: string[], calls: GuardedCall[] }>}
 *   `problems` lists what differs from the state a reset leaves.
 */
export async function inspectFixtureRepo(name, options = {}) {
  const info = fixtureRepo(name)
  const stateDir = options.stateDir ?? harnessStateDir()
  const release = await acquireLock(info.name, {
    dir: join(stateDir, 'locks'),
    timeoutMs: options.lockTimeoutMs,
  })
  const tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'hackwin-fixture-repo-')))
  try {
    /** @type {GuardedCall[]} */
    const calls = []
    const executor = guardExecutor(
      options.executors?.lead ?? createGhExecutor({ env: liveEnv('lead', tempDir) }),
      { repo: info.repo, account: 'lead', calls },
    )
    const github = createGitHub({ executor, repo: info.repo })
    const state = await readFixtureRepoState(github, info)
    return { state, problems: problemsOf(state, info), calls }
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
    release()
  }
}

/**
 * Check, before the reset, that the Lead administers the repository and that `builder1` is
 * `test-bot-builder` with write access. Every failure names the account or the variable.
 * @param {import('./fixture-repos.js').FixtureRepoInfo} info
 * @param {(account?: string) => GitHub} github
 * @param {(line: string) => void} log
 */
async function checkAccounts(info, github, log) {
  const lead = await named('the Lead (the gh login of this machine)', () => github('lead').login())
  const leadRepo = await named(`the Lead (${lead}) reading ${info.repo}`, () =>
    github('lead').repository(),
  )
  if (!leadRepo.permissions.admin) {
    throw new Error(`the Lead (${lead}) is not an admin of the fixture repository ${info.repo}`)
  }
  const builder = await named(`builder1 (${accounts.builder1.login}, ${TOKEN_VARIABLE})`, () =>
    github('builder1').login(),
  )
  if (builder.toLowerCase() !== accounts.builder1.login.toLowerCase()) {
    throw new Error(
      `${TOKEN_VARIABLE} belongs to ${builder}, not to builder1 (${accounts.builder1.login})`,
    )
  }
  const builderRepo = await named(`builder1 (${builder}) reading ${info.repo}`, () =>
    github('builder1').repository(),
  )
  if (!builderRepo.permissions.push) {
    throw new Error(
      `builder1 (${builder}) has no write access to ${info.repo}; accept the invitation`,
    )
  }
  log(`accounts: lead ${lead} (admin), builder1 ${builder} (write)`)
  return {
    lead,
    builder1: builder,
    builder2: accounts.builder2.login,
    solo: lead,
  }
}

/**
 * Run a check and name what failed: a missing repository answers 404, a refused token 401.
 * @template T
 * @param {string} what
 * @param {() => Promise<T>} check
 * @returns {Promise<T>}
 */
async function named(what, check) {
  try {
    return await check()
  } catch (error) {
    const status = /** @type {any} */ (error)?.status
    const reason =
      status === 404
        ? 'GitHub answered 404: the repository is missing or not visible to this account'
        : status === 401
          ? 'GitHub refused the credential (HTTP 401)'
          : (error?.message ?? String(error))
    throw new Error(`${what} failed: ${reason}`, { cause: error })
  }
}

/**
 * The environment of a child process as this account.
 * @param {string} key `lead` or `builder1`.
 * @param {string} tempDir
 * @returns {Record<string, string | undefined>}
 */
function liveEnv(key, tempDir) {
  /** @type {Record<string, string | undefined>} */
  const env = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith('GIT_') || ['GH_REPO', 'HACKWIN_CALLER', TOKEN_VARIABLE].includes(name))
      continue
    env[name] = value
  }
  const gitconfig = join(tempDir, `${key}.gitconfig`)
  // builder1's helper reads GH_TOKEN from the environment of git: the token is never in a file.
  const helper =
    key === 'builder1'
      ? '!f() { test "$1" = get && echo username=x-access-token && echo "password=$GH_TOKEN"; }; f'
      : '!gh auth git-credential'
  writeFileSync(
    gitconfig,
    [
      '[user]',
      `\tname = HackWin Test ${key}`,
      `\temail = ${key}@example.invalid`,
      '[init]',
      '\tdefaultBranch = main',
      '[commit]',
      '\tgpgsign = false',
      '[credential]',
      '\thelper =',
      `\thelper = ${JSON.stringify(helper)}`,
      '',
    ].join('\n'),
  )
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    NO_COLOR: '1',
  })
  if (key === 'builder1') {
    const configDir = join(tempDir, 'gh-builder1')
    mkdirSync(configDir, { recursive: true })
    delete env.GITHUB_TOKEN
    env.GH_CONFIG_DIR = configDir
    env.GH_TOKEN = requireBuilderToken()
  }
  return env
}

/**
 * The error with the token of builder1 removed from its message and stack.
 * @param {unknown} error
 */
function redactError(error) {
  if (error instanceof Error) {
    error.message = redact(error.message)
    if (error.stack) error.stack = redact(error.stack)
    if (error instanceof HackwinError && error.details?.tail) {
      error.details.tail = error.details.tail.map((/** @type {string} */ line) => redact(line))
    }
  }
  return error
}

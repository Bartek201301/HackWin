// A fixture for the tests of `setup`: an offline repository with a bare origin, unconfigured, and a
// fake GitHub that knows the test accounts, answers `gh version` and the user lookups of step 3,
// holds the push protection setting of step 13, and records every call, so a test can tell what
// changed on GitHub.
//
// Step 14 runs the checks of `join` for the Lead's machine, so a `bin` directory comes first on
// PATH: a `hackwin` that runs the CLI of this checkout (the hooks' self test calls it), a `claude`
// that does nothing, and an `npm` that only notes its arguments, so the install of the Node
// fixture stays offline. The install of `join` inherits the PATH of the test process, so
// runSetup puts the directory first there too while setup runs.

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs'
import { delimiter, join, relative } from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { main } from '../../../src/cli/main.js'
import { createFakeClock, quoteShellArg } from '../../../src/core/runtime/index.js'
import {
  BUILDER3_LOGIN,
  accounts,
  createFakeGitHub,
  createFixture,
  httpError,
  rawResult,
  teamConfig,
  yaml,
} from '../../harness/index.js'

const CLI = fileURLToPath(new URL('../../../bin/hackwin.js', import.meta.url))

/** @typedef {import('../../harness/index.js').FakeGitHub} FakeGitHub */
/** @typedef {import('../../harness/index.js').Fixture} Fixture */

export const LEAD = accounts.lead.login

/** The logins that exist on the fake GitHub. */
export const KNOWN_LOGINS = Object.freeze([
  accounts.lead.login,
  accounts.builder1.login,
  accounts.builder2.login,
  BUILDER3_LOGIN,
])

/** The event of every answers file. */
export const EVENT = Object.freeze({
  start: '2026-10-24T09:00:00+02:00',
  end: '2026-10-25T15:00:00+02:00',
})

/**
 * An unconfigured repository and a fake GitHub on which the Lead is an admin.
 * @param {object} [options]
 * @param {boolean} [options.nodeProject] Start main from the Node fixture: the template and a
 *   Node project. True by default.
 * @param {Record<string, string>} [options.files] Files of the first commit, besides the Node
 *   fixture or instead of the README.
 * @param {'public' | 'private'} [options.visibility] A private repository behaves as
 *   `hackwin-fixture-private`: no rule sets and no push protection, unless the next two options
 *   say otherwise.
 * @param {boolean} [options.rulesetsOffered]
 * @param {'offered' | 'refused'} [options.pushProtection] Offered: the setting reads `disabled`
 *   until enabled. Refused: enabling it answers HTTP 200 and the setting reads back null, as
 *   on `hackwin-fixture-private` (docs/verification.md E3).
 * @param {'User' | 'Organization'} [options.ownerType] Who owns the repository.
 * @param {{ hackwin: unknown, owners: unknown }} [options.config] Commit a configuration on main,
 *   which makes the repository configured.
 */
export async function createSetupFixture({
  nodeProject = true,
  files,
  visibility = 'public',
  rulesetsOffered = visibility === 'public',
  pushProtection = visibility === 'public' ? 'offered' : 'refused',
  ownerType = 'User',
  config,
} = {}) {
  const fixture = await createFixture({ nodeProject, files, config })
  const fake = createFakeGitHub({ visibility, rulesetsOffered })
  fake.on('version', () =>
    rawResult({ code: 0, stdout: 'gh version 2.88.1 (2026-01-01)\n', stderr: '' }),
  )
  fake.on('GET users/:login', ({ params }) => {
    if (!KNOWN_LOGINS.some((login) => login.toLowerCase() === params.login.toLowerCase())) {
      throw httpError(404, 'Not Found')
    }
    return { login: params.login, type: 'User' }
  })
  const security = servePushProtection(fake, pushProtection, ownerType)
  return { fixture, fake, security, env: toolsEnv(fixture) }
}

/**
 * The repository requests of step 13 on the fake GitHub: `GET repos/{owner}/{repo}` with
 * `security_and_analysis`, and `PATCH repos/{owner}/{repo}` that changes it.
 * @param {FakeGitHub} fake
 * @param {'offered' | 'refused'} mode
 * @param {'User' | 'Organization'} ownerType
 * @returns {{ pushProtection: string | null, afterPatch: Array<string | null> }} The setting,
 *   which a test may change, and what the reads after the next PATCH return before they return
 *   the setting: GitHub's reads lag its writes (src/commands/setup/settle.js). The entry
 *   `!timeout` makes that read fail as gh does when GitHub does not answer.
 */
function servePushProtection(fake, mode, ownerType) {
  /** @type {{ pushProtection: string | null, afterPatch: Array<string | null> }} */
  const security = { pushProtection: mode === 'offered' ? 'disabled' : null, afterPatch: [] }
  /** @type {Array<string | null>} */
  let lagging = []
  const { state } = fake
  /**
   * @param {string} login
   * @param {string | null} pushProtection
   */
  const repositoryJson = (login, pushProtection = security.pushProtection) => {
    const order = ['read', 'triage', 'write', 'maintain', 'admin']
    const level = state.collaborators[login] ?? (state.visibility === 'public' ? 'read' : null)
    const rank = level === null ? -1 : order.indexOf(level)
    return {
      full_name: state.repo,
      name: state.repo.split('/')[1],
      owner: { login: state.repo.split('/')[0], type: ownerType },
      default_branch: state.defaultBranch,
      visibility: state.visibility,
      private: state.visibility === 'private',
      html_url: `https://github.com/${state.repo}`,
      permissions: {
        admin: rank >= 4,
        maintain: rank >= 3,
        push: rank >= 2,
        triage: rank >= 1,
        pull: rank >= 0,
      },
      // GitHub returns the block only to admins, and null where it offers no secret scanning.
      ...(rank >= 4
        ? {
            security_and_analysis:
              pushProtection === null
                ? null
                : {
                    secret_scanning: { status: 'enabled' },
                    secret_scanning_push_protection: { status: pushProtection },
                  },
          }
        : {}),
    }
  }
  fake.on('GET repos/{owner}/{repo}', ({ login }) => {
    const status = lagging.length > 0 ? lagging.shift() : security.pushProtection
    return status === '!timeout' ? TIMEOUT : repositoryJson(login, status ?? null)
  })
  fake.on('PATCH repos/{owner}/{repo}', ({ login, body }) => {
    lagging = [...security.afterPatch]
    const wanted = body?.security_and_analysis ?? {}
    if (mode === 'refused') {
      if (wanted.secret_scanning) {
        throw httpError(422, 'Secret scanning is not available for this repository.')
      }
      // HTTP 200 that enables nothing (docs/verification.md, E3 step 2).
      return {
        ...repositoryJson(login),
        security_and_analysis: {
          secret_scanning: { status: 'disabled' },
          secret_scanning_push_protection: { status: 'disabled' },
        },
      }
    }
    const status = wanted.secret_scanning_push_protection?.status
    if (status !== undefined) security.pushProtection = status
    return repositoryJson(login)
  })
  return security
}

/**
 * The fixture's environment with the commands of step 14 first on PATH.
 * @param {Fixture} fixture
 * @returns {Record<string, string | undefined>}
 */
export function toolsEnv(fixture) {
  return { ...fixture.env, PATH: `${toolsDir(fixture.dir)}${delimiter}${fixture.env.PATH}` }
}

/**
 * The directory of the commands setup's step 14 meets: `hackwin`, `claude` and `npm`.
 * @param {string} dir The fixture's directory.
 * @returns {string}
 */
function toolsDir(dir) {
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  const tools = {
    hackwin: `#!/bin/sh\nexec ${quoteShellArg(process.execPath)} ${quoteShellArg(CLI)} "$@"\n`,
    claude: '#!/bin/sh\nexit 0\n',
    npm: `#!/bin/sh\necho "$*" >> ${quoteShellArg(join(dir, 'npm.log'))}\nexit 0\n`,
  }
  for (const [name, text] of Object.entries(tools)) {
    writeFileSync(join(bin, name), text)
    chmodSync(join(bin, name), 0o755)
  }
  return bin
}

/**
 * gh's answer when GitHub does not answer, as the integrator's run of 16 October 2026 logged it:
 * exit 1 and no HTTP status.
 */
export const TIMEOUT = rawResult({
  code: 1,
  stderr:
    'Get "https://api.github.com/repos/hackwin-test/app": dial tcp 140.82.121.6:443: i/o timeout\n',
})

/** The answers of `join` that setup hands on for the Lead's machine (CM11). */
export const JOIN_ANSWERS = Object.freeze({ language: 'English', explanation_style: 'concise' })

/**
 * The answers of a fixture team of this size (test/harness/team.js), with changes.
 * @param {1 | 3 | 4} size
 * @param {(answers: any) => void} [change]
 * @returns {any}
 */
export function teamAnswers(size, change) {
  const answers = { ...structuredClone(teamConfig(size).answers), ...JOIN_ANSWERS }
  answers.project.event = { ...EVENT }
  change?.(answers)
  return answers
}

/**
 * Write an answers file into the fixture's directory, outside the checkout.
 * @param {Fixture} fixture
 * @param {unknown} answers
 * @param {string} [name]
 * @returns {string}
 */
export function writeAnswers(fixture, answers, name = 'answers.yml') {
  const file = join(fixture.dir, name)
  writeFileSync(file, typeof answers === 'string' ? answers : yaml(answers))
  return file
}

/**
 * Run `hackwin setup` in-process in the main checkout, as this login, against the fake GitHub.
 * @param {Fixture} fixture
 * @param {FakeGitHub} fake
 * @param {object} [options]
 * @param {unknown} [options.answers] Written to an answers file and passed as --answers.
 * @param {string[]} [options.args]
 * @param {string} [options.login]
 * @param {string[]} [options.input] Lines typed in the terminal.
 * @param {boolean} [options.tty] stdin and stdout are terminals: the caller is `terminal`.
 * @param {Record<string, string | undefined>} [options.env] The fixture's environment with the
 *   commands of step 14 first on PATH by default.
 * @param {string} [options.cwd]
 */
export async function runSetup(fixture, fake, options = {}) {
  const args = [...(options.args ?? [])]
  if (options.answers !== undefined) {
    args.push('--answers', writeAnswers(fixture, options.answers))
  }
  return runHackwin(fixture, fake, ['setup', ...args], options)
}

/**
 * Run a hackwin command in-process, as runSetup runs `setup`.
 * @param {Fixture} fixture
 * @param {FakeGitHub} fake
 * @param {string[]} argv The command and its arguments.
 * @param {object} [options]
 * @param {string} [options.login]
 * @param {string[]} [options.input]
 * @param {boolean} [options.tty]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {string} [options.cwd]
 * @param {import('../../../src/core/runtime/index.js').Clock} [options.clock] A fake clock by
 *   default, so that waiting for GitHub's reads to settle takes no time.
 */
export async function runHackwin(fixture, fake, argv, options = {}) {
  const { login = LEAD, input = [], tty = false } = options
  const env = options.env ?? toolsEnv(fixture)
  let stdout = ''
  let stderr = ''
  const stdin = Object.assign(Readable.from(input.map((line) => `${line}\n`)), { isTTY: tty })
  const path = process.env.PATH
  process.env.PATH = env.PATH
  try {
    const code = await main(argv, {
      cwd: options.cwd ?? fixture.main,
      env,
      stdin,
      stdout: { write: (chunk) => (stdout += chunk), isTTY: tty },
      stderr: { write: (chunk) => (stderr += chunk) },
      ghExecutor: fake.as(login),
      clock: options.clock ?? createFakeClock(new Date()),
    })
    return { code, stdout, stderr }
  } finally {
    if (path === undefined) delete process.env.PATH
    else process.env.PATH = path
  }
}

/**
 * What `npm` was asked to do by the setups of this fixture, one line per call.
 * @param {Fixture} fixture
 * @returns {string[]}
 */
export function npmCalls(fixture) {
  const log = join(fixture.dir, 'npm.log')
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []
}

/**
 * Every file of a checkout outside `.git`, with its content and executable bit, every directory
 * and every symlink with its target, so that a test can tell that nothing changed.
 * @param {string} root
 * @returns {Record<string, string>}
 */
export function snapshot(root) {
  /** @type {Record<string, string>} */
  const entries = {}
  for (const name of readdirSync(root, { recursive: true })) {
    const path = String(name)
    if (path === '.git' || path.startsWith(`.git/`) || path.startsWith('node_modules')) continue
    const file = join(root, path)
    const stats = lstatSync(file)
    const key = relative(root, file)
    entries[key] = stats.isSymbolicLink()
      ? `link to ${readlinkSync(file)}`
      : stats.isDirectory()
        ? 'directory'
        : `${(stats.mode & 0o111) !== 0 ? 'x' : '-'} ${readFileSync(file, 'utf8')}`
  }
  return entries
}

/**
 * The calls that would change GitHub: anything but a read.
 * @param {FakeGitHub} fake
 */
export function writes(fake) {
  return fake.calls.filter((call) => call.method !== null && call.method !== 'GET')
}

/**
 * A pre-receive hook on the fixture's origin that marks its start, waits, and then accepts or
 * refuses the push.
 * @param {Fixture} fixture
 * @param {boolean} accept
 * @returns {string} The marker file, which appears when the push has started.
 */
export function slowOrigin(fixture, accept) {
  const marker = join(fixture.dir, 'push-started')
  const hook = join(fixture.origin, 'hooks', 'pre-receive')
  writeFileSync(
    hook,
    `#!/bin/sh\ncat >/dev/null\ntouch '${marker}'\nsleep 1\n${accept ? 'exit 0' : 'echo refused >&2\nexit 1'}\n`,
  )
  chmodSync(hook, 0o755)
  return marker
}

/**
 * Wait until a file exists, for at most 5 seconds.
 * @param {string} file
 */
export async function waitFor(file) {
  for (let tries = 0; tries < 200 && !existsSync(file); tries += 1) await sleep(25)
  if (!existsSync(file)) throw new Error(`${file} did not appear`)
}

/**
 * The commit of origin's main.
 * @param {Fixture} fixture
 * @returns {Promise<string>}
 */
export async function originMain(fixture) {
  const { stdout } = await fixture.git.run(['ls-remote', fixture.origin, 'refs/heads/main'])
  return stdout.split(/\s+/)[0]
}

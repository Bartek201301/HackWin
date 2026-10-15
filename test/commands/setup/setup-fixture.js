// A fixture for the tests of `setup`: an offline repository with a bare origin, unconfigured, and a
// fake GitHub that knows the test accounts, answers `gh version` and the user lookups of step 3,
// and records every call, so a test can tell that GitHub was left unchanged.

import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { Readable } from 'node:stream'
import { main } from '../../../src/cli/main.js'
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
 * @param {'public' | 'private'} [options.visibility]
 * @param {{ hackwin: unknown, owners: unknown }} [options.config] Commit a configuration on main,
 *   which makes the repository configured.
 */
export async function createSetupFixture({ nodeProject = true, files, visibility, config } = {}) {
  const fixture = await createFixture({ nodeProject, files, config })
  const fake = createFakeGitHub({ visibility })
  fake.on('version', () =>
    rawResult({ code: 0, stdout: 'gh version 2.88.1 (2026-01-01)\n', stderr: '' }),
  )
  fake.on('GET users/:login', ({ params }) => {
    if (!KNOWN_LOGINS.some((login) => login.toLowerCase() === params.login.toLowerCase())) {
      throw httpError(404, 'Not Found')
    }
    return { login: params.login, type: 'User' }
  })
  return { fixture, fake }
}

/**
 * The answers of a fixture team of this size (test/harness/team.js), with changes.
 * @param {1 | 3 | 4} size
 * @param {(answers: any) => void} [change]
 * @returns {any}
 */
export function teamAnswers(size, change) {
  const answers = structuredClone(teamConfig(size).answers)
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
 * @param {Record<string, string | undefined>} [options.env]
 * @param {string} [options.cwd]
 */
export async function runSetup(fixture, fake, options = {}) {
  const { answers, login = LEAD, input = [], tty = false, env = fixture.env } = options
  const args = [...(options.args ?? [])]
  if (answers !== undefined) args.push('--answers', writeAnswers(fixture, answers))
  let stdout = ''
  let stderr = ''
  const stdin = Object.assign(Readable.from(input.map((line) => `${line}\n`)), { isTTY: tty })
  const code = await main(['setup', ...args], {
    cwd: options.cwd ?? fixture.main,
    env,
    stdin,
    stdout: { write: (chunk) => (stdout += chunk), isTTY: tty },
    stderr: { write: (chunk) => (stderr += chunk) },
    ghExecutor: fake.as(login),
  })
  return { code, stdout, stderr }
}

/**
 * Every file of a checkout outside `.git`, with its content and executable bit, and every
 * directory, so that a test can tell that nothing changed.
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
    entries[key] = stats.isDirectory()
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

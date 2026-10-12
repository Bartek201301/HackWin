// The test accounts (docs/build/contracts.md sections 6.1 and 6.4) and the machine account's
// credential.
//
// The token of `builder1` comes from HACKWIN_TEST_BUILDER_TOKEN. test/harness/setup.js takes it
// out of process.env before any test runs, so no child process inherits it by accident. From
// then on it reaches a child process only through that process's environment, as GH_TOKEN of a
// `builder1` call. It is never printed, logged or written to a file; redact() removes it from
// any text the harness prints or logs.

import { FIXTURE_OWNER } from './fixture-repos.js'

/** The variable that holds the token of `test-bot-builder`. */
export const TOKEN_VARIABLE = 'HACKWIN_TEST_BUILDER_TOKEN'

/** What redact() writes in place of the token. */
export const REDACTED = `[${TOKEN_VARIABLE}]`

/**
 * @typedef {object} Account
 * @property {'lead' | 'builder1' | 'builder2' | 'solo'} key
 * @property {string} login The login in team configurations and in the fake GitHub.
 * @property {boolean} live True when a test may act as this account on real GitHub.
 * @property {string} description
 */

/** @type {Readonly<Record<'lead' | 'builder1' | 'builder2' | 'solo', Readonly<Account>>>} */
export const accounts = Object.freeze({
  lead: Object.freeze({
    key: 'lead',
    login: FIXTURE_OWNER,
    live: true,
    description: `the gh login of the machine, which owns the fixture repositories (${FIXTURE_OWNER})`,
  }),
  builder1: Object.freeze({
    key: 'builder1',
    login: 'test-bot-builder',
    live: true,
    description: `the machine account test-bot-builder, with its token from ${TOKEN_VARIABLE}`,
  }),
  builder2: Object.freeze({
    key: 'builder2',
    login: 'maljul',
    live: false,
    description:
      "maljul, a real teammate's account used only as a name in team configurations: never invited, and acting only against the fake GitHub",
  }),
  solo: Object.freeze({
    key: 'solo',
    login: FIXTURE_OWNER,
    live: true,
    description: "the Lead's account, the only member of a solo team",
  }),
})

/**
 * The fourth member of a team of 4, a name only like `builder2`. No GitHub account had this
 * login on 12 October 2026 (HTTP 404), so anyone may register it later.
 */
export const BUILDER3_LOGIN = 'hackwin-test-builder3'

/**
 * Every login the harness uses only as a name: in team configurations and in the fake GitHub.
 * No test acts as one on real GitHub, and the guard refuses any real call that would invite,
 * assign or mention one.
 */
export const NAME_ONLY_LOGINS = Object.freeze([accounts.builder2.login, BUILDER3_LOGIN])

/**
 * The account of this key, or an error that names the known keys.
 * @param {string} key
 * @returns {Readonly<Account>}
 */
export function accountOf(key) {
  const account = accounts[/** @type {keyof typeof accounts} */ (key)]
  if (!account) {
    throw new Error(
      `unknown test account ${key}; the accounts are ${Object.keys(accounts).join(', ')}`,
    )
  }
  return account
}

const STORE = Symbol.for('hackwin.test.builderToken')

/**
 * Move the token out of the environment into the harness. Runs from test/harness/setup.js
 * before every test file; a later call finds the token already moved.
 * @param {Record<string, string | undefined>} [env]
 */
export function captureCredential(env = process.env) {
  const value = env[TOKEN_VARIABLE]
  if (value === undefined) return
  delete env[TOKEN_VARIABLE]
  if (value.trim() !== '') {
    Object.defineProperty(process, STORE, {
      value: value.trim(),
      configurable: true,
      enumerable: false,
      writable: false,
    })
  }
}

/**
 * The token of `builder1`, or null when HACKWIN_TEST_BUILDER_TOKEN was not set.
 * @returns {string | null}
 */
export function builderToken() {
  captureCredential()
  return /** @type {any} */ (process)[STORE] ?? null
}

/**
 * The token of `builder1`, or an error that names the variable.
 * @returns {string}
 */
export function requireBuilderToken() {
  const token = builderToken()
  if (token === null) {
    throw new Error(
      `${TOKEN_VARIABLE} is not set: the machine account builder1 (${accounts.builder1.login}) needs its token in the environment that runs npm run test:ac`,
    )
  }
  return token
}

/**
 * The text with the token of `builder1` replaced by [HACKWIN_TEST_BUILDER_TOKEN].
 * @param {string} text
 * @param {string | null} [token] The token; the one of HACKWIN_TEST_BUILDER_TOKEN by default.
 * @returns {string}
 */
export function redact(text, token = builderToken()) {
  return token === null || token === '' ? text : String(text).split(token).join(REDACTED)
}

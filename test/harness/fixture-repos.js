// The fixture repositories of docs/build/contracts.md section 6.4, in one place. Automated tests
// use only these four; `hackwin-sandbox` is for the human's live tests and is never touched.

/** The account that owns the fixture repositories, and the Lead of the live tests. */
export const FIXTURE_OWNER = 'Bartek201301'

/** The commit every fixture repository's `main` is reset to: the sandbox's `main` after its PR #1. */
export const RESET_SHA = 'bf2af037ab756d7051e35bdd7e3f18c92eda45b5'

/** The tree of RESET_SHA, which the Node fixture copies (test/harness/node-project). */
export const RESET_TREE = 'dd1e605a2bd588e38de2fa5dacc034996f16d5f5'

/** The repository that no automated test may touch. */
export const SANDBOX = 'hackwin-sandbox'

/**
 * @typedef {object} FixtureRepoInfo
 * @property {string} name For example `hackwin-fixture-a`.
 * @property {string} repo `owner/name`.
 * @property {'public' | 'private'} visibility
 * @property {string} resetSha
 * @property {string} usedBy
 * @property {boolean} protectionRefused GitHub answers HTTP 403 on the rule set and branch
 *   protection endpoints of this repository (no GitHub Pro), and the reset accepts that answer.
 */

/** @type {ReadonlyArray<Readonly<FixtureRepoInfo>>} */
export const FIXTURE_REPOS = Object.freeze(
  [
    { name: 'hackwin-fixture-a', visibility: 'public', usedBy: 'lane A and the integration tasks' },
    { name: 'hackwin-fixture-b', visibility: 'public', usedBy: 'lane B and the integration tasks' },
    { name: 'hackwin-fixture-c', visibility: 'public', usedBy: 'lane C and the integration tasks' },
    {
      name: 'hackwin-fixture-private',
      visibility: 'private',
      usedBy: 'the cases where GitHub refuses protection',
    },
  ].map((entry) =>
    Object.freeze({
      ...entry,
      visibility: /** @type {'public' | 'private'} */ (entry.visibility),
      repo: `${FIXTURE_OWNER}/${entry.name}`,
      resetSha: RESET_SHA,
      protectionRefused: entry.visibility === 'private',
    }),
  ),
)

/**
 * The fixture repository of this name, given as `hackwin-fixture-a` or `Bartek201301/hackwin-fixture-a`.
 * Any other repository, `hackwin-sandbox` above all, is an error.
 * @param {string} name
 * @returns {Readonly<FixtureRepoInfo>}
 */
export function fixtureRepo(name) {
  const short = String(name).replace(new RegExp(`^${FIXTURE_OWNER}/`, 'i'), '')
  if (short.toLowerCase() === SANDBOX) {
    throw new Error(`${SANDBOX} is for the human's live tests; automated tests never touch it`)
  }
  const info = FIXTURE_REPOS.find((entry) => entry.name === short)
  if (!info) {
    const names = FIXTURE_REPOS.map((entry) => entry.name).join(', ')
    throw new Error(`${name} is not a fixture repository; the fixture repositories are ${names}`)
  }
  return info
}

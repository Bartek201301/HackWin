// The test harness of the HackWin build (docs/build/contracts.md section 4.12): offline fixtures,
// the fake GitHub, the fixture repository driver and the test accounts. Lanes import it from
// their own test files; tests reach GitHub accounts only through it.

export {
  createFixture,
  cleanupFixtures,
  isolatedEnv,
  NODE_PROJECT_DIR,
  FIXTURE_IDENTITY,
} from './fixture.js'
export {
  createFakeGitHub,
  httpError,
  rawResult,
  FakeGitHubError,
  DEFAULT_FAKE_REPO,
} from './fake-github.js'
export { withFixtureRepo } from './fixture-repo.js'
export { accounts, accountOf, builderToken, redact, TOKEN_VARIABLE } from './accounts.js'
export {
  teamConfig,
  teamMembers,
  hackwinObject,
  ownersObject,
  yaml,
  TEAM_SIZES,
  BUILDER3_LOGIN,
} from './team.js'
export {
  FIXTURE_REPOS,
  FIXTURE_OWNER,
  RESET_SHA,
  RESET_TREE,
  SANDBOX,
  fixtureRepo,
} from './fixture-repos.js'

/** @typedef {import('./fixture.js').Fixture} Fixture */
/** @typedef {import('./fake-github.js').FakeGitHub} FakeGitHub */
/** @typedef {import('./fake-github.js').FakeRequest} FakeRequest */
/** @typedef {import('./fixture-repo.js').FixtureRepoContext} FixtureRepoContext */
/** @typedef {import('./team.js').TeamConfig} TeamConfig */

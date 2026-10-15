// The test harness of the HackWin build (docs/build/contracts.md section 4.12): offline fixtures,
// the fake GitHub, the fixture repository driver and the test accounts. Lanes import it from
// their own test files; tests reach GitHub accounts only through it.

export { createFixture, cleanupFixtures, isolatedEnv, FIXTURE_IDENTITY } from './fixture.js'
export {
  NODE_PROJECT_FILE,
  nodeProjectFiles,
  writeNodeProject,
  packNodeProject,
} from './node-project.js'
export {
  createFakeGitHub,
  httpError,
  rawResult,
  FakeGitHubError,
  DEFAULT_FAKE_REPO,
  RULESETS_NOT_OFFERED,
} from './fake-github.js'
export { withFixtureRepo, inspectFixtureRepo } from './fixture-repo.js'
export {
  accounts,
  accountOf,
  builderToken,
  redact,
  TOKEN_VARIABLE,
  BUILDER3_LOGIN,
  NAME_ONLY_LOGINS,
} from './accounts.js'
export { teamConfig, teamMembers, hackwinObject, ownersObject, yaml, TEAM_SIZES } from './team.js'
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
/** @typedef {import('./fake-github.js').FakeRuleset} FakeRuleset */
/** @typedef {import('./fake-github.js').FakeMilestone} FakeMilestone */
/** @typedef {import('./fixture-repo.js').FixtureRepoContext} FixtureRepoContext */
/** @typedef {import('./reset.js').FixtureRepoState} FixtureRepoState */
/** @typedef {import('./team.js').TeamConfig} TeamConfig */

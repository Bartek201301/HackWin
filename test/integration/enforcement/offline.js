// The offline world of the enforcement scenarios: an unconfigured Node project with a bare origin,
// and a fake GitHub that answers what `setup`, the Gate and `status` ask. It is the place for the
// case that no real repository produces: GitHub accepts the rules for everyone but refuses the
// update restriction (AC70; docs/verification.md section 5). The rule set of the update
// restriction is refused with HTTP 422, which setup reads as a refusal (src/commands/setup/rules.js).
//
// The fake GitHub stands for GitHub's answers only. Git pushes go to the bare origin, and every gh
// call to the fake, as in the lane tests of setup.

import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { createFakeClock } from '../../../src/core/runtime/index.js'
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
import { QUICK_COMMANDS, onPath, runCli, toolsDir } from './scene.js'

/** The logins that exist on the fake GitHub. */
const KNOWN_LOGINS = [
  accounts.lead.login,
  accounts.builder1.login,
  accounts.builder2.login,
  BUILDER3_LOGIN,
]

/** What the fake GitHub answers to the rule set of the update restriction where it refuses it. */
export const RESTRICTION_REFUSAL = 'Validation Failed: the rule update is not available'

/**
 * An unconfigured repository on which GitHub offers the rules for everyone and push protection
 * and, with `refuseUpdateRestriction`, refuses the update restriction.
 * @param {{ refuseUpdateRestriction: boolean }} options
 */
export async function createOfflineWorld({ refuseUpdateRestriction }) {
  const fixture = await createFixture({ nodeProject: true })
  const fake = createFakeGitHub({ visibility: 'public' })
  fake.on('version', () =>
    rawResult({ code: 0, stdout: 'gh version 2.88.1 (2026-01-01)\n', stderr: '' }),
  )
  fake.on('GET users/:login', ({ params }) => {
    const known = KNOWN_LOGINS.some((login) => login.toLowerCase() === params.login.toLowerCase())
    if (!known) throw httpError(404, 'Not Found')
    return { login: params.login, type: 'User' }
  })
  servePushProtection(fake)
  fake.on('POST repos/{owner}/{repo}/rulesets', ({ body }) => {
    const restriction = body.rules.some((/** @type {any} */ rule) => rule.type === 'update')
    if (refuseUpdateRestriction && restriction) throw httpError(422, RESTRICTION_REFUSAL)
    return fake.addRuleset(body)
  })
  const env = onPath(fixture.env, toolsDir(fixture.dir))
  return { fixture, fake, env, lead: fake.as(accounts.lead.login) }
}

/**
 * The repository requests of setup's step 13 on the fake GitHub: `GET repos/{owner}/{repo}` with
 * `security_and_analysis`, which GitHub returns only to admins, and `PATCH repos/{owner}/{repo}`,
 * which enables push protection.
 * @param {import('../../harness/index.js').FakeGitHub} fake
 */
function servePushProtection(fake) {
  const { state } = fake
  let pushProtection = 'disabled'
  /** @param {string} login */
  const repository = (login) => {
    const order = ['read', 'triage', 'write', 'maintain', 'admin']
    const level = state.collaborators[login] ?? (state.visibility === 'public' ? 'read' : null)
    const rank = level === null ? -1 : order.indexOf(level)
    return {
      full_name: state.repo,
      name: state.repo.split('/')[1],
      owner: { login: state.repo.split('/')[0], type: 'User' },
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
      ...(rank >= 4
        ? {
            security_and_analysis: {
              secret_scanning: { status: 'enabled' },
              secret_scanning_push_protection: { status: pushProtection },
            },
          }
        : {}),
    }
  }
  fake.on('GET repos/{owner}/{repo}', ({ login }) => repository(login))
  fake.on('PATCH repos/{owner}/{repo}', ({ login, body }) => {
    const status = body?.security_and_analysis?.secret_scanning_push_protection?.status
    if (status !== undefined) pushProtection = status
    return repository(login)
  })
}

/**
 * Run `hackwin setup --answers` for a team of 3 in the main checkout, as the Lead. A fake clock,
 * so that waiting for GitHub's reads to settle takes no time.
 * @param {Awaited<ReturnType<typeof createOfflineWorld>>} world
 */
export async function offlineSetup(world) {
  const answers = structuredClone(teamConfig(3).answers)
  answers.commands = { ...answers.commands, ...QUICK_COMMANDS }
  Object.assign(answers, { language: 'English', explanation_style: 'concise' })
  const file = join(world.fixture.dir, 'answers.yml')
  writeFileSync(file, yaml(answers))
  return runCli(['setup', '--answers', file], {
    cwd: world.fixture.main,
    env: world.env,
    executor: world.lead,
    clock: createFakeClock(new Date()),
  })
}

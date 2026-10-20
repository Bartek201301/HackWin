// The offline world of the parity scenarios: the Node fixture in a fixture with a bare origin, the
// Lead's main checkout as the clone `setup` runs in, and a fake GitHub linked to the origin, so
// that pushes, pull requests and merges act on the same branches. Besides the requests of the
// typed helpers, the fake answers what `setup` asks for: `gh version`, the user lookups of
// step 3 and the push protection setting of step 13, which it offers.

import { createFakeClock } from '../../../src/core/runtime/index.js'
import {
  accounts,
  createFakeGitHub,
  createFixture,
  httpError,
  rawResult,
  teamConfig,
} from '../../harness/index.js'
import { createWorld, runSetup, soloAnswers } from './world.js'

/** @typedef {import('../../harness/index.js').FakeGitHub} FakeGitHub */

/** The member of the solo team, the Lead. */
export const SOLO = accounts.solo.login

/**
 * An offline world with a solo team: the repository is not configured yet.
 * @param {object} [options]
 * @param {(line: string) => void} [options.log]
 */
export async function createOfflineWorld({ log } = {}) {
  const fixture = await createFixture({ nodeProject: true })
  const fake = createFakeGitHub({ origin: fixture.origin, collaborators: { [SOLO]: 'admin' } })
  serveSetupRequests(fake)
  const world = await createWorld({
    main: fixture.main,
    dir: fixture.dir,
    env: fixture.env,
    executor: fake.as(SOLO),
    login: SOLO,
    log,
  })
  const team = teamConfig(1)
  return {
    fixture,
    fake,
    world,
    team,
    /** Run `setup` with the answers of the solo team, as the Lead. */
    setup: () => runSetup(world, soloAnswers(team), { clock: createFakeClock(new Date()) }),
    async cleanup() {
      await world.close()
      fixture.cleanup()
    },
  }
}

/**
 * The requests of `setup` that the fake GitHub does not answer by itself.
 * @param {FakeGitHub} fake
 */
function serveSetupRequests(fake) {
  const { state } = fake
  let pushProtection = 'disabled'
  fake.on('version', () => rawResult({ stdout: 'gh version 2.88.1 (2026-01-01)\n' }))
  fake.on('GET users/:login', ({ params }) => {
    if (params.login.toLowerCase() !== SOLO.toLowerCase()) throw httpError(404, 'Not Found')
    return { login: params.login, type: 'User' }
  })
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
      // GitHub returns the block only to admins.
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

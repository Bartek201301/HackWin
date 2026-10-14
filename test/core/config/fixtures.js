// Configuration fixtures for the tests of task 1.3b: a valid hackwin.yml and owners.yml for a
// team of three, a configured repository with a bare origin, and a fake gh that answers the
// login. The logins are names only; no test here reaches GitHub.

import { join } from 'node:path'
import { stringify } from 'yaml'
import { VERSION } from '../../../src/cli/context.js'
import { createRepoWithOrigin } from '../git/temp-repo.js'

/** A valid owners.yml as an object: a shared role, two feature roles and README.md open. */
export function ownersObject() {
  return {
    schema: 1,
    roles: {
      shared: { shared: true, paths: ['src/shared/**', 'docs/**', '.github/**'] },
      web: { paths: ['src/features/web/**'] },
      api: { paths: ['src/features/api/**'] },
    },
    open: ['README.md'],
  }
}

/** A valid hackwin.yml as an object, pinned to the running version. */
export function hackwinObject() {
  return {
    schema: 1,
    cli_version: VERSION,
    project: {
      default_branch: 'main',
      language: 'en',
      event: { start: '2026-10-24T09:00:00+02:00', end: '2026-10-25T15:00:00+02:00' },
    },
    team: {
      lead: 'lead',
      members: [
        { name: 'Lead', github: 'lead', roles: ['shared'], agent: 'claude', sessions: 2 },
        {
          name: 'Builder One',
          github: 'builder-one',
          roles: ['web'],
          agent: 'claude',
          sessions: 2,
        },
        { name: 'Builder Two', github: 'builder-two', roles: ['api'], agent: 'codex', sessions: 1 },
      ],
    },
    commands: {
      install: 'npm ci',
      check: 'npm run check',
      test: 'npx vitest run',
      format: 'npx prettier --write',
      generate: null,
      lockfile_regen: 'npm install --package-lock-only',
      smoke: null,
    },
    paths: {
      contracts: ['src/shared/contracts/**'],
      generated: [],
      manifests: ['package.json'],
      lockfiles: ['package-lock.json'],
      gated: { migrations: [], production_config: [] },
      ledger: null,
    },
    tasks: { max_files: 10 },
    gate: {
      poll_seconds: 60,
      ci_rerun_limit: 1,
      repeated_failure_threshold: 2,
      heartbeat_stale_seconds: 300,
      status_issue_seconds: 120,
      ci_timeout_minutes: 20,
      step_timeout_minutes: 20,
      known_flaky_tests: [],
      secret_patterns: [],
    },
    resolver: { enabled: false, model: null, max_turns: 30 },
  }
}

/**
 * YAML text of a fixture object.
 * @param {unknown} value
 */
export function yaml(value) {
  return stringify(value)
}

/**
 * A bare origin and its main checkout with hackwin.yml and owners.yml on main, plus a second
 * clone, the publisher, that pushes later versions of main.
 * @param {{ hackwin?: unknown, owners?: unknown }} [files]
 */
export function createConfiguredRepo({ hackwin = hackwinObject(), owners = ownersObject() } = {}) {
  const repo = createRepoWithOrigin()
  writeConfig(repo, repo.clone, { hackwin, owners })
  repo.git(repo.clone, 'add', '.')
  repo.git(repo.clone, 'commit', '--quiet', '-m', 'configure hackwin')
  repo.git(repo.clone, 'push', '--quiet', 'origin', 'main')
  const publisher = join(repo.dir, 'publisher')
  repo.git(repo.dir, 'clone', '--quiet', repo.origin, publisher)
  return {
    ...repo,
    publisher,
    /**
     * Push a new commit to origin's main from the publisher.
     * @param {Record<string, string>} files Paths and contents, or YAML objects for the config.
     * @param {string} [message]
     */
    publish(files, message = 'change main') {
      repo.git(publisher, 'pull', '--quiet', '--ff-only', 'origin', 'main')
      for (const [path, text] of Object.entries(files)) repo.write(join(publisher, path), text)
      repo.git(publisher, 'add', '.')
      repo.git(publisher, 'commit', '--quiet', '-m', message)
      repo.git(publisher, 'push', '--quiet', 'origin', 'main')
      return repo.git(publisher, 'rev-parse', 'HEAD').trim()
    },
  }
}

/**
 * @param {{ write: (path: string, text: string) => void }} repo
 * @param {string} dir
 * @param {{ hackwin: unknown, owners: unknown }} files
 */
function writeConfig(repo, dir, { hackwin, owners }) {
  repo.write(join(dir, 'hackwin.yml'), typeof hackwin === 'string' ? hackwin : yaml(hackwin))
  repo.write(join(dir, 'owners.yml'), typeof owners === 'string' ? owners : yaml(owners))
}

/**
 * A gh executor that answers `gh api user` with this login and fails every other call.
 * @param {string} [login]
 * @returns {import('../../../src/core/github/index.js').GhExecutor}
 */
export function fakeGh(login = 'lead') {
  return async (args) =>
    args.join(' ') === 'api --method GET user'
      ? { code: 0, stdout: JSON.stringify({ login }), stderr: '' }
      : { code: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` }
}

/** A writable stream stand-in that keeps what was written. */
export function sink() {
  return {
    text: '',
    /** @param {string} chunk */
    write(chunk) {
      this.text += chunk
    },
  }
}

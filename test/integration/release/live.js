// Helpers of the release scenarios on a fixture repository (release.fixture.test.js): the Lead's
// clone with a CLI on PATH, runs of a CLI through the harness's guard, the answers of a team of
// one, and the check run `hackwin` of GitHub Actions with its log. Every gh call goes through
// the guarded executor of the Lead, so it reaches only the fixture repository.

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RemoteError } from '../../../src/core/runtime/index.js'
import { teamConfig, yaml } from '../../harness/index.js'
import { runCli, withCli } from './clis.js'
import { QUICK_COMMANDS } from './scene.js'

/** @typedef {import('./clis.js').Cli} Cli */
/** @typedef {import('../../harness/index.js').FixtureRepoContext} FixtureRepoContext */

/**
 * The variable that names the build `n` of the GitHub pre-releases `<phase>.0-pre.<n>`,
 * `<phase>.1-pre.<n>` and `<next phase>.0-pre.<n>` (docs/build/contracts.md 6.2). The human
 * creates them (plan section 9, decision 5) and sets it locally.
 */
export const PRERELEASE_VARIABLE = 'HACKWIN_TEST_PRERELEASE'

/** How long a scenario waits for the check run `hackwin` of one head commit. */
const CHECK_PATIENCE_MS = 30 * 60_000

/**
 * The build of the pre-releases, from PRERELEASE_VARIABLE; an error that names the versions to
 * create when it is not set.
 * @param {(n: string) => { old: string, fix: string, other: string }} releasesOf
 * @returns {string}
 */
export function prereleaseBuild(releasesOf) {
  const value = process.env[PRERELEASE_VARIABLE]?.trim() ?? ''
  if (!/^\d+$/.test(value)) {
    const sample = releasesOf('<n>')
    throw new Error(
      `${PRERELEASE_VARIABLE} is not set to a build number: this scenario installs the GitHub pre-releases ${sample.old}, ${sample.fix} and ${sample.other} of this repository by URL; create them and set ${PRERELEASE_VARIABLE}=<n>`,
    )
  }
  return value
}

/**
 * The answers of `setup --answers` (CM11) for a team of one, the Lead, on the stand-in commands
 * of scene.js, so that the project's commands install nothing, on this machine or in the job
 * `hackwin` of CI.
 * @param {FixtureRepoContext} repo
 * @param {(answers: any) => void} [change]
 */
export function soloAnswers(repo, change) {
  const answers = structuredClone(teamConfig(1).answers)
  answers.team.lead = repo.logins.lead
  answers.team.members[0].github = repo.logins.lead
  answers.commands = { ...QUICK_COMMANDS }
  Object.assign(answers, { language: 'English', explanation_style: 'concise' })
  change?.(answers)
  return answers
}

/**
 * The Lead's clone of the fixture repository, with a `claude` that does nothing on PATH: join's
 * step 3 looks for it, and take, without a terminal, starts no agent.
 * @param {FixtureRepoContext} repo
 */
export async function leadClone(repo) {
  const clone = await repo.clone('lead')
  const tools = join(repo.tempDir, 'tools')
  mkdirSync(tools, { recursive: true })
  writeFileSync(join(tools, 'claude'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(tools, 'claude'), 0o755)
  const env = { ...clone.env, PATH: `${tools}:${clone.env.PATH}` }
  return {
    ...clone,
    env,
    /** The clone's environment with a CLI first on PATH, where the git hooks find it. */
    envOf: (/** @type {Cli} */ cli) => withCli(cli, env),
  }
}

/** @typedef {Awaited<ReturnType<typeof leadClone>>} LeadClone */

/**
 * Run `hackwin <argv>` of a CLI as the Lead, in the clone by default, and log it.
 * @param {FixtureRepoContext} repo
 * @param {LeadClone} clone
 * @param {Cli} cli
 * @param {string[]} argv
 * @param {{ cwd?: string }} [options]
 */
export async function runLive(repo, clone, cli, argv, { cwd = clone.path } = {}) {
  const result = await runCli(cli, argv, {
    cwd,
    env: clone.envOf(cli),
    ghExecutor: repo.executor('lead'),
  })
  repo.log(
    `hackwin ${cli.version} ${argv.join(' ')} exited ${result.code}\n${result.stdout}\n${result.stderr}`,
  )
  return result
}

/**
 * `hackwin setup --answers` of a CLI in the clone.
 * @param {FixtureRepoContext} repo
 * @param {LeadClone} clone
 * @param {Cli} cli
 * @param {unknown} answers
 */
export function setupLive(repo, clone, cli, answers) {
  const file = join(repo.tempDir, 'answers.yml')
  writeFileSync(file, yaml(answers))
  return runLive(repo, clone, cli, ['setup', '--answers', file])
}

/**
 * `hackwin join --answers` of a CLI in the clone.
 * @param {FixtureRepoContext} repo
 * @param {LeadClone} clone
 * @param {Cli} cli
 */
export function joinLive(repo, clone, cli) {
  const file = join(repo.tempDir, 'join-answers.yml')
  writeFileSync(file, yaml({ language: 'English', explanation_style: 'concise' }))
  return runLive(repo, clone, cli, ['join', '--answers', file])
}

/** gh commands other than `gh api` that only read. */
const READ_COMMANDS = Object.freeze(['version', 'run view'])

/**
 * The gh calls of the run so far, from the index `from` on, that may change something on
 * GitHub: every `gh api` call with a method other than GET, and every other gh command except
 * those that only read. Each as `<METHOD> <endpoint>` or the gh command.
 * @param {FixtureRepoContext} repo
 * @param {number} [from]
 */
export function writeCalls(repo, from = 0) {
  return repo.calls
    .slice(from)
    .filter((call) => call.refused === null)
    .map((call) => {
      if (call.args[0] !== 'api') return call.args.slice(0, 2).join(' ')
      const at = call.args.findIndex((arg) => arg === '--method' || arg === '-X')
      const method = at === -1 ? 'GET' : call.args[at + 1].toUpperCase()
      const endpoint = call.args.find(
        (arg, index) => index > 0 && !arg.startsWith('-') && call.args[index - 1] !== '--method',
      )
      return `${method} ${endpoint}`
    })
    .filter(
      (call) =>
        !call.startsWith('GET ') && !READ_COMMANDS.some((command) => call.startsWith(command)),
    )
}

/**
 * The commit of `main` on the fixture repository.
 * @param {LeadClone} clone
 */
export async function remoteMain(clone) {
  const { stdout } = await clone.git.run(['ls-remote', 'origin', 'refs/heads/main'])
  return stdout.split(/\s+/)[0]
}

/**
 * Wait until GitHub Actions finished the check run `hackwin` of a commit; the check run. A look
 * that fails without an HTTP status or with a 5xx, as on a flaky network, is made again.
 * @param {FixtureRepoContext} repo
 * @param {string} sha
 * @returns {Promise<{ id: number, status: string, conclusion: string | null, details_url: string }>}
 */
export async function finishedCheck(repo, sha) {
  const lead = repo.github('lead')
  const deadline = Date.now() + CHECK_PATIENCE_MS
  for (;;) {
    try {
      const answer = await lead.api(`repos/{owner}/{repo}/commits/${sha}/check-runs`, {
        query: { check_name: 'hackwin' },
      })
      const run = answer?.check_runs?.find(
        (/** @type {any} */ entry) => entry.name === 'hackwin' && entry.status === 'completed',
      )
      if (run) {
        repo.log(`check run hackwin of ${sha}: ${run.conclusion}, ${run.details_url}`)
        return run
      }
    } catch (error) {
      if (!isTransient(error)) throw error
      repo.log(`looking for the check run hackwin of ${sha} failed, again soon: ${error.message}`)
    }
    if (Date.now() > deadline) {
      throw new Error(`the check run hackwin of ${sha} did not finish within 30 minutes`)
    }
    await new Promise((resolve) => setTimeout(resolve, 15_000))
  }
}

/**
 * The log of the workflow run of a check run, as `gh run view <id> --log` prints it. gh prints
 * a log only once the whole run is complete, which can be a little after its check run, so a
 * failed call is made again for up to five minutes.
 * @param {FixtureRepoContext} repo
 * @param {{ details_url: string }} check
 * @returns {Promise<string>}
 */
export async function checkLog(repo, check) {
  const id = /\/actions\/runs\/(\d+)/.exec(check.details_url)?.[1]
  if (!id) throw new Error(`the check run names no workflow run: ${check.details_url}`)
  const deadline = Date.now() + 5 * 60_000
  for (;;) {
    const result = await repo.github('lead').run(['run', 'view', id, '--log'])
    if (result.code === 0) return result.stdout
    if (Date.now() > deadline) {
      throw new Error(`gh run view ${id} --log exited ${result.code}: ${result.stderr}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 15_000))
  }
}

/**
 * True for a GitHub call that failed without an HTTP status or with a 5xx.
 * @param {unknown} error
 */
function isTransient(error) {
  const status = /** @type {any} */ (error)?.status
  return error instanceof RemoteError && (status === undefined || status === null || status >= 500)
}

/**
 * Run `scenario` and put the repository's push protection setting back as it was afterwards:
 * setup enables it (step 13), and the reset leaves repository settings alone.
 * @template T
 * @param {FixtureRepoContext} repo
 * @param {() => Promise<T>} scenario
 * @returns {Promise<T>}
 */
export async function keepingPushProtection(repo, scenario) {
  const lead = repo.github('lead')
  const read = async () =>
    (await lead.api('repos/{owner}/{repo}'))?.security_and_analysis?.secret_scanning_push_protection
      ?.status ?? null
  const initial = await read()
  repo.log(`push protection before the scenario: ${initial}`)
  try {
    return await scenario()
  } finally {
    if (initial !== null) {
      await lead.api('repos/{owner}/{repo}', {
        method: 'PATCH',
        body: { security_and_analysis: { secret_scanning_push_protection: { status: initial } } },
      })
      repo.log(`push protection put back to ${initial}`)
    }
  }
}

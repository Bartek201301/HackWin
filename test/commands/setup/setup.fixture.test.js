// `setup` on real fixture repositories. These tests run only through `npm run test:ac`, and fail
// when a fixture repository or the gh login is missing. They act only as the Lead, so they need
// no HACKWIN_TEST_BUILDER_TOKEN: the team of 3 names builder1 and builder2, but setup only reads
// their write access, and every run answers the invitation question with no (`invite: false`),
// so builder2 (`maljul`) is never invited. The reset before each scenario deletes the labels and
// the rule sets and resets main; push protection is a setting that the reset leaves alone, so the
// test that turns it off turns it on again.

import { describe, expect, test } from 'vitest'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { main } from '../../../src/cli/main.js'
import { readProtection } from '../../../src/core/protection/index.js'
import { quoteShellArg, systemClock } from '../../../src/core/runtime/index.js'
import { isJoinComplete, readLocal } from '../../../src/core/state/index.js'
import { labelCatalogue } from '../../../src/commands/setup/labels.js'
import { readPushProtection } from '../../../src/commands/setup/push-protection.js'
import { BRANCH_RULES, UPDATE_RESTRICTION } from '../../../src/commands/setup/rules.js'
import { settledRead } from '../../../src/commands/setup/settle.js'
import { MANIFEST, PROJECT_FILES, SETTINGS_PATH } from '../../../src/generate/index.js'
import { ownersObject, withFixtureRepo, yaml } from '../../harness/index.js'
import { teamAnswers } from './setup-fixture.js'

/** @import { GhExecutor } from '../../../src/core/github/index.js' */
/** @import { FixtureRepoContext } from '../../harness/index.js' */

const TIMEOUT_MS = 30 * 60_000

/** The scenarios act only as the Lead. */
const AS_LEAD = { accounts: ['lead'] }

const CLI = fileURLToPath(new URL('../../../bin/hackwin.js', import.meta.url))

/** Every label of 8.2 for the roles of the Node fixture's owners.yml. */
const ALL_LABELS = labelCatalogue(Object.keys(ownersObject().roles))
  .map((label) => label.name)
  .sort()

/**
 * A clone of the fixture repository, as the Lead, with `hackwin` (this checkout's CLI), `claude`
 * and `npm` first on PATH. The `npm` only notes its arguments, so the install of join's step 4
 * downloads nothing; the `claude` does nothing.
 * @param {FixtureRepoContext} repo
 */
async function leadClone(repo) {
  const clone = await repo.clone('lead')
  const bin = join(repo.tempDir, 'bin')
  mkdirSync(bin, { recursive: true })
  const tools = {
    hackwin: `#!/bin/sh\nexec ${quoteShellArg(process.execPath)} ${quoteShellArg(CLI)} "$@"\n`,
    claude: '#!/bin/sh\nexit 0\n',
    npm: `#!/bin/sh\necho "$*" >> ${quoteShellArg(join(repo.tempDir, 'npm.log'))}\nexit 0\n`,
  }
  for (const [name, text] of Object.entries(tools)) {
    writeFileSync(join(bin, name), text)
    chmodSync(join(bin, name), 0o755)
  }
  const env = { ...clone.env, PATH: `${bin}${delimiter}${clone.env.PATH}` }
  return { ...clone, env, git: clone.git.with({ env }) }
}

/**
 * Run `hackwin setup` in-process in the clone, as the Lead. The install of join inherits the PATH
 * of this process, so the tools come first there too while setup runs.
 * @param {FixtureRepoContext} repo
 * @param {Awaited<ReturnType<typeof leadClone>>} clone
 * @param {{ answers?: unknown, args?: string[], executor?: GhExecutor }} [options]
 */
async function runLiveSetup(repo, clone, { answers = teamAnswers(3), args = [], executor } = {}) {
  const file = join(repo.tempDir, 'answers.yml')
  writeFileSync(file, yaml(answers))
  let stdout = ''
  let stderr = ''
  const path = process.env.PATH
  process.env.PATH = clone.env.PATH
  try {
    const code = await main(['setup', '--answers', file, ...args], {
      cwd: clone.path,
      env: clone.env,
      stdin: Object.assign(Readable.from([]), { isTTY: false }),
      stdout: { write: (chunk) => (stdout += chunk), isTTY: false },
      stderr: { write: (chunk) => (stderr += chunk) },
      ghExecutor: executor ?? repo.executor('lead'),
    })
    repo.log(`setup ${args.join(' ')} exited ${code}\n${stdout}\n${stderr}`)
    return { code, stdout, stderr }
  } finally {
    if (path === undefined) delete process.env.PATH
    else process.env.PATH = path
  }
}

/**
 * The gh calls of the run so far that changed something, as `<METHOD> <endpoint>`.
 * @param {FixtureRepoContext} repo
 */
function writeCalls(repo) {
  return repo.calls
    .filter((call) => call.refused === null && call.args[0] === 'api')
    .map((call) => {
      const at = call.args.indexOf('--method')
      const method = at === -1 ? 'GET' : call.args[at + 1]
      const endpoint = call.args.find(
        (arg, index) => index > 0 && arg.startsWith('repos/') && call.args[index - 1] !== '-f',
      )
      return `${method} ${endpoint}`
    })
    .filter((call) => !call.startsWith('GET '))
}

describe('AC1: setup on a public fixture repository', () => {
  test(
    'AC1: setup with scripted answers for 3 members creates the committed files of 6.4 and every label of 8.2, and the rules read back from GitHub are the rules for everyone and the update restriction',
    async () => {
      await withFixtureRepo(
        'hackwin-fixture-a',
        async (repo) => {
          const clone = await leadClone(repo)
          const result = await runLiveSetup(repo, clone)
          expect(result.stderr).not.toContain('hackwin setup:')
          expect(result.code).toBe(0)

          const lead = repo.github('lead')
          await clone.git.fetch()
          const { stdout: tree } = await clone.git.run([
            'ls-tree',
            '-r',
            '--name-only',
            'origin/main',
          ])
          for (const path of [
            'hackwin.yml',
            'owners.yml',
            ...MANIFEST.map((file) => file.path),
            SETTINGS_PATH,
            ...PROJECT_FILES.map((file) => file.path).filter((path) => !path.endsWith('check.yml')),
          ]) {
            expect(tree.split('\n')).toContain(path)
          }
          expect((await lead.listLabels()).map((label) => label.name).sort()).toEqual(ALL_LABELS)

          const rulesets = await lead.apiPages('repos/{owner}/{repo}/rulesets')
          expect(rulesets.map((ruleset) => ruleset.name).sort()).toEqual(
            [BRANCH_RULES, UPDATE_RESTRICTION].sort(),
          )
          const { state, rules } = await readProtection(lead)
          repo.log(`read back: ${state} ${JSON.stringify(rules)}`)
          expect(state).toBe('full-restricted')
          expect(rules).toMatchObject({
            pullRequestRequired: true,
            checkRequired: true,
            forcePushBlocked: true,
            deletionBlocked: true,
            appliesToAdmins: true,
            updateRestricted: true,
          })
          // The pin is GitHub's to accept (docs/verification.md, open question 5); an unpinned
          // check is never left silently.
          if (!rules.checkPinned) {
            expect(result.stdout).toContain('the required check hackwin is not pinned')
          }
          expect(result.stdout).toContain('protection: full, with the update restriction')
          const record = await readLocal(join(clone.path, '.git'))
          expect(isJoinComplete(record, repo.logins.lead)).toBe(true)
        },
        AS_LEAD,
      )
    },
    TIMEOUT_MS,
  )
})

describe('AC2: setup where GitHub refuses protection', () => {
  test(
    'AC2: on the private fixture repository setup exits 0 and reports soft mode, and git push origin main from the joined clone is rejected by the pre-push hook',
    async () => {
      await withFixtureRepo(
        'hackwin-fixture-private',
        async (repo) => {
          const clone = await leadClone(repo)
          const result = await runLiveSetup(repo, clone)
          expect(result.stderr).not.toContain('hackwin setup:')
          expect(result.code).toBe(0)
          expect(result.stdout).toContain(
            `protection: soft: GitHub offers no branch rules for ${repo.repo} (a private repository on a free plan has none)`,
          )
          expect((await readProtection(repo.github('lead'))).state).toBe('soft')

          const remoteMain = async () =>
            (await clone.git.run(['ls-remote', 'origin', 'refs/heads/main'])).stdout.split(/\s+/)[0]
          const before = await remoteMain()
          writeFileSync(join(clone.path, 'README.md'), '# Straight to main\n')
          await clone.git.run(['commit', '--quiet', '--no-verify', '-am', 'Straight to main'])
          const push = await clone.git.run(['push', 'origin', 'main'], { allowFailure: true })
          repo.log(`git push origin main exited ${push.code}: ${push.stderr}`)
          expect(push.code).not.toBe(0)
          expect(push.stderr).toContain('rule: E2: no direct push to main')
          expect(await remoteMain()).toBe(before)
        },
        AS_LEAD,
      )
    },
    TIMEOUT_MS,
  )
})

describe('AC6: setup --resume on a public fixture repository', () => {
  test(
    'AC6: a setup that stops after the bootstrap push is completed by setup --resume, and a second resume creates no label or rule set',
    async () => {
      await withFixtureRepo(
        'hackwin-fixture-a',
        async (repo) => {
          const clone = await leadClone(repo)
          // The network fails at the first rule set request, after the bootstrap push.
          const real = repo.executor('lead')
          let failed = false
          /** @type {GhExecutor} */
          const failing = async (args, call) => {
            if (!failed && args.includes('POST') && args.some((arg) => arg.endsWith('/rulesets'))) {
              failed = true
              return { code: 1, stdout: '', stderr: 'error connecting to api.github.com\n' }
            }
            return real(args, call)
          }
          let result = await runLiveSetup(repo, clone, { executor: failing })
          expect(result.code).toBe(3)
          expect(result.stderr).toContain(`run \`hackwin setup --resume\` in ${clone.path}`)
          const lead = repo.github('lead')
          expect(await lead.apiPages('repos/{owner}/{repo}/rulesets')).toEqual([])
          await clone.git.fetch()
          const head = await clone.git.revParse('origin/main')
          expect(head).not.toBe(repo.resetSha)

          result = await runLiveSetup(repo, clone, { args: ['--resume'] })
          expect(result.stderr).not.toContain('hackwin setup:')
          expect(result.code).toBe(0)
          expect(result.stdout).toContain(
            `labels: 0 created, ${ALL_LABELS.length} were there already`,
          )
          expect((await readProtection(lead)).state).toBe('full-restricted')

          const before = writeCalls(repo).length
          result = await runLiveSetup(repo, clone, { args: ['--resume'] })
          expect(result.code).toBe(0)
          const again = writeCalls(repo).slice(before)
          repo.log(`writes of the second resume: ${JSON.stringify(again)}`)
          expect(again.filter((call) => call.startsWith('POST '))).toEqual([])
          expect(again.filter((call) => call.includes('/collaborators/'))).toEqual([])
          expect((await lead.listLabels()).map((label) => label.name).sort()).toEqual(ALL_LABELS)
          expect(await lead.apiPages('repos/{owner}/{repo}/rulesets')).toHaveLength(2)
          await clone.git.fetch()
          expect(await clone.git.revParse('origin/main')).toBe(head)
          expect(await clone.git.isClean()).toBe(true)
        },
        AS_LEAD,
      )
    },
    TIMEOUT_MS,
  )
})

describe('AC80/setup: push protection on the fixture repositories', () => {
  test(
    'AC80/setup: on a public fixture repository, where GitHub offers push protection, setup enables it and the setting read back is on',
    async () => {
      await withFixtureRepo(
        'hackwin-fixture-a',
        async (repo) => {
          const lead = repo.github('lead')
          // One read right after a write can show the old value (settle.js), so every read here
          // waits until GitHub's reads have settled.
          const settled = async () =>
            (
              await settledRead(systemClock, () => readPushProtection(lead), {
                since: Date.now(),
                what: 'the push protection setting',
              })
            ).value
          const initial = await settled()
          repo.log(`push protection before the test: ${initial}`)
          try {
            // Off first, so that the run shows setup turning it on.
            await lead.api('repos/{owner}/{repo}', {
              method: 'PATCH',
              body: {
                security_and_analysis: { secret_scanning_push_protection: { status: 'disabled' } },
              },
            })
            expect(await settled()).toBe('disabled')
            const clone = await leadClone(repo)
            const result = await runLiveSetup(repo, clone)
            expect(result.code).toBe(0)
            expect(result.stdout).toContain('push protection: on: GitHub blocks a push')
            expect(await settled()).toBe('enabled')
          } finally {
            // Always back to the setting the test found. A read right before did not do: on
            // 15 October 2026 it skipped the restore, and the setting stayed disabled.
            if (initial !== null) {
              await lead.api('repos/{owner}/{repo}', {
                method: 'PATCH',
                body: {
                  security_and_analysis: { secret_scanning_push_protection: { status: initial } },
                },
              })
              repo.log(`push protection after the test: ${await settled()}`)
            }
          }
        },
        AS_LEAD,
      )
    },
    TIMEOUT_MS,
  )

  test(
    'AC80/setup: on the private fixture repository, where GitHub refuses push protection, setup exits 0 and its summary reports push protection as off',
    async () => {
      await withFixtureRepo(
        'hackwin-fixture-private',
        async (repo) => {
          const clone = await leadClone(repo)
          const result = await runLiveSetup(repo, clone, { answers: teamAnswers(3) })
          expect(result.code).toBe(0)
          expect(result.stdout).toContain(
            `push protection: off: GitHub does not offer it for ${repo.repo}, so HackWin's own secret scans (E6) run alone`,
          )
          expect(await readPushProtection(repo.github('lead'))).not.toBe('enabled')
        },
        AS_LEAD,
      )
    },
    TIMEOUT_MS,
  )
})

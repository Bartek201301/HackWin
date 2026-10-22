import { describe, expect, test } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createGitHub } from '../../../src/core/github/index.js'
import {
  ACTIONS_APP_ID,
  REQUIRED_CHECK,
  readProtection,
} from '../../../src/core/protection/index.js'
import { isJoinComplete, readLocal } from '../../../src/core/state/index.js'
import { LABELS } from '../../../src/core/tasks/index.js'
import {
  MANIFEST,
  PROJECT_FILES,
  SETTINGS_PATH,
  TEMPLATE_CHECK_WORKFLOW_PATH,
} from '../../../src/generate/index.js'
import { labelCatalogue } from '../../../src/commands/setup/labels.js'
import { BRANCH_RULES, UPDATE_RESTRICTION } from '../../../src/commands/setup/rules.js'
import { SETTLE, settledRead } from '../../../src/commands/setup/settle.js'
import { RemoteError, createFakeClock } from '../../../src/core/runtime/index.js'
import { accounts, httpError, ownersObject, teamConfig } from '../../harness/index.js'
import {
  JOIN_ANSWERS,
  LEAD,
  createSetupFixture,
  originMain,
  runHackwin,
  runSetup,
  slowOrigin,
  teamAnswers,
  waitFor,
  writeAnswers,
  writes,
} from './setup-fixture.js'

/** @typedef {import('../../harness/index.js').FakeGitHub} FakeGitHub */
/** @typedef {import('../../harness/index.js').Fixture} Fixture */

const BUILDER1 = accounts.builder1.login
const BUILDER2 = accounts.builder2.login

/** The roles of the Node fixture's owners.yml. */
const ROLES = Object.keys(ownersObject().roles)

/** Every label of 8.2 for the Node fixture's roles. */
const ALL_LABELS = labelCatalogue(ROLES).map((label) => label.name)

/** The rules for everyone and the update restriction as the reader reports them (A32, D2). */
const FULL_RESTRICTED = Object.freeze({
  pullRequestRequired: true,
  requiredChecks: [{ context: REQUIRED_CHECK, integrationId: ACTIONS_APP_ID }],
  checkRequired: true,
  checkPinned: true,
  forcePushBlocked: true,
  deletionBlocked: true,
  appliesToAdmins: true,
  updateRestricted: true,
  bypassable: [],
})

/** @param {FakeGitHub} fake */
function leadClient(fake) {
  return createGitHub({ executor: fake.as(LEAD), repo: fake.state.repo })
}

/**
 * The calls of one kind: `<METHOD> <endpoint>`, the endpoint as a regular expression.
 * @param {FakeGitHub} fake
 * @param {string} method
 * @param {RegExp} endpoint
 */
function callsOf(fake, method, endpoint) {
  return fake.calls.filter(
    (call) => call.method === method && endpoint.test(call.endpoint ?? '') && call.code === 0,
  )
}

/** @param {FakeGitHub} fake */
function counts(fake) {
  return {
    labels: callsOf(fake, 'POST', /\/labels$/).length,
    rulesets: callsOf(fake, 'POST', /\/rulesets$/).length,
    invitations: callsOf(fake, 'PUT', /\/collaborators\//).length,
  }
}

/** @param {FakeGitHub} fake */
function labelNames(fake) {
  return fake.state.labels.map((label) => label.name)
}

/**
 * The answers of a team of 3 in which builder2 has no write access yet.
 * @param {boolean | undefined} invite
 */
function answersWithInvite(invite) {
  return teamAnswers(3, (a) => {
    if (invite === undefined) delete a.invite
    else a.invite = invite
  })
}

describe('AC1: setup configures the repository and GitHub', () => {
  test('AC1: with scripted answers for 3 members, setup creates the committed files of 6.4 and every label of 8.2, and the rules read back from GitHub are the rules for everyone and the update restriction', async () => {
    const { fixture, fake, security } = await createSetupFixture()
    const result = await runSetup(fixture, fake, { answers: teamAnswers(3) })
    expect(result.stderr).not.toContain('hackwin setup:')
    expect(result.code).toBe(0)

    const { stdout: tree } = await fixture.git.run(['ls-tree', '-r', '--name-only', 'origin/main'])
    const committed = [
      'hackwin.yml',
      'owners.yml',
      ...MANIFEST.map((file) => file.path),
      SETTINGS_PATH,
      ...PROJECT_FILES.map((file) => file.path).filter(
        (path) => path !== TEMPLATE_CHECK_WORKFLOW_PATH,
      ),
    ]
    for (const path of committed) expect(tree.split('\n')).toContain(path)

    expect(labelNames(fake).sort()).toEqual([...ALL_LABELS].sort())
    for (const { name } of LABELS) expect(labelNames(fake)).toContain(name)
    for (const role of ROLES) expect(labelNames(fake)).toContain(`role:${role}`)

    expect(fake.state.rulesets.map((ruleset) => ruleset.name)).toEqual([
      BRANCH_RULES,
      UPDATE_RESTRICTION,
    ])
    expect(await readProtection(leadClient(fake))).toEqual({
      state: 'full-restricted',
      rules: FULL_RESTRICTED,
    })
    expect(security.pushProtection).toBe('enabled')

    expect(result.stdout).toContain(
      `protection: full, with the update restriction: changes to main only through a pull request whose check hackwin passed, no force push and no deletion, for every account, the owner included; only ${LEAD} can update main`,
    )
    expect(result.stdout).toContain('push protection: on: GitHub blocks a push')
  })

  test('AC1: the summary names the protection state, push protection, what each member runs, the next steps and .env.local; the Lead is joined', async () => {
    const { fixture, fake } = await createSetupFixture()
    const result = await runSetup(fixture, fake, { answers: teamAnswers(3), args: ['--json'] })
    expect(result.code).toBe(0)
    const json = JSON.parse(result.stdout)
    const lines = json.lines.join('\n')
    const url = `https://github.com/${fake.state.repo}`
    expect(json.lines[0]).toBe(`setup of ${fake.state.repo} is complete`)
    expect(lines).toContain('protection: full, with the update restriction')
    expect(lines).toContain('push protection: on')
    expect(lines).toContain(`Lead (${LEAD}): joined on this machine`)
    for (const login of [BUILDER1, BUILDER2]) {
      expect(lines).toMatch(
        new RegExp(
          `\\(${login}\\): run \`hackwin join\` in the main checkout of their clone of ${url}`,
        ),
      )
    }
    expect(lines).toContain(`run \`cd ${fixture.main} && hackwin gate\`, in a separate terminal`)
    expect(lines).toContain('write the first tasks by hand')
    expect(lines).toContain('send .env.local to each member over a private channel')
    expect(json.data.protection.state).toBe('full-restricted')
    expect(json.data.pushProtection.on).toBe(true)
    expect(json.data.join.exitCode).toBe(0)

    // Step 14 ran the checks of join in the main checkout: the record, the hooks, the settings.
    const record = await readLocal(join(fixture.main, '.git'))
    expect(isJoinComplete(record, LEAD)).toBe(true)
    expect(record?.language).toBe(JOIN_ANSWERS.language)
    expect(await fixture.git.configGet('core.hooksPath')).toBe('.githooks')
    expect(readFileSync(join(fixture.main, 'CLAUDE.local.md'), 'utf8')).toContain(
      JOIN_ANSWERS.explanation_style,
    )
    expect(await fixture.git.isClean()).toBe(true)
  })
})

describe('AC2: where GitHub refuses protection, setup switches to soft protection', () => {
  test('AC2: setup exits 0 and reports soft mode, and git push origin main from the joined checkout is rejected by the pre-push hook', async () => {
    const { fixture, fake, env } = await createSetupFixture({ visibility: 'private' })
    const result = await runSetup(fixture, fake, { answers: teamAnswers(3) })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(
      'protection: soft: GitHub offers no branch rules for hackwin-test/app (a private repository on a free plan has none). The pre-push hook blocks pushes to main, agent sessions have no right to merge, and the Gate serializes merges',
    )
    expect(fake.state.rulesets).toEqual([])
    expect((await readProtection(leadClient(fake))).state).toBe('soft')

    // The main checkout is joined by step 14, so its hooks are active.
    const git = fixture.git.with({ env })
    const before = await originMain(fixture)
    writeFileSync(join(fixture.main, 'README.md'), '# Straight to main\n')
    // The pre-commit hook blocks a commit on main first; --no-verify skips it, not the push.
    await git.run(['commit', '--quiet', '--no-verify', '-am', 'Straight to main'])
    const push = await git.run(['push', 'origin', 'main'], { allowFailure: true })
    expect(push.code).not.toBe(0)
    expect(push.stderr).toContain('rule: E2: no direct push to main')
    expect(await originMain(fixture)).toBe(before)
  })
})

describe('AC6: setup --resume finishes an interrupted setup and creates nothing twice', () => {
  test('AC6: a setup that fails after the bootstrap push is completed by setup --resume; a second resume and a second join create no label, rule set, invitation or file', async () => {
    const { fixture, fake } = await createSetupFixture()
    delete fake.state.collaborators[BUILDER2]
    const failing = fake.on('POST repos/{owner}/{repo}/rulesets', () => {
      throw httpError(502, 'Server Error')
    })
    const answers = answersWithInvite(true)
    let result = await runSetup(fixture, fake, { answers })
    expect(result.code).toBe(3)
    expect(result.stderr).toContain(
      `run \`cd ${fixture.main} && hackwin setup --resume\`: origin holds the bootstrap commit`,
    )
    const head = await fixture.git.revParse('HEAD')
    expect(await originMain(fixture)).toBe(head)
    expect(labelNames(fake).sort()).toEqual([...ALL_LABELS].sort())
    expect(fake.state.invitations.map((invitation) => invitation.login)).toEqual([BUILDER2])
    expect(fake.state.rulesets).toEqual([])

    failing()
    result = await runSetup(fixture, fake, { answers, args: ['--resume'] })
    expect(result.stderr).not.toContain('hackwin setup:')
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('resuming setup of hackwin-test/app')
    expect(result.stdout).toContain('labels: 0 created, 24 were there already')
    expect(result.stdout).toContain(`invited earlier, not accepted yet: ${BUILDER2}`)
    expect(result.stdout).toContain(
      `Builder Two (${BUILDER2}): accept the invitation GitHub sent, then run \`hackwin join\``,
    )
    expect((await readProtection(leadClient(fake))).state).toBe('full-restricted')
    expect(isJoinComplete(await readLocal(join(fixture.main, '.git')), LEAD)).toBe(true)

    const before = counts(fake)
    result = await runSetup(fixture, fake, { answers, args: ['--resume'] })
    expect(result.code).toBe(0)
    const join_ = await runHackwin(fixture, fake, [
      'join',
      '--answers',
      writeAnswers(fixture, JOIN_ANSWERS, 'join.yml'),
    ])
    expect(join_.stderr).toBe('')
    expect(join_.code).toBe(0)
    expect(counts(fake)).toEqual(before)
    expect(labelNames(fake).sort()).toEqual([...ALL_LABELS].sort())
    expect(fake.state.rulesets).toHaveLength(2)
    expect(fake.state.invitations).toHaveLength(1)
    expect(await fixture.git.revParse('HEAD')).toBe(head)
    expect(await originMain(fixture)).toBe(head)
    expect(await fixture.git.isClean()).toBe(true)
  })

  test('AC6: a setup interrupted during a push that lands stops after it; setup --resume completes it', async () => {
    const { fixture, fake } = await createSetupFixture()
    const marker = slowOrigin(fixture, true)
    const run = runSetup(fixture, fake, { answers: teamAnswers(3) })
    await waitFor(marker)
    // What Ctrl+C delivers to setup's handler; the git child is not signalled.
    process.emit('SIGHUP')
    const result = await run
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('setup was interrupted after its bootstrap push')
    expect(result.stderr).toContain(`run \`cd ${fixture.main} && hackwin setup --resume\``)
    const head = await fixture.git.revParse('HEAD')
    expect(await originMain(fixture)).toBe(head)
    expect(await fixture.git.isClean()).toBe(true)
    expect(writes(fake)).toEqual([])

    const resumed = await runSetup(fixture, fake, { answers: teamAnswers(3), args: ['--resume'] })
    expect(resumed.code).toBe(0)
    expect(labelNames(fake).sort()).toEqual([...ALL_LABELS].sort())
    expect((await readProtection(leadClient(fake))).state).toBe('full-restricted')
    expect(await fixture.git.revParse('HEAD')).toBe(head)
  })
})

describe('1.4f/rules: who can update the default branch, by the kind of owner', () => {
  test('1.4f/rules: on an organization repository the summary says that every admin of the repository can update main, not the Lead alone', async () => {
    const { fixture, fake } = await createSetupFixture({ ownerType: 'Organization' })
    const result = await runSetup(fixture, fake, { answers: teamAnswers(3), args: ['--json'] })
    expect(result.code).toBe(0)
    const lines = JSON.parse(result.stdout).lines.join('\n')
    expect(lines).toContain(
      `protection: full, with the update restriction: changes to main only through a pull request whose check hackwin passed, no force push and no deletion, for every account, the owner included; only the admins of hackwin-test/app can update main, ${LEAD} and any other admin of the repository, the organization's owners included, so GitHub refuses a merge by any account without admin rights`,
    )
    expect(lines).not.toContain(`only ${LEAD} can update main`)
  })

  test('1.4f/rules: on an organization repository without the update restriction, the summary names the admins', async () => {
    const { fixture, fake } = await createSetupFixture({ ownerType: 'Organization' })
    fake.on('POST repos/{owner}/{repo}/rulesets', ({ body }) => {
      if (body.rules.some((/** @type {any} */ rule) => rule.type === 'update')) {
        throw httpError(422, 'Validation Failed')
      }
      return fake.addRuleset(body)
    })
    const result = await runSetup(fixture, fake, { answers: teamAnswers(3) })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(
      'GitHub does not restrict updates of main to the admins of hackwin-test/app (GitHub answered: gh: Validation Failed (HTTP 422))',
    )
  })
})

describe('AC70/setup: GitHub accepts the rules for everyone but not the update restriction', () => {
  test('AC70/setup: setup exits 0 and reports full protection without the update restriction', async () => {
    const { fixture, fake } = await createSetupFixture()
    fake.on('POST repos/{owner}/{repo}/rulesets', ({ body }) => {
      if (body.rules.some((/** @type {any} */ rule) => rule.type === 'update')) {
        throw httpError(422, 'Validation Failed: the rule update is not available')
      }
      return fake.addRuleset(body)
    })
    const result = await runSetup(fixture, fake, { answers: teamAnswers(3), args: ['--json'] })
    expect(result.code).toBe(0)
    const json = JSON.parse(result.stdout)
    expect(json.lines).toContain(
      `protection: full, without the update restriction: changes to main only through a pull request whose check hackwin passed, no force push and no deletion, for every account, the owner included; GitHub does not restrict updates of main to ${LEAD} (GitHub answered: gh: Validation Failed: the rule update is not available (HTTP 422)), so merges by agent sessions are blocked only softly (10.6)`,
    )
    expect(json.data.protection.state).toBe('full')
    expect(fake.state.rulesets.map((ruleset) => ruleset.name)).toEqual([BRANCH_RULES])
    expect(await readProtection(leadClient(fake))).toEqual({
      state: 'full',
      rules: { ...FULL_RESTRICTED, updateRestricted: false },
    })
  })
})

describe('AC80/setup: push protection where GitHub offers it, and off where it does not', () => {
  test('AC80/setup: where GitHub offers push protection, setup enables it and the setting read back is on', async () => {
    const { fixture, fake, security } = await createSetupFixture()
    const result = await runSetup(fixture, fake, { answers: teamAnswers(3) })
    expect(result.code).toBe(0)
    const enabling = callsOf(fake, 'PATCH', /^repos\/\{owner\}\/\{repo\}$/)
    expect(enabling.map((call) => call.body)).toEqual([
      { security_and_analysis: { secret_scanning_push_protection: { status: 'enabled' } } },
    ])
    expect(security.pushProtection).toBe('enabled')
    expect(result.stdout).toContain('push protection: the setting read back from GitHub is enabled')
    expect(result.stdout).toContain('push protection: on: GitHub blocks a push')
  })

  test('AC80/setup: setup sends the enabling call even when push protection reads on, because a read may be stale', async () => {
    const { fixture, fake, security } = await createSetupFixture()
    security.pushProtection = 'enabled'
    const result = await runSetup(fixture, fake, { answers: teamAnswers(3) })
    expect(result.code).toBe(0)
    expect(callsOf(fake, 'PATCH', /^repos\/\{owner\}\/\{repo\}$/)).toHaveLength(1)
    expect(security.pushProtection).toBe('enabled')
    expect(result.stdout).toContain('push protection: on: GitHub blocks a push')
  })

  test('AC80/setup: where GitHub answers the enabling call with 200 and the setting reads back null, setup exits 0 and reports push protection as off', async () => {
    const { fixture, fake, security } = await createSetupFixture({ pushProtection: 'refused' })
    const result = await runSetup(fixture, fake, { answers: teamAnswers(3) })
    expect(result.code).toBe(0)
    expect(callsOf(fake, 'PATCH', /^repos\/\{owner\}\/\{repo\}$/)).toHaveLength(1)
    expect(security.pushProtection).toBeNull()
    expect(result.stdout).toContain(
      "push protection: off: GitHub does not offer it for hackwin-test/app, so HackWin's own secret scans (E6) run alone",
    )
  })

  test('AC80/setup: where GitHub refuses the enabling call, setup exits 0 and reports push protection as off', async () => {
    const { fixture, fake } = await createSetupFixture()
    fake.on('PATCH repos/{owner}/{repo}', () => {
      throw httpError(422, 'Secret scanning is not available for this repository.')
    })
    const result = await runSetup(fixture, fake, { answers: teamAnswers(3), args: ['--json'] })
    expect(result.code).toBe(0)
    const json = JSON.parse(result.stdout)
    expect(json.lines.join('\n')).toContain('push protection: off')
    expect(json.data.pushProtection).toMatchObject({ on: false, status: 'disabled' })
  })
})

describe('1.4f/labels: the labels of 8.2', () => {
  test('1.4f/labels: a label that exists, in any letter case, stays as it is and is not created again', async () => {
    const { fixture, fake } = await createSetupFixture()
    fake.state.labels.push(
      { name: 'Ready', color: '123456', description: "the team's own" },
      { name: 'gate:failed', color: 'abcdef', description: '' },
    )
    const result = await runSetup(fixture, fake, { answers: teamAnswers(3) })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('labels: 22 created, 2 were there already')
    const created = callsOf(fake, 'POST', /\/labels$/).map((call) => call.body.name)
    expect(created).not.toContain('ready')
    expect(created).not.toContain('gate:failed')
    expect(fake.state.labels.find((label) => label.name === 'Ready')?.color).toBe('123456')
    expect(labelNames(fake)).toHaveLength(ALL_LABELS.length)
  })
})

describe('1.4f/invitations: members without write access, after confirmation (A47)', () => {
  test('1.4f/invitations: with invite true, setup invites the member without write access, and a waiting invitation is never sent again', async () => {
    const { fixture, fake } = await createSetupFixture()
    delete fake.state.collaborators[BUILDER2]
    const result = await runSetup(fixture, fake, { answers: answersWithInvite(true) })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(`invited to hackwin-test/app: ${BUILDER2}`)
    const invited = callsOf(fake, 'PUT', /\/collaborators\//)
    expect(invited.map((call) => call.endpoint)).toEqual([
      `repos/{owner}/{repo}/collaborators/${BUILDER2}`,
    ])
    expect(fake.state.invitations.map((invitation) => invitation.login)).toEqual([BUILDER2])
  })

  test('1.4f/invitations: with invite false or no answer outside a terminal, setup invites nobody and says how to give write access', async () => {
    for (const invite of [false, undefined]) {
      const { fixture, fake } = await createSetupFixture()
      delete fake.state.collaborators[BUILDER2]
      const result = await runSetup(fixture, fake, { answers: answersWithInvite(invite) })
      expect(result.code, String(invite)).toBe(0)
      expect(callsOf(fake, 'PUT', /\/collaborators\//), String(invite)).toEqual([])
      expect(result.stdout).toContain(`not invited, without write access: ${BUILDER2}`)
      expect(result.stdout).toContain(
        `Builder Two (${BUILDER2}): needs write access to hackwin-test/app first: give them write access on GitHub (Settings, Collaborators), or run \`cd ${fixture.main} && hackwin setup --resume\` and answer yes to the invitation`,
      )
    }
  })

  test('1.4f/invitations: in a terminal, setup says what it is about to do and invites only after a typed yes', async () => {
    for (const [typed, invites] of [
      ['yes', true],
      ['y', false],
      ['', false],
    ]) {
      const { fixture, fake } = await createSetupFixture()
      delete fake.state.collaborators[BUILDER2]
      const result = await runSetup(fixture, fake, {
        answers: answersWithInvite(undefined),
        tty: true,
        input: [String(typed)],
      })
      expect(result.code, String(typed)).toBe(0)
      expect(result.stdout).toContain(
        `setup can invite ${BUILDER2} (Builder Two) to hackwin-test/app with write access; GitHub sends each an invitation to accept`,
      )
      expect(result.stdout).toContain('Type yes to invite them, or no [no]: ')
      expect(fake.state.invitations.length, String(typed)).toBe(invites ? 1 : 0)
    }
  })

  test('1.4f/invitations: where GitHub refuses an invitation, setup continues and says to invite by hand', async () => {
    const { fixture, fake } = await createSetupFixture()
    delete fake.state.collaborators[BUILDER2]
    fake.on('PUT repos/{owner}/{repo}/collaborators/:login', () => {
      throw httpError(422, 'Validation Failed')
    })
    const result = await runSetup(fixture, fake, { answers: answersWithInvite(true) })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(`GitHub refused the invitation of ${BUILDER2}:`)
    expect(result.stdout).toContain(
      `Builder Two (${BUILDER2}): needs write access to hackwin-test/app first: give them write access on GitHub`,
    )
  })

  test('1.4f/invitations: an invite answer that is not true or false exits 2 before setup changes anything', async () => {
    const { fixture, fake } = await createSetupFixture()
    const head = await fixture.git.revParse('HEAD')
    const result = await runSetup(fixture, fake, {
      answers: teamAnswers(3, (a) => (a.invite = 'maybe')),
    })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('invite must be true or false')
    expect(await originMain(fixture)).toBe(head)
    expect(writes(fake)).toEqual([])
  })
})

describe('1.4f/rules: the branch rules and their read back', () => {
  test('1.4f/rules: where GitHub refuses the pinned check, the rules for everyone require it unpinned and the summary says so; setup --resume pins it once GitHub accepts the pin', async () => {
    const { fixture, fake } = await createSetupFixture()
    const pinned = (/** @type {any} */ body) =>
      body.rules.some((/** @type {any} */ rule) =>
        (rule.parameters?.required_status_checks ?? []).some(
          (/** @type {any} */ check) => check.integration_id !== undefined,
        ),
      )
    const refusing = fake.on('POST repos/{owner}/{repo}/rulesets', ({ body }) => {
      if (pinned(body)) throw httpError(422, 'Validation Failed: integration_id is not valid')
      return fake.addRuleset(body)
    })
    let result = await runSetup(fixture, fake, { answers: teamAnswers(3) })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(
      `the required check hackwin is not pinned to the GitHub Actions app (GitHub answered: gh: Validation Failed: integration_id is not valid (HTTP 422)): a status that anyone with write access posts by hand can satisfy it. Once GitHub Actions has run in hackwin-test/app, run \`cd ${fixture.main} && hackwin setup --resume\` to pin it`,
    )
    let protection = await readProtection(leadClient(fake))
    expect(protection.state).toBe('full-restricted')
    expect(protection.rules.requiredChecks).toEqual([
      { context: REQUIRED_CHECK, integrationId: null },
    ])

    refusing()
    result = await runSetup(fixture, fake, { answers: teamAnswers(3), args: ['--resume'] })
    expect(result.code).toBe(0)
    expect(result.stdout).not.toContain('not pinned')
    protection = await readProtection(leadClient(fake))
    expect(protection.rules.checkPinned).toBe(true)
    expect(fake.state.rulesets).toHaveLength(2)
  })

  test('1.4f/rules: where GitHub refuses the rules for everyone, setup reports soft protection and creates no update restriction', async () => {
    const { fixture, fake } = await createSetupFixture()
    fake.on('POST repos/{owner}/{repo}/rulesets', () => {
      throw httpError(422, 'Validation Failed')
    })
    const result = await runSetup(fixture, fake, { answers: teamAnswers(3) })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(
      'protection: soft: GitHub refused the branch rules (GitHub answered: gh: Validation Failed (HTTP 422))',
    )
    expect(callsOf(fake, 'POST', /\/rulesets$/)).toEqual([])
    expect(
      fake.calls.filter(
        (call) => call.method === 'POST' && /\/rulesets$/.test(call.endpoint ?? ''),
      ),
    ).toHaveLength(2)
  })

  test('1.4f/rules: rule sets of setup that exist already are updated in place, never created again', async () => {
    const { fixture, fake } = await createSetupFixture()
    const own = fake.addRuleset({ name: BRANCH_RULES, enforcement: 'disabled', rules: [] })
    const result = await runSetup(fixture, fake, { answers: teamAnswers(3) })
    expect(result.code).toBe(0)
    expect(fake.state.rulesets.filter((ruleset) => ruleset.name === BRANCH_RULES)).toHaveLength(1)
    expect(callsOf(fake, 'PUT', new RegExp(`/rulesets/${own.id}$`))).toHaveLength(1)
    expect((await readProtection(leadClient(fake))).state).toBe('full-restricted')
  })
})

describe('1.4f/resume: setup --resume runs only where the bootstrap push happened, for the Lead', () => {
  test('1.4f/resume: after a setup that put its files back although its push landed, setup --resume first brings main up to origin', async () => {
    const { fixture, fake } = await createSetupFixture()
    let result = await runSetup(fixture, fake, { answers: teamAnswers(3) })
    expect(result.code).toBe(0)
    const bootstrapCommit = await originMain(fixture)
    // What such a setup leaves: origin holds the commit, the checkout is as it was, and clean.
    await fixture.git.run(['reset', '--quiet', '--hard', 'HEAD~1'])
    expect(await fixture.git.isClean()).toBe(true)
    result = await runSetup(fixture, fake, { answers: teamAnswers(3), args: ['--resume'] })
    expect(result.stderr).not.toContain('hackwin setup:')
    expect(result.code).toBe(0)
    expect(await fixture.git.revParse('HEAD')).toBe(bootstrapCommit)
    expect(result.stdout).toContain('pass  hooks: core.hooksPath is .githooks')
  })

  test('1.4f/resume: a main checkout behind origin that cannot be fast-forwarded is refused before anything changes on GitHub', async () => {
    const { fixture, fake } = await createSetupFixture()
    expect((await runSetup(fixture, fake, { answers: teamAnswers(3) })).code).toBe(0)
    await fixture.git.run(['reset', '--quiet', '--hard', 'HEAD~1'])
    writeFileSync(join(fixture.main, 'README.md'), '# Changed here\n')
    const before = writes(fake).length
    const result = await runSetup(fixture, fake, { answers: teamAnswers(3), args: ['--resume'] })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain(
      'the main checkout does not hold origin/main, which holds the bootstrap commit of setup',
    )
    expect(result.stderr).toContain(
      `run \`cd ${fixture.main} && git switch main && git merge --ff-only origin/main\`, then run \`cd ${fixture.main} && hackwin setup --resume\``,
    )
    expect(writes(fake)).toHaveLength(before)
  })

  test('1.4f/resume: on a repository without hackwin.yml on origin there is nothing to resume', async () => {
    const { fixture, fake } = await createSetupFixture()
    const result = await runSetup(fixture, fake, { args: ['--resume'] })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('there is nothing to resume')
    expect(result.stderr).toContain(`run \`cd ${fixture.main} && hackwin setup\``)
    expect(writes(fake)).toEqual([])
  })

  test('1.4f/resume: a member who is not the Lead, or a task worktree, exits 2 and changes nothing', async () => {
    const team = teamConfig(3)
    const { fixture, fake } = await createSetupFixture({
      config: { hackwin: team.hackwin, owners: team.owners },
    })
    let result = await runSetup(fixture, fake, { args: ['--resume'], login: BUILDER1 })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain(
      `setup --resume is run by the Lead, ${LEAD}, but gh is logged in as ${BUILDER1}`,
    )
    const task = await fixture.worktree({ issue: 7 })
    result = await runSetup(fixture, fake, { args: ['--resume'], cwd: task.path })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain(`run \`cd ${fixture.main} && hackwin setup --resume\``)
    expect(writes(fake)).toEqual([])
  })
})

describe('1.4f/settle: setup does not trust one read right after it writes a setting', () => {
  test('1.4f/settle: the read back settles on the value that holds, not on the first read or on a stale one', async () => {
    // The reads after `enabled` on hackwin-fixture-a, 15 October 2026: the new value from 0 to
    // 2.3 s, the old one from 2.7 to 9.8 s, the new one from 10.2 s on (settle.js).
    const clock = createFakeClock('2026-10-15T05:50:06.772Z')
    const since = clock.now().getTime()
    /** @type {string[]} */
    const seen = []
    const read = async () => {
      const at = clock.now().getTime() - since
      const value = at < 2_500 || at >= 10_000 ? 'enabled' : 'disabled'
      seen.push(value)
      return value
    }
    const result = await settledRead(clock, read, { since, what: 'the setting' })
    expect(result).toMatchObject({ value: 'enabled', settled: true, changes: 2 })
    expect(seen).toContain('disabled')
    expect(clock.now().getTime() - since).toBeGreaterThanOrEqual(SETTLE.minMs)

    // The same reads, old and new swapped: a value that only looked new at first is not taken.
    const swapped = createFakeClock('2026-10-15T05:49:45.566Z')
    const start = swapped.now().getTime()
    const stale = await settledRead(
      swapped,
      async () => {
        const at = swapped.now().getTime() - start
        return at >= 2_500 && at < 4_500 ? 'enabled' : 'disabled'
      },
      { since: start, what: 'the setting' },
    )
    expect(stale).toMatchObject({ value: 'disabled', settled: true, changes: 2 })
  })

  test('1.4f/settle: push protection that reads back the old value for a while after the enabling call is reported as on', async () => {
    const { fixture, fake, security } = await createSetupFixture()
    security.afterPatch = ['enabled', 'enabled', ...Array(8).fill('disabled')]
    const result = await runSetup(fixture, fake, { answers: teamAnswers(3), args: ['--json'] })
    expect(result.code).toBe(0)
    const json = JSON.parse(result.stdout)
    expect(json.lines).toContain(
      "push protection: on: GitHub blocks a push that holds a secret it recognizes, and HackWin's own secret scans run as well",
    )
    expect(json.data.pushProtection).toMatchObject({ on: true, settled: true })
    expect(json.data.pushProtection.reads).toBeGreaterThan(10)
  })

  test('1.4f/settle: rule sets that GitHub does not report for a while after setup created them are read back as full-restricted', async () => {
    const { fixture, fake } = await createSetupFixture()
    let stale = 0
    const off = fake.on('GET repos/{owner}/{repo}/rules/branches/:branch*', () => {
      stale += 1
      if (stale === 6) off()
      return []
    })
    const result = await runSetup(fixture, fake, { answers: teamAnswers(3), args: ['--json'] })
    expect(result.code).toBe(0)
    expect(stale).toBe(6)
    const json = JSON.parse(result.stdout)
    expect(json.data.protection).toMatchObject({ state: 'full-restricted', settled: true })
    expect(json.lines.join('\n')).toContain('protection: full, with the update restriction')
  })

  test('1.4f/settle: a setting whose reads never settle is reported with the last read and a note to read it again', async () => {
    const { fixture, fake, security } = await createSetupFixture()
    security.afterPatch = Array.from({ length: 200 }, (_, index) =>
      index % 2 === 0 ? 'enabled' : 'disabled',
    )
    const result = await runSetup(fixture, fake, { answers: teamAnswers(3), args: ['--json'] })
    expect(result.code).toBe(0)
    const json = JSON.parse(result.stdout)
    expect(json.data.pushProtection.settled).toBe(false)
    expect(json.lines.join('\n')).toMatch(
      new RegExp(
        `the push protection setting read back from GitHub changed \\d+ times in 60 s, and the line above shows the last read; GitHub may hold another value\\. To read it again later, run \`cd ${fixture.main.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} && hackwin setup --resume\``,
      ),
    )
  })
})

/** The error of a read that GitHub did not answer, as the GitHub client throws it. */
function timedOut() {
  return new RemoteError(
    'GitHub call failed: gh api --method GET repos/{owner}/{repo}: dial tcp 140.82.121.6:443: i/o timeout',
    { tail: ['dial tcp 140.82.121.6:443: i/o timeout'] },
  )
}

describe('1.4f/settle: a read back survives a failure that may pass, and only that', () => {
  test('1.4f/settle: a read that times out in the middle of settling is a missed sample, and the wait settles after it', async () => {
    const clock = createFakeClock()
    const since = clock.now().getTime()
    let calls = 0
    /** @type {number | null} */
    let failedAt = null
    const result = await settledRead(
      clock,
      async () => {
        calls += 1
        if (calls === 12) {
          failedAt = clock.now().getTime() - since
          throw timedOut()
        }
        return 'enabled'
      },
      { since, what: 'the push protection setting' },
    )
    expect(result).toMatchObject({ value: 'enabled', settled: true, failures: 1, changes: 0 })
    // The reads before the failure no longer count: 5 s of agreeing reads after it.
    expect(clock.now().getTime() - since).toBeGreaterThanOrEqual(
      Number(failedAt) + SETTLE.intervalMs + SETTLE.stableMs,
    )
  })

  test('1.4f/settle: reads that fail until the budget runs out end with exit 3 and the last failure, within the budget', async () => {
    const clock = createFakeClock()
    const since = clock.now().getTime()
    const run = settledRead(
      clock,
      async () => {
        throw timedOut()
      },
      { since, what: 'the push protection setting' },
    )
    await expect(run).rejects.toThrow(RemoteError)
    await expect(run).rejects.toMatchObject({ exitCode: 3 })
    await expect(run).rejects.toThrow(
      /^setup could not read back the push protection setting steadily within 60 s: \d+ reads failed, the last with: GitHub call failed: .*i\/o timeout$/,
    )
    const elapsed = clock.now().getTime() - since
    expect(elapsed).toBeGreaterThanOrEqual(SETTLE.maxMs)
    expect(elapsed).toBeLessThan(SETTLE.maxMs + SETTLE.intervalMs)
  })

  test('1.4f/settle: a refusal ends the wait at once, and a read running beside it stops at its next read', async () => {
    const clock = createFakeClock()
    const since = clock.now().getTime()
    const refusal = new RemoteError('GitHub call failed: Resource not accessible', { status: 403 })
    let refused = 0
    await expect(
      settledRead(
        clock,
        async () => {
          refused += 1
          throw refusal
        },
        { since, what: 'the branch rules' },
      ),
    ).rejects.toBe(refusal)
    expect(refused).toBe(1)
    expect(clock.now().getTime()).toBe(since)

    /** @type {import('../../../src/commands/setup/settle.js').Stop} */
    const stop = {}
    let other = 0
    let failing = 0
    const results = await Promise.allSettled([
      settledRead(
        clock,
        async () => {
          failing += 1
          if (failing === 3) throw refusal
          return 'full'
        },
        { since, what: 'the branch rules', stop },
      ),
      settledRead(
        clock,
        async () => {
          other += 1
          return 'enabled'
        },
        { since, what: 'the push protection setting', stop },
      ),
    ])
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected'])
    expect(stop.error).toBe(refusal)
    expect(other).toBeLessThanOrEqual(failing)
  })

  test('1.4f/settle: a network timeout during the read back of setup does not end setup', async () => {
    const { fixture, fake, security } = await createSetupFixture()
    security.afterPatch = ['enabled', 'enabled', '!timeout', 'enabled']
    const result = await runSetup(fixture, fake, { answers: teamAnswers(3), args: ['--json'] })
    expect(result.code).toBe(0)
    const json = JSON.parse(result.stdout)
    expect(json.data.pushProtection).toMatchObject({ on: true, settled: true, failures: 1 })
    expect(json.data.protection).toMatchObject({ state: 'full-restricted', settled: true })
  })

  test('1.4f/settle: network failures until the budget runs out end setup with exit 3, the last failure and the resume hint', async () => {
    const { fixture, fake, security } = await createSetupFixture()
    security.afterPatch = Array(200).fill('!timeout')
    const result = await runSetup(fixture, fake, { answers: teamAnswers(3) })
    expect(result.code).toBe(3)
    expect(result.stderr).toMatch(
      /hackwin setup: setup could not read back the push protection setting steadily within 60 s: \d+ reads failed, the last with: GitHub call failed: .*i\/o timeout/,
    )
    expect(result.stderr).toContain(`run \`cd ${fixture.main} && hackwin setup --resume\``)
  })

  test('1.4f/settle: a refusal during the read back of setup ends it at once, and the other read stops', async () => {
    const { fixture, fake } = await createSetupFixture()
    fake.on('GET repos/{owner}/{repo}/rules/branches/:branch*', () => {
      throw httpError(403, 'Resource not accessible by integration')
    })
    const result = await runSetup(fixture, fake, { answers: teamAnswers(3) })
    expect(result.code).toBe(3)
    expect(result.stderr).toContain('Resource not accessible by integration')
    expect(result.stderr).toContain(`run \`cd ${fixture.main} && hackwin setup --resume\``)
    const patchAt = fake.calls.findIndex(
      (call) => call.method === 'PATCH' && call.endpoint === 'repos/{owner}/{repo}',
    )
    const reads = fake.calls
      .slice(patchAt + 1)
      .filter((call) => call.method === 'GET' && call.endpoint === 'repos/{owner}/{repo}')
    const rulesReads = fake.calls.filter((call) => /\/rules\/branches\//.test(call.endpoint ?? ''))
    expect(rulesReads).toHaveLength(1)
    expect(reads.length).toBeLessThanOrEqual(1)
  })
})

// What setup asks and tells in words of the team (task 1.4m): one plain sentence before each block
// of questions, the sessions question in tasks at the same time, the stack commands, the smoke test
// and the path groups as one block, event times as YYYY-MM-DD HH:MM in the machine's time zone, a
// message per member to paste into a chat, and next steps for the Lead.

import { describe, expect, test } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPOSITORY_URL, VERSION } from '../../../src/cli/context.js'
import { installCommand, loadConfig } from '../../../src/core/config/index.js'
import { JOIN_INTRO } from '../../../src/commands/setup/finish.js'
import { ROLES_INTRO } from '../../../src/commands/setup/ownership.js'
import { PROJECT_INTRO, eventTime } from '../../../src/commands/setup/project.js'
import { STACK_INTRO } from '../../../src/commands/setup/stack.js'
import { TEAM_INTRO } from '../../../src/commands/setup/team.js'
import { renderHackwinConfig } from '../../../src/generate/index.js'
import { accounts, hackwinObject } from '../../harness/index.js'
import {
  EVENT,
  LEAD,
  createSetupFixture,
  runSetup,
  teamAnswers,
  toolsEnv,
  writes,
} from './setup-fixture.js'

const BUILDER1 = accounts.builder1.login
const BUILDER2 = accounts.builder2.login

/** The time zone of the tests that type event times: CEST until 25 October 2026, then CET. */
const ZONE = 'Europe/Warsaw'

/**
 * Run with the time zone of this machine set to `zone`, as TZ sets it, and put it back after.
 * @template T
 * @param {string} zone
 * @param {() => Promise<T>} run
 * @returns {Promise<T>}
 */
async function inTimeZone(zone, run) {
  const before = process.env.TZ
  process.env.TZ = zone
  try {
    return await run()
  } finally {
    if (before === undefined) delete process.env.TZ
    else process.env.TZ = before
  }
}

/**
 * The terminal answers of a solo team on the Node fixture up to the stack block, which the test
 * answers, and after it.
 * @param {string[]} stack The answers of the stack block.
 * @param {string[]} [times] The event start and end.
 */
function soloInput(stack, times = [EVENT.start, EVENT.end]) {
  return [
    '1', // people
    '', // the Lead's login: the gh login
    'Solo', // the Lead's name
    '', // agent: claude
    '', // tasks at the same time: 2
    '', // keep the roles of owners.yml
    '', // the Lead holds every role
    ...stack,
    ...times,
    '', // project language: en
    '', // answer language of join: the project language
    '', // explanation style of join: concise
  ]
}

/** The stack block that setup shows for the Node fixture, with the question after it. */
const STACK_BLOCK = [
  STACK_INTRO,
  'Commands, detected from package.json and package-lock.json (npm):',
  '  install the dependencies: npm ci',
  '  full check: npm run check',
  '  run the tests a task names: npm test --',
  '  format files: npm run format --',
  '  rebuild generated files: none',
  '  rebuild the lockfile: npm install --package-lock-only',
  '  smoke test after each merge: none',
  'Files that only the Lead changes; other kinds can be added later through a pull request:',
  '  dependency files: package.json',
  '  lockfiles: package-lock.json',
  '  database migrations: none',
  '  production config: none',
  'Keep all of these? Type yes, or edit [yes]: ',
].join('\n')

/**
 * @param {string} text
 * @param {string} part
 */
const count = (text, part) => text.split(part).length - 1

describe('1.4m/questions: each block of setup questions says what it decides, in words of the team', () => {
  test('1.4m/questions: in a terminal, each block starts with one plain sentence, and the questions use no words of the tool', async () => {
    const { fixture, fake } = await createSetupFixture()
    // builder1 has no write access yet, so that setup asks about the invitation too.
    delete fake.state.collaborators[BUILDER1]
    const input = [
      '2', // people
      '', // the Lead's login: the gh login
      'Lead', // the Lead's name
      '', // agent: claude
      '', // tasks at the same time: 2
      BUILDER1,
      'Builder One',
      '', // agent: claude
      '', // tasks at the same time: 2
      '', // keep the roles of owners.yml
      '', // the Lead's roles: the proposal
      '', // builder1's roles: the proposal
      '', // keep the commands, the smoke test and the path groups
      EVENT.start,
      EVENT.end,
      '', // project language: en
      '', // no invitation
      '', // answer language of join: the project language
      '', // explanation style of join: concise
    ]
    const result = await inTimeZone(ZONE, () => runSetup(fixture, fake, { tty: true, input }))
    expect(result.stderr).not.toContain('hackwin setup:')
    expect(result.code).toBe(0)
    const { stdout } = result

    for (const intro of [TEAM_INTRO, ROLES_INTRO, STACK_INTRO, PROJECT_INTRO, JOIN_INTRO]) {
      expect(intro, 'one sentence').toMatch(/^[A-Z][^.]*\.$/)
      expect(count(stdout, intro), intro).toBe(1)
    }
    expect(stdout).toContain(`${TEAM_INTRO}\nHow many people are in the team, 1 to 4: `)
    expect(stdout).toContain(
      `${ROLES_INTRO}\nOwnership roles, from owners.yml; <folder>/** is a folder and everything in it:\n`,
    )
    expect(stdout).toContain(
      'Keep these roles? Type yes, or edit [yes]: Who holds which role: every role has exactly one holder, the member whose tasks may change its folders, and shared goes to the Lead.\nRoles of Lead',
    )
    expect(stdout).toContain(STACK_BLOCK)
    expect(stdout).toContain(
      `${PROJECT_INTRO}\nEvent start, the hour the event begins, as YYYY-MM-DD HH:MM in ${ZONE}, such as 2026-10-24 09:00: `,
    )
    expect(stdout).toContain(
      `setup can invite ${BUILDER1} (Builder One) to hackwin-test/app with write access; GitHub sends each an invitation to accept\nType yes to invite them, or no [no]: `,
    )
    expect(stdout).toContain(`${JOIN_INTRO}\nAnswer language of your agent sessions [`)

    const questions = stdout.slice(0, stdout.indexOf('bootstrap commit'))
    expect(questions).not.toMatch(/\bglobs?\b|path groups?|manifests?|lockfile_regen/i)
    expect(questions).not.toContain('Agent sessions')
  })

  test('1.4m/questions: the sessions question asks how many tasks a person can run at the same time, with the choices and the stored value of before', async () => {
    const { fixture, fake } = await createSetupFixture()
    const input = soloInput([''])
    input.splice(4, 1, '4', '3') // tasks at the same time: 4 is refused, then 3
    const result = await runSetup(fixture, fake, { tty: true, input })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(
      'How many tasks can Solo run at the same time, one agent session each: 1 or 2, or 3 as an advanced option [2]: ',
    )
    expect(result.stdout).toContain('  answer 1, 2 or 3\n')
    expect(result.stderr).toContain(`${LEAD} runs 3 agent sessions, an advanced option`)
    const { hackwin } = await loadConfig(fixture.git)
    expect(hackwin.team.members[0].sessions).toBe(3)
  })

  test('1.4m/questions: setup shows the detected commands, the smoke test and the path groups as one block and asks once to keep all of them', async () => {
    const { fixture, fake } = await createSetupFixture()
    const result = await runSetup(fixture, fake, { tty: true, input: soloInput(['']) })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(STACK_BLOCK)
    expect(count(result.stdout, 'Keep all of these?')).toBe(1)
    expect(result.stdout).not.toContain('Smoke test')
    expect(result.stdout).not.toContain('Keep these commands')
    const { hackwin } = await loadConfig(fixture.git)
    expect(hackwin.commands).toEqual(hackwinObject(1).commands)
    expect(hackwin.paths).toEqual({ ...hackwinObject(1).paths, contracts: [] })
  })

  test('1.4m/questions: an edit that changes one of them changes only that one', async () => {
    const { fixture, fake } = await createSetupFixture()
    const stack = [
      'edit',
      '', // install
      '', // check
      '', // test
      '', // format
      '', // generate: none
      '', // lockfile
      'npm run smoke', // the smoke test, the only change
      '', // dependency files
      '', // lockfiles
      '', // database migrations: none
      '', // production config: none
    ]
    const result = await runSetup(fixture, fake, { tty: true, input: soloInput(stack) })
    expect(result.stderr).not.toContain('hackwin setup:')
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(
      `${STACK_BLOCK}Type a new value, or press Enter to keep the one in brackets.\nInstall the dependencies [npm ci]: Full check [npm run check]: `,
    )
    expect(result.stdout).toContain(
      'Smoke test after each merge, or none [none]: Dependency files, paths separated by commas, at least the one of the planned stack, such as package.json [package.json]: Lockfiles, paths separated by commas, or none [package-lock.json]: ',
    )
    const { hackwin } = await loadConfig(fixture.git)
    expect(hackwin.commands).toEqual({ ...hackwinObject(1).commands, smoke: 'npm run smoke' })
    expect(hackwin.paths).toEqual({ ...hackwinObject(1).paths, contracts: [] })
  })

  test('1.4m/questions: where setup detects no command, it names the missing ones and goes through every value', async () => {
    const { fixture, fake } = await createSetupFixture({
      nodeProject: false,
      files: { 'README.md': '# App\n', 'app/main.py': '' },
    })
    const stack = [
      'pip install -r requirements.txt',
      'make check',
      'pytest',
      'black',
      '', // generate: none
      'pip-compile',
      '', // smoke test: none
      'requirements.in',
      'requirements.txt',
      '', // database migrations: none
      '', // production config: none
    ]
    const result = await runSetup(fixture, fake, { tty: true, input: soloInput(stack) })
    expect(result.stderr).not.toContain('hackwin setup:')
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(
      [
        'Commands, none detected: this is not a Node project:',
        '  install the dependencies: none',
      ].join('\n'),
    )
    expect(result.stdout).toContain(
      '  production config: none\nRequired and missing: install the dependencies, full check, run the tests a task names, format files, rebuild the lockfile, dependency files.\nType a new value, or press Enter to keep the one in brackets.\nInstall the dependencies: ',
    )
    expect(result.stdout).not.toContain('Keep all of these?')
    const { hackwin } = await loadConfig(fixture.git)
    expect(hackwin.commands).toEqual({
      install: 'pip install -r requirements.txt',
      check: 'make check',
      test: 'pytest',
      format: 'black',
      generate: null,
      lockfile_regen: 'pip-compile',
      smoke: null,
    })
    expect(hackwin.paths.manifests).toEqual(['requirements.in'])
    expect(hackwin.paths.lockfiles).toEqual(['requirements.txt'])
  })

  test('1.4m/questions: an answers file of today gives the same hackwin.yml as before', async () => {
    for (const size of /** @type {const} */ ([1, 3, 4])) {
      const { fixture, fake } = await createSetupFixture()
      const result = await runSetup(fixture, fake, { answers: teamAnswers(size) })
      expect(result.code, String(size)).toBe(0)
      const { stdout } = await fixture.git.run(['show', 'origin/main:hackwin.yml'])
      expect(stdout, String(size)).toBe(renderHackwinConfig(hackwinObject(size)))
    }
  })
})

describe('1.4m/times: event times as YYYY-MM-DD HH:MM in the time zone of the machine', () => {
  test('1.4m/times: typed in a terminal, they are read in the time zone of this machine, stored with their offset and echoed', async () => {
    const { fixture, fake } = await createSetupFixture()
    // The clocks of Europe/Warsaw go back on 25 October 2026 at 03:00: the offsets differ.
    const input = soloInput([''], ['2026-10-24 09:00', '2026-10-25 15:00'])
    const result = await inTimeZone(ZONE, () => runSetup(fixture, fake, { tty: true, input }))
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('  Event start: 2026-10-24T09:00:00+02:00, in Europe/Warsaw\n')
    expect(result.stdout).toContain('  Event end: 2026-10-25T15:00:00+01:00, in Europe/Warsaw\n')
    expect(result.stdout).toContain(
      'project: event from 2026-10-24T09:00:00+02:00 to 2026-10-25T15:00:00+01:00',
    )
    const { hackwin } = await loadConfig(fixture.git)
    expect(hackwin.project.event).toEqual({
      start: '2026-10-24T09:00:00+02:00',
      end: '2026-10-25T15:00:00+01:00',
    })
  })

  test('1.4m/times: in the answers file too; the ISO form is stored as it is', async () => {
    const { fixture, fake } = await createSetupFixture()
    const answers = teamAnswers(3, (a) => {
      a.project.event = { start: '2026-10-24 9:00', end: '2026-10-25T15:00:00+02:00' }
    })
    const result = await inTimeZone('America/New_York', () => runSetup(fixture, fake, { answers }))
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(
      '  Event start: 2026-10-24T09:00:00-04:00, in America/New_York\n',
    )
    expect(result.stdout).not.toContain('  Event end:')
    const { hackwin } = await loadConfig(fixture.git)
    expect(hackwin.project.event).toEqual({
      start: '2026-10-24T09:00:00-04:00',
      end: '2026-10-25T15:00:00+02:00',
    })
  })

  test('1.4m/times: the ISO form keeps working in a terminal, and a value in neither form is refused and asked again', async () => {
    const { fixture, fake } = await createSetupFixture()
    const input = soloInput([''], ['tomorrow', '2026-03-29 02:30', EVENT.start, EVENT.end])
    const result = await inTimeZone(ZONE, () => runSetup(fixture, fake, { tty: true, input }))
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(
      '  must be a date and time as YYYY-MM-DD HH:MM, such as 2026-10-24 09:00, or an ISO 8601 time with an offset, such as 2026-10-24T09:00:00+02:00\n',
    )
    expect(result.stdout).toContain(
      '  is a time that the clock of this machine skips in Europe/Warsaw, such as an hour lost to daylight saving time\n',
    )
    const { hackwin } = await loadConfig(fixture.git)
    expect(hackwin.project.event).toEqual(EVENT)
  })

  test('1.4m/times: a value in neither form in the answers file exits 2, names the key and changes nothing', async () => {
    for (const value of ['24.10.2026 09:00', '2026-02-30 09:00', '2026-10-24 24:00']) {
      const { fixture, fake } = await createSetupFixture()
      const head = await fixture.git.revParse('HEAD')
      const answers = teamAnswers(3, (a) => (a.project.event.start = value))
      const result = await runSetup(fixture, fake, { answers })
      expect(result.code, value).toBe(2)
      expect(result.stderr).toContain(
        'project.event.start must be a date and time as YYYY-MM-DD HH:MM, such as 2026-10-24 09:00, or an ISO 8601 time with an offset',
      )
      expect(result.stderr).toContain('key: project.event.start')
      expect(await fixture.git.revParse('HEAD')).toBe(head)
      expect(writes(fake)).toEqual([])
    }
  })

  test('1.4m/times: eventTime reads a date and an hour in the time zone of this machine', async () => {
    await inTimeZone('Asia/Kolkata', async () => {
      expect(eventTime('2026-10-24 09:00')).toBe('2026-10-24T09:00:00+05:30')
      expect(eventTime('2026-10-24  9:05')).toBe('2026-10-24T09:05:00+05:30')
    })
    await inTimeZone('UTC', async () => {
      expect(eventTime('2026-10-24 09:00')).toBe('2026-10-24T09:00:00+00:00')
    })
    expect(eventTime('2026-10-24T09:00:00Z')).toBe('2026-10-24T09:00:00Z')
    expect(eventTime('2026-10-24T09:00')).toBeNull()
    expect(eventTime('2026-13-01 09:00')).toBeNull()
  })
})

/**
 * The message of a member, indented as the summary prints it.
 * @param {string} name
 * @param {boolean} invited
 */
function message(name, invited) {
  const steps = [
    ...(invited
      ? [
          'Accept the invitation to hackwin-test/app that GitHub sent you: https://github.com/hackwin-test/app/invitations',
        ]
      : []),
    `Install HackWin ${VERSION}, the version of the team:\n       ${installCommand(VERSION, REPOSITORY_URL)}`,
    'Clone the repository, in the folder where you keep your projects:\n       git clone https://github.com/hackwin-test/app',
    'Go into the clone and join the team:\n       cd app && hackwin join',
  ]
  return [
    `    ${name}, you are in our HackWin team for hackwin-test/app. To start:`,
    ...steps.map((step, index) => `    ${index + 1}. ${step}`),
  ].join('\n')
}

describe('1.4m/members: the summary prints a message to paste into a chat for each member', () => {
  test('1.4m/members: a member with write access gets install, clone and join; an invited member also the invitation; the Lead none', async () => {
    const { fixture, fake } = await createSetupFixture()
    delete fake.state.collaborators[BUILDER1]
    const answers = teamAnswers(3, (a) => {
      a.invite = true
    })
    const result = await runSetup(fixture, fake, { answers, args: ['--json'] })
    expect(result.code).toBe(0)
    const lines = JSON.parse(result.stdout).lines.join('\n')
    expect(lines).toContain(
      [
        `  Lead (${LEAD}): joined on this machine`,
        `  Builder One (${BUILDER1}): GitHub sent them an invitation; send them this message:`,
        message('Builder One', true),
        `  Builder Two (${BUILDER2}): send them this message:`,
        message('Builder Two', false),
        'next steps for you, the Lead:',
      ].join('\n'),
    )
    expect(lines).not.toContain('Lead, you are in our HackWin team')
  })

  test('1.4m/members: a member without write access is still told to get it first, and their message has no invitation', async () => {
    const { fixture, fake } = await createSetupFixture()
    delete fake.state.collaborators[BUILDER1]
    const result = await runSetup(fixture, fake, { answers: teamAnswers(3), args: ['--json'] })
    expect(result.code).toBe(0)
    const lines = JSON.parse(result.stdout).lines.join('\n')
    expect(lines).toContain(
      [
        `  Builder One (${BUILDER1}): needs write access to hackwin-test/app first: give them write access on GitHub (Settings, Collaborators), or run \`cd ${fixture.main} && hackwin setup --resume\` and answer yes to the invitation; then send them this message:`,
        message('Builder One', false),
      ].join('\n'),
    )
  })

  test('1.4m/members: when join fails on the Lead machine, the Lead line still says so', async () => {
    const { fixture, fake } = await createSetupFixture()
    const env = toolsEnv(fixture)
    // The install of join fails on this machine.
    writeFileSync(join(fixture.dir, 'bin', 'npm'), '#!/bin/sh\nexit 1\n')
    const result = await runSetup(fixture, fake, { answers: teamAnswers(3), env })
    expect(result.code).toBe(1)
    expect(result.stdout).toContain(`setup of hackwin-test/app is complete except for join`)
    expect(result.stdout).toContain(
      `  Lead (${LEAD}): join on this machine is not complete; fix the failed checks above, then run \`cd ${fixture.main} && hackwin join\`\n`,
    )
    expect(result.stdout).toContain(`  Builder One (${BUILDER1}): send them this message:\n`)
  })
})

describe('1.4m/next: the next steps of the Lead at the end of setup', () => {
  test('1.4m/next: the Gate as a line to paste, the first tasks, take with no number and the guide; the summary keeps what step 15 names', async () => {
    const { fixture, fake } = await createSetupFixture()
    const result = await runSetup(fixture, fake, { answers: teamAnswers(3), args: ['--json'] })
    expect(result.code).toBe(0)
    const { lines } = JSON.parse(result.stdout)
    const main = fixture.main
    expect(lines.slice(lines.indexOf('next steps for you, the Lead:'))).toEqual([
      'next steps for you, the Lead:',
      `  1. start the Gate in a terminal of its own and leave it open: run \`cd ${main} && hackwin gate\``,
      `  2. write the first tasks as issues from the template "HackWin task" (.github/ISSUE_TEMPLATE/hackwin-task.md), or ask your planning session, the Claude Code session in ${main}, to write them from that template`,
      `  3. take a task: run \`cd ${main} && hackwin take\`; with no number, take picks the next task of your queue`,
      '  4. read docs/hackwin/using-hackwin.md: how the team works with HackWin',
      '  send .env.local to each member over a private channel; it is never committed',
    ])
    const text = lines.join('\n')
    expect(text).toContain('protection: full, with the update restriction')
    expect(text).toContain('push protection: on')
    expect(text).toContain('members:')
    expect(text).toContain('cd app && hackwin join')
    expect(text).not.toContain('manual-workflow.md')
  })
})

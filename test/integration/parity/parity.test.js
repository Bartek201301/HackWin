// Terminal and Claude Code parity (AC14), the /gate wrapper (AC58 once more, through the wrapper
// that setup generated) and the command set of Phase 1 (AC67), offline: a fake GitHub linked to
// the fixture's bare origin, and a repository that `setup` configured for a solo team. Each
// wrapper's command line runs in a child process (plan section 9, decision 9); no test starts a
// real Claude Code session.

import { afterEach, describe, expect, test } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { COMMANDS } from '../../../src/cli/registry.js'
import { gateFiles } from '../../../src/commands/gate/state.js'
import {
  STATUS_LABEL,
  STATUS_TITLE,
  formatStatusBody,
} from '../../../src/commands/gate/status-issue.js'
import { exec } from '../../../src/core/runtime/index.js'
import { MODES, expectParity, runParity } from './flows.js'
import { wrapperCommandLineOf, writeTask } from './world.js'
import { createOfflineWorld } from './world-offline.js'

const CLI = fileURLToPath(new URL('../../../bin/hackwin.js', import.meta.url))

/**
 * Each test runs `setup` and many child processes; the wait is long, so that a machine loaded by
 * other test runs does not fail a test.
 */
const TIMEOUT_MS = 120_000

/** The six commands of Phase 1 (7, AC67). */
const PHASE_1 = ['setup', 'join', 'take', 'ship', 'status', 'gate']

/** The commands of the PRD's 9 that arrive with later phases: `plan`, `tasks`, `propose`. */
const LATER_PHASES = ['plan', 'tasks', 'propose']

/** @type {Array<() => Promise<void>>} */
const cleanups = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

/** An offline world with a solo team, configured by `setup`. */
async function configured() {
  const scene = await createOfflineWorld()
  cleanups.push(scene.cleanup)
  const setup = await scene.setup()
  expect(setup.stderr).not.toContain('hackwin setup:')
  expect(setup.code).toBe(0)
  return scene
}

/**
 * The closed status issue that the Gate of an earlier run left, with one digest line, as on a
 * fixture repository after its reset: the reset closes it, and GitHub's list of the issues with
 * the label `gate-status` still showed it after the label was deleted and created again (20
 * October 2026). `status` reads a closed status issue when no open one exists.
 * @param {import('./world.js').World} world
 */
async function leaveGateStatus(world) {
  const time = '2026-10-20T09:34:28.793Z'
  const { body } = formatStatusBody({
    heartbeat_at: time,
    stopped_at: time,
    starts: 1,
    gate_id: null,
    protection: 'full-restricted',
    update_restricted: true,
    queue: [],
    attention: [],
    digest: [
      {
        time,
        pr: 15,
        author: world.login,
        result: 'merged',
        stage: 'after-merge',
        duration: '19s',
        note: 'merge commit 11301c23c194',
      },
    ],
  })
  const issue = await world.github.createIssue({
    title: STATUS_TITLE,
    body,
    labels: [STATUS_LABEL],
  })
  await world.github.updateIssue(issue.number, { state: 'closed', stateReason: 'not_planned' })
}

describe('AC14: terminal and Claude Code parity', () => {
  test(
    'AC14: on one fixture, take, ship and status from a terminal and through the Claude Code wrappers give the same labels, branch, pull request body and exit code',
    async () => {
      const { world } = await configured()
      await leaveGateStatus(world)

      const run = await runParity(world)

      expectParity(world, run)
      // Both calls of `status` showed the earlier Gate's digest line in full.
      for (const mode of MODES) {
        expect(run.observed[mode].status.stdout).toMatch(
          new RegExp(`\\ngate digest:\\n {2}\\S+ #15 ${world.login} merged stage=after-merge `),
        )
      }
      // The wrappers' child processes reached GitHub through the bridge, as the Lead.
      expect(world.bridgeCalls.length).toBeGreaterThan(0)
      expect(world.bridgeCalls.every((call) => call.code === 0)).toBe(true)
    },
    TIMEOUT_MS,
  )

  test(
    'AC14: a take and a ship that are refused exit with the same code and message from a terminal and through the wrappers',
    async () => {
      const { world } = await configured()
      const first = await writeTask(world, {
        title: 'Counter first',
        role: 'counter',
        paths: ['src/features/counter/first/**'],
        acceptance: ['src/features/counter/first/first.test.mjs'],
      })
      const second = await writeTask(world, {
        title: 'Counter second',
        role: 'counter',
        paths: ['src/features/counter/second/**'],
        acceptance: ['src/features/counter/second/second.test.mjs'],
        dependsOn: [first],
      })

      /** @type {Array<[string, string, number]>} */
      const refusals = [
        // An issue that does not exist: a precondition, exit 2.
        ['take', '999', 2],
        // A dependency is still open: check 3 blocks, exit 1.
        ['take', String(second), 1],
        // ship outside a task worktree: a precondition, exit 2.
        ['ship', '', 2],
      ]
      for (const [command, typed, code] of refusals) {
        const terminal = await world.run(typed === '' ? [command] : [command, typed])
        const wrapper = await world.wrapper(command, typed)
        expect(terminal.code, terminal.stderr).toBe(code)
        expect(wrapper.code, wrapper.stderr).toBe(code)
        expect(wrapper.stderr).toBe(terminal.stderr)
        expect(wrapper.stdout).toBe(terminal.stdout)
      }
      expect((await world.github.getIssue(second))?.labels).toEqual([])
      expect(world.agentStarts()).toEqual([])
    },
    TIMEOUT_MS,
  )
})

describe('AC58/wrapper: the generated /gate wrapper starts no Gate', () => {
  test(
    'AC58/wrapper: the /gate wrapper that setup generated, called inside an agent session in the main checkout or a task worktree, starts no Gate process and prints the instruction to run hackwin gate in a separate terminal',
    async () => {
      const { world, fake } = await configured()
      const worktree = join(`${world.main}.worktrees`, '1-session')
      await world
        .git()
        .run(['worktree', 'add', '--quiet', '-b', 'task/1-session', worktree, 'origin/main'])

      for (const cwd of [world.main, worktree]) {
        const result = await world.wrapper('gate', '', { cwd })
        expect(result.line).toBe('HACKWIN_CALLER=claude-code hackwin gate $ARGUMENTS')
        expect(result.code).toBe(2)
        expect(result.stdout).toBe('')
        expect(result.stderr).toBe(
          [
            'hackwin gate: the Gate starts only in its own terminal, never inside an agent session or a script: open a separate terminal for it; no Gate is running on this machine',
            `  to resolve: run \`hackwin gate\` in ${world.main}`,
            '',
          ].join('\n'),
        )
      }
      // The wrapper's command line makes the CLI see the caller kind of a Claude Code session.
      const json = await world.wrapper('gate', '--json')
      expect(json.code).toBe(2)
      expect(JSON.parse(json.stdout)).toMatchObject({
        command: 'gate',
        ok: false,
        exitCode: 2,
        error: { kind: 'precondition', details: { caller: 'claude-code', running: null } },
      })

      // No Gate ran: no lock, state, heartbeat or id in the clone, no status issue, and the
      // wrapper's process only read from GitHub.
      const files = gateFiles(await world.git().commonDir())
      for (const file of [files.lock, files.state, files.heartbeat, files.id]) {
        expect(existsSync(file), file).toBe(false)
      }
      expect(fake.state.items.filter((item) => item.labels.includes(STATUS_LABEL))).toEqual([])
      expect(world.bridgeCalls.length).toBeGreaterThan(0)
      for (const call of world.bridgeCalls) {
        expect(call.args.slice(0, 3), call.args.join(' ')).toEqual(['api', '--method', 'GET'])
      }
    },
    TIMEOUT_MS,
  )
})

describe('AC67: the command set of Phase 1', () => {
  test(
    'AC67: the CLI offers exactly the six commands of Phase 1, none of a later phase, and setup generates wrappers only for those six',
    async () => {
      const { world } = await configured()

      // The CLI that a terminal runs.
      const help = await exec(process.execPath, [CLI, '--help'], { env: world.env })
      expect(help.code).toBe(0)
      const listed = help.stdout
        .split('Commands:\n')[1]
        .split('\n\n')[0]
        .split('\n')
        .map((line) => line.trim().split(/\s+/)[0])
      expect(listed).toEqual(PHASE_1)
      expect(help.stdout).not.toContain('internal')
      expect(COMMANDS.map((command) => command.name)).toEqual(PHASE_1)
      for (const command of LATER_PHASES) {
        const result = await world.run([command])
        expect(result.code, command).toBe(2)
        expect(result.stderr, command).toContain(`hackwin: unknown command: ${command}`)
      }

      // The wrappers that setup committed: a skill per command of Phase 1 that runs the command
      // with HACKWIN_CALLER=claude-code, nothing for a later phase, and no command files.
      const git = world.git()
      await git.fetch({ prune: true })
      const tree = (await git.run(['ls-tree', '-r', '--name-only', 'origin/main'])).stdout
        .split('\n')
        .filter((path) => path.startsWith('.claude/'))
      // A wrapper is a file that has the session run a hackwin command line in a `sh` block;
      // settings.json names hackwin only in its hook commands.
      /** @type {string[]} */
      const wrappers = []
      for (const path of tree) {
        const content = /** @type {string} */ (await git.showFile('origin/main', path))
        if (/^```sh\n[^\n]*\bhackwin\b/m.test(content)) wrappers.push(path)
      }
      expect(tree).toContain('.claude/settings.json')
      expect(wrappers).toEqual(PHASE_1.map((name) => `.claude/skills/${name}/SKILL.md`).sort())
      expect(tree.filter((path) => path.startsWith('.claude/commands/'))).toEqual([])
      for (const command of LATER_PHASES) {
        expect(tree.filter((path) => path.startsWith(`.claude/skills/${command}/`))).toEqual([])
      }

      // Each wrapper's command line reaches a command the CLI has: with `--help` it prints that
      // command's usage and exits 0, without touching GitHub.
      const calls = world.bridgeCalls.length
      for (const name of PHASE_1) {
        const content = /** @type {string} */ (
          await git.showFile('origin/main', `.claude/skills/${name}/SKILL.md`)
        )
        expect(wrapperCommandLineOf(content)).toBe(
          `HACKWIN_CALLER=claude-code hackwin ${name} $ARGUMENTS`,
        )
        const result = await world.wrapper(name, '--help')
        expect(result.code, name).toBe(0)
        const entry = /** @type {(typeof COMMANDS)[number]} */ (
          COMMANDS.find((command) => command.name === name)
        )
        expect(result.stdout).toBe(`Usage: ${entry.usage}\n\n${entry.summary}.\n`)
      }
      expect(world.bridgeCalls.length).toBe(calls)
    },
    TIMEOUT_MS,
  )
})

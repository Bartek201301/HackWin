// The flows of the parity scenarios, the same offline (fake GitHub) and on a fixture repository.
//
// - The parity flow (AC14): on one configured repository the Lead writes two tasks by hand with
//   the same title and role and disjoint paths. One goes through `take`, `ship` and `status` from
//   a terminal, the other through the Claude Code wrappers, one step after the other, so that
//   both meet the same state. Both get the same labels, branch, pull request body and exit code,
//   up to their issue number; `status` prints the same lines both ways on the same state, the
//   clone's record of the last `status` call included, and changes no label. By design `take`
//   differs in one thing: from a terminal it starts the agent in the worktree, through the
//   wrapper it prints the prompt file and the command that starts the agent in a new terminal
//   (the scope change on #28; `docs/verification.md`, row 4).
// - The solo flow (AC66): with one member, `setup`, a task written by hand, `take`, `ship`, a
//   merge by the Gate and `status` complete.

import { expect } from 'vitest'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { STATUS_LABEL } from '../../../src/commands/gate/status-issue.js'
import { promptPath, readLastStatus, statePaths } from '../../../src/core/state/index.js'
import { branchName, slugOf } from '../../../src/core/tasks/index.js'
import { taskWorktreePath } from '../../../src/core/worktrees/index.js'
import { commitWork, labelsOf, pullOf, startGate, until, writeTask } from './world.js'

/** @import { World } from './world.js' */

/** The title of every task of the scenarios. */
export const TITLE = 'Counter reset'

/** The ways a command is called. */
export const MODES = /** @type {const} */ (['terminal', 'wrapper'])

/** @typedef {typeof MODES[number]} Mode */

/**
 * The task of a mode, and the work its agent commits: inside the task's own paths, with the
 * acceptance test it names. The test is a script that the quick test command, `node`, runs. It
 * also passes the fixture project's own check (`npm run check` of its workflow `check`): it uses
 * no global, which the project's eslint does not define for a `.mjs` file, and its name is not
 * one that `vitest run` collects as a test file, which would fail without a test in it.
 * @param {string} name A directory under `src/features/counter/`.
 */
export function counterTask(name) {
  const dir = `src/features/counter/${name}`
  return {
    task: {
      title: TITLE,
      role: 'counter',
      paths: [`${dir}/**`],
      acceptance: [`${dir}/reset.check.mjs`],
    },
    work: {
      [`${dir}/reset.js`]: 'export const reset = () => 0\n',
      [`${dir}/reset.check.mjs`]: [
        "import assert from 'node:assert/strict'",
        "import { reset } from './reset.js'",
        '',
        'assert.equal(reset(), 0)',
        '',
      ].join('\n'),
    },
  }
}

/**
 * Call a command in one of the two ways.
 * @param {World} world
 * @param {Mode} mode
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string }} [options]
 */
export function call(world, mode, command, args, options = {}) {
  return mode === 'terminal'
    ? world.run([command, ...args], options)
    : world.wrapper(command, args.join(' '), options)
}

/**
 * A text with the issue number of a task replaced by `<N>`, where it names the task: `#N` and
 * the branch `task/N-...`.
 * @param {string} text
 * @param {number} issue
 */
export function withoutIssue(text, issue) {
  return text
    .replaceAll(new RegExp(`#${issue}(?![0-9])`, 'g'), '#<N>')
    .replaceAll(`task/${issue}-`, 'task/<N>-')
}

/**
 * The lines of `status` with every duration replaced, since two calls a moment apart may count
 * a different number of minutes until the deadline.
 * @param {string} text
 */
export function withoutDurations(text) {
  return text.replace(/\b\d+(?:h\d{2}m|m\d{2}s|s)\b/g, '<duration>')
}

/**
 * The labels, assignees and states of the issues and pull requests, by number.
 * @param {World} world
 * @param {number[]} numbers
 */
function snapshot(world, numbers) {
  return world.settled(
    async () => {
      /** @type {Record<number, Awaited<ReturnType<typeof labelsOf>>>} */
      const state = {}
      for (const number of numbers) state[number] = await labelsOf(world, number)
      return state
    },
    `the labels of ${numbers.map((number) => `#${number}`).join(', ')}`,
  )
}

/**
 * Keep the clone's record of the member's last `status` call, and return a function that puts it
 * back. `status` writes the record and shows the digest only since the previous call, so two
 * calls one after the other differ whenever the status issue holds a digest line; the parity flow
 * gives both the record the first one found. The file is `sessions/status.json` of the clone's
 * state (`statusFile` in `src/core/state/index.js`); the read back checks that it still is.
 * @param {string} commonDir
 */
async function keepLastStatus(commonDir) {
  const seen = await readLastStatus(commonDir)
  const path = join(statePaths(commonDir).sessions, 'status.json')
  const text = existsSync(path) ? readFileSync(path, 'utf8') : null
  return async () => {
    if (text === null) rmSync(path, { force: true })
    else writeFileSync(path, text)
    expect(await readLastStatus(commonDir), 'the record of the last status call').toBe(seen)
  }
}

/**
 * The parity flow on a configured repository with a solo team, whose member is the Lead of the
 * world. It returns what it observed for the assertions of `expectParity`.
 * @param {World} world
 */
export async function runParity(world) {
  const tasks = { terminal: counterTask('terminal'), wrapper: counterTask('wrapper') }
  /** @type {Record<Mode, number>} */
  const issues = {
    terminal: await writeTask(world, tasks.terminal.task),
    wrapper: await writeTask(world, tasks.wrapper.task),
  }
  /** @type {Record<Mode, string>} */
  const worktrees = {
    terminal: taskWorktreePath(world.main, issues.terminal, slugOf(TITLE)),
    wrapper: taskWorktreePath(world.main, issues.wrapper, slugOf(TITLE)),
  }

  const observed = /** @type {Record<Mode, any>} */ ({ terminal: {}, wrapper: {} })
  for (const mode of MODES) {
    const take = await call(world, mode, 'take', [String(issues[mode])])
    observed[mode].take = take
    observed[mode].afterTake = await world.settled(
      () => labelsOf(world, issues[mode]),
      `#${issues[mode]} after take`,
    )
    observed[mode].branch = await world.git(worktrees[mode]).currentBranch()
  }
  const starts = world.agentStarts()

  for (const mode of MODES) {
    observed[mode].head = await commitWork(world, worktrees[mode], tasks[mode].work)
  }
  for (const mode of MODES) {
    observed[mode].ship = await call(world, mode, 'ship', [], { cwd: worktrees[mode] })
    observed[mode].afterShip = await world.settled(
      () => labelsOf(world, issues[mode]),
      `#${issues[mode]} after ship`,
    )
    const branch = branchName(issues[mode], TITLE)
    const pull = await world.settled(() => pullOf(world, branch), `the pull request of ${branch}`)
    observed[mode].pull = pull
    observed[mode].pullLabels =
      pull === null
        ? null
        : await world.settled(() => labelsOf(world, pull.number), `#${pull.number} after ship`)
  }

  const numbers = [
    ...MODES.map((mode) => issues[mode]),
    ...MODES.map((mode) => observed[mode].pull?.number).filter(Boolean),
  ]
  const before = await snapshot(world, numbers)
  const commonDir = await world.git().commonDir()
  const restore = await keepLastStatus(commonDir)
  for (const mode of MODES) {
    await restore()
    observed[mode].status = await call(world, mode, 'status', [])
  }
  const after = await snapshot(world, numbers)
  /** @type {Record<Mode, string>} */
  const prompts = {
    terminal: promptPath(commonDir, issues.terminal),
    wrapper: promptPath(commonDir, issues.wrapper),
  }
  return { issues, worktrees, observed, starts, before, after, prompts }
}

/**
 * The assertions of AC14 on what `runParity` observed.
 * @param {World} world
 * @param {Awaited<ReturnType<typeof runParity>>} run
 */
export function expectParity(world, run) {
  const { issues, worktrees, observed, starts, before, after, prompts } = run
  const { terminal, wrapper } = observed
  // Each mode's task has its own paths under counterTask's directory, which the pull request
  // body names among its acceptance tests (#147).
  const same = (/** @type {Mode} */ mode, /** @type {string} */ text) =>
    withoutIssue(text, issues[mode]).replaceAll(
      `src/features/counter/${mode}/`,
      'src/features/counter/<mode>/',
    )

  // take: the same exit code, labels, assignee and branch.
  expect(terminal.take.code, terminal.take.stderr).toBe(0)
  expect(wrapper.take.code, wrapper.take.stderr).toBe(terminal.take.code)
  expect(terminal.afterTake).toEqual({
    labels: ['in-progress', 'role:counter'],
    assignees: [world.login.toLowerCase()],
    state: 'open',
  })
  expect(wrapper.afterTake).toEqual(terminal.afterTake)
  expect(terminal.branch).toBe(branchName(issues.terminal, TITLE))
  expect(wrapper.branch).toBe(branchName(issues.wrapper, TITLE))
  expect(same('wrapper', wrapper.branch)).toBe(same('terminal', terminal.branch))

  // take, by design: the terminal starts the agent in the worktree with the prompt; the wrapper
  // starts none and prints the prompt file and the start command for a new terminal.
  const prompt = (/** @type {Mode} */ mode) => readFileSync(prompts[mode], 'utf8')
  expect(starts).toEqual([{ cwd: worktrees.terminal, args: [prompt('terminal')] }])
  expect(wrapper.take.stdout).toContain(`prompt: ${prompts.wrapper}`)
  expect(wrapper.take.stdout).toContain(
    `start Claude Code for #${issues.wrapper} in a new terminal: run \`cd ${worktrees.wrapper} && claude "$(cat ${prompts.wrapper})"\``,
  )
  expect(terminal.take.stdout).toContain(`starting Claude Code in ${worktrees.terminal}`)

  // ship: the same exit code, labels, branch and pull request body.
  expect(terminal.ship.code, terminal.ship.stderr).toBe(0)
  expect(wrapper.ship.code, wrapper.ship.stderr).toBe(terminal.ship.code)
  expect(terminal.afterShip).toEqual({
    ...terminal.afterTake,
    labels: ['in-review', 'role:counter'],
  })
  expect(wrapper.afterShip).toEqual(terminal.afterShip)
  for (const mode of MODES) {
    const { pull, branch, head } = observed[mode]
    expect(pull, `the pull request of ${branch}`).not.toBeNull()
    expect(pull).toMatchObject({ headRef: branch, headSha: head, baseRef: 'main', draft: false })
    expect(pull.body).toContain(`Closes #${issues[mode]}`)
  }
  expect(same('wrapper', wrapper.pull.body)).toBe(same('terminal', terminal.pull.body))
  expect(wrapper.pull.title).toBe(terminal.pull.title)
  expect(wrapper.pullLabels).toEqual(terminal.pullLabels)

  // status: the same exit code and lines on the same state, and no label changes.
  expect(terminal.status.code, terminal.status.stderr).toBe(0)
  expect(wrapper.status.code, wrapper.status.stderr).toBe(terminal.status.code)
  expect(withoutDurations(wrapper.status.stdout)).toBe(withoutDurations(terminal.status.stdout))
  expect(withoutDurations(wrapper.status.stderr)).toBe(withoutDurations(terminal.status.stderr))
  expect(after).toEqual(before)
}

/**
 * The solo flow on a configured repository whose only member is the Lead of the world: a task
 * written by hand, `take` from a terminal, the agent's commit, `ship`, the Gate until it merged
 * the pull request, and `status`.
 * @param {World} world
 * @param {object} options
 * @param {(pull: { number: number, headSha: string }) => Promise<void>} options.beforeGate What
 *   stands for CI before the Gate starts: offline a check run on the fake GitHub; on a fixture
 *   repository nothing, as GitHub Actions runs the workflow.
 * @param {number} options.mergeTimeoutMs How long the Gate may take to merge.
 */
export async function runSolo(world, { beforeGate, mergeTimeoutMs }) {
  const { task, work } = counterTask('reset')
  const issue = await writeTask(world, task)
  const worktree = taskWorktreePath(world.main, issue, slugOf(TITLE))
  const take = await world.run(['take', String(issue)])
  expect(take.code, take.stderr).toBe(0)
  const head = await commitWork(world, worktree, work)
  const ship = await world.run(['ship'], { cwd: worktree })
  expect(ship.code, ship.stderr).toBe(0)
  const branch = branchName(issue, TITLE)
  const pull = await world.settled(() => pullOf(world, branch), `the pull request of ${branch}`)
  expect(pull, `the pull request of #${issue}`).not.toBeNull()
  const opened = /** @type {NonNullable<typeof pull>} */ (pull)
  expect(opened.headSha).toBe(head)

  await beforeGate({ number: opened.number, headSha: head })
  const gate = await startGate(world)
  // The run ends with its digest line in the Gate's terminal (9.6). The Lead types `quit` only
  // then: a run that `quit` stops after its merge ends at the Gate's next start (7.5 step 5).
  const digestLine = new RegExp(`#${opened.number} \\S+ \\S+ stage=`)
  try {
    await until(
      () => {
        if (gate.ended !== null) {
          throw new Error(
            `the Gate stopped before its run of #${opened.number} ended: ${gate.ended.error ?? 'without an error'}\n${gate.out}`,
          )
        }
        return digestLine.test(gate.out)
      },
      `the end of the Gate's run of #${opened.number}`,
      { timeoutMs: mergeTimeoutMs, everyMs: 1000, detail: () => gate.out },
    )
  } finally {
    await gate.quit().catch((error) => world.log(`the Gate stopped on an error: ${error}`))
  }
  const merged = await world.settled(
    () => world.github.getPullRequest(opened.number),
    `#${opened.number} after the Gate`,
  )
  // The Gate wrote the status issue as it stopped; `status` reads it once GitHub shows it.
  await world.settled(
    async () =>
      (await world.github.listIssues({ state: 'open', labels: [STATUS_LABEL] })).map(
        (status) => status.body,
      ),
    'the status issue after the Gate stopped',
  )
  const status = await world.run(['status'])
  return { issue, worktree, take, head, ship, pull: opened, merged, gate, status }
}

/**
 * The assertions of AC66 on what `runSolo` observed.
 * @param {World} world
 * @param {Awaited<ReturnType<typeof runSolo>>} run
 */
export async function expectSolo(world, run) {
  const { issue, worktree, head, pull, merged, gate, status } = run
  expect(world.agentStarts().map((start) => start.cwd)).toEqual([worktree])
  expect(merged).toMatchObject({ merged: true, headSha: head })

  // The merge closed the task through `Closes #N`, and main holds the work.
  const task = await world.settled(() => labelsOf(world, issue), `#${issue} after the merge`)
  expect(task.state).toBe('closed')
  const git = world.git()
  await git.fetch({ prune: true })
  expect(await git.isAncestor(head, 'origin/main')).toBe(true)
  expect(await git.showFile('origin/main', 'src/features/counter/reset/reset.js')).toBe(
    'export const reset = () => 0\n',
  )

  // The Gate printed the merge, and `status` shows it in the digest.
  const { number } = pull
  expect(gate.out).toMatch(new RegExp(`#${number} \\S+ merged stage=`))
  expect(status.code, status.stderr).toBe(0)
  expect(status.stdout).toMatch(
    new RegExp(`^gate digest[^\\n]*:\\n(?:  .*\\n)*  [^\\n]*#${number} \\S+ merged`, 'm'),
  )
  expect(status.stdout).toContain('the Lead stopped the Gate at ')
  expect(status.stdout).toContain('waiting for merge: none\n')
}

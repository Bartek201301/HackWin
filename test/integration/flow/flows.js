// The flows of 1.7a (#26), the same on the fake GitHub (flow.test.js, task-link.test.js) and on a
// fixture repository (flow.fixture.test.js). Each flow runs the commands as the members run them
// and records what it saw; the tests assert on the record, so that every criterion is checked on
// the same run.
//
// - `takeToMerge`: the Lead runs `setup`, builder1 runs `join`, the Lead writes three task issues
//   by hand from the template: two of builder1's roles, the second depending on the first and
//   labeled `blocked` by hand, and one with the deadline left empty, as the template has it.
//   builder1 `take`s the first task, a scripted session commits, `ship` opens the pull request,
//   CI runs and the Gate merges it. The next `take` of builder1 picks the dependent, which the
//   Gate relabeled, and removes the merged worktree; that task is shipped and merged too.
//   (AC65, AC32, AC33)
// - `taskLinkFailures`: pull requests opened by hand that name no open task with a valid data
//   block, or come from a `spike/` branch, fail CI and stage 2 of the Gate; a pull request of the
//   Lead that edits a generated wrapper by hand fails CI. (AC71)

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readProtection } from '../../../src/core/protection/index.js'
import { branchName, slugOf } from '../../../src/core/tasks/index.js'
import { taskWorktreePath } from '../../../src/core/worktrees/index.js'
import { wrapperPath } from '../../../src/generate/index.js'
import { accounts } from '../../harness/index.js'
import { agentStarts, commitWork, firstParentHistory, passingTest } from './world.js'

/** @import { GitHub, PullRequest } from '../../../src/core/github/index.js' */
/** @import { Git } from '../../../src/core/git/index.js' */
/** @import { RunResult, TaskInput, LeadGate } from './world.js' */

export const BUILDER1 = accounts.builder1.login

/**
 * A member's machine in a world: a clone, its programs and its environment.
 * @typedef {object} Machine
 * @property {string} login
 * @property {string} path The main checkout of the clone.
 * @property {string} agentLog Where the `claude` of this machine records its starts.
 * @property {Record<string, string | undefined>} env
 * @property {(cwd?: string) => Git} git Git in a checkout of this machine, with its environment.
 * @property {(argv: string[], options?: { cwd?: string }) => Promise<RunResult>} run Run
 *   `hackwin <argv>` as this member, in the main checkout by default.
 */

/**
 * What CI said about a pull request: the check run `hackwin` on its head commit.
 * @typedef {object} CiResult
 * @property {boolean} passed
 * @property {string} head The head commit it ran on.
 * @property {string} text What `hackwin internal ci` printed: offline its output, on GitHub the
 *   log of the job.
 */

/**
 * The world a flow runs in.
 * @typedef {object} World
 * @property {boolean} live True on a fixture repository.
 * @property {Machine} lead The Lead's machine: the clone `setup` runs in.
 * @property {GitHub} github The Lead's client.
 * @property {() => Promise<RunResult>} setup `hackwin setup --answers` as the Lead.
 * @property {(login: string, name: string) => Promise<Machine>} joinedMachine A clone of a
 *   member on which `hackwin join --answers` exited 0.
 * @property {(task: TaskInput & { labels?: string[] }) => Promise<number>} writeTask A task
 *   issue written by hand from the template on origin/main, as the Lead.
 * @property {(member: Machine, pull: { branch: string, files: Record<string, string>, body: string }) => Promise<{ number: number, head: string }>} openByHand
 *   A branch pushed with `--no-verify` and a pull request opened by hand, as the member.
 * @property {(number: number) => Promise<CiResult>} ci CI on the pull request's head commit:
 *   run offline, waited for on GitHub.
 * @property {() => Promise<LeadGate>} startGate The Lead's Gate in the Lead's main checkout.
 * @property {<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string) => Promise<T>} eventually
 *   A read of GitHub after a write: once offline; on GitHub again until `done` holds or a minute
 *   passed, since GitHub's reads can lag its writes. The last value is returned either way.
 * @property {(line: string) => void} log
 */

/** The tasks of `takeToMerge`. */
export const FLOW_TASKS = Object.freeze({
  reset: {
    title: 'Counter reset',
    role: 'counter',
    paths: ['src/features/counter/**'],
    acceptance: ['src/features/counter/reset.test.mjs'],
  },
  undo: {
    title: 'Counter undo',
    role: 'counter',
    paths: ['src/features/counter/**'],
    acceptance: ['src/features/counter/undo.test.mjs'],
  },
  // The deadline is left as the template has it, empty: a block that 8.1 makes invalid.
  filter: {
    title: 'Todo filter',
    role: 'todos',
    paths: ['src/features/todos/**'],
    acceptance: ['src/features/todos/filter.test.mjs'],
    deadline: '',
  },
})

/** What the scripted sessions commit for each task of `takeToMerge`. */
export const FLOW_WORK = Object.freeze({
  reset: {
    'src/features/counter/reset.js': 'export const reset = () => 0\n',
    'src/features/counter/reset.test.mjs': passingTest('counter reset'),
  },
  undo: {
    'src/features/counter/undo.js': 'export const undo = (history) => history.slice(0, -1)\n',
    'src/features/counter/undo.test.mjs': passingTest('counter undo'),
  },
})

/**
 * Throw when a step that later steps depend on failed, with what it printed.
 * @param {boolean} ok
 * @param {string} what
 * @param {RunResult} [result]
 */
function step(ok, what, result) {
  if (ok) return
  const output = result ? `\nexit ${result.code}\n${result.stdout}${result.stderr}` : ''
  throw new Error(`${what}${output}`)
}

/**
 * The labels, assignees and state of an issue, as a person sees them on GitHub.
 * @param {GitHub} github
 * @param {number} number
 */
export async function issueView(github, number) {
  const issue = await github.getIssue(number)
  if (issue === null) throw new Error(`#${number} does not exist`)
  return {
    state: issue.state,
    stateReason: issue.stateReason,
    labels: [...issue.labels].sort(),
    assignees: issue.assignees.map((login) => login.toLowerCase()).sort(),
  }
}

/**
 * The pull request of a branch, or null.
 * @param {GitHub} github
 * @param {string} branch
 * @returns {Promise<PullRequest | null>}
 */
export async function pullOf(github, branch) {
  const pulls = await github.listPullRequests({ state: 'all', head: branch })
  return pulls.find((pull) => pull.headRef === branch) ?? null
}

/**
 * The commit of a branch on origin, read with git from a checkout, or null.
 * @param {Git} git
 * @param {string} branch
 */
export async function remoteBranch(git, branch) {
  const { stdout } = await git.run(['ls-remote', 'origin', `refs/heads/${branch}`])
  return stdout.split(/\s+/)[0] || null
}

/**
 * The names of the files in a directory, or none when it does not exist.
 * @param {string} dir
 * @returns {string[]}
 */
function listFiles(dir) {
  return existsSync(dir) ? readdirSync(dir).sort() : []
}

/**
 * The paths of the worktrees of a clone.
 * @param {Git} git
 */
async function worktreePaths(git) {
  return (await git.worktreeList()).map((worktree) => worktree.path)
}

/**
 * Try to push a commit straight to main from a member's main checkout, as AC33 rules out: once
 * through the `pre-push` hook, and on GitHub also with `--no-verify`, which skips the hooks (10.6),
 * so that GitHub's rules alone decide. The commit is made on a detached HEAD with `--no-verify`,
 * since the `pre-commit` hook blocks a commit on main (E18), and the checkout returns to `main`.
 * @param {World} world
 * @param {Machine} member
 */
async function pushToMain(world, member) {
  const git = member.git()
  await git.fetch({ prune: true })
  await git.run(['checkout', '--quiet', '--detach', 'refs/remotes/origin/main'])
  try {
    await commitWork(
      member.path,
      { 'README.md': `# Straight to main from ${member.login}\n` },
      { env: member.env, message: 'Straight to main', noVerify: true },
    )
    const refspec = 'HEAD:refs/heads/main'
    const hook = await git.run(['push', 'origin', refspec], { allowFailure: true })
    world.log(`${member.login}: git push origin ${refspec} exited ${hook.code}: ${hook.stderr}`)
    /** @type {{ hook: { code: number | null, stderr: string }, noVerify?: { code: number | null, stderr: string } }} */
    const result = { hook: { code: hook.code, stderr: hook.stderr } }
    if (world.live) {
      const direct = await git.run(['push', '--no-verify', 'origin', refspec], {
        allowFailure: true,
      })
      world.log(
        `${member.login}: git push --no-verify origin ${refspec} exited ${direct.code}: ${direct.stderr}`,
      )
      result.noVerify = { code: direct.code, stderr: direct.stderr }
    }
    return result
  } finally {
    await git.run(['checkout', '--quiet', '--force', 'main'])
  }
}

/**
 * The flow of AC65, AC32 and AC33: from a task written by hand to its merge.
 * @param {World} world
 * @param {Record<string, any>} [seen] The record to fill, which shows how far a failed run got.
 */
export async function takeToMerge(world, seen = {}) {
  const { github, lead } = world

  // The Lead configures the repository. The bootstrap commit is the commit of origin/main after
  // setup, which pushed it (CM8).
  seen.setup = await world.setup()
  step(seen.setup.code === 0, 'setup did not exit 0', seen.setup)
  await lead.git().fetch({ prune: true })
  seen.bootstrap = await lead.git().revParse('refs/remotes/origin/main')
  seen.protection = (await readProtection(github)).state

  const builder = await world.joinedMachine(BUILDER1, 'builder1')
  const reset = await world.writeTask(FLOW_TASKS.reset)
  // The dependent is labeled `blocked` by hand, as the Phase 1 fixture sets it (AC32).
  const undo = await world.writeTask({
    ...FLOW_TASKS.undo,
    dependsOn: [reset],
    labels: ['blocked'],
  })
  const filter = await world.writeTask(FLOW_TASKS.filter)
  seen.numbers = { reset, undo, filter }
  seen.branch = branchName(reset, FLOW_TASKS.reset.title)
  seen.worktree = taskWorktreePath(builder.path, reset, slugOf(FLOW_TASKS.reset.title))
  seen.undoBranch = branchName(undo, FLOW_TASKS.undo.title)
  seen.undoWorktree = taskWorktreePath(builder.path, undo, slugOf(FLOW_TASKS.undo.title))
  seen.filterWorktree = taskWorktreePath(builder.path, filter, slugOf(FLOW_TASKS.filter.title))
  seen.filterBefore = await issueView(github, filter)

  // Before the merge: the invalid task and the dependent are refused, and status lists both.
  seen.invalidTake = await builder.run(['take', String(filter)])
  seen.filterWorktreeExists = existsSync(seen.filterWorktree)
  seen.blockedTake = await builder.run(['take', String(undo)])
  seen.status = await builder.run(['status'])

  // builder1 takes the first task; a scripted session commits; ship opens the pull request.
  seen.take = await builder.run(['take', String(reset)])
  step(seen.take.code === 0, `take ${reset} did not exit 0`, seen.take)
  seen.agentStarts = agentStarts(builder.agentLog)
  seen.afterTake = await world.eventually(
    () => issueView(github, reset),
    (view) => view.labels.includes('in-progress'),
    `the claim of #${reset}`,
  )
  seen.worktreeBranch = await builder.git(seen.worktree).currentBranch()
  seen.head = await commitWork(seen.worktree, FLOW_WORK.reset, { env: builder.env })
  seen.ship = await builder.run(['ship'], { cwd: seen.worktree })
  step(seen.ship.code === 0, 'ship did not exit 0', seen.ship)
  seen.pull = await world.eventually(
    () => pullOf(github, seen.branch),
    (pull) => pull !== null,
    `the pull request of ${seen.branch}`,
  )
  step(seen.pull !== null, `ship opened no pull request from ${seen.branch}`)
  seen.afterShip = await world.eventually(
    () => issueView(github, reset),
    (view) => view.labels.includes('in-review'),
    `#${reset} in review`,
  )
  seen.ci = await world.ci(seen.pull.number)
  step(seen.ci.passed, `CI failed on #${seen.pull.number}:\n${seen.ci.text}`)

  const gate = await world.startGate()
  try {
    await gate.poll()
    seen.merged = await gate.ended(seen.pull.number, 'merged')
    seen.gateRecord = gate.state().prs[String(seen.pull.number)]
    seen.afterMerge = {
      pull: await world.eventually(
        () => github.getPullRequest(seen.pull.number),
        (pull) => pull?.merged === true,
        `#${seen.pull.number} merged`,
      ),
      issue: await world.eventually(
        () => issueView(github, reset),
        (view) => view.state === 'closed',
        `#${reset} closed`,
      ),
      undo: await world.eventually(
        () => issueView(github, undo),
        (view) => view.labels.includes('ready'),
        `#${undo} ready`,
      ),
      branch: await world.eventually(
        () => remoteBranch(lead.git(), seen.branch),
        (sha) => sha === null,
        `${seen.branch} deleted`,
      ),
      scratch: existsSync(join(gate.files.worktrees, 'scratch')),
      scratchPath: join(gate.files.worktrees, 'scratch'),
      // The logs of the merge test of stage 7, which ran in the scratch worktree.
      mergeTestLogs: listFiles(join(gate.files.logs, `pr-${seen.pull.number}`)),
      leadWorktrees: await worktreePaths(lead.git()),
      builderWorktree: existsSync(seen.worktree),
    }

    // The next take on the builder's machine: the dependent is takeable now, and the worktree of
    // the merged task goes.
    seen.nextTake = await builder.run(['take'])
    step(seen.nextTake.code === 0, 'the next take did not exit 0', seen.nextTake)
    seen.afterNextTake = {
      worktree: existsSync(seen.worktree),
      worktrees: await worktreePaths(builder.git()),
      undo: await world.eventually(
        () => issueView(github, undo),
        (view) => view.labels.includes('in-progress'),
        `the claim of #${undo}`,
      ),
    }

    // The dependent is shipped and merged too, so that main has two merges after the bootstrap.
    await commitWork(seen.undoWorktree, FLOW_WORK.undo, { env: builder.env })
    seen.undoShip = await builder.run(['ship'], { cwd: seen.undoWorktree })
    step(seen.undoShip.code === 0, 'ship of the dependent did not exit 0', seen.undoShip)
    seen.undoPull = await world.eventually(
      () => pullOf(github, seen.undoBranch),
      (pull) => pull !== null,
      `the pull request of ${seen.undoBranch}`,
    )
    step(seen.undoPull !== null, `ship opened no pull request from ${seen.undoBranch}`)
    seen.undoCi = await world.ci(seen.undoPull.number)
    step(seen.undoCi.passed, `CI failed on #${seen.undoPull.number}:\n${seen.undoCi.text}`)
    await gate.poll()
    seen.undoMerged = await gate.ended(seen.undoPull.number, 'merged')
  } finally {
    await gate.quit()
    seen.gateOut = gate.out
  }

  // AC65: the invalid task, read again minutes after take refused it on GitHub, so that a change
  // that take made would show even through a lagging read.
  seen.filterAfter = await issueView(github, filter)

  // AC33: nothing reaches main but the Gate's merges. main is read before and after the pushes
  // straight to main, which must leave it where the Gate's last merge put it.
  await lead.git().fetch({ prune: true })
  seen.mainBeforePushes = await lead.git().revParse('refs/remotes/origin/main')
  seen.pushes = {
    builder: await pushToMain(world, builder),
    lead: await pushToMain(world, lead),
  }
  await lead.git().fetch({ prune: true })
  seen.main = await lead.git().revParse('refs/remotes/origin/main')
  seen.history = await firstParentHistory(lead.git(), 'refs/remotes/origin/main')
  // The two pull requests of this run. A fixture repository keeps the closed pull requests of
  // earlier runs, which count for nothing here.
  const ours = [seen.pull.number, seen.undoPull.number]
  seen.merges = (
    await world.eventually(
      () => github.listPullRequests({ state: 'closed' }),
      (pulls) =>
        ours.every((number) =>
          pulls.some((pull) => pull.number === number && pull.merged && pull.mergeCommitSha),
        ),
      `the merges of #${ours.join(' and #')}`,
    )
  )
    .filter((pull) => ours.includes(pull.number) && pull.merged)
    .map((pull) => ({ number: pull.number, mergeCommitSha: pull.mergeCommitSha }))
  return seen
}

/** The tasks of `taskLinkFailures`. */
export const LINK_TASKS = Object.freeze({
  // Open and valid; never taken.
  limit: {
    title: 'Counter limit',
    role: 'counter',
    paths: ['src/features/counter/**'],
    acceptance: ['src/features/counter/limit.test.mjs'],
  },
  // A path of another role: the block is invalid (8.1, contracts 4.4 "Task paths").
  sort: {
    title: 'Todo sort',
    role: 'todos',
    paths: ['src/features/greeting/**'],
    acceptance: ['src/features/todos/sort.test.mjs'],
  },
  // Valid, and closed by the Lead.
  done: {
    title: 'Todo done',
    role: 'todos',
    paths: ['src/features/todos/**'],
    acceptance: ['src/features/todos/done.test.mjs'],
  },
  // The Lead's task that edits a generated wrapper by hand (E19).
  wrapper: {
    title: 'Take wrapper text',
    role: 'shared',
    paths: ['.claude/**', 'src/shared/**'],
    acceptance: ['src/shared/wrapper.test.mjs'],
  },
})

/** The issue of `taskLinkFailures` that is no task: it has no data block. */
export const NOTE = Object.freeze({
  title: 'Counter colours',
  body: 'An idea for later, with no task block.\n',
})

/** The pull requests of `taskLinkFailures` that builder1 opens by hand. */
export const BY_HAND = Object.freeze(['invalid', 'closed', 'none', 'notTask', 'spike'])

/**
 * The flow of AC71: pull requests that name no open task with a valid data block, or come from a
 * `spike/` branch, fail CI and stage 2 of the Gate; a pull request of the Lead that edits a
 * generated wrapper by hand fails CI (E19).
 * @param {World} world
 * @param {Record<string, any>} [seen] The record to fill, which shows how far a failed run got.
 */
export async function taskLinkFailures(world, seen = {}) {
  const { github, lead } = world

  seen.setup = await world.setup()
  step(seen.setup.code === 0, 'setup did not exit 0', seen.setup)
  await lead.git().fetch({ prune: true })
  seen.bootstrap = await lead.git().revParse('refs/remotes/origin/main')

  const builder = await world.joinedMachine(BUILDER1, 'builder1')
  const limit = await world.writeTask(LINK_TASKS.limit)
  const sort = await world.writeTask(LINK_TASKS.sort)
  const done = await world.writeTask(LINK_TASKS.done)
  await github.updateIssue(done, { state: 'closed', stateReason: 'not_planned' })
  const note = (await github.createIssue(NOTE)).number
  seen.numbers = { limit, sort, done, note }

  /** @type {Record<string, { branch: string, files: Record<string, string>, body: string }>} */
  const pulls = {
    invalid: {
      branch: branchName(sort, LINK_TASKS.sort.title),
      files: { 'src/features/todos/sort.js': 'export const sort = (todos) => [...todos]\n' },
      body: `Closes #${sort}\n`,
    },
    closed: {
      branch: branchName(done, LINK_TASKS.done.title),
      files: { 'src/features/todos/done.js': 'export const done = true\n' },
      body: `Closes #${done}\n`,
    },
    none: {
      branch: branchName(limit, LINK_TASKS.limit.title),
      files: { 'src/features/counter/limit.js': 'export const limit = 10\n' },
      body: 'The counter limit, with no closing line.\n',
    },
    notTask: {
      branch: branchName(note, NOTE.title),
      files: { 'src/features/counter/colours.js': "export const colours = ['red']\n" },
      body: `Closes #${note}\n`,
    },
    spike: {
      branch: 'spike/counter-limit',
      files: { 'src/features/counter/limit-spike.js': 'export const limit = 99\n' },
      body: `Closes #${limit}\n`,
    },
  }
  seen.pulls = {}
  for (const key of BY_HAND) {
    seen.pulls[key] = { ...pulls[key], ...(await world.openByHand(builder, pulls[key])) }
  }
  seen.ci = {}
  for (const key of BY_HAND) seen.ci[key] = await world.ci(seen.pulls[key].number)

  const gate = await world.startGate()
  try {
    await gate.poll()
    seen.gate = {}
    for (const key of BY_HAND) {
      const { number } = seen.pulls[key]
      const line = await gate.ended(number, 'failed')
      seen.gate[key] = {
        line,
        record: gate.state().prs[String(number)],
        comments: await world.eventually(
          () => github.listComments(number),
          (comments) => comments.length > 0,
          `the Gate's comment on #${number}`,
        ),
        view: await world.eventually(
          () => issueView(github, number),
          (view) => view.labels.includes('gate:failed'),
          `#${number} labeled gate:failed`,
        ),
      }
    }
  } finally {
    await gate.quit()
    seen.gateOut = gate.out
  }
  seen.pullsAfter = {}
  for (const key of BY_HAND) {
    seen.pullsAfter[key] = await github.getPullRequest(seen.pulls[key].number)
  }
  await lead.git().fetch({ prune: true })
  seen.main = await lead.git().revParse('refs/remotes/origin/main')

  // The Lead's pull request that changes a generated wrapper by hand: its task is of the shared
  // role, taken and shipped as any other; CI fails it (E19).
  const wrapper = await world.writeTask(LINK_TASKS.wrapper)
  seen.numbers.wrapper = wrapper
  seen.wrapperTake = await lead.run(['take', String(wrapper)])
  step(seen.wrapperTake.code === 0, `take ${wrapper} did not exit 0`, seen.wrapperTake)
  const worktree = taskWorktreePath(lead.path, wrapper, slugOf(LINK_TASKS.wrapper.title))
  seen.wrapperFile = wrapperPath('take')
  const generated = await lead.git(worktree).showFile('HEAD', seen.wrapperFile)
  step(generated !== null, `the worktree of #${wrapper} has no ${seen.wrapperFile}`)
  seen.wrapperHead = await commitWork(
    worktree,
    {
      [seen.wrapperFile]: `${generated}\nAsk before you take a task.\n`,
      'src/shared/wrapper.test.mjs': passingTest('the take wrapper'),
    },
    { env: lead.env, message: 'Change the take wrapper by hand' },
  )
  seen.wrapperShip = await lead.run(['ship'], { cwd: worktree })
  step(seen.wrapperShip.code === 0, 'ship of the wrapper change did not exit 0', seen.wrapperShip)
  const branch = branchName(wrapper, LINK_TASKS.wrapper.title)
  seen.wrapperPull = await world.eventually(
    () => pullOf(github, branch),
    (pull) => pull !== null,
    `the pull request of ${branch}`,
  )
  step(seen.wrapperPull !== null, `ship opened no pull request from ${branch}`)
  seen.wrapperCi = await world.ci(seen.wrapperPull.number)
  return seen
}

// The assertions of 1.7a (#26) on what a flow recorded (flows.js). The offline tests and the
// tests on a fixture repository call the same ones, so that both check the same claims.

import { expect } from 'vitest'
import { VERSION } from '../../../src/cli/context.js'
import { latestGateComment } from '../../../src/commands/gate/comment.js'
import { accounts } from '../../harness/index.js'
import { BUILDER1, FLOW_TASKS } from './flows.js'

const LEAD = accounts.lead.login

/** The reason of each pull request of `taskLinkFailures` (contracts 4.5, `checkTaskLink`). */
export const LINK_REASONS = Object.freeze({
  invalid: 'invalid-task-block',
  closed: 'issue-not-open',
  none: 'no-closes-line',
  notTask: 'invalid-task-block',
  spike: 'spike-branch',
})

/**
 * AC65, first part: the task written by hand is taken by `take`, shipped and merged by the Gate.
 * @param {Record<string, any>} seen The record of `takeToMerge`.
 */
export function expectTakenAndMerged(seen, { live }) {
  const { reset } = seen.numbers
  const { take, ship, pull } = seen
  expect(take.code).toBe(0)
  expect(take.stdout).toContain(`selected #${reset} ${FLOW_TASKS.reset.title} (role counter)`)
  // The task written by hand had no role label; take adds it with the claim (7.7 step 4).
  expect(take.stdout).toContain(
    `claimed #${reset}: in-progress, assigned to ${BUILDER1}, labeled role:counter`,
  )
  expect(take.stdout).toContain(
    `worktree: ${seen.worktree} on ${seen.branch}, new from origin/main`,
  )
  expect(seen.worktreeBranch).toBe(seen.branch)
  // Not in a terminal, take prints the start command and starts no agent (contracts 3.5).
  expect(take.stdout).toContain(`start Claude Code for #${reset} in a new terminal`)
  expect(seen.agentStarts).toBe(0)
  expect(seen.afterTake).toMatchObject({
    state: 'open',
    labels: ['in-progress', 'role:counter'],
    assignees: [BUILDER1.toLowerCase()],
  })

  expect(ship.code).toBe(0)
  expect(pull).toMatchObject({ headRef: seen.branch, baseRef: 'main', draft: false })
  expect(pull.author.toLowerCase()).toBe(BUILDER1.toLowerCase())
  expect(pull.body.split(/\r?\n/)).toContain(`Closes #${reset}`)
  expect(pull.headSha).toBe(seen.head)
  expect(ship.stdout).toContain(`PR #${pull.number} opened at ${seen.head}. Do not merge. Stop.`)
  expect(seen.afterShip.labels).toEqual(['in-review', 'role:counter'])
  expect(seen.ci.passed).toBe(true)
  const lines = ciLines(seen.ci.text)
  expect(lines).toContain(
    `step 1, configuration: hackwin.yml and owners.yml of origin/main apply; checked with hackwin ${VERSION}`,
  )
  expect(lines).toContain(`hackwin CI passed for pull request #${pull.number} at ${seen.head}`)
  // On GitHub the workflow installs the version that setup pinned, a pre-release, by URL.
  if (live) {
    expect(lines).toContain(`hackwin.yml on main pins ${VERSION}; installing hackwin ${VERSION}`)
  }

  expect(seen.merged).toMatchObject({ pr: pull.number, result: 'merged', author: BUILDER1 })
  expect(seen.gateRecord).toMatchObject({ head_sha: seen.head, result: 'merged' })
  expect(seen.afterMerge.pull).toMatchObject({ merged: true })
  expect(seen.afterMerge.pull.mergeCommitSha).toMatch(/^[0-9a-f]{40}$/)
  expect(seen.gateOut).toContain(
    `#${pull.number} merged head ${seen.head} as ${seen.afterMerge.pull.mergeCommitSha}`,
  )
  expect(seen.afterMerge.issue.state).toBe('closed')
}

/**
 * AC65, second part: the issue with an invalid data block is refused by `take` with the reason,
 * nothing changes on it, and `status` lists it as invalid.
 * @param {Record<string, any>} seen The record of `takeToMerge`.
 */
export function expectInvalidRefused(seen) {
  const { filter } = seen.numbers
  const reason = 'deadline is missing; every task has one (T11)'
  expect(seen.invalidTake.code).toBe(1)
  expect(seen.invalidTake.stderr).toContain(
    `hackwin take: blocked: #${filter} cannot be taken: the task block of #${filter} is invalid: ${reason}`,
  )
  expect(seen.filterAfter).toEqual(seen.filterBefore)
  expect(seen.filterAfter.labels).not.toContain('in-progress')
  expect(seen.filterWorktreeExists).toBe(false)
  expect(seen.status.code).toBe(0)
  expect(seen.status.stdout).toContain(
    `#${filter} has an invalid task block: ${reason}: ${FLOW_TASKS.filter.title}`,
  )
}

/**
 * AC32, first part: after the merge the remote branch is deleted, the issue is closed, the
 * dependent labeled `blocked` by hand is relabeled `ready` and is takeable, and the Gate's scratch
 * worktree is gone.
 * @param {Record<string, any>} seen The record of `takeToMerge`.
 */
export function expectAfterMerge(seen) {
  const { reset, undo } = seen.numbers
  const { afterMerge } = seen
  expect(afterMerge.branch).toBeNull()
  expect(seen.gateOut).toContain(`the remote branch ${seen.branch} is deleted`)
  expect(afterMerge.issue).toMatchObject({ state: 'closed', stateReason: 'completed' })

  // Before the merge the dependent was refused; after it, it is ready and taken.
  expect(seen.blockedTake.code).toBe(1)
  expect(seen.blockedTake.stderr).toContain(
    `#${undo} cannot be taken: blocked by #${reset}, still open`,
  )
  expect(afterMerge.undo.labels).toContain('ready')
  expect(afterMerge.undo.labels).not.toContain('blocked')
  expect(seen.gateOut).toContain(`the task #${undo}, which depended on #${reset}, is ready`)
  expect(seen.nextTake.stdout).toContain(
    `selected #${undo} ${FLOW_TASKS.undo.title} (role counter)`,
  )

  // Stage 7 ran its merge test in the scratch worktree: install, check and acceptance tests.
  const tested = `${seen.head.slice(0, 12)}-on-${seen.bootstrap.slice(0, 12)}`
  for (const name of ['install', 'check', 'acceptance']) {
    expect(afterMerge.mergeTestLogs).toContain(`${tested}-${name}.log`)
  }
  expect(afterMerge.scratch).toBe(false)
  expect(afterMerge.leadWorktrees).not.toContain(afterMerge.scratchPath)
  expect(
    afterMerge.leadWorktrees.some((/** @type {string} */ path) => path.includes('/hackwin/gate/')),
  ).toBe(false)
}

/**
 * AC32, second part: on the builder's machine the worktree of the merged task stays until the
 * next `take`, which removes it.
 * @param {Record<string, any>} seen The record of `takeToMerge`.
 */
export function expectNextTakeRemoves(seen) {
  expect(seen.afterMerge.builderWorktree).toBe(true)
  expect(seen.nextTake.code).toBe(0)
  expect(seen.nextTake.stdout).toContain(`removed the worktree of a merged task: ${seen.worktree}`)
  expect(seen.afterNextTake.worktree).toBe(false)
  expect(seen.afterNextTake.worktrees).not.toContain(seen.worktree)
  expect(seen.afterNextTake.worktrees).toContain(seen.undoWorktree)
}

/**
 * AC33: in full protection mode, every commit on the first parent history of main after the
 * bootstrap commit is the merge commit of a pull request. A push straight to main is refused by
 * the `pre-push` hook, and on GitHub also with the hooks skipped.
 * @param {Record<string, any>} seen The record of `takeToMerge`.
 * @param {{ live: boolean }} world
 */
export function expectOnlyMerges(seen, { live }) {
  expect(seen.protection).toBe('full-restricted')
  expect(seen.setup.stdout).toContain('protection: full, with the update restriction')

  for (const member of ['builder', 'lead']) {
    const push = seen.pushes[member]
    expect(push.hook.code, `${member}: git push origin HEAD:refs/heads/main`).not.toBe(0)
    expect(push.hook.stderr).toContain('rule: E2: no direct push to main')
    if (live) {
      expect(push.noVerify.code, `${member}: git push --no-verify`).not.toBe(0)
      expect(push.noVerify.stderr).toContain('GH013: Repository rule violations found')
      expect(push.noVerify.stderr).toContain('Changes must be made through a pull request')
    }
  }

  // The pushes straight to main left it at the Gate's last merge.
  expect(seen.main, 'main after the pushes straight to main').toBe(seen.mainBeforePushes)
  const shas = seen.history.map((/** @type {{ sha: string }} */ commit) => commit.sha)
  const at = shas.indexOf(seen.bootstrap)
  expect(at, 'the bootstrap commit is on the first parent history of main').toBeGreaterThan(0)
  const after = seen.history.slice(0, at)
  const merges = new Map(
    seen.merges.map((/** @type {{ number: number, mergeCommitSha: string }} */ pull) => [
      pull.mergeCommitSha,
      pull.number,
    ]),
  )
  for (const commit of after) {
    expect(merges.has(commit.sha), `${commit.sha} is the merge commit of a pull request`).toBe(true)
    expect(commit.parents).toHaveLength(2)
  }
  // The two pull requests of the flow, newest first.
  expect(after.map((/** @type {{ sha: string }} */ commit) => merges.get(commit.sha))).toEqual([
    seen.undoPull.number,
    seen.pull.number,
  ])
}

/**
 * AC71: a pull request opened by hand that names no open task with a valid data block, or comes
 * from a `spike/` branch, fails CI and stage 2 of the Gate, which comments and labels it.
 * @param {Record<string, any>} seen The record of `taskLinkFailures`.
 * @param {keyof typeof LINK_REASONS} key
 */
export function expectTaskLinkFailure(seen, key) {
  const pull = seen.pulls[key]
  const reason = LINK_REASONS[key]
  const ci = seen.ci[key]
  expect(ci.passed).toBe(false)
  expect(ci.head).toBe(pull.head)
  const lines = ciLines(ci.text)
  expect(lines).toContain(
    `step 1, configuration: hackwin.yml and owners.yml of origin/main apply; checked with hackwin ${VERSION}`,
  )
  for (const expected of ciFailure(seen, key)) expect(lines).toContain(expected)

  const { line, record, comments, view } = seen.gate[key]
  expect(line).toMatchObject({ pr: pull.number, result: 'failed', stage: 'task-link' })
  expect(line.note).toContain(`task link: ${reason}`)
  expect(record).toMatchObject({ head_sha: pull.head, result: 'failed' })
  const gate = latestGateComment(comments, { pr: pull.number, lead: LEAD })
  expect(gate?.marker).toMatchObject({ pr: pull.number, sha: pull.head, stage: 'task-link' })
  expect(gate?.comment.body).toContain('failed at stage 2, task link')
  expect(gate?.comment.body).toContain(`(\`${reason}\`)`)
  expect(view.labels).toContain('gate:failed')
  expect(seen.pullsAfter[key]).toMatchObject({ state: 'open', merged: false })
  expect(seen.main).toBe(seen.bootstrap)
}

/**
 * The lines of what CI printed, each without the time that a log of GitHub Actions puts first and
 * without the indent of the runner's error lines (contracts 3.3), so that a test compares whole
 * lines.
 * @param {string} text
 * @returns {string[]}
 */
export function ciLines(text) {
  return text.split(/\r?\n/).map((line) => line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, '').trim())
}

/**
 * The lines with which CI fails each pull request of `taskLinkFailures` at step 2: the message
 * of its reason (`checkTaskLinkStep` in src/internal/ci/index.js), the rule, and the issue it
 * names with what is wrong with it. Each reason has a message of its own, so a pull request that
 * fails for another reason does not match.
 * @param {Record<string, any>} seen
 * @param {keyof typeof LINK_REASONS} key
 * @returns {string[]}
 */
function ciFailure(seen, key) {
  const { sort, done, note } = seen.numbers
  const failed = (/** @type {string} */ message) =>
    `hackwin internal ci: blocked: step 2, task link: ${message}`
  const E11 = 'rule: E11: one issue, one pull request; the pull request names a valid open task'
  switch (key) {
    case 'invalid':
      return [
        failed(`issue #${sort} is not a task with a valid data block`),
        E11,
        `- issue #${sort}: paths[0] (src/features/greeting/**) lies in the role greeting, not in the task's role todos`,
      ]
    case 'closed':
      return [failed(`issue #${done} is not an open issue`), E11, `- issue #${done}`]
    case 'none':
      return [failed('the body has no line `Closes #<N>` that names the task'), E11]
    case 'notTask':
      return [
        failed(`issue #${note} is not a task with a valid data block`),
        E11,
        `- issue #${note}: no # hackwin:task block`,
      ]
    case 'spike':
      return [
        failed(`${seen.pulls.spike.branch} is a spike/ branch, which is never merged`),
        'rule: E16: spike/ branches are never merged',
      ]
  }
}

/**
 * AC71, last part: a pull request of the Lead that changes a generated wrapper by hand passes
 * `ship`, which has no E19 check (10.5), and fails CI at its generated file step.
 * @param {Record<string, any>} seen The record of `taskLinkFailures`.
 */
export function expectWrapperEditFails(seen) {
  const { wrapper } = seen.numbers
  const pull = seen.wrapperPull
  expect(seen.wrapperShip.code).toBe(0)
  expect(pull.author.toLowerCase()).toBe(LEAD.toLowerCase())
  expect(pull.headSha).toBe(seen.wrapperHead)
  const ci = seen.wrapperCi
  expect(ci.passed).toBe(false)
  expect(ci.head).toBe(seen.wrapperHead)
  const lines = ciLines(ci.text)
  expect(lines).toContain(
    `step 2, task link: ${pull.headRef} closes task #${wrapper}, an open task with a valid data block`,
  )
  expect(lines).toContain(`step 3, scope check: 2 changed files inside the roles of ${LEAD}`)
  expect(lines).toContain(
    `hackwin internal ci: blocked: step 6, generated files: 1 generated file of the branch differs from the output of hackwin ${VERSION}`,
  )
  expect(lines).toContain('rule: E19: generated wrappers and hook shims are not edited by hand')
  expect(lines).toContain(
    `- ${seen.wrapperFile}: its content differs from what hackwin ${VERSION} generates`,
  )
}

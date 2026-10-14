import { describe, expect, test } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { accounts, createFakeGitHub, hackwinObject, yaml } from '../../harness/index.js'
import {
  agentBin,
  asFork,
  expectInOrder,
  promptFileOf,
  take,
  task,
  teamFixture,
  worktreeOf,
} from './helpers.js'

/** @typedef {import('../../harness/index.js').Fixture} Fixture */

const LEAD = accounts.lead.login
const BUILDER1 = accounts.builder1.login // counter, todos
const BUILDER2 = accounts.builder2.login // greeting

const COUNTER = ['src/features/counter/**']

/**
 * Task 7 of the role counter, titled "Counter reset", with these labels and assignees.
 * @param {string[]} labels
 * @param {string[]} [assignees]
 */
function counterReset(labels, assignees = []) {
  return task(7, { title: 'Counter reset', role: 'counter', paths: COUNTER, labels, assignees })
}

/**
 * The open pull request of task 7, from its branch in this repository.
 * @param {{ number?: number, labels?: string[], author?: string, comments?: Array<{ body: string, author: string }> }} [options]
 */
function counterResetPull({ number = 20, labels = [], author = BUILDER1, comments = [] } = {}) {
  return {
    number,
    title: 'Counter reset',
    head: 'task/7-counter-reset',
    body: 'Closes #7',
    author,
    labels,
    comments,
    files: [{ path: 'src/features/counter/reset.js', status: 'added', previousPath: null }],
  }
}

/**
 * A team fixture, builder1's joined clone, and a first `take 7` of "Counter reset" in it.
 * @param {string} name
 * @param {Parameters<typeof teamFixture>[1]} [edit]
 */
async function takenCounterReset(name, edit) {
  const fixture = await teamFixture(name, edit)
  const clone = await fixture.joinedClone({ name: 'builder1', login: BUILDER1 })
  const first = await take(
    fixture,
    clone.path,
    createFakeGitHub({ issues: [counterReset(['ready'])] }),
    BUILDER1,
    ['7'],
  )
  expect(first.code, first.stderr).toBe(0)
  return { fixture, clone, worktree: worktreeOf(fixture, 'builder1', '7-counter-reset') }
}

describe("AC52: take <N> on the caller's own in-progress task reopens the worktree with a continue prompt. After a take whose install failed, take <N> finishes the remaining steps and gives the first prompt. take <N> --release returns the task to ready and frees the session slot. take <N> on a task whose PR is gate:failed brings the local branch up to the remote branch, including a commit that reached the remote branch from elsewhere", () => {
  test('a resume reopens the same worktree with a continue prompt that holds the seven parts and the state of the branch; checks 4 and 5 count neither the task nor its own pull request', async () => {
    // builder1 runs one session at a time, so check 5 passes only without the task itself.
    const { fixture, clone, worktree } = await takenCounterReset('continue', (hackwin) => {
      hackwin.team.members[1].sessions = 1
    })
    // The session committed work, left a file uncommitted and stopped. main moved meanwhile.
    const work = await fixture.commit('Reset button', {
      dir: worktree.path,
      files: { 'src/features/counter/reset.js': 'export const reset = () => 0\n' },
    })
    writeFileSync(join(worktree.path, 'src/features/counter/draft.js'), 'export const draft = 1\n')
    const main = await fixture.publish(
      { 'src/features/todos/list.js': 'export const list = []\n' },
      { message: 'Todos' },
    )
    // Its own pull request is open, as after a ship that stopped before step 14.
    const fake = createFakeGitHub({
      issues: [counterReset(['in-progress', 'role:counter'], [BUILDER1])],
      pulls: [counterResetPull()],
    })
    const agents = agentBin(fixture, 'continue')

    const result = await take(fixture, clone.path, fake, BUILDER1, ['7'], {
      env: agents.env,
      tty: true,
    })
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain(
      'resuming #7 Counter reset (role counter): in progress, assigned to you',
    )
    expect(result.stdout).toContain(`#7 stays in-progress, assigned to ${BUILDER1}`)
    expect(result.stdout).toContain(`worktree: ${worktree.path} on task/7-counter-reset, reused`)
    expect(result.stderr).toContain(
      `warning: task/7-counter-reset lacks commits of origin/main ${main.slice(0, 12)}, which take did not merge: the worktree has uncommitted changes or untracked files; \`hackwin ship\` merges origin/main before it checks the branch`,
    )
    expect(await worktree.git.revParse('HEAD')).toBe(work)
    expect(existsSync(join(worktree.path, 'src/features/counter/draft.js'))).toBe(true)

    const promptFile = promptFileOf(clone, 7)
    expect(result.stdout).toContain(`continue prompt: ${promptFile}`)
    const prompt = readFileSync(promptFile, 'utf8')
    expect(agents.call('claude')).toEqual({ cwd: worktree.path, args: [prompt] })
    expectInOrder(prompt, [
      '# Task #7: Counter reset',
      'You continue this one task in its own worktree.',
      'do not start over',
      '## 1. The task',
      '## 2. Your role and its paths',
      '## 3. Where to run',
      `- Worktree: \`${worktree.path}\``,
      '## 4. What changed on main',
      'Files changed on main since',
      '- A `src/features/todos/list.js`',
      '## 5. When you finish',
      '## 6. Security',
      '## 7. Personal settings',
      '## 8. The state of the branch',
      `- \`task/7-counter-reset\` is at \`${work}\`.`,
      '- `take` did not merge `origin/main`: the worktree has uncommitted changes or untracked files.',
      `- It does not contain \`origin/main\` at \`${main}\`.`,
      '- `origin/task/7-counter-reset` does not exist: the branch was never pushed.',
      '- Its own commits, which `origin/main` lacks, newest first:',
      `  - \`${work.slice(0, 12)}\` Reset button`,
      '- Uncommitted changes and untracked files in the worktree',
      '?? src/features/counter/draft.js',
    ])

    // The labels, the assignee and the worktree stay as they were.
    expect(fake.find(7)?.labels.sort()).toEqual(['in-progress', 'role:counter'])
    expect(fake.find(7)?.assignees).toEqual([BUILDER1])
    const worktrees = await clone.git.worktreeList()
    expect(worktrees.filter((entry) => entry.branch?.startsWith('task/7-'))).toHaveLength(1)
    fixture.cleanup()
  })

  test('after a take whose install failed, take <N> finishes the remaining steps and gives the first prompt', async () => {
    const fixture = await teamFixture(
      'install-resume',
      (hackwin) => {
        hackwin.commands.install = "echo 'npm ERR! code E404' >&2; exit 7"
      },
      { 'package.json': '{}\n' },
    )
    const clone = await fixture.joinedClone({ name: 'builder1', login: BUILDER1 })
    const fake = createFakeGitHub({ issues: [counterReset(['ready'])] })
    const failed = await take(fixture, clone.path, fake, BUILDER1, ['7'])
    expect(failed.code).toBe(1)
    expect(existsSync(promptFileOf(clone, 7))).toBe(false)

    // The install is fixed on main.
    const hackwin = hackwinObject(3)
    hackwin.commands.install = 'pwd -P > .install-ran'
    await fixture.publish({ 'hackwin.yml': yaml(hackwin) }, { message: 'Fix the install' })

    const result = await take(fixture, clone.path, fake, BUILDER1, ['7'])
    expect(result.code, result.stderr).toBe(0)
    const worktree = worktreeOf(fixture, 'builder1', '7-counter-reset')
    expect(result.stdout).toContain(
      'resuming #7 Counter reset (role counter): in progress, assigned to you',
    )
    expect(result.stdout).toContain(`install passed in ${worktree.path}: pwd -P > .install-ran`)
    const promptFile = promptFileOf(clone, 7)
    expect(result.stdout).toContain(`\nprompt: ${promptFile}`)
    expect(result.stdout).not.toContain('continue prompt')
    const prompt = readFileSync(promptFile, 'utf8')
    expect(prompt).toContain('You work on this one task in its own worktree.')
    expect(prompt).toContain('## 7. Personal settings')
    expect(prompt).not.toContain('## 8.')
    expect(fake.find(7)?.labels).toContain('in-progress')
    expect(fake.find(7)?.assignees).toEqual([BUILDER1])
    fixture.cleanup()
  })

  test('take <N> --release returns the task to ready and frees the session slot; the branch and the worktree stay, and a second release changes nothing', async () => {
    const fixture = await teamFixture('release', (hackwin) => {
      hackwin.team.members[1].sessions = 1
    })
    const clone = await fixture.joinedClone({ name: 'builder1', login: BUILDER1 })
    const fake = createFakeGitHub({
      issues: [
        task(7, { role: 'counter', paths: COUNTER }),
        task(8, { role: 'todos', paths: ['src/features/todos/**'] }),
      ],
    })
    expect((await take(fixture, clone.path, fake, BUILDER1, ['7'])).code).toBe(0)
    const full = await take(fixture, clone.path, fake, BUILDER1, ['8'])
    expect(full.code).toBe(1)
    expect(full.stderr).toContain('#8 cannot be taken: you already run 1 task: #7')

    const released = await take(fixture, clone.path, fake, BUILDER1, ['7', '--release'])
    expect(released.code, released.stderr).toBe(0)
    const worktree = worktreeOf(fixture, 'builder1', '7-task-7')
    expect(released.stdout).toContain(
      `released #7 Task 7: ready, ${BUILDER1} is no longer assigned; the branch task/7-task-7 and its worktree ${worktree.path} stay for the next take`,
    )
    expect(fake.find(7)?.labels.sort()).toEqual(['ready', 'role:counter'])
    expect(fake.find(7)?.assignees).toEqual([])
    expect(await clone.git.tryRevParse('refs/heads/task/7-task-7')).not.toBeNull()
    expect(await worktree.git.currentBranch()).toBe('task/7-task-7')

    // The session slot is free.
    expect((await take(fixture, clone.path, fake, BUILDER1, ['8'])).code).toBe(0)

    const again = await take(fixture, clone.path, fake, BUILDER1, ['7', '--release'])
    expect(again.code, again.stderr).toBe(0)
    expect(again.stdout).toContain(
      '#7 is already ready and not assigned to you: nothing to release',
    )
    expect(fake.find(7)?.labels.sort()).toEqual(['ready', 'role:counter'])
    fixture.cleanup()
  })

  test("take <N> on a task whose pull request is gate:failed brings the local branch up to the remote branch, including a commit that reached it from elsewhere, and gives a fix prompt with the Gate's comment", async () => {
    const { fixture, clone, worktree } = await takenCounterReset('fix')
    // ship pushed the work, a teammate pushed a commit onto the branch, the Gate failed the PR.
    const shipped = await fixture.commit('Reset button', {
      dir: worktree.path,
      files: { 'src/features/counter/reset.js': 'export const reset = () => 0\n' },
      push: true,
    })
    const elsewhere = await fixture.publish(
      { 'src/features/counter/note.md': 'from elsewhere\n' },
      { message: 'A commit from elsewhere', branch: 'task/7-counter-reset' },
    )
    const fake = createFakeGitHub({
      issues: [counterReset(['in-review', 'role:counter'], [BUILDER1])],
      pulls: [
        counterResetPull({
          labels: ['gate:failed', 'needs-owner'],
          comments: [
            {
              body: 'Stage 7, merge test: `npm run check` failed.\n\nFix it on the branch.',
              author: LEAD,
            },
            { body: 'I pushed a note onto your branch.', author: BUILDER2 },
          ],
        }),
      ],
    })
    const agents = agentBin(fixture, 'fix')

    const result = await take(fixture, clone.path, fake, BUILDER1, ['7'], {
      env: agents.env,
      tty: true,
    })
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain(
      'reopening #7 Counter reset (role counter): the Gate handed its pull request #20 back (gate:failed)',
    )
    expect(result.stdout).toContain(
      `fast-forwarded task/7-counter-reset to origin/task/7-counter-reset ${elsewhere.slice(0, 12)}`,
    )
    expect(await worktree.git.revParse('HEAD')).toBe(elsewhere)
    expect(readFileSync(join(worktree.path, 'src/features/counter/note.md'), 'utf8')).toBe(
      'from elsewhere\n',
    )

    const promptFile = promptFileOf(clone, 7)
    expect(result.stdout).toContain(`fix prompt: ${promptFile}`)
    const prompt = readFileSync(promptFile, 'utf8')
    expect(agents.call('claude')).toEqual({ cwd: worktree.path, args: [prompt] })
    expectInOrder(prompt, [
      'You fix this one task in its own worktree.',
      '## 1. The task',
      '## 5. When you finish',
      '## 7. Personal settings',
      "## 8. The Gate's comment",
      `The Gate handed pull request #20 (https://github.com/${fake.state.repo}/pull/20) back: it is labeled \`gate:failed\`, \`needs-owner\`.`,
      "The Gate's comment, ",
      '> Stage 7, merge test: `npm run check` failed.',
      '>\n> Fix it on the branch.',
      '`hackwin ship` updates pull request #20.',
      '## 9. The state of the branch',
      `- \`task/7-counter-reset\` is at \`${elsewhere}\`.`,
      '- `take` fast-forwarded it to `origin/task/7-counter-reset`.',
      '- It contains `origin/main`',
      '- `origin/task/7-counter-reset` is at the same commit.',
      `  - \`${elsewhere.slice(0, 12)}\` A commit from elsewhere`,
      `  - \`${shipped.slice(0, 12)}\` Reset button`,
      '- The worktree has no uncommitted changes and no untracked files.',
    ])
    expect(prompt).not.toContain('I pushed a note onto your branch.')

    // The task stays in review (8.3), and no warning repeats the pull request being fixed.
    expect(fake.find(7)?.labels.sort()).toEqual(['in-review', 'role:counter'])
    expect(fake.find(7)?.assignees).toEqual([BUILDER1])
    expect(result.stderr).not.toContain('PR #20')
    fixture.cleanup()
  })
})

describe("1.5c/fix: a fix merges the remote branch into local commits, makes a missing branch from the remote one, and is refused for a pull request that is not the caller's or not handed back", () => {
  test('local commits that were not pushed get a merge of the remote branch, never a rebase', async () => {
    const { fixture, clone, worktree } = await takenCounterReset('fix-merge')
    await fixture.commit('Reset button', {
      dir: worktree.path,
      files: { 'src/features/counter/reset.js': 'export const reset = () => 0\n' },
      push: true,
    })
    const local = await fixture.commit('Local fix, not pushed', {
      dir: worktree.path,
      files: { 'src/features/counter/reset.js': 'export const reset = () => 0 // fixed\n' },
    })
    const remote = await fixture.publish(
      { 'src/features/counter/note.md': 'from elsewhere\n' },
      { message: 'A commit from elsewhere', branch: 'task/7-counter-reset' },
    )
    const fake = createFakeGitHub({
      issues: [counterReset(['in-review', 'role:counter'], [BUILDER1])],
      pulls: [counterResetPull({ labels: ['gate:failed'] })],
    })
    const result = await take(fixture, clone.path, fake, BUILDER1, ['7'])
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain(
      `merged origin/task/7-counter-reset ${remote.slice(0, 12)} into task/7-counter-reset`,
    )
    const parents = await worktree.git.run(['rev-list', '--parents', '-n', '1', 'HEAD'])
    expect(parents.stdout.trim().split(' ').slice(1)).toEqual([local, remote])
    const prompt = readFileSync(promptFileOf(clone, 7), 'utf8')
    expect(prompt).toContain('- `take` merged `origin/task/7-counter-reset` into it.')
    expect(prompt).toContain('the branch has 2 commits that it lacks.')
    fixture.cleanup()
  })

  test('without a local worktree and branch, the branch is made from the remote branch of the pull request', async () => {
    const { fixture, clone, worktree } = await takenCounterReset('fix-remote')
    const shipped = await fixture.commit('Reset button', {
      dir: worktree.path,
      files: { 'src/features/counter/reset.js': 'export const reset = () => 0\n' },
      push: true,
    })
    await clone.git.worktreeRemove(worktree.path, { force: true })
    await clone.git.run(['branch', '-D', 'task/7-counter-reset'])
    const fake = createFakeGitHub({
      issues: [counterReset(['in-review', 'role:counter'], [BUILDER1])],
      pulls: [counterResetPull({ labels: ['gate:failed'] })],
    })
    const result = await take(fixture, clone.path, fake, BUILDER1, ['7'])
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain(
      `worktree: ${worktree.path} on task/7-counter-reset, new from origin/task/7-counter-reset`,
    )
    expect(await worktree.git.revParse('HEAD')).toBe(shipped)
    expect(await worktree.git.currentBranch()).toBe('task/7-counter-reset')
    fixture.cleanup()
  })

  test('a worktree of the task on another branch than its pull request exits 2 and changes nothing', async () => {
    const { fixture, clone, worktree } = await takenCounterReset('fix-other-branch')
    const fake = createFakeGitHub({
      issues: [counterReset(['in-review', 'role:counter'], [BUILDER1])],
      pulls: [{ ...counterResetPull({ labels: ['gate:failed'] }), head: 'task/7-renamed' }],
    })
    const result = await take(fixture, clone.path, fake, BUILDER1, ['7'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain(
      `the worktree of #7 at ${worktree.path} is on task/7-counter-reset, but its pull request #20 comes from task/7-renamed`,
    )
    expect(result.stderr).toContain(
      `to resolve: run \`git worktree remove ${worktree.path}\` in ${clone.path}`,
    )
    expect(fake.find(7)?.labels.sort()).toEqual(['in-review', 'role:counter'])
    fixture.cleanup()
  })

  test.each([
    ['its pull request waits for the Gate', [], [BUILDER1], BUILDER1, false],
    ['its pull request comes from a fork', ['gate:failed'], [BUILDER1], BUILDER1, true],
    ["it is someone else's", ['gate:failed'], [BUILDER2], BUILDER2, false],
  ])('a task in review is not reopened when %s', async (_, labels, assignees, author, fork) => {
    const fixture = await teamFixture('fix-refused')
    const clone = await fixture.joinedClone({ name: 'builder1', login: BUILDER1 })
    const fake = createFakeGitHub({
      issues: [counterReset(['in-review', 'role:counter'], assignees)],
      pulls: [counterResetPull({ labels, author })],
    })
    if (fork) asFork(fake, [20])
    const result = await take(fixture, clone.path, fake, BUILDER1, ['7'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('#7 cannot be taken: #7 is in review')
    expect(existsSync(join(fixture.dir, 'builder1.worktrees'))).toBe(false)
    fixture.cleanup()
  })
})

describe('1.5c/resume: a claim left half done is resumed, and a resume still runs checks 1 to 4', () => {
  test('a task in progress without an assignee, branch or worktree gets the assignee, the worktree and the first prompt', async () => {
    const fixture = await teamFixture('half-claim')
    const clone = await fixture.joinedClone({ name: 'builder1', login: BUILDER1 })
    const fake = createFakeGitHub({ issues: [counterReset(['in-progress'])] })
    const result = await take(fixture, clone.path, fake, BUILDER1, ['7'])
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain(
      'resuming #7 Counter reset (role counter): in progress without an assignee, a claim an earlier take left half done',
    )
    expect(result.stdout).toContain(
      `claimed #7: in-progress, assigned to ${BUILDER1}, labeled role:counter`,
    )
    const worktree = worktreeOf(fixture, 'builder1', '7-counter-reset')
    expect(await worktree.git.revParse('HEAD')).toBe(await clone.git.revParse('origin/main'))
    expect(fake.find(7)?.labels.sort()).toEqual(['in-progress', 'role:counter'])
    expect(fake.find(7)?.assignees).toEqual([BUILDER1])
    const prompt = readFileSync(promptFileOf(clone, 7), 'utf8')
    expect(prompt).toContain('You work on this one task in its own worktree.')
    expect(
      JSON.parse((await take(fixture, clone.path, fake, BUILDER1, ['7', '--json'])).stdout).data,
    ).toMatchObject({
      mode: 'resume',
      prompt: { kind: 'continue' },
    })
    fixture.cleanup()
  })

  test('a claim left half done is not resumed by a member who lacks the role (check 1)', async () => {
    const fixture = await teamFixture('half-claim-role')
    const clone = await fixture.joinedClone({ name: 'builder2', login: BUILDER2 })
    const fake = createFakeGitHub({ issues: [counterReset(['in-progress'])] })
    const result = await take(fixture, clone.path, fake, BUILDER2, ['7'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('#7 cannot be resumed: #7 is a task of the role counter')
    expect(fake.find(7)?.assignees).toEqual([])
    fixture.cleanup()
  })

  test('a pull request of a fork from a branch of the same name is no pull request of the task: check 4 counts it', async () => {
    const fixture = await teamFixture('resume-fork')
    const clone = await fixture.joinedClone({ name: 'builder1', login: BUILDER1 })
    const fake = createFakeGitHub({
      issues: [counterReset(['in-progress', 'role:counter'], [BUILDER1])],
      pulls: [counterResetPull({ number: 21, author: BUILDER2 })],
    })
    asFork(fake, [21])
    const result = await take(fixture, clone.path, fake, BUILDER1, ['7'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain(
      '#7 cannot be resumed: path collision with PR #21: src/features/counter/reset.js',
    )
    fixture.cleanup()
  })
})

describe('1.5c/main: take, a resume included, starts from the current origin/main or says why it cannot', () => {
  test('a branch that a failed `git worktree add -b` left behind moves to the current origin/main', async () => {
    const fixture = await teamFixture('leftover-branch')
    const clone = await fixture.joinedClone({ name: 'builder1', login: BUILDER1 })
    const fake = createFakeGitHub({ issues: [counterReset(['ready'])] })
    // Something sits at the path of the worktree, so `git worktree add -b` fails after it made
    // the branch.
    const worktree = worktreeOf(fixture, 'builder1', '7-counter-reset')
    mkdirSync(worktree.path, { recursive: true })
    writeFileSync(join(worktree.path, 'notes.txt'), 'not a worktree\n')
    const failed = await take(fixture, clone.path, fake, BUILDER1, ['7'])
    expect(failed.code).toBe(2)
    const old = await clone.git.revParse('refs/heads/task/7-counter-reset')
    expect(old).toBe(await clone.git.revParse('origin/main'))

    rmSync(worktree.path, { recursive: true })
    const main = await fixture.publish(
      { 'src/shared/types.js': 'export {}\n' },
      { message: 'Types' },
    )
    const result = await take(fixture, clone.path, fake, BUILDER1, ['7'])
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain(
      `worktree: ${worktree.path} on task/7-counter-reset, added for the existing branch`,
    )
    expect(result.stdout).toContain(
      `fast-forwarded task/7-counter-reset to origin/main ${main.slice(0, 12)}`,
    )
    expect(await worktree.git.revParse('HEAD')).toBe(main)
    fixture.cleanup()
  })

  test('a resume of a branch with commits of its own and a clean worktree merges the current origin/main', async () => {
    const { fixture, clone, worktree } = await takenCounterReset('resume-merge')
    const work = await fixture.commit('Reset button', {
      dir: worktree.path,
      files: { 'src/features/counter/reset.js': 'export const reset = () => 0\n' },
    })
    const main = await fixture.publish(
      { 'src/features/todos/list.js': 'export const list = []\n' },
      { message: 'Todos' },
    )
    const fake = createFakeGitHub({
      issues: [counterReset(['in-progress', 'role:counter'], [BUILDER1])],
    })
    const result = await take(fixture, clone.path, fake, BUILDER1, ['7'])
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain(
      `merged origin/main ${main.slice(0, 12)} into task/7-counter-reset`,
    )
    const head = await worktree.git.run(['log', '-1', '--format=%P%n%s'])
    expect(head.stdout.trim().split('\n')).toEqual([
      `${work} ${main}`,
      'Merge origin/main into task/7-counter-reset',
    ])
    const prompt = readFileSync(promptFileOf(clone, 7), 'utf8')
    expectInOrder(prompt, [
      '## 8. The state of the branch',
      '- `take` merged `origin/main` into it.',
      `- It contains \`origin/main\` at \`${main}\`.`,
      `\` Merge origin/main into task/7-counter-reset`,
      `  - \`${work.slice(0, 12)}\` Reset button`,
    ])
    fixture.cleanup()
  })

  test('a merge of origin/main that conflicts is undone, and take says why the branch does not contain it', async () => {
    const { fixture, clone, worktree } = await takenCounterReset('resume-conflict')
    const work = await fixture.commit('Shared types, mine', {
      dir: worktree.path,
      files: { 'src/features/counter/types.js': 'export const kind = "mine"\n' },
    })
    const main = await fixture.publish(
      { 'src/features/counter/types.js': 'export const kind = "theirs"\n' },
      { message: 'Shared types, theirs' },
    )
    const fake = createFakeGitHub({
      issues: [counterReset(['in-progress', 'role:counter'], [BUILDER1])],
    })
    const result = await take(fixture, clone.path, fake, BUILDER1, ['7'])
    expect(result.code, result.stderr).toBe(0)
    expect(result.stderr).toContain(
      `warning: task/7-counter-reset lacks commits of origin/main ${main.slice(0, 12)}, which take did not merge: the merge conflicts in 1 file, so it was undone: src/features/counter/types.js`,
    )
    expect(await worktree.git.revParse('HEAD')).toBe(work)
    expect(await worktree.git.isClean()).toBe(true)
    expect(await worktree.git.tryRevParse('MERGE_HEAD')).toBeNull()
    const prompt = readFileSync(promptFileOf(clone, 7), 'utf8')
    expect(prompt).toContain(
      '- `take` did not merge `origin/main`: the merge conflicts in 1 file, so it was undone: `src/features/counter/types.js`.',
    )
    expect(prompt).toContain(`- It does not contain \`origin/main\` at \`${main}\`.`)
    fixture.cleanup()
  })
})

describe('1.5c/release: take <N> --release releases only your own task in progress', () => {
  test.each([
    [
      'in review',
      ['in-review', 'role:counter'],
      [BUILDER1],
      '#7 cannot be released: it is in-review, not in progress',
    ],
    [
      "someone else's",
      ['in-progress', 'role:counter'],
      [BUILDER2],
      `#7 cannot be released: it is in progress, assigned to ${BUILDER2}, not to you`,
    ],
  ])('a task %s is refused', async (_, labels, assignees, message) => {
    const fixture = await teamFixture('release-refused')
    const clone = await fixture.joinedClone({ name: 'builder1', login: BUILDER1 })
    const fake = createFakeGitHub({ issues: [counterReset(labels, assignees)] })
    const result = await take(fixture, clone.path, fake, BUILDER1, ['7', '--release'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain(message)
    expect(result.stderr).toContain('rule: take --release: only your own task in progress')
    expect(fake.find(7)?.labels.sort()).toEqual([...labels].sort())
    fixture.cleanup()
  })

  test('a claim left half done is released by a holder of the role, and not by anyone else', async () => {
    const fixture = await teamFixture('release-half')
    const builder1 = await fixture.joinedClone({ name: 'builder1', login: BUILDER1 })
    const builder2 = await fixture.joinedClone({ name: 'builder2', login: BUILDER2 })
    const fake = createFakeGitHub({ issues: [counterReset(['in-progress'])] })
    const refused = await take(fixture, builder2.path, fake, BUILDER2, ['7', '--release'])
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain('#7 cannot be released: you do not hold the role counter')
    const released = await take(fixture, builder1.path, fake, BUILDER1, ['7', '--release'])
    expect(released.code, released.stderr).toBe(0)
    expect(released.stdout).toContain(
      'released #7 Counter reset: ready, it had no assignee; it has no local branch yet',
    )
    expect(fake.find(7)?.labels).toEqual(['ready'])
    fixture.cleanup()
  })
})

describe('AC54/take: with core.hooksPath unset in a joined clone, take sets it again', () => {
  test('a first take, a resume and a release each set it again', async () => {
    const fixture = await teamFixture('hooks')
    const clone = await fixture.joinedClone({ name: 'builder1', login: BUILDER1 })
    const fake = createFakeGitHub({ issues: [counterReset(['ready'])] })
    const warning =
      'warning: core.hooksPath was not set, so the git hooks were off; set it to .githooks (E20)'
    for (const args of [['7'], ['7'], ['7', '--release']]) {
      await clone.git.run(['config', '--unset', 'core.hooksPath'])
      const result = await take(fixture, clone.path, fake, BUILDER1, args)
      expect(result.code, result.stderr).toBe(0)
      expect(result.stderr).toContain(warning)
      expect(await clone.git.configGet('core.hooksPath')).toBe('.githooks')
    }
    expect(fake.find(7)?.labels.sort()).toEqual(['ready', 'role:counter'])
    fixture.cleanup()
  })
})

describe("AC32/take: on the builder's machine the next take removes the worktree of a merged task", () => {
  test('a take and a resume after the merge each remove the worktree of the merged task', async () => {
    const fixture = await teamFixture('merged')
    const clone = await fixture.joinedClone({ name: 'builder1', login: BUILDER1 })
    const merged = { number: 6, title: 'Old task', state: 'closed', merged: true, files: [] }
    const fake = createFakeGitHub({
      issues: [counterReset(['ready'])],
      pulls: [
        { ...merged, head: 'task/5-old-task', author: BUILDER1 },
        { ...merged, number: 10, head: 'task/9-older-task', author: BUILDER1 },
      ],
    })
    const old = (issue, slug) => join(fixture.dir, 'builder1.worktrees', `${issue}-${slug}`)
    /** @param {string} path @param {string} branch */
    const addWorktree = (path, branch) =>
      clone.git.worktreeAdd(path, { branch, createBranch: true, startPoint: 'origin/main' })

    await addWorktree(old(5, 'old-task'), 'task/5-old-task')
    const first = await take(fixture, clone.path, fake, BUILDER1, ['7'])
    expect(first.code, first.stderr).toBe(0)
    expect(first.stdout).toContain(`removed the worktree of a merged task: ${old(5, 'old-task')}`)
    expect(existsSync(old(5, 'old-task'))).toBe(false)

    await addWorktree(old(9, 'older-task'), 'task/9-older-task')
    const resume = await take(fixture, clone.path, fake, BUILDER1, ['7'])
    expect(resume.code, resume.stderr).toBe(0)
    expect(resume.stdout).toContain('resuming #7')
    expect(resume.stdout).toContain(
      `removed the worktree of a merged task: ${old(9, 'older-task')}`,
    )
    expect(existsSync(old(9, 'older-task'))).toBe(false)
    expect(existsSync(worktreeOf(fixture, 'builder1', '7-counter-reset').path)).toBe(true)
    fixture.cleanup()
  })
})

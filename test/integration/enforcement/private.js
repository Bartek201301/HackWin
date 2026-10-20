// The scenario on hackwin-fixture-private, where GitHub refuses rule sets and push protection
// (docs/verification.md E3 and section 5): the refusing case of AC80, and an outsider's task issue
// across the layers (the scope change on #27 from the Lead's review of PR #73).
//
// The team is the Lead alone (the fixture team of 1), so `test-bot-builder` (builder1) is an
// account outside the team of hackwin.yml. It keeps its write access to the repository and opens
// an issue with a valid `# hackwin:task` block. The Lead holds every role, so every refusal below
// comes from the issue's author, not from a scope:
//
// - `status` does not count or list the outsider's issue; `take <N>` exits 2 and names the author
//   (#75); `ship` on a branch of it exits 2 and names the author;
// - a pull request of the Lead that names the issue fails the task link of `internal ci` (#76) and
//   the Gate's stage 2 (#24, #74).
//
// The Lead's own task adds a line with the team's own secret pattern: blocked at commit,
// committed with --no-verify and pushed, it fails CI and the Gate (E6, AC80).

import { parseStatusBody, STATUS_LABEL } from '../../../src/commands/gate/status-issue.js'
import { readPushProtection } from '../../../src/commands/setup/push-protection.js'
import { readProtection } from '../../../src/core/protection/index.js'
import { branchName, slugOf } from '../../../src/core/tasks/index.js'
import { taskWorktreePath } from '../../../src/core/worktrees/index.js'
import { teamConfig } from '../../harness/index.js'
import {
  answersFile,
  checkLog,
  finishedChecks,
  headOf,
  memberClone,
  patiently,
  pullState,
  remoteHead,
} from './live.js'
import {
  QUICK_COMMANDS,
  TEAM_PATTERN,
  TEST_SECRET,
  digestLines,
  digestOf,
  gateStart,
  pullBody,
  startLeadGate,
  stopGate,
  taskBody,
  toolsDir,
  writeFiles,
} from './scene.js'

/** @typedef {import('../../harness/index.js').FixtureRepoContext} FixtureRepoContext */

export const PRIVATE_REPO = 'hackwin-fixture-private'

/** How long the scenario waits for one result of the Gate. */
const GATE_PATIENCE_MS = 30 * 60_000

const SECRET_TASK = Object.freeze({
  title: 'Counter token',
  role: 'counter',
  paths: ['src/features/counter/token/**'],
  acceptance: ['src/features/counter/token/token.check.js'],
})

const OUTSIDER_TASK = Object.freeze({
  title: 'Counter reset',
  role: 'counter',
  paths: ['src/features/counter/reset/**'],
  acceptance: ['src/features/counter/reset/reset.check.js'],
})

/**
 * The answers of `setup`: the fixture team of 1, the Lead alone, on the quick commands, with the
 * team's own secret pattern and a short poll.
 * @param {FixtureRepoContext} repo
 */
function privateAnswers(repo) {
  const answers = structuredClone(teamConfig(1).answers)
  answers.team.lead = repo.logins.lead
  answers.team.members[0].github = repo.logins.lead
  answers.commands = { ...answers.commands, ...QUICK_COMMANDS }
  answers.gate = { poll_seconds: 10, secret_patterns: [TEAM_PATTERN] }
  return { ...answers, language: 'English', explanation_style: 'concise' }
}

/**
 * The scenario on the private fixture repository.
 * @param {FixtureRepoContext} repo
 */
export async function privateScenario(repo) {
  /** @type {Record<string, any>} */
  const o = { repo: repo.repo }
  const lead = repo.github('lead')
  const bin = toolsDir(repo.tempDir)

  const leadMember = await memberClone(repo, 'lead', bin)
  o.setup = await leadMember.run([
    'setup',
    '--answers',
    answersFile(repo, 'setup.yml', privateAnswers(repo)),
  ])
  if (o.setup.code !== 0) throw new Error(`setup exited ${o.setup.code}:\n${o.setup.stderr}`)
  o.protection = await readProtection(lead)
  o.pushProtection = await readPushProtection(lead)
  repo.log(`after setup: ${o.protection.state}, push protection ${o.pushProtection}`)

  const secretIssue = await lead.createIssue({
    title: SECRET_TASK.title,
    body: taskBody(SECRET_TASK),
    labels: ['ready', `role:${SECRET_TASK.role}`],
  })
  o.secretTask = secretIssue.number
  const outsiderIssue = await repo.github('builder1').createIssue({
    title: OUTSIDER_TASK.title,
    body: taskBody(OUTSIDER_TASK),
    labels: ['ready', `role:${OUTSIDER_TASK.role}`],
  })
  o.outsiderTask = outsiderIssue.number
  o.outsiderAuthor = (await lead.getIssue(o.outsiderTask))?.author ?? null
  repo.log(`tasks: secret #${o.secretTask}, outsider's #${o.outsiderTask} by ${o.outsiderAuthor}`)

  // The Lead's task with the secret.
  const secret = {
    path: taskWorktreePath(leadMember.path, o.secretTask, slugOf(SECRET_TASK.title)),
    branch: branchName(o.secretTask, SECRET_TASK.title),
  }
  o.secretTake = await leadMember.run(['take', String(o.secretTask)])
  o.status = await leadMember.run(['status'])
  o.statusJson = await leadMember.run(['status', '--json'])
  o.outsiderTake = await leadMember.run(['take', String(o.outsiderTask)])

  writeFiles(secret.path, {
    'src/features/counter/token/token.ts': `export const token = '${TEST_SECRET}'\n`,
  })
  await leadMember.git(['add', '--all'], { cwd: secret.path })
  o.secretCommit = await leadMember.git(['commit', '-m', 'Add the counter token'], {
    cwd: secret.path,
  })
  o.secretNoVerify = await leadMember.git(
    ['commit', '--no-verify', '-m', 'Add the counter token'],
    { cwd: secret.path },
  )
  o.secretPush = await leadMember.git(
    ['push', '--no-verify', '-u', 'origin', `HEAD:refs/heads/${secret.branch}`],
    { cwd: secret.path },
  )
  o.secretSha = await headOf(leadMember, secret.path)
  o.secretRemote = await remoteHead(leadMember, secret.branch)
  o.secretPull = (
    await lead.createPullRequest({
      title: SECRET_TASK.title,
      head: secret.branch,
      base: 'main',
      body: pullBody(o.secretTask),
    })
  ).number

  // A branch of the outsider's issue: `ship` refuses it, so it is pushed past the hooks.
  const outsider = {
    path: taskWorktreePath(leadMember.path, o.outsiderTask, slugOf(OUTSIDER_TASK.title)),
    branch: branchName(o.outsiderTask, OUTSIDER_TASK.title),
  }
  await leadMember.git(['fetch', 'origin'])
  await leadMember.git(['worktree', 'add', '-b', outsider.branch, outsider.path, 'origin/main'])
  writeFiles(outsider.path, {
    'src/features/counter/reset/reset.ts': 'export const reset = () => 0\n',
    'src/features/counter/reset/reset.check.js': "console.log('the reset is 0')\n",
  })
  await leadMember.git(['add', '--all'], { cwd: outsider.path })
  o.outsiderCommit = await leadMember.git(['commit', '-m', 'Reset the counter'], {
    cwd: outsider.path,
  })
  o.outsiderShip = await leadMember.run(['ship'], { cwd: outsider.path })
  o.outsiderPush = await leadMember.git(
    ['push', '--no-verify', '-u', 'origin', `HEAD:refs/heads/${outsider.branch}`],
    { cwd: outsider.path },
  )
  o.outsiderSha = await headOf(leadMember, outsider.path)
  o.outsiderPull = (
    await lead.createPullRequest({
      title: OUTSIDER_TASK.title,
      head: outsider.branch,
      base: 'main',
      body: pullBody(o.outsiderTask),
    })
  ).number
  repo.log(`pull requests: secret #${o.secretPull}, outsider's issue #${o.outsiderPull}`)

  const gate = await startLeadGate({
    cwd: leadMember.path,
    env: leadMember.env,
    executor: repo.executor('lead'),
  })
  try {
    o.gateStart = await gateStart(gate, 5 * 60_000)
    if (!('started' in o.gateStart)) throw new Error(`the Gate did not start:\n${gate.out}`)
    o.secretDigest = await digestOf(gate, o.secretPull, 'failed', { timeoutMs: GATE_PATIENCE_MS })
    o.outsiderDigest = await digestOf(gate, o.outsiderPull, 'failed', {
      timeoutMs: GATE_PATIENCE_MS,
    })
  } finally {
    await stopGate(gate, { timeoutMs: 5 * 60_000, log: repo.log })
    o.gateOut = gate.out
    o.notifications = gate.notifications
    o.digest = digestLines(gate.commonDir)
    repo.log(`the Gate printed:\n${gate.out}`)
  }

  for (const key of ['secret', 'outsider']) {
    const checks = await finishedChecks(repo, o[`${key}Sha`])
    o[`${key}Checks`] = checks
    o[`${key}Log`] = await checkLog(repo, checks[0])
    o[`${key}State`] = await pullState(repo, o[`${key}Pull`])
  }
  const statusIssues = await patiently(repo, 'the status issue', () =>
    lead.listIssues({ state: 'open', labels: [STATUS_LABEL] }),
  )
  o.statusIssue = statusIssues.length === 1 ? parseStatusBody(statusIssues[0].body) : null
  o.mainAfter = (await lead.api('repos/{owner}/{repo}/commits/main'))?.sha ?? null
  return o
}

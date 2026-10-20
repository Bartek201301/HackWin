// The scenario on a public fixture repository, where GitHub accepts the rules for everyone, the
// update restriction and push protection (docs/verification.md rows 5 to 7). One `setup` and one
// Gate serve AC47, AC54, AC63 and the offered case of AC80; the scenario returns what each layer
// did, and enforcement.fixture.test.js asserts each criterion on it.
//
// The team is the fixture team of 3 (test/harness/team.js): the Lead holds `shared`, builder1
// (`test-bot-builder`) holds `counter` and `todos` and works with Codex, so no Claude Code hook
// runs for it (AC47), and builder2 is a name only that never acts. Four tasks, written by hand:
//
// | Task    | Taken by | Change                                                 | Criterion  |
// | ------- | -------- | ------------------------------------------------------ | ---------- |
// | outside | builder1 | a file of the Lead's role `shared`                     | AC47       |
// | stale   | Lead     | a generated file that `commands.generate` changes      | AC54       |
// | green   | builder1 | its own files; shipped, green, merged only by the Gate | AC54, AC63 |
// | secret  | builder1 | a line with the team's own secret pattern              | AC80       |
//
// The order is chosen so that no timing of GitHub decides a result:
//
// 1. Push protection off, then `setup`, which turns it on again (AC80), and the tasks.
// 2. builder1 joins; a commit on main (AC54); the outside task, blocked at commit, then committed
//    with --no-verify, pushed and opened (AC47); the Lead's stale task, pushed past `ship`.
// 3. A rule set that the Lead's account can bypass: the Gate refuses to start (AC63). Without it
//    the Gate starts, and the rule set comes back before the green task exists, so its merge
//    must stop at stage 10 with an attention line (AC63).
// 4. The green task: `take` and `ship` with core.hooksPath unset (AC54), a rewritten push (AC54),
//    then the secret task (AC80).
// 5. Once the Gate refused the green merge, the rule set goes; builder1's merges of the green pull
//    request and the Lead's --admin merge of a red one are refused by GitHub (AC63); the deny rule
//    and the PreToolUse hook refuse the Lead's session (AC63); `retry` lets the Gate merge it.
// 6. The CI results and logs, the Gate's comments and labels, the status issue.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseStatusBody, STATUS_LABEL } from '../../../src/commands/gate/status-issue.js'
import { readProtection } from '../../../src/core/protection/index.js'
import { branchName, slugOf } from '../../../src/core/tasks/index.js'
import { taskWorktreePath } from '../../../src/core/worktrees/index.js'
import { teamConfig } from '../../harness/index.js'
import {
  BYPASSABLE_RULESET,
  answersFile,
  bypassableRuleset,
  checkLog,
  finishedChecks,
  ghAs,
  headOf,
  memberClone,
  patiently,
  protectionWhen,
  pullState,
  remoteHead,
  removeBypassable,
  setPushProtection,
  settledPushProtection,
} from './live.js'
import {
  GENERATE,
  GENERATED_FILE,
  GENERATED_SOURCE,
  QUICK_COMMANDS,
  TEAM_PATTERN,
  TEST_SECRET,
  digestLines,
  digestOf,
  gateStart,
  leadSessionMerges,
  mergeCommands,
  pullBody,
  startLeadGate,
  stopGate,
  taskBody,
  toolsDir,
  writeFiles,
} from './scene.js'

/** @typedef {import('../../harness/index.js').FixtureRepoContext} FixtureRepoContext */
/** @typedef {import('./live.js').Member} Member */

/** The public fixture repository of the scenario (not hackwin-fixture-a, which #26 uses). */
export const PUBLIC_REPO = 'hackwin-fixture-b'

/** How long the scenario waits for one result of the Gate. */
const GATE_PATIENCE_MS = 30 * 60_000

/** How long the scenario waits for a Gate to stop after `quit`. */
const STOP_PATIENCE_MS = 5 * 60_000

/** The tasks of the scenario: title, role, paths and acceptance test. */
const TASKS = Object.freeze({
  outside: {
    title: 'Todos filter',
    role: 'todos',
    paths: ['src/features/todos/**'],
    acceptance: ['src/features/todos/filter.check.js'],
  },
  stale: {
    title: 'Shared words',
    role: 'shared',
    paths: ['src/shared/words/**'],
    acceptance: ['src/shared/words/words.check.js'],
  },
  green: {
    title: 'Counter step',
    role: 'counter',
    paths: ['src/features/counter/step/**'],
    acceptance: ['src/features/counter/step/step.check.js'],
  },
  secret: {
    title: 'Counter config',
    role: 'counter',
    paths: ['src/features/counter/config/**'],
    acceptance: ['src/features/counter/config/config.check.js'],
  },
})

/**
 * The answers of `setup` (CM11): the fixture team of 3 on the quick commands, builder1 with Codex,
 * a generate command, the team's own secret pattern and a short poll.
 * @param {FixtureRepoContext} repo
 */
function publicAnswers(repo) {
  const answers = structuredClone(teamConfig(3).answers)
  answers.team.lead = repo.logins.lead
  answers.team.members[0].github = repo.logins.lead
  answers.team.members[1].agent = 'codex'
  answers.commands = { ...answers.commands, ...QUICK_COMMANDS, generate: GENERATE }
  answers.paths = { ...answers.paths, generated: [GENERATED_FILE] }
  answers.gate = { poll_seconds: 10, secret_patterns: [TEAM_PATTERN] }
  return { ...answers, language: 'English', explanation_style: 'concise' }
}

/**
 * The task worktree that `take` makes for a task, and its branch.
 * @param {Member} member
 * @param {number} issue
 * @param {string} title
 */
function worktreeOf(member, issue, title) {
  return {
    path: taskWorktreePath(member.path, issue, slugOf(title)),
    branch: branchName(issue, title),
  }
}

/**
 * Delete the rule set BYPASSABLE_RULESET, and wait until GitHub's reads no longer show a rule that
 * the Lead's account can bypass.
 * @param {FixtureRepoContext} repo
 */
async function deleteBypassable(repo) {
  const { deleted, failed } = await removeBypassable(repo)
  if (deleted.length === 0 || failed.length > 0) {
    throw new Error(
      `the rule set ${BYPASSABLE_RULESET} was not deleted: deleted ${JSON.stringify(deleted)}, failed ${JSON.stringify(failed.map((entry) => entry.id))}`,
    )
  }
  await protectionWhen(
    repo,
    (read) => read.rules.bypassable.length === 0,
    `the rule set ${BYPASSABLE_RULESET} gone`,
  )
}

/**
 * The scenario on the public fixture repository. It turns push protection off and puts it back
 * as it found it, because the reset leaves repository settings alone; it does not run where the
 * setting cannot be read, as `keepingPushProtection` of test/integration/release/live.js.
 * @param {FixtureRepoContext} repo
 */
export async function publicScenario(repo) {
  /** @type {Record<string, any>} */
  const o = { repo: repo.repo }
  o.pushProtectionBefore = await settledPushProtection(repo)
  if (o.pushProtectionBefore === null) {
    throw new Error(
      `the push protection setting of ${repo.repo} could not be read, so it could not be put back after the scenario; the scenario did not run`,
    )
  }
  repo.log(`push protection before the scenario: ${o.pushProtectionBefore}`)
  /** @type {{ error: unknown } | null} */
  let failure = null
  try {
    o.pushProtectionOff = await setPushProtection(repo, 'disabled')
    await scenario(repo, o)
  } catch (error) {
    failure = { error }
  }
  try {
    o.pushProtectionAfter = await setPushProtection(repo, o.pushProtectionBefore)
    repo.log(`push protection after the scenario: ${o.pushProtectionAfter}`)
  } catch (error) {
    // The scenario's own error, when it has one, is the one to report; this one is in the log.
    repo.log(`push protection could not be put back to ${o.pushProtectionBefore}: ${error}`)
    if (failure === null) throw error
  }
  if (failure !== null) throw failure.error
  return o
}

/**
 * @param {FixtureRepoContext} repo
 * @param {Record<string, any>} o The observations.
 */
async function scenario(repo, o) {
  const lead = repo.github('lead')
  const bin = toolsDir(repo.tempDir)

  // 1. setup, and the tasks written by hand.
  const leadMember = await memberClone(repo, 'lead', bin)
  o.setup = await leadMember.run([
    'setup',
    '--answers',
    answersFile(repo, 'setup.yml', publicAnswers(repo)),
  ])
  if (o.setup.code !== 0) throw new Error(`setup exited ${o.setup.code}:\n${o.setup.stderr}`)
  o.protection = await protectionWhen(
    repo,
    (read) => read.state === 'full-restricted',
    'the protection state full-restricted',
  )
  o.pushProtection = await settledPushProtection(repo)
  repo.log(`after setup: ${o.protection.state}, push protection ${o.pushProtection}`)

  /** @type {Record<keyof typeof TASKS, number>} */
  const tasks = /** @type {any} */ ({})
  for (const [key, task] of Object.entries(TASKS)) {
    const issue = await lead.createIssue({
      title: task.title,
      body: taskBody(task),
      labels: ['ready', `role:${task.role}`],
    })
    tasks[/** @type {keyof typeof TASKS} */ (key)] = issue.number
  }
  o.tasks = tasks
  repo.log(`tasks: ${JSON.stringify(tasks)}`)

  // 2. builder1 joins; a commit on main; the outside task; the Lead's stale task.
  const builder = await memberClone(repo, 'builder1', bin)
  o.join = await builder.run([
    'join',
    '--answers',
    answersFile(repo, 'join.yml', { language: 'English', explanation_style: 'concise' }),
  ])
  if (o.join.code !== 0) throw new Error(`join exited ${o.join.code}:\n${o.join.stdout}`)

  const readme = readFileSync(join(builder.path, 'README.md'), 'utf8')
  const mainBefore = await headOf(builder)
  writeFiles(builder.path, { 'README.md': `${readme}\nA fix straight on main.\n` })
  await builder.git(['add', 'README.md'])
  o.mainCommit = await builder.git(['commit', '-m', 'Fix straight on main'])
  o.mainMoved = (await headOf(builder)) !== mainBefore
  await builder.git(['reset', '--hard', 'HEAD'])

  const outside = worktreeOf(builder, tasks.outside, TASKS.outside.title)
  o.outsideTake = await builder.run(['take', String(tasks.outside)])
  const feature = readFileSync(join(outside.path, 'src/shared/feature.ts'), 'utf8')
  writeFiles(outside.path, {
    'src/features/todos/filter.ts': 'export const filter = (done: boolean) => !done\n',
    'src/shared/feature.ts': `${feature}export const filtered = true\n`,
  })
  await builder.git(['add', '--all'], { cwd: outside.path })
  o.outsideCommit = await builder.git(['commit', '-m', 'Filter the todos'], { cwd: outside.path })
  o.outsideNoVerify = await builder.git(['commit', '--no-verify', '-m', 'Filter the todos'], {
    cwd: outside.path,
  })
  o.outsidePush = await builder.git(['push', '-u', 'origin', `HEAD:refs/heads/${outside.branch}`], {
    cwd: outside.path,
  })
  o.outsidePushNoVerify = await builder.git(
    ['push', '--no-verify', '-u', 'origin', `HEAD:refs/heads/${outside.branch}`],
    { cwd: outside.path },
  )
  o.outsideSha = await headOf(builder, outside.path)
  o.outsidePull = (
    await builder.github.createPullRequest({
      title: TASKS.outside.title,
      head: outside.branch,
      base: 'main',
      body: pullBody(tasks.outside),
    })
  ).number
  repo.log(`outside: #${o.outsidePull} at ${o.outsideSha}`)

  const stale = worktreeOf(leadMember, tasks.stale, TASKS.stale.title)
  o.staleTake = await leadMember.run(['take', String(tasks.stale)])
  writeFiles(stale.path, {
    [GENERATED_SOURCE]: 'quiet words\n',
    [GENERATED_FILE]: 'stale words\n',
    'src/shared/words/words.check.js': "console.log('the words are there')\n",
  })
  await leadMember.git(['add', '--all'], { cwd: stale.path })
  o.staleCommit = await leadMember.git(['commit', '-m', 'Add the words'], { cwd: stale.path })
  o.staleShip = await leadMember.run(['ship'], { cwd: stale.path })
  o.stalePush = await leadMember.git(
    ['push', '--no-verify', '-u', 'origin', `HEAD:refs/heads/${stale.branch}`],
    { cwd: stale.path },
  )
  o.staleSha = await headOf(leadMember, stale.path)
  o.stalePull = (
    await lead.createPullRequest({
      title: TASKS.stale.title,
      head: stale.branch,
      base: 'main',
      body: pullBody(tasks.stale),
    })
  ).number
  repo.log(`stale: #${o.stalePull} at ${o.staleSha}`)

  // Steps 3 to 5 create a rule set with an admin bypass twice; it goes on every path, so that it
  // never outlives the scenario on the repository.
  try {
    await gateSteps(repo, o, { lead, leadMember, builder, tasks })
  } finally {
    await removeBypassable(repo).catch((error) =>
      repo.log(`the rule sets ${BYPASSABLE_RULESET} could not be listed: ${error}`),
    )
  }

  // 6. CI, the pull requests and the status issue.
  for (const key of ['outside', 'stale', 'secret']) {
    const checks = await finishedChecks(repo, o[`${key}Sha`])
    o[`${key}Checks`] = checks
    o[`${key}Log`] = await checkLog(repo, checks[0])
  }
  for (const key of ['outside', 'stale', 'secret', 'green']) {
    o[`${key}State`] = await pullState(repo, o[`${key}Pull`])
  }
  const statusIssues = await patiently(repo, 'the status issue', () =>
    lead.listIssues({ state: 'open', labels: [STATUS_LABEL] }),
  )
  o.statusIssue = statusIssues.length === 1 ? parseStatusBody(statusIssues[0].body) : null
  o.mainAfter = (await lead.api('repos/{owner}/{repo}/commits/main'))?.sha ?? null
  o.protectionAfter = await readProtection(lead)
}

/**
 * Steps 3 to 5: the Gate refuses to start, then runs: it refuses the green merge while the Lead
 * can bypass another rule, GitHub refuses the other merges, and after `retry` it merges.
 * @param {FixtureRepoContext} repo
 * @param {Record<string, any>} o The observations.
 * @param {{ lead: import('../../../src/core/github/index.js').GitHub, leadMember: Member, builder: Member, tasks: Record<keyof typeof TASKS, number> }} members
 */
async function gateSteps(repo, o, { lead, leadMember, builder, tasks }) {
  // 3. A rule the Lead's account can bypass: the Gate refuses to start.
  const gateOptions = { cwd: leadMember.path, env: leadMember.env, executor: repo.executor('lead') }
  await lead.api('repos/{owner}/{repo}/rulesets', { method: 'POST', body: bypassableRuleset() })
  o.bypassableAtStart = (
    await protectionWhen(
      repo,
      (read) => read.rules.bypassable.some((rule) => rule.ruleset === BYPASSABLE_RULESET),
      `the rule set ${BYPASSABLE_RULESET} in force`,
    )
  ).rules
  const refused = await startLeadGate(gateOptions)
  try {
    o.gateRefusal = await gateStart(refused, 5 * 60_000)
  } finally {
    // Stopped on every path, so that no Gate polls the repository after the lock is released.
    await stopGate(refused, { timeoutMs: STOP_PATIENCE_MS, log: repo.log })
    o.gateRefusalOut = refused.out
  }
  await deleteBypassable(repo)

  const gate = await startLeadGate(gateOptions)
  try {
    o.gateStart = await gateStart(gate, 5 * 60_000)
    if (!('started' in o.gateStart)) throw new Error(`the Gate did not start:\n${gate.out}`)
    await lead.api('repos/{owner}/{repo}/rulesets', {
      method: 'POST',
      body: bypassableRuleset(),
    })
    await protectionWhen(
      repo,
      (read) => read.rules.bypassable.some((rule) => rule.ruleset === BYPASSABLE_RULESET),
      `the rule set ${BYPASSABLE_RULESET} in force again`,
    )

    // 4. The green task, with core.hooksPath unset before take and before ship.
    const green = worktreeOf(builder, tasks.green, TASKS.green.title)
    await builder.git(['config', '--unset', 'core.hooksPath'])
    o.hooksBeforeTake = await builder.git(['config', '--get', 'core.hooksPath'])
    o.greenTake = await builder.run(['take', String(tasks.green)])
    o.hooksAfterTake = await builder.git(['config', '--get', 'core.hooksPath'])
    writeFiles(green.path, {
      'src/features/counter/step/step.ts': 'export const step = 1\n',
      'src/features/counter/step/step.check.js': "console.log('the step is 1')\n",
    })
    await builder.git(['add', '--all'], { cwd: green.path })
    o.greenCommit = await builder.git(['commit', '-m', 'Add the counter step'], { cwd: green.path })
    await builder.git(['config', '--unset', 'core.hooksPath'])
    o.hooksBeforeShip = await builder.git(['config', '--get', 'core.hooksPath'])
    o.greenShip = await builder.run(['ship'], { cwd: green.path })
    o.hooksAfterShip = await builder.git(['config', '--get', 'core.hooksPath'])
    const shipped = /PR #(\d+) opened at ([0-9a-f]{40})\. Do not merge\. Stop\./.exec(
      o.greenShip.stdout,
    )
    if (shipped === null)
      throw new Error(`ship did not open a pull request:\n${o.greenShip.stderr}`)
    o.greenPull = Number(shipped[1])
    o.greenSha = shipped[2]
    repo.log(`green: #${o.greenPull} at ${o.greenSha}`)

    // A push that rewrites the pushed task branch.
    o.rewriteAmend = await builder.git(['commit', '--amend', '-m', 'Add the counter step again'], {
      cwd: green.path,
    })
    o.rewritePush = await builder.git(
      ['push', '--force', 'origin', `HEAD:refs/heads/${green.branch}`],
      { cwd: green.path },
    )
    o.greenRemoteAfterRewrite = await remoteHead(builder, green.branch)
    await builder.git(['reset', '--hard', o.greenSha], { cwd: green.path })

    // The secret task.
    const secret = worktreeOf(builder, tasks.secret, TASKS.secret.title)
    o.secretTake = await builder.run(['take', String(tasks.secret)])
    writeFiles(secret.path, {
      'src/features/counter/config/token.ts': `export const token = '${TEST_SECRET}'\n`,
    })
    await builder.git(['add', '--all'], { cwd: secret.path })
    o.secretCommit = await builder.git(['commit', '-m', 'Configure the counter'], {
      cwd: secret.path,
    })
    o.secretNoVerify = await builder.git(['commit', '--no-verify', '-m', 'Configure the counter'], {
      cwd: secret.path,
    })
    o.secretPush = await builder.git(
      ['push', '--no-verify', '-u', 'origin', `HEAD:refs/heads/${secret.branch}`],
      { cwd: secret.path },
    )
    o.secretSha = await headOf(builder, secret.path)
    o.secretRemote = await remoteHead(builder, secret.branch)
    o.secretPull = (
      await builder.github.createPullRequest({
        title: TASKS.secret.title,
        head: secret.branch,
        base: 'main',
        body: pullBody(tasks.secret),
      })
    ).number
    repo.log(`secret: #${o.secretPull} at ${o.secretSha}`)

    // 5. The Gate refuses the green merge while the Lead can bypass another rule.
    const refusedMerge = await digestOf(gate, o.greenPull, 'failed', {
      timeoutMs: GATE_PATIENCE_MS,
    })
    o.greenRefusedDigest = refusedMerge
    o.greenRefusedPull = await pullState(repo, o.greenPull)
    o.digestBeforeRetry = digestLines(gate.commonDir).length
    await deleteBypassable(repo)

    // GitHub refuses builder1's merges of the green pull request, and the Lead's --admin merge of
    // a pull request whose required check failed.
    o.greenChecks = await finishedChecks(repo, o.greenSha)
    const mergeGreen = ['pr', 'merge', String(o.greenPull), '--merge']
    o.builderMerge = await ghAs(repo, 'builder1', [
      ...mergeGreen,
      '--match-head-commit',
      o.greenSha,
    ])
    o.builderAdminMerge = await ghAs(repo, 'builder1', [
      ...mergeGreen,
      '--admin',
      '--match-head-commit',
      o.greenSha,
    ])
    o.builderRestMerge = await ghAs(repo, 'builder1', [
      'api',
      '--method',
      'PUT',
      `repos/{owner}/{repo}/pulls/${o.greenPull}/merge`,
      '-f',
      'merge_method=merge',
      '-f',
      `sha=${o.greenSha}`,
    ])
    o.greenAfterBuilder = await pullState(repo, o.greenPull)
    o.outsideChecks = await finishedChecks(repo, o.outsideSha)
    o.leadAdminMerge = await ghAs(repo, 'lead', [
      'pr',
      'merge',
      String(o.outsidePull),
      '--merge',
      '--admin',
      '--match-head-commit',
      o.outsideSha,
    ])
    o.outsideAfterAdmin = await pullState(repo, o.outsidePull)
    for (const [key, value] of Object.entries({
      builderMerge: o.builderMerge,
      builderAdminMerge: o.builderAdminMerge,
      builderRestMerge: o.builderRestMerge,
      leadAdminMerge: o.leadAdminMerge,
    })) {
      repo.log(`${key}: exit ${value.code}: ${value.stderr.trim()} ${value.stdout.trim()}`)
    }

    // A Claude Code session of the Lead tries the same merge.
    o.leadSession = await leadSessionMerges({
      checkout: leadMember.path,
      env: leadMember.env,
      commands: mergeCommands({ repo: repo.repo, pr: o.greenPull, sha: o.greenSha }),
    })

    // The Gate merges the green pull request after `retry`.
    gate.type(`retry ${o.greenPull}`)
    o.greenMergedDigest = await digestOf(gate, o.greenPull, 'merged', {
      timeoutMs: GATE_PATIENCE_MS,
      from: o.digestBeforeRetry,
    })
    o.outsideDigest = await digestOf(gate, o.outsidePull, 'scope-violation', {
      timeoutMs: GATE_PATIENCE_MS,
    })
    o.secretDigest = await digestOf(gate, o.secretPull, 'failed', { timeoutMs: GATE_PATIENCE_MS })
    o.staleDigest = await digestOf(gate, o.stalePull, 'failed', { timeoutMs: GATE_PATIENCE_MS })
  } finally {
    await stopGate(gate, { timeoutMs: STOP_PATIENCE_MS, log: repo.log })
    o.gateOut = gate.out
    o.notifications = gate.notifications
    o.digest = digestLines(gate.commonDir)
    repo.log(`the Gate printed:\n${gate.out}`)
  }
}

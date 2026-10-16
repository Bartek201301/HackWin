// The stages of the pipeline (9.2). Stages 1 to 6, here, decide whether a pull request may be
// tested at all: fetch, task link, scope, secrets, gated paths and conflict detection. Stages 7
// to 11 test, wait for CI, merge and clean up: merge-test.js, ci.js and merge.js. None calls a
// model (G9). A stage returns nothing when it passes, a Failure when the run fails there, STOP
// when the run ends without a result (after `quit`, or when intake took the pull request away
// from it), or REPEAT from stage 9 when main moved since the merge test.

import { createMatcher, rolesOf, scopeCheck } from '../../core/config/index.js'
import { formatFinding } from '../../core/secrets/index.js'
import { checkTaskLink } from '../../core/tasks/index.js'
import { closeAttention, raiseAttention } from './attention.js'
import { codeSpan } from './comment.js'
import { ciStage } from './ci.js'
import { afterMergeStage, freshnessStage, mergeStage } from './merge.js'
import { mergeTestStage } from './merge-test.js'
import {
  IN_MAIN_CHECKOUT,
  MAX_DETAILS,
  STOP,
  capped,
  changedPaths,
  count,
  currentConfig,
  fetchHead,
  leaveAlone,
  listed,
  outsiderOf,
  retrying,
  scanHead,
  setGateLabels,
  takeCommand,
} from './pulls.js'

/** @import { Config } from '../../core/config/index.js' */
/** @import { ChangedFile, Git } from '../../core/git/index.js' */
/** @import { PullRequest } from '../../core/github/index.js' */
/** @import { Finding } from '../../core/secrets/index.js' */
/** @import { TaskLink, TaskLinkReason } from '../../core/tasks/index.js' */
/** @import { Gate } from './gate.js' */
/** @import { Tools } from './pipeline.js' */
/** @import { Failure, REPEAT } from './pulls.js' */
/** @import { PullRecord } from './state.js' */

export { REPEAT, STOP } from './pulls.js'

/**
 * One run of a pull request through the stages, from the head SHA it started with.
 * @typedef {object} PullRun
 * @property {Gate} gate
 * @property {Tools} tools
 * @property {number} pr
 * @property {string} sha The full head SHA under test.
 * @property {PullRecord} record The record the run started with.
 * @property {number} startedAt Milliseconds.
 * @property {string | null} author The pull request author's login.
 * @property {string} main The full SHA of main that the run tests against: the one stage 1
 *   fetched, or the one stage 9 found when main moved since the merge test.
 * @property {Config} config The configuration on that main (A17).
 * @property {number | null} task The task that stage 2 found.
 * @property {ChangedFile[]} changed The files the head changes since its merge base with main.
 * @property {number} reruns How often the merge test ran a command again for a known flaky test.
 * @property {PullRequest | null} pull The pull request as stage 10 read it after the merge.
 * @property {() => boolean} superseded True once intake replaced the record: a new head SHA, a
 *   draft, or a closed pull request.
 * @property {(write: () => Promise<void>) => Promise<boolean>} act Writes to GitHub for this
 *   pull request one after another with intake, and only while the run is not superseded.
 */

/**
 * @typedef {object} Stage
 * @property {string} name As the state, the marker and the digest name it.
 * @property {number} number
 * @property {(run: PullRun) => Promise<Failure | typeof STOP | typeof REPEAT | void>} run
 */

/**
 * How a comment names a stage: `stage 3, scope`.
 * @param {Stage} stage
 * @returns {string}
 */
export function stageTitle(stage) {
  return `stage ${stage.number}, ${stage.name.replace(/-/g, ' ')}`
}

/**
 * Stage 1: fetch main and the head, record both full SHAs, set `gate:testing`. A failed fetch is
 * tried again with increasing waits, until it succeeds, the Lead types `quit` or intake takes the
 * pull request away.
 * @param {PullRun} run
 * @returns {Promise<typeof STOP | void>}
 */
async function fetchStage(run) {
  const { gate, pr, sha } = run
  const branch = gate.config.hackwin.project.default_branch
  const fetched = await retrying(run, 'stage 1, fetch', () =>
    fetchHead(gate, pr, sha, { main: true }),
  )
  if (fetched === STOP) return STOP
  run.main = await gate.git.revParse(`refs/remotes/origin/${branch}`)
  run.config = await currentConfig(gate, run.main)
  if (!(await run.act(() => setGateLabels(gate.ctx.github, pr, ['gate:testing'])))) return STOP
  gate.state.main_sha = run.main
}

/**
 * Stage 2: the pull request comes from a `task/` branch and names one open task with a valid data
 * block (E11, E16).
 * @param {PullRun} run
 * @returns {Promise<Failure | typeof STOP | void>}
 */
async function taskLinkStage(run) {
  const { github } = run.gate.ctx
  const pull = await github.getPullRequest(run.pr)
  // A closed pull request leaves the queue at the next intake.
  if (pull === null || pull.state !== 'open') return STOP
  run.author = pull.author
  // A pull request queued before its author left the team, or from a state of before this rule.
  const why = await outsiderOf(run.gate, run.tools, run.config, pull)
  if (why !== null) {
    await run.act(() => leaveAlone(run.gate, run.tools, pull, why))
    return STOP
  }
  const link = await checkTaskLink(github, run.config, pull)
  if (link.ok) {
    run.task = link.issue
    return
  }
  return taskLinkFailure(link, pull)
}

/**
 * Stage 3: every changed file lies in a role that the pull request's author holds, or on the
 * `open` list (G11, 8.4). The roles of the task the pull request names play no part.
 * @param {PullRun} run
 * @returns {Promise<Failure | typeof STOP | void>}
 */
async function scopeStage(run) {
  const { gate, pr, sha } = run
  run.changed = await gate.git.changedFiles({ base: run.main, head: sha, threeDot: true })
  const login = run.author ?? ''
  const { violations } = scopeCheck(run.config, { login, files: changedPaths(run.changed) })
  if (run.superseded()) return STOP
  if (violations.length === 0) {
    closeAttention(gate, { pr, types: ['scope-violation'], why: `head ${sha} passes stage 3` })
    return
  }
  const roles = rolesOf(run.config, login)
  const held =
    roles.length === 0
      ? `${login || 'the author'} holds no role in hackwin.yml`
      : `${login} holds ${roles.map((role) => `\`${role}\``).join(', ')}`
  const files = violations.map(
    ({ path, role, holder }) => `${path} (${role}, ${holder ?? 'no member'})`,
  )
  return {
    result: 'scope-violation',
    labels: ['scope-violation'],
    reason: `${count(violations.length, 'changed file lies', 'changed files lie')} outside the roles of the author: ${held} (G11). Each file with its owning role and holder:`,
    details: capped(
      violations.map(
        ({ path, role, holder }) =>
          `${codeSpan(path)}: role \`${role}\`, held by ${holder ?? 'no member'}`,
      ),
    ),
    next: `take these files out of the pull request: ${takeCommand(run.task)} ${IN_MAIN_CHECKOUT} resumes the task; the session restores them to their state on main and runs \`hackwin ship\`. A change that another role's files need is a task for that role, which the Lead writes (I14).`,
    note: `${count(violations.length, 'file', 'files')} outside the author's roles`,
    attention: {
      type: 'scope-violation',
      todo: `${login || 'the author'} changes files outside their roles: ${listed(files)}; the author takes them out, or the owning role gets a task for the change`,
    },
  }
}

/**
 * Stage 4: the intake scan found no secret in this head SHA. A head SHA that was not scanned yet,
 * for example in a state from before a restart, is scanned here.
 * @param {PullRun} run
 * @returns {Promise<Failure | typeof STOP | void>}
 */
async function secretsStage(run) {
  const { gate, record, sha } = run
  if (record.secret_scanned_sha === sha) return
  const findings = await scanHead(gate, run.config, { base: run.main, head: sha })
  if (run.superseded()) return STOP
  record.secret_scanned_sha = sha
  if (findings.length === 0) return
  return secretFailure({ pr: run.pr, findings, task: run.task, atIntake: false })
}

/**
 * Stage 5: a change of `paths.gated` raises an attention item of the type migration or
 * production config (G10, 9.5). The run goes on.
 * @param {PullRun} run
 * @returns {Promise<typeof STOP | void>}
 */
async function gatedStage(run) {
  const { gate, pr } = run
  const { gated, ledger } = run.config.hackwin.paths
  const paths = changedPaths(run.changed)
  const kinds = /** @type {const} */ ([
    { type: 'migration', key: 'migrations', recorded: 'migration' },
    { type: 'production-config', key: 'production_config', recorded: 'production_config' },
  ])
  const found = kinds
    .map((kind) => {
      const matches = createMatcher(gated[kind.key])
      return { ...kind, files: paths.filter((path) => matches(path)) }
    })
    .filter((kind) => kind.files.length > 0)
  if (run.superseded()) return STOP
  run.record.gated = found.map((kind) => kind.recorded)
  for (const kind of found) {
    const files = listed(kind.files)
    const todo =
      kind.type === 'migration'
        ? `review the migration in ${files}, apply it by hand outside HackWin${ledger ? ` and record it in ${ledger}` : ''}; the Gate tests and merges the pull request like any other`
        : `review the production config change in ${files} and apply it by hand outside HackWin${ledger ? `, then record it in ${ledger}` : ''}; the Gate tests and merges the pull request like any other`
    await raiseAttention(gate, run.tools.notifier, { type: kind.type, pr, todo })
  }
}

/**
 * Stage 6: `git merge-tree --write-tree` of main and the head. Every conflict, in any file, fails
 * with `needs-owner` and the comment that the script writes (RS11, 9.3, I7): the files and the
 * merged pull requests that changed them on main. No model is called.
 * @param {PullRun} run
 * @returns {Promise<Failure | void>}
 */
async function conflictStage(run) {
  const { gate, sha, main } = run
  const merge = await gate.git.mergeTree(main, sha)
  if (merge.clean) return
  const base = await gate.git.mergeBase(main, sha)
  const files = merge.conflicts.slice(0, MAX_DETAILS)
  const details = []
  for (const file of files) {
    details.push(`${codeSpan(file)}: ${await changedOnMain(gate.git, { base, main, file })}`)
  }
  if (merge.conflicts.length > files.length) {
    details.push(`and ${merge.conflicts.length - files.length} more files`)
  }
  return {
    result: 'needs-owner',
    labels: ['needs-owner'],
    reason: `the head conflicts with main \`${main}\` in ${count(merge.conflicts.length, 'file', 'files')}; the Gate resolves no conflict in this version (I7). Each file with the merged pull requests that changed it on main since the merge base${base ? ` \`${base}\`` : ''}:`,
    details,
    next: `the author resolves the conflicts: ${takeCommand(run.task)} ${IN_MAIN_CHECKOUT} resumes the task; the session merges main, resolves the conflicts in its files and runs \`hackwin ship\` (9.3).`,
    note: `conflict in ${count(merge.conflicts.length, 'file', 'files')}`,
  }
}

/** Stages 1 to 11, in order (G8). */
export const STAGES = Object.freeze(
  /** @type {Stage[]} */ ([
    { name: 'fetch', number: 1, run: fetchStage },
    { name: 'task-link', number: 2, run: taskLinkStage },
    { name: 'scope', number: 3, run: scopeStage },
    { name: 'secrets', number: 4, run: secretsStage },
    { name: 'gated-paths', number: 5, run: gatedStage },
    { name: 'conflicts', number: 6, run: conflictStage },
    { name: 'merge-test', number: 7, run: mergeTestStage },
    { name: 'ci', number: 8, run: ciStage },
    { name: 'freshness', number: 9, run: freshnessStage },
    { name: 'merge', number: 10, run: mergeStage },
    { name: 'after-merge', number: 11, run: afterMergeStage },
  ]),
)

/**
 * The stage of this name.
 * @param {string} name
 * @returns {Stage}
 */
export function stageNamed(name) {
  const stage = STAGES.find((each) => each.name === name)
  if (!stage) throw new Error(`no stage ${name}`)
  return stage
}

/** The stage the secret scan belongs to, also when intake runs it. */
export const SECRETS_STAGE = /** @type {Stage} */ (STAGES.find((stage) => stage.name === 'secrets'))

/**
 * The failure of a head SHA that adds a secret, at intake or at stage 4 (G12, A41) [D3]. The
 * comment gives file, line and pattern name, never the matched text.
 * @param {{ pr: number, findings: Finding[], task: number | null, atIntake: boolean }} found
 * @returns {Failure}
 */
export function secretFailure({ pr, findings, task, atIntake }) {
  const where = findings.map(formatFinding)
  return {
    result: 'failed',
    labels: [],
    reason: `the head adds ${count(findings.length, 'line or file', 'lines or files')} that match a secret pattern${atIntake ? ', found by the scan at intake' : ''} (G12, A41). A pushed branch of a public repository is public, so the secret is exposed already. File, line and pattern of each finding:`,
    details: capped(where.map(codeSpan)),
    next: `the Lead rotates the secret at once, then types \`ack ${pr}\` in the Gate terminal. The author removes it from the branch: ${takeCommand(task)} ${IN_MAIN_CHECKOUT} resumes the task; the session removes it and runs \`hackwin ship\`. The secret stays in the history of the pushed branch, so only the rotation makes it harmless.`,
    note: `secret: ${count(findings.length, 'finding', 'findings')}`,
    attention: {
      type: 'secret',
      todo: `rotate the secret in ${listed(where)} at once, it is on a pushed branch; then type \`ack ${pr}\``,
    },
  }
}

/** @type {Record<TaskLinkReason | 'issue-not-open' | 'invalid-task-block', (pull: PullRequest, task: string) => [string, string]>} */
const TASK_LINK = {
  'no-task-branch': (pull) => [
    `the branch ${codeSpan(pull.headRef)} is not a task branch \`task/<N>-<slug>\`; only \`hackwin ship\` opens a pull request, from the branch of a task (8.4)`,
    `open the pull request with \`hackwin ship\` in the task's worktree, and close this one`,
  ],
  'spike-branch': (pull) => [
    `the branch ${codeSpan(pull.headRef)} is a \`spike/\` branch, which is never merged (E16)`,
    `ask the Lead for a task for the change, start it with \`hackwin take <task>\` ${IN_MAIN_CHECKOUT}, open its pull request with \`hackwin ship\`, and close this one`,
  ],
  'no-closes-line': (pull, task) => [
    'the body has no line `Closes #<N>` that names the task (T1)',
    `edit the body to hold exactly one line \`Closes #${task}\`, then ask the Lead to type \`retry ${pull.number}\` in the Gate terminal`,
  ],
  'several-closing-references': (pull, task) => [
    'the body holds more than one closing reference, and a merge must close exactly the task (T1)',
    `edit the body to keep only the line \`Closes #${task}\`, then ask the Lead to type \`retry ${pull.number}\` in the Gate terminal`,
  ],
  'branch-issue-mismatch': (pull, task) => [
    `the line \`Closes #<N>\` names another issue than the branch ${codeSpan(pull.headRef)} (T1)`,
    `edit the body to name the task of the branch, \`Closes #${task}\`, then ask the Lead to type \`retry ${pull.number}\` in the Gate terminal`,
  ],
  'issue-not-open': (pull, task) => [
    `the task #${task} is not open`,
    `ask the Lead whether the task is still wanted; once it is open again, the Lead types \`retry ${pull.number}\` in the Gate terminal`,
  ],
  'invalid-task-block': (pull, task) => [
    `the task #${task} has no valid task block (8.1)`,
    `ask the Lead to fix the task block of #${task}, then to type \`retry ${pull.number}\` in the Gate terminal`,
  ],
}

/**
 * The failure of stage 2 for each reason of the task link. For `invalid-task-block` the comment
 * gives the reasons of `checkTaskLink`, which are safe to print (contracts 4.5): an issue that no
 * member of the team wrote is no task, and the comment names the issue and its author (scope
 * change on #24, #74).
 * @param {Exclude<TaskLink, { ok: true }>} link
 * @param {PullRequest} pull
 * @returns {Failure}
 */
function taskLinkFailure(link, pull) {
  const { reason } = link
  const branchTask = /^task\/(\d+)/.exec(pull.headRef)?.[1]
  const named = /^Closes #(\d+)\s*$/m.exec(pull.body ?? '')?.[1]
  const task = reason === 'issue-not-open' || reason === 'invalid-task-block' ? named : branchTask
  if ('member' in link && !link.member) {
    const author = link.author ?? 'an unknown account'
    return {
      result: 'failed',
      labels: [],
      reason: `the issue #${task} that the pull request names is no task: no member of the team wrote it (\`${reason}\`):`,
      details: capped(link.errors.map(codeSpan)),
      next: `the author asks the Lead for a task, an issue that the Lead or a member of the team writes, and edits the body to hold exactly one line \`Closes #<task>\` that names it; then the Lead types \`retry ${pull.number}\` in the Gate terminal. The issue #${task} of ${author} stays no task.`,
      note: `task link: #${task} written by ${author}, not a member`,
    }
  }
  const [text, next] = TASK_LINK[reason](pull, task ?? '<N>')
  const errors = 'errors' in link ? link.errors : []
  return {
    result: 'failed',
    labels: [],
    reason: `${text} (\`${reason}\`)${errors.length > 0 ? ':' : ''}`,
    details: capped(errors.map(codeSpan)),
    next,
    note: `task link: ${reason}`,
  }
}

/**
 * What changed a conflicting file on main since the merge base: the merged pull requests, read
 * from the first-parent history of main ("Merge pull request #<N> ..." or a squashed "... (#<N>)"),
 * else the commits.
 * @param {Git} git
 * @param {{ base: string | null, main: string, file: string }} where
 * @returns {Promise<string>}
 */
async function changedOnMain(git, { base, main, file }) {
  const range = base === null ? main : `${base}..${main}`
  const log = await git.run(['log', '--first-parent', '--format=%H%x09%s', range, '--', file])
  /** @type {string[]} */
  const pulls = []
  /** @type {string[]} */
  const commits = []
  for (const line of log.stdout.split('\n').filter(Boolean)) {
    const [commit, ...rest] = line.split('\t')
    const subject = rest.join('\t')
    const number =
      /^Merge pull request #(\d+)\b/.exec(subject)?.[1] ?? /\(#(\d+)\)\s*$/.exec(subject)?.[1]
    if (number) {
      if (!pulls.includes(`#${number}`)) pulls.push(`#${number}`)
    } else {
      commits.push(`commit \`${commit.slice(0, 12)}\``)
    }
  }
  if (pulls.length === 0 && commits.length === 0) {
    return 'no commit on main since the merge base changed it'
  }
  const parts = [
    ...(pulls.length > 0 ? [`changed by ${listed(pulls, 10)}`] : []),
    ...(commits.length > 0 ? [`changed without a pull request by ${listed(commits, 3)}`] : []),
  ]
  return parts.join('; ')
}

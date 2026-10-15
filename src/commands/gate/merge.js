// Stages 9 to 11 (9.2; G15, G16, G19, G20, G22; I12; A35): freshness, the pinned merge and what
// follows it.
//
// Stage 9 fetches main and compares it with the main that stage 7 tested; when main moved, the
// run goes back to stage 6, so conflict detection and the merge test run again before the merge
// (G20). Stage 10 merges with `gh pr merge <PR> --merge --match-head-commit <full SHA>`, so GitHub
// merges exactly the tested head or nothing (G15). While the update restriction is active GitHub
// shows every pull request as BLOCKED and gh refuses a merge without `--admin`, so the Gate adds
// `--admin` then, and only then (#23; docs/verification.md rows 6 and 14). `--admin` lifts no rule
// that the Lead's account cannot bypass, so before each such merge the Gate reads the protection
// again and merges only while `bypassable` is empty. A head that moved sends the pull request to
// the back of the queue with its new SHA; any other refusal fails the run with `merge-refused`.
// Then the Gate deletes the remote branch.
//
// Stage 11 sets `gate:merged`, closes the task issue, sets the dependents whose dependencies are
// all closed from `blocked` to `ready` (I12), closes the pull request's attention items that close
// with it (9.6), makes sure the scratch worktree is gone, writes the digest line and runs
// `commands.smoke` on the new main when it is set. A failed smoke test raises a repeated failure
// attention item (A42); the fix arrives as a separate small pull request (G19). A run that stops
// after the merge, at `quit` or a crash, takes up again at stage 10 without merging a second time.

import { join } from 'node:path'
import { readProtection } from '../../core/protection/index.js'
import { RemoteError, execShell } from '../../core/runtime/index.js'
import { setTaskStatus, toTask } from '../../core/tasks/index.js'
import { CLOSED_WITH_THE_PULL, closeAttention, raiseAttention } from './attention.js'
import { inlineCode } from './comment.js'
import {
  REPEAT,
  STOP,
  count,
  currentConfig,
  duration,
  fetchMain,
  leaveQueue,
  listed,
  messageOf,
  pullRef,
  retrying,
  setGateLabels,
  taskOf,
  thisRepository,
  writeDigest,
} from './pulls.js'
import { closeScratch, installInScratch, openScratch, projectEnv } from './scratch.js'

/** @import { PullRequest } from '../../core/github/index.js' */
/** @import { Failure } from './pulls.js' */
/** @import { PullRun } from './stages.js' */

/**
 * Stage 9: when main moved since the merge test, stages 6 and 7 run again (G20).
 * @param {PullRun} run
 * @returns {Promise<typeof STOP | typeof REPEAT | void>}
 */
export async function freshnessStage(run) {
  const { gate, pr } = run
  const main = await retrying(run, 'stage 9, freshness', () => fetchMain(gate))
  if (main === STOP) return STOP
  gate.state.main_sha = main
  if (main === run.main) return
  gate.line(
    `#${pr} stage 9, freshness: main moved from ${run.main} to ${main} since the merge test, so stages 6 and 7 run again (G20)`,
  )
  if (!(await run.act(() => setGateLabels(gate.ctx.github, pr, ['gate:testing'])))) return STOP
  run.main = main
  run.config = await currentConfig(gate, main)
  return REPEAT
}

/**
 * Stage 10: the pinned merge, then the deletion of the remote branch.
 * @param {PullRun} run
 * @returns {Promise<Failure | typeof STOP | void>}
 */
export async function mergeStage(run) {
  const { gate, pr, sha, record } = run
  const { github } = gate.ctx
  const branch = gate.config.hackwin.project.default_branch

  if (record.result !== 'merged') {
    const tried = await retrying(run, 'stage 10, merge', async () => {
      const protection = await readProtection(github, { branch })
      gate.protection = protection
      const admin = protection.rules.updateRestricted
      const bypassable = admin ? protection.rules.bypassable : []
      if (bypassable.length > 0) return { bypassable, merged: null }
      /** @type {{ value: { refused: RemoteError | null, pull: PullRequest | null, admin: boolean } | null }} */
      const merged = { value: null }
      // The merge and the record of its result run one after another with intake, so that
      // intake never takes a pull request that the Gate merged for one merged outside it.
      const acted = await run.act(async () => {
        /** @type {RemoteError | null} */
        let refused = null
        try {
          await github.run([
            'pr',
            'merge',
            String(pr),
            '--merge',
            ...(admin ? ['--admin'] : []),
            '--match-head-commit',
            sha,
          ])
        } catch (error) {
          if (!(error instanceof RemoteError)) throw error
          refused = error
        }
        const pull = await github.getPullRequest(pr)
        merged.value = { refused, pull, admin }
        if (pull?.merged) {
          record.result = 'merged'
          record.stage = 'merge'
          await gate.save()
        }
      })
      return { bypassable, merged: acted ? merged.value : null }
    })
    if (tried === STOP) return STOP
    if (tried.bypassable.length > 0) return bypassFailure(run, tried.bypassable)
    if (tried.merged === null) return STOP
    const { refused, pull, admin } = tried.merged
    // A pull request closed meanwhile leaves the queue at the next intake.
    if (pull === null || (pull.state !== 'open' && !pull.merged)) return STOP
    if (!pull.merged) {
      if (pull.headSha !== sha) return requeue(run, pull)
      return refusal(run, refused, admin)
    }
    run.pull = pull
    gate.line(
      `#${pr} merged head ${sha} as ${pull.mergeCommitSha ?? 'a merge commit'}${admin ? ' (with --admin: the update restriction is active)' : ''}`,
    )
  }

  const pull = run.pull ?? (await retrying(run, 'stage 10, merge', () => github.getPullRequest(pr)))
  if (pull === STOP) return STOP
  if (pull === null) return
  run.pull = pull
  return deleteBranch(run, pull)
}

/**
 * Delete the remote branch of a merged pull request (G22, A35). A branch that is gone already
 * counts as deleted; a branch of another repository is not the Gate's to delete.
 * @param {PullRun} run
 * @param {PullRequest} pull
 * @returns {Promise<typeof STOP | void>}
 */
async function deleteBranch(run, pull) {
  const { gate, pr } = run
  const ref = pull.headRef.split('/').map(encodeURIComponent).join('/')
  const deleted = await retrying(run, 'stage 10, merge', async () => {
    if (pull.headRepo?.toLowerCase() !== (await thisRepository(gate, run.tools))) return false
    try {
      await gate.ctx.github.api(`repos/{owner}/{repo}/git/refs/heads/${ref}`, { method: 'DELETE' })
    } catch (error) {
      if (!(error instanceof RemoteError) || (error.status !== 404 && error.status !== 422)) {
        throw error
      }
    }
    return true
  })
  if (deleted === STOP) return STOP
  if (deleted) gate.line(`#${pr} the remote branch ${pull.headRef} is deleted`)
}

/**
 * The head moved since the tested SHA: the new head joins the back of the queue as at intake,
 * and this run ends as `requeued`.
 * @param {PullRun} run
 * @param {PullRequest} pull
 * @returns {Promise<typeof STOP>}
 */
async function requeue(run, pull) {
  const { gate, pr, sha } = run
  gate.line(
    `#${pr} stage 10, merge: the head moved from ${sha} to ${pull.headSha} after the merge test, so GitHub did not merge it; the new head joins the back of the queue`,
  )
  await run.tools.admit(gate, pull)
  return STOP
}

/**
 * A merge that GitHub refused for another reason than a moved head (`merge-refused`).
 * @param {PullRun} run
 * @param {RemoteError | null} refused
 * @param {boolean} admin
 * @returns {Failure}
 */
function refusal(run, refused, admin) {
  const tail = /** @type {string[] | undefined} */ (refused?.details?.tail)
  const said = refused === null ? [] : (tail ?? [refused.message])
  return {
    result: 'failed',
    labels: [],
    reason: `GitHub refused the merge of head \`${run.sha}\`${admin ? ' with `--admin`' : ''} (\`merge-refused\`)${said.length > 0 ? '. It answered:' : ''}`,
    details: said.map((line) => inlineCode(line)),
    next: `the Lead reads the answer; once what GitHub refused is fixed, the Lead types \`retry ${run.pr}\` in the Gate terminal. The Gate tested this head, so the author changes nothing unless the answer names the pull request.`,
    note: 'merge-refused',
  }
}

/**
 * The update restriction is active, but the Lead's account can bypass other rules too, which a
 * merge with `--admin` would skip (#23). The Gate does not merge.
 * @param {PullRun} run
 * @param {Array<{ type: string, ruleset: string }>} bypassable
 * @returns {Failure}
 */
function bypassFailure(run, bypassable) {
  const rules = bypassable.map(({ type, ruleset }) => `\`${type}\` of the rule set \`${ruleset}\``)
  return {
    result: 'failed',
    labels: [],
    reason: `the Gate did not merge: the update restriction is active, so the merge needs \`--admin\`, and the Lead's account can bypass other rules as well, which \`--admin\` would skip (\`merge-refused\`). The rules:`,
    details: rules,
    next: `nothing for the author. The Lead puts these rules into a rule set without bypass actors on GitHub (Settings, Rules, Rulesets) and types \`retry ${run.pr}\` in the Gate terminal.`,
    note: 'merge-refused: rules the Lead can bypass',
    attention: {
      type: 'repeated-failure',
      todo: `the Gate merges nothing while the Lead's account can bypass ${listed(rules)}; move these rules into a rule set without bypass actors, then type \`retry ${run.pr}\``,
    },
  }
}

/**
 * Stage 11.
 * @param {PullRun} run
 * @returns {Promise<typeof STOP | void>}
 */
export async function afterMergeStage(run) {
  const { gate, pr, record } = run
  const { github } = gate.ctx
  // Null only for a pull request that GitHub no longer returns.
  const pull = run.pull
  const labelled = await retrying(run, 'stage 11, after merge', () =>
    setGateLabels(github, pr, ['gate:merged']),
  )
  if (labelled === STOP) return STOP
  const task = run.task ?? (pull === null ? null : taskOf(pull))
  if (task !== null) {
    const closed = await retrying(run, 'stage 11, after merge', () => closeTask(run, task))
    if (closed === STOP) return STOP
  }
  closeAttention(gate, { pr, types: CLOSED_WITH_THE_PULL, why: 'the pull request is merged' })
  await closeScratch(gate)
  await gate.git.run(['update-ref', '-d', pullRef(pr)], { allowFailure: true })

  const now = gate.ctx.clock.now()
  record.stage = 'after-merge'
  leaveQueue(gate.state, pr)
  const merge = pull?.mergeCommitSha ?? null
  await writeDigest(gate, {
    time: now.toISOString(),
    pr,
    author: run.author ?? pull?.author ?? '-',
    result: 'merged',
    stage: 'after-merge',
    duration: duration(now.getTime() - run.startedAt),
    note: [
      merge ? `merge commit ${merge.slice(0, 12)}` : 'merged',
      ...(record.ci_reruns > 0 ? [count(record.ci_reruns, 'CI rerun', 'CI reruns')] : []),
      ...(run.reruns > 0 ? [count(run.reruns, 'merge test rerun', 'merge test reruns')] : []),
    ].join('; '),
  })
  await gate.save()
  await smoke(run, merge)
}

/**
 * Close the task issue when it is still open, then set its dependents whose dependencies are all
 * closed from `blocked` to `ready` (I12).
 * @param {PullRun} run
 * @param {number} task
 * @returns {Promise<void>}
 */
async function closeTask(run, task) {
  const { gate, pr } = run
  const { github } = gate.ctx
  const issue = await github.getIssue(task)
  if (issue !== null && issue.state === 'open' && !issue.isPullRequest) {
    await github.updateIssue(task, { state: 'closed', stateReason: 'completed' })
    gate.line(`#${pr} closed its task #${task}`)
  }
  const blocked = await github.listIssues({ state: 'open', labels: ['blocked'] })
  /** @type {Map<number, { state: string }>} */
  const states = new Map([[task, { state: 'closed' }]])
  for (const candidate of blocked) {
    const dependent = toTask(candidate, run.config)
    const needs = dependent?.block?.depends_on ?? []
    if (!dependent || !needs.includes(task)) continue
    for (const number of needs) {
      if (states.has(number)) continue
      const other = await github.getIssue(number)
      states.set(number, { state: other?.state ?? 'open' })
    }
    const open = needs.filter((number) => states.get(number)?.state !== 'closed')
    if (open.length > 0) continue
    await setTaskStatus(github, dependent.number, 'ready')
    gate.line(`#${pr} the task #${dependent.number}, which depended on #${task}, is ready`)
  }
}

/**
 * `commands.smoke` on the new main (G16), when it is set. A failure raises a repeated failure
 * attention item (A42). A pass closes the items of earlier failed smoke tests: the open repeated
 * failure items of merged pull requests, whose other items closed with their merge.
 * @param {PullRun} run
 * @param {string | null} merge The merge commit.
 * @returns {Promise<void>}
 */
async function smoke(run, merge) {
  const { gate, pr, config } = run
  const command = config.hackwin.commands.smoke
  if (typeof command !== 'string' || command.trim() === '') return
  /** @type {string | null} */
  let main = null
  try {
    const fetched = await fetchMain(gate)
    main = merge !== null && (await gate.git.tryRevParse(`${merge}^{commit}`)) ? merge : fetched
  } catch (error) {
    gate.line(
      `#${pr} smoke test: main was not fetched, so the smoke test did not run: ${messageOf(error)}`,
    )
    return
  }
  const timeoutMs = config.hackwin.gate.step_timeout_minutes * 60_000
  const env = projectEnv(gate.ctx.env)
  const logs = `logs/pr-${pr}/${main.slice(0, 12)}`
  const scratch = await openScratch(gate, main)
  /** @type {{ ok: boolean, what: string, tail: string[] }} */
  let outcome
  try {
    const installed = await installInScratch(gate, scratch, {
      config,
      timeoutMs,
      logFile: join(gate.files.root, `${logs}-smoke-install.log`),
      env,
    })
    if (!installed.ok) {
      outcome = { ok: false, what: 'its install failed', tail: installed.run?.tail ?? [] }
    } else {
      const result = await execShell(command, {
        cwd: scratch.path,
        env,
        timeoutMs,
        logFile: join(gate.files.root, `${logs}-smoke.log`),
      })
      const ok = result.code === 0 && !result.timedOut
      const how = result.timedOut
        ? `it ran longer than ${timeoutMs / 60_000} min`
        : `exit ${result.code}`
      outcome = { ok, what: how, tail: result.tail }
    }
  } finally {
    await closeScratch(gate)
  }
  gate.state.last_smoke = { main_sha: main, result: outcome.ok ? 'passed' : 'failed' }
  if (outcome.ok) {
    gate.line(`#${pr} smoke test passed on main ${main}`)
    for (const item of gate.state.attention) {
      if (item.type !== 'repeated-failure' || item.resolved_at) continue
      if (gate.state.prs[String(item.pr)]?.result !== 'merged') continue
      closeAttention(gate, {
        pr: Number(item.pr),
        types: ['repeated-failure'],
        why: `the smoke test passes on main ${main}`,
      })
    }
  } else {
    gate.line(
      `#${pr} smoke test failed on main ${main}: ${outcome.what}; ${outcome.tail.slice(-1)[0] ?? ''}`,
    )
    await raiseAttention(gate, run.tools.notifier, {
      type: 'repeated-failure',
      pr,
      todo: `the smoke test ${inlineCode(command)} failed on main ${main.slice(0, 12)} after the merge of #${pr} (${outcome.what}; the log is .git/hackwin/gate/${logs}-smoke.log); write a task for the fix, which arrives as a separate small pull request`,
    })
  }
  await gate.save()
}

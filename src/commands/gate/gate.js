// The Gate process (7.5; 9.1 G1 to G6, G24, G25): its own process in its own terminal on the
// Lead's laptop, which never touches an agent conversation. It takes the lock, counts the start,
// keeps the laptop awake, loads the state file, writes the status issue and polls every
// `gate.poll_seconds` until the Lead types `quit`.
//
// The poll loop and the pull request pipeline run side by side: a poll writes the heartbeat,
// fetches origin and runs the intake, while one pull request at a time goes through the stages,
// whose commands run as child processes. So polling and the heartbeat go on while a stage runs
// (G5). The pipeline of section 9 plugs into the loop (`Pipeline`); without it the Gate polls but
// takes no pull request.

import { readProtection } from '../../core/protection/index.js'
import { PreconditionError, runIn } from '../../core/runtime/index.js'
import { mainCheckout } from '../../core/worktrees/index.js'
import { startKeepAwake } from './awake.js'
import { INPUT_HELP, readCommands } from './input.js'
import { acquireLock, releaseLock, runningGate } from './lock.js'
import {
  gateFiles,
  loadGateId,
  loadState,
  readHeartbeat,
  saveState,
  writeHeartbeat,
} from './state.js'
import {
  createStatusPublisher,
  findStatusIssue,
  otherGateHeartbeat,
  parseStatusBody,
} from './status-issue.js'

/** @import { CommandContext, CommandResult } from '../../cli/context.js' */
/** @import { Config } from '../../core/config/index.js' */
/** @import { Git } from '../../core/git/index.js' */
/** @import { Issue } from '../../core/github/index.js' */
/** @import { Protection } from '../../core/protection/index.js' */
/** @import { KeepAwake, StartKeepAwake } from './awake.js' */
/** @import { TypedCommand } from './input.js' */
/** @import { GateFiles, GateState } from './state.js' */
/** @import { StatusPublisher } from './status-issue.js' */

/** The longest wait between two looks at the clock and at `quit`. */
const TICK_MS = 1000

/**
 * The pull request pipeline of section 9, which the loop runs.
 * @typedef {object} Pipeline
 * @property {(gate: Gate) => Promise<void>} [intake] Runs at every poll, after the fetch: lists
 *   the open pull requests and queues new head SHAs, and those of `gate.retries` (9.2).
 * @property {(gate: Gate, pr: number) => Promise<void>} [run] Takes the pull request at the head
 *   of the queue through the stages (G8, G17). It announces each stage with `gate.stage()`, which
 *   writes the heartbeat and the state, and returns between two stages once `gate.stopping` is
 *   true. A finished run takes the pull request off the head of the queue.
 */

/**
 * What the pipeline gets from the Gate.
 * @typedef {object} Gate
 * @property {CommandContext} ctx
 * @property {Config} config
 * @property {Git} git Git in this checkout with the member hooks switched off (10.3).
 * @property {GateFiles} files
 * @property {GateState} state
 * @property {Protection} protection The latest protection read, which the status issue shows.
 * @property {string} id The random id of this clone's Gate, which the status issue shows.
 * @property {Set<number>} retries The pull requests the Lead typed `retry` for, until the intake
 *   queues them again.
 * @property {number | null} running The pull request whose run is under way.
 * @property {boolean} stopping True once the Lead typed `quit`.
 * @property {Promise<void>} stopped Settles when the Gate stops.
 * @property {() => void} stop Stops the Gate after the current step, as `quit` does.
 * @property {(text: string) => void} line Prints a line with the time as hours and minutes.
 * @property {(pr: number, stage: string) => Promise<void>} stage Records a stage change.
 * @property {() => Promise<void>} save Writes the state file.
 * @property {(stoppedAt?: string | null, at?: string) => Promise<void>} beat Renews the local
 *   heartbeat, with the time `at`, now by default.
 */

/**
 * @typedef {object} GateOptions
 * @property {Pipeline} [pipeline] The stages; none by default.
 * @property {StartKeepAwake} [keepAwake]
 * @property {number} [pid] The process of the Gate; this one by default.
 */

/**
 * Run the Gate until the Lead types `quit`.
 * @param {CommandContext} ctx
 * @param {GateOptions} [options]
 * @returns {Promise<CommandResult>}
 */
export async function startGate(ctx, options = {}) {
  const { pipeline = {}, keepAwake = startKeepAwake, pid = process.pid } = options
  const { config, identity } = prepared(ctx)
  const lead = config.hackwin.team.lead
  if (!identity.isLead) {
    throw new PreconditionError(
      `there is one Gate, on the Lead's laptop under the Lead's account ${lead}, and merges wait while it is down; gh is logged in as ${identity.login}`,
      { resolve: `ask the Lead (${lead}) to start the Gate if it is down` },
    )
  }
  const files = gateFiles(ctx.gitCommonDir)
  const main = await mainCheckout(ctx.git)
  if (ctx.caller !== 'terminal') throw await notInTerminal(ctx, files, main)

  const lock = await acquireLock(files.lock, { pid, now: ctx.clock.now() })
  if (!lock.acquired) {
    const holder = lock.holder
    throw new PreconditionError(
      `another Gate is running on this machine${holder ? `: pid ${holder.pid}, started ${holder.started_at}` : ''}; there is one Gate per project`,
      {
        resolve: 'use the running Gate, or type `quit` in its terminal before you start another',
        details: { holder },
      },
    )
  }
  /** @type {KeepAwake | null} */
  let awake = null
  /** @type {{ close: () => void } | null} */
  let input = null
  try {
    if (lock.replaced) {
      ctx.out.line(`replaced the lock of a Gate that no longer runs (pid ${lock.replaced.pid})`)
    }
    const protection = await readProtection(ctx.github, {
      branch: config.hackwin.project.default_branch,
    })
    requireOnlyUpdateBypass(protection)
    const issue = await findStatusIssue(ctx.github)
    const own = await loadGateId(files.id, ctx.clock.now())
    await refuseOtherGate({ ctx, config, files, issue, main, own })

    const { state, kept } = await loadState(files.state, ctx.clock.now())
    if (kept !== null) {
      ctx.out.warn(
        `the state file was not readable; it is kept as ${kept}, and the Gate starts empty`,
      )
    }
    state.starts += 1
    await saveState(files.state, state)

    const gate = createGate({ ctx, config, files, state, pid, protection, id: own.id })
    awake = await keepAwake({
      pid,
      onLost: (reason) =>
        ctx.out.warn(`the laptop may sleep now: ${reason}; merges wait while it sleeps`),
    })
    if (!awake.active) {
      ctx.out.warn(
        `the Gate cannot keep this laptop awake: ${awake.reason}; merges wait while it sleeps`,
      )
    }
    // The first heartbeat in the status issue clears the stop time of the last `quit` (7.5 step 6).
    const status = createStatusPublisher(gate, issue)
    await status.publish()
    await gate.save()
    for (const text of headerLines({ gate, status, awake, pid, pipeline })) ctx.out.line(text)

    input = readCommands(ctx.stdin, (command) => onCommand(gate, command))
    await runLoop(gate, pipeline, status)

    const stoppedAt = ctx.clock.now().toISOString()
    await status.publish({ stoppedAt })
    await gate.save()
    return {
      lines: [
        `${hoursAndMinutes(ctx.clock.now())} Gate stopped; to start it again, ${runIn('hackwin gate', main)}`,
      ],
      data: { starts: state.starts, stopped_at: stoppedAt, queue: [...state.queue] },
    }
  } finally {
    input?.close()
    awake?.stop()
    await releaseLock(files.lock, lock.record)
  }
}

/**
 * The refusal outside a terminal (7.5, preconditions): the `/gate` wrapper of an agent session,
 * a script or a hook starts nothing. It says how to start the Gate and whether one runs.
 * @param {CommandContext} ctx
 * @param {GateFiles} files
 * @param {string} main
 * @returns {Promise<PreconditionError>}
 */
async function notInTerminal(ctx, files, main) {
  const holder = await runningGate(files.lock)
  const heartbeat = holder === null ? null : await readHeartbeat(files.heartbeat)
  const running =
    holder === null
      ? 'no Gate is running on this machine'
      : `a Gate is already running on this machine: pid ${holder.pid}, started ${holder.started_at}${heartbeat ? `, last heartbeat ${heartbeat.heartbeat_at}` : ''}`
  return new PreconditionError(
    `the Gate starts only in its own terminal, never inside an agent session or a script: open a separate terminal for it; ${running}`,
    {
      resolve: { command: 'hackwin gate', dir: main },
      details: { caller: ctx.caller, running: holder },
    },
  )
}

/**
 * While the update restriction is active the Gate merges with `--admin` (#23), so it starts
 * only when the Lead's account can bypass no other rule.
 * @param {Protection} protection
 */
function requireOnlyUpdateBypass({ rules }) {
  if (!rules.updateRestricted || rules.bypassable.length === 0) return
  const named = rules.bypassable.map(({ type, ruleset }) => `${type} (rule set ${ruleset})`)
  throw new PreconditionError(
    `the update restriction is active, so the Gate merges with --admin, which would also skip these rules that the Lead's account can bypass: ${named.join(', ')}`,
    {
      resolve:
        "put these rules into a rule set without bypass actors on GitHub (Settings, Rules, Rulesets), so that the Lead's account can bypass only the update restriction, then start the Gate again",
      details: { bypassable: rules.bypassable },
    },
  )
}

/**
 * One Gate per project (G2): the lock holds only within one clone, so a start also refuses while
 * the status issue shows the fresh heartbeat of a Gate that has not stopped, unless this clone's
 * own Gate wrote it, as before a crash.
 * @param {{ ctx: CommandContext, config: Config, files: GateFiles, issue: Issue | null, main: string, own: { id: string, created: boolean } }} parts
 */
async function refuseOtherGate({ ctx, config, files, issue, main, own }) {
  if (issue === null) return
  const stale = config.hackwin.gate.heartbeat_stale_seconds
  const other = otherGateHeartbeat(parseStatusBody(issue.body), {
    gateId: own.id,
    newId: own.created,
    local: await readHeartbeat(files.heartbeat),
    now: ctx.clock.now(),
    staleSeconds: stale,
  })
  if (other === null) return
  const whose = other.gate_id === null ? 'a Gate without an id' : `the Gate ${other.gate_id}`
  const where =
    other.gate_id === null ? '' : ` (its clone holds ${other.gate_id} in .git/hackwin/gate/gate-id)`
  const staleAt = new Date(Date.parse(other.heartbeat_at) + stale * 1000).toISOString()
  throw new PreconditionError(
    `another Gate is running for this project: the status issue #${issue.number} shows the heartbeat of ${whose} at ${other.heartbeat_at}, ${other.age_seconds} s old, and no stop; this clone's Gate is ${own.id}; there is one Gate per project`,
    {
      resolve: `type \`quit\` in that Gate's terminal${where}; if it no longer runs, wait until ${staleAt}, when its heartbeat is ${stale} s old; then ${runIn('hackwin gate', main)}`,
      details: { status_issue: issue.number, gate_id: own.id, other },
    },
  )
}

/**
 * @param {{ ctx: CommandContext, config: Config, files: GateFiles, state: GateState, pid: number, protection: Protection, id: string }} parts
 * @returns {Gate}
 */
function createGate({ ctx, config, files, state, pid, protection, id }) {
  // State and heartbeat writes run one after another, each with the state of its turn.
  let writes = Promise.resolve()
  /** @param {() => Promise<void>} write */
  const serial = (write) => {
    const next = writes.then(write)
    writes = next.catch(() => {})
    return next
  }
  /** @type {() => void} */
  let settle = () => {}
  /** @type {Promise<void>} */
  const stopped = new Promise((resolve) => {
    settle = resolve
  })

  /** @type {Gate} */
  const gate = {
    ctx,
    config,
    git: ctx.git.with({ hooksOff: true }),
    files,
    state,
    protection,
    id,
    retries: new Set(),
    running: null,
    stopping: false,
    stopped,
    stop: () => {
      gate.stopping = true
      settle()
    },
    line: (text) => ctx.out.line(`${hoursAndMinutes(ctx.clock.now())} ${text}`),
    stage: async (pr, stage) => {
      const record = state.prs[String(pr)]
      if (record) record.stage = stage
      await Promise.all([gate.beat(), gate.save()])
    },
    save: () => serial(() => saveState(files.state, state)),
    beat: (stoppedAt = null, at = ctx.clock.now().toISOString()) =>
      serial(() =>
        writeHeartbeat(files.heartbeat, {
          pid,
          heartbeat_at: at,
          last_github_ok_at: state.last_github_ok_at,
          stopped_at: stoppedAt,
        }),
      ),
  }
  return gate
}

/**
 * The poll loop (G24): a poll every `gate.poll_seconds` and an edit of the status issue every
 * `gate.status_issue_seconds` (G25) until `quit`, then the end of the step under way: the poll,
 * the edit, or the stage of the running pull request.
 * @param {Gate} gate
 * @param {Pipeline} pipeline
 * @param {StatusPublisher} status
 * @returns {Promise<void>}
 */
async function runLoop(gate, pipeline, status) {
  const { clock } = gate.ctx
  const interval = gate.config.hackwin.gate.poll_seconds * 1000
  /** @type {Promise<void> | null} */
  let polling = null
  /** @type {Promise<void> | null} */
  let working = null
  /** @type {Promise<unknown> | null} */
  let editing = null
  const run = pipeline.run

  const work = async () => {
    while (run && !gate.stopping) {
      const pr = gate.state.queue[0]
      if (pr === undefined) return
      gate.running = pr
      try {
        await run(gate, pr)
      } catch (error) {
        gate.line(`#${pr}: the run stopped on an unexpected error: ${messageOf(error)}`)
        return
      } finally {
        gate.running = null
        await gate.save()
      }
      // A run that leaves its pull request at the head waits for the next poll.
      if (gate.state.queue[0] === pr) return
    }
  }
  const startWork = () => {
    if (working !== null || !run || gate.stopping || gate.state.queue.length === 0) return
    working = work().finally(() => {
      working = null
    })
  }

  let next = clock.now().getTime()
  while (!gate.stopping) {
    const now = clock.now().getTime()
    if (now >= next) {
      next += interval
      // After the laptop slept, the missed polls are not made up.
      if (next <= now) next = now + interval
      await gate.beat()
      polling ??= poll(gate, pipeline).finally(() => {
        polling = null
        startWork()
      })
    }
    if (editing === null && clock.now().getTime() >= status.nextAt) {
      editing = status.publish().finally(() => {
        editing = null
      })
    }
    // While an edit is under way the next one cannot be due.
    const due = editing === null ? Math.min(next, status.nextAt) : next
    const wait = Math.max(0, Math.min(TICK_MS, due - clock.now().getTime()))
    await Promise.race([clock.sleep(wait), gate.stopped])
  }
  await Promise.all([polling, working, editing])
}

/**
 * One poll: fetch origin for the newest main, then the intake.
 * @param {Gate} gate
 * @param {Pipeline} pipeline
 * @returns {Promise<void>}
 */
async function poll(gate, pipeline) {
  const { clock } = gate.ctx
  const { state } = gate
  state.last_poll_at = clock.now().toISOString()
  const branch = gate.config.hackwin.project.default_branch
  try {
    await gate.git.fetch({ remote: 'origin' })
    state.main_sha = await gate.git.revParse(`refs/remotes/origin/${branch}`)
    state.last_github_ok_at = clock.now().toISOString()
  } catch (error) {
    gate.line(`poll: the fetch of origin failed, the next poll tries again: ${messageOf(error)}`)
  }
  if (pipeline.intake) {
    try {
      await pipeline.intake(gate)
    } catch (error) {
      gate.line(`poll: the intake failed, the next poll tries again: ${messageOf(error)}`)
    }
  }
  await gate.save()
}

/**
 * Act on a typed line (7.5 step 9).
 * @param {Gate} gate
 * @param {TypedCommand} command
 */
function onCommand(gate, command) {
  switch (command.name) {
    case 'quit':
      if (gate.stopping) return
      gate.stop()
      gate.line('quit: the Gate stops after the current step')
      return
    case 'ack':
      ack(gate, command.pr).catch((error) =>
        gate.line(`ack #${command.pr}: the state file was not written: ${messageOf(error)}`),
      )
      return
    case 'retry':
      retry(gate, command.pr)
      return
    default:
      gate.line(`unknown input: ${command.text}; ${INPUT_HELP}`)
  }
}

/**
 * `ack <PR>`: close the open secret attention item of the pull request, once the Lead has
 * rotated the secret (9.6). Nothing else closes it.
 * @param {Gate} gate
 * @param {number} pr
 * @returns {Promise<void>}
 */
async function ack(gate, pr) {
  const item = gate.state.attention.find(
    (entry) => entry.type === 'secret' && Number(entry.pr) === pr && !entry.resolved_at,
  )
  if (!item) {
    gate.line(`ack #${pr}: #${pr} has no open secret attention item`)
    return
  }
  item.resolved_at = gate.ctx.clock.now().toISOString()
  await gate.save()
  gate.line(`ack #${pr}: the secret attention item of #${pr} is closed`)
}

/**
 * `retry <PR>`: queue the current head SHA of a pull request again, after a failed or flaky run
 * that needs no new commit (A43). The intake of the next poll queues it.
 * @param {Gate} gate
 * @param {number} pr
 */
function retry(gate, pr) {
  const record = gate.state.prs[String(pr)]
  if (!record) {
    gate.line(`retry #${pr}: the Gate has not seen #${pr}`)
  } else if (gate.retries.has(pr) || gate.state.queue.includes(pr)) {
    gate.line(`retry #${pr}: #${pr} is queued already`)
  } else if (record.result !== 'failed' && record.result !== 'flaky') {
    gate.line(
      `retry #${pr}: only a failed or flaky run is retried, and the last run of #${pr} ended ${record.result ?? 'without a result'}; a new head SHA queues it again`,
    )
  } else {
    gate.retries.add(pr)
    gate.line(`retry #${pr}: queued again at the next poll`)
  }
}

/**
 * The header (7.5 step 7).
 * @param {{ gate: Gate, status: StatusPublisher, awake: KeepAwake, pid: number, pipeline: Pipeline }} parts
 * @returns {string[]}
 */
function headerLines({ gate, status, awake, pid, pipeline }) {
  const { ctx, config, state, protection } = gate
  const { gated } = config.hackwin.paths
  const restarts = state.starts > 1 ? `, restart ${state.starts - 1}` : ''
  const queued = state.queue.length
  const issue = status.issue
  const lines = [
    `${hoursAndMinutes(ctx.clock.now())} Gate started: start ${state.starts}${restarts}, pid ${pid}`,
    `protection: ${protection.state}`,
    'resolver: none',
    `poll: every ${config.hackwin.gate.poll_seconds} s`,
    `queue: ${queued} pull ${queued === 1 ? 'request' : 'requests'}`,
    `status issue: ${issue === null ? 'not created yet' : `#${issue.number} ${issue.url}`}`,
    `keep awake: ${awake.active ? awake.command : 'off'}`,
  ]
  if (gated.migrations.length === 0 && gated.production_config.length === 0) {
    lines.push(
      'notice: paths.gated is empty, so the Gate can raise no attention line for a migration or a production config change',
    )
  }
  if (!pipeline.run) {
    lines.push('notice: the pipeline is not built yet: this Gate polls, but takes no pull request')
  }
  lines.push(INPUT_HELP)
  return lines
}

/**
 * The time as the terminal prints it (9.6): hours and minutes, local time.
 * @param {Date} time
 */
function hoursAndMinutes(time) {
  const pad = (/** @type {number} */ value) => String(value).padStart(2, '0')
  return `${pad(time.getHours())}:${pad(time.getMinutes())}`
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The configuration and identity the runner prepared for every user command (contracts 3.6).
 * @param {CommandContext} ctx
 */
function prepared(ctx) {
  if (!ctx.config || !ctx.identity) {
    throw new Error('gate needs the configuration and identity that the runner prepares')
  }
  return { config: ctx.config, identity: ctx.identity }
}

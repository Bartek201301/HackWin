// `hackwin internal hook session-start` (10.4, E5): when a Claude Code session starts or resumes,
// the hook fetches, then prints a summary that Claude Code adds to the session's context:
//
// - the commits that reached main since the main commit last recorded for this worktree (by
//   `take` or an earlier session start) or, when the worktree has none, last recorded anywhere
//   in this clone (7.7 step 6), and the files they changed, the member's own scope first (I6);
// - the new "Scope change:" comments on the worktree's task;
// - the member's pull requests that wait for them (`needs-owner`, `gate:failed`,
//   `scope-violation`, as in 7.7 step 3).
//
// It then records the current main commit for the worktree, and in the main checkout applies
// CM10. It is the only Claude Code hook that uses the network. A failed fetch or GitHub call is
// named in the summary, which then uses what this clone has; the configuration and CM12 come
// from origin/main after the fetch, as in the other hooks (config.js).
//
// Claude Code puts at most 10,000 characters of a hook's plain stdout into the context; longer
// output reaches Claude only as a file path and a 2,000 character preview (hooks reference).
// The summary stays below SUMMARY_LIMIT: each part that does not fit ends with the command that
// shows the rest and the directory to run it in.

import { changesOnMain } from '../../core/changes/index.js'
import { fastForwardMainCheckout } from '../../core/config/index.js'
import { PreconditionError, RemoteError } from '../../core/runtime/errors.js'
import { runIn } from '../../core/runtime/output.js'
import { latestMainSeen, readMainSeen, writeMainSeen } from '../../core/state/index.js'
import { currentTask } from '../../core/worktrees/index.js'
import { hookIdentity, loadHookConfig } from './config.js'
import { readHookEvent } from './event.js'

/** @import { CommandContext, CommandResult } from '../../cli/context.js' */
/** @import { ChangesOnMain } from '../../core/changes/index.js' */
/** @import { Config, Identity } from '../../core/config/index.js' */
/** @import { Comment, PullRequest } from '../../core/github/index.js' */
/** @import { MainSeen } from '../../core/state/index.js' */

/** A comment that starts with this is a scope change of the task (8.1). */
export const SCOPE_CHANGE = 'Scope change:'

/** The labels on a pull request that wait for its author (7.7 step 3, 8.2). */
export const WAITING_LABELS = Object.freeze(['needs-owner', 'gate:failed', 'scope-violation'])

/** The most characters the summary prints, line breaks included: below Claude Code's 10,000. */
export const SUMMARY_LIMIT = 9000

/** A line of a commit, file, comment or pull request longer than this is cut. */
export const MAX_LINE = 240

/** The most characters of the summary for the scope changes and for the waiting pull requests. */
const SCOPE_CHANGES_LIMIT = 4000
const WAITING_LIMIT = 1000

/**
 * @typedef {MainSeen & { where: 'worktree' | 'clone' }} RecordedMain
 */

/**
 * @typedef {object} Commit
 * @property {string} sha
 * @property {string} subject
 */

/**
 * @param {CommandContext} ctx
 * @returns {Promise<CommandResult>}
 */
export async function run(ctx) {
  await readHookEvent(ctx, 'SessionStart', { optional: true })
  /** @type {string[]} */
  const problems = []
  try {
    await ctx.git.fetch({ remote: 'origin' })
  } catch (error) {
    if (!(error instanceof RemoteError)) throw error
    problems.push(`${error.message}; this summary uses origin as this clone last fetched it.`)
  }
  const config = await loadHookConfig(ctx)
  const identity = await hookIdentity(ctx, config)
  const defaultBranch = config.hackwin.project.default_branch
  const { status: fastForward } = await fastForwardMainCheckout(ctx.git, { defaultBranch })

  const dir = ctx.gitCommonDir
  const worktree = ctx.repoRoot
  const own = await readMainSeen(dir, worktree)
  const latest = own ? null : await latestMainSeen(dir)
  /** @type {RecordedMain | null} */
  const recorded = own
    ? { ...own, where: 'worktree' }
    : latest
      ? { ...latest, where: 'clone' }
      : null
  const changes = await changesOnMain(ctx.git, {
    from: recorded?.main_sha ?? null,
    to: config.sha,
    ownPaths: identity.roles.flatMap((role) => config.owners.roles[role]?.paths ?? []),
  })
  const commits = changes.from === null ? [] : await commitsBetween(ctx, changes.from, changes.to)

  const task = await currentTask(ctx.git)
  /** @type {Comment[]} */
  let scopeChanges = []
  if (task !== null) {
    try {
      const since = own === null ? null : Date.parse(own.recorded_at)
      scopeChanges = (await ctx.github.listComments(task.issue)).filter(
        (comment) =>
          comment.body.trimStart().startsWith(SCOPE_CHANGE) &&
          (since === null || Date.parse(comment.createdAt) > since),
      )
    } catch (error) {
      if (!isUnreachable(error)) throw error
      problems.push(`The scope changes of task #${task.issue} could not be read: ${error.message}`)
    }
  }
  /** @type {PullRequest[]} */
  let waiting = []
  try {
    waiting = await pullsWaitingFor(ctx, identity.login)
  } catch (error) {
    if (!isUnreachable(error)) throw error
    problems.push(`The pull requests that wait for you could not be read: ${error.message}`)
  }

  await writeMainSeen(dir, worktree, changes.to, ctx.clock.now())

  const changeParts = changesParts({ config, identity, recorded, changes, commits, worktree })
  const opening = [
    `HackWin session start for ${identity.login} in ${worktree}${task ? `, on task #${task.issue} (${task.branch})` : ''}.`,
    ...problems.map((problem) => clip(problem, 2 * MAX_LINE)),
    changeParts.head,
  ]
  const closing = [
    ...fastForwardLines(fastForward, defaultBranch, worktree),
    `Recorded ${changes.to.slice(0, 12)} as the main commit this worktree has seen.`,
  ]
  // The parts get the room in the order of their weight: a scope change changes the task.
  let room = SUMMARY_LIMIT - sizeOf([...opening, ...closing])
  const scopeLines = scopeChangeLines({
    issue: task?.issue ?? null,
    comments: scopeChanges,
    sinceRecord: own !== null,
    worktree,
    budget: Math.min(room, SCOPE_CHANGES_LIMIT),
  })
  room -= sizeOf(scopeLines)
  const waitingPart = waitingLines(waiting, identity.login, worktree, Math.min(room, WAITING_LIMIT))
  room -= sizeOf(waitingPart)
  const commitLines = changeParts.commits(Math.floor(room / 2))
  room -= sizeOf(commitLines)
  const fileLines = changeParts.files(room)

  const lines = [
    ...opening,
    ...commitLines,
    ...fileLines,
    ...scopeLines,
    ...waitingPart,
    ...closing,
  ]
  return {
    lines,
    data: {
      login: identity.login,
      worktree,
      task: task?.issue ?? null,
      recorded,
      from: changes.from,
      to: changes.to,
      commits,
      files: changes.files,
      scopeChanges,
      waitingPulls: waiting.map(({ number, title, labels, url }) => ({
        number,
        title,
        labels,
        url,
      })),
      fastForward,
      problems,
    },
  }
}

/**
 * The commits that reached main between two commits, oldest first: the first-parent history, so
 * a merged pull request is one commit.
 * @param {CommandContext} ctx
 * @param {string} from
 * @param {string} to
 * @returns {Promise<Commit[]>}
 */
async function commitsBetween(ctx, from, to) {
  const result = await ctx.git.run([
    'log',
    '--first-parent',
    '--reverse',
    '--format=%H%x09%s',
    `${from}..${to}`,
  ])
  return result.stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const tab = line.indexOf('\t')
      return { sha: line.slice(0, tab), subject: line.slice(tab + 1) }
    })
}

/**
 * The open pull requests of the member that carry a label that waits for them.
 * @param {CommandContext} ctx
 * @param {string} login
 * @returns {Promise<PullRequest[]>}
 */
async function pullsWaitingFor(ctx, login) {
  const wanted = login.toLowerCase()
  return (await ctx.github.listPullRequests({ state: 'open' })).filter(
    (pull) =>
      pull.author?.toLowerCase() === wanted &&
      pull.labels.some((label) => WAITING_LABELS.includes(label)),
  )
}

/**
 * The summary of the changes on main: the line that says since which commit, and the lists of
 * commits and files, each cut to a budget.
 * @param {object} input
 * @param {Config} input.config
 * @param {Identity} input.identity
 * @param {RecordedMain | null} input.recorded
 * @param {ChangesOnMain} input.changes
 * @param {Commit[]} input.commits
 * @param {string} input.worktree
 * @returns {{ head: string, commits: (budget: number) => string[], files: (budget: number) => string[] }}
 */
function changesParts({ config, identity, recorded, changes, commits, worktree }) {
  const at = `${config.ref} is at ${changes.to.slice(0, 12)}.`
  const none = { commits: () => [], files: () => [] }
  if (recorded === null) {
    return {
      head: `${at} No main commit was recorded in this clone before, so there is no list of the commits that reached main; the next session start lists the commits after this one.`,
      ...none,
    }
  }
  const where = recorded.where === 'worktree' ? 'for this worktree' : 'in this clone'
  const since = `${recorded.main_sha.slice(0, 12)}, the main commit last recorded ${where} (${recorded.recorded_at})`
  if (changes.from === null) {
    return {
      head: `${at} The main commit last recorded ${where}, ${recorded.main_sha}, is not in this clone, so there is no list of the commits that reached main.`,
      ...none,
    }
  }
  if (commits.length === 0) return { head: `${at} No commit reached main since ${since}.`, ...none }

  const range = `${changes.from.slice(0, 12)}..${changes.to.slice(0, 12)}`
  const own = changes.files.filter((file) => file.own)
  const other = changes.files.filter((file) => !file.own)
  const fileList = [
    'Files these commits changed, your own scope first:',
    ...(own.length > 0
      ? [`In your roles (${identity.roles.join(', ')}):`, ...own.map(fileLine)]
      : []),
    ...(other.length > 0 ? ['Elsewhere:', ...other.map(fileLine)] : []),
  ]
  return {
    head: `${at} Commits that reached main since ${since}:`,
    commits: (budget) =>
      fit(
        commits.map(({ sha, subject }) => clip(`- ${sha.slice(0, 12)} ${subject}`)),
        budget,
        (left) =>
          `- and ${left.length} more; to see them, ${runIn(`git log --first-parent --oneline ${range}`, worktree)}`,
      ),
    files: (budget) =>
      changes.files.length === 0
        ? []
        : fit(
            fileList,
            budget,
            (left) =>
              `- and ${left.filter((line) => line.startsWith('- ')).length} more files; to see them, ${runIn(`git diff --name-status ${range}`, worktree)}`,
          ),
  }
}

/**
 * The scope changes, oldest first, within a budget. A later scope change wins over an earlier
 * one, so when not all fit, the newest are kept, the oldest kept one may be cut, and a last line
 * says where to read them all.
 * @param {object} input
 * @param {number | null} input.issue
 * @param {Comment[]} input.comments
 * @param {boolean} input.sinceRecord False when the worktree had no record, so every one is listed.
 * @param {string} input.worktree
 * @param {number} input.budget
 * @returns {string[]}
 */
function scopeChangeLines({ issue, comments, sinceRecord, worktree, budget }) {
  if (issue === null || comments.length === 0) return []
  const what = sinceRecord ? 'New scope changes' : 'Scope changes'
  const title = `${what} on task #${issue}, oldest first. A scope change wins over the issue text, and a later one over an earlier one:`
  const pointer = `Not every scope change is shown in full here; to read them all, ${runIn(`gh issue view ${issue} --comments`, worktree)}.`
  const blocks = comments.map((comment) => [
    `${comment.author}, ${comment.createdAt}:`,
    ...comment.body
      .trim()
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => clip(line === '' ? '>' : `> ${line}`)),
  ])
  if (sizeOf([title, ...blocks.flat()]) <= budget) return [title, ...blocks.flat()]

  let room = budget - sizeOf([title, pointer])
  /** @type {string[][]} */
  const kept = []
  for (const block of blocks.reverse()) {
    if (sizeOf(block) <= room) {
      kept.unshift(block)
      room -= sizeOf(block)
      continue
    }
    const part = fit(block, room, () => '> ...')
    if (part.length > 2) kept.unshift(part)
    break
  }
  return [title, ...kept.flat(), pointer]
}

/**
 * @param {PullRequest[]} pulls
 * @param {string} login
 * @param {string} worktree
 * @param {number} budget
 * @returns {string[]}
 */
function waitingLines(pulls, login, worktree, budget) {
  if (pulls.length === 0) return []
  const title = 'Your pull requests that wait for you:'
  const lines = pulls.map((pull) => {
    const labels = pull.labels.filter((label) => WAITING_LABELS.includes(label)).join(', ')
    const where = pull.url ? `; read the Gate's comment on ${pull.url}` : ''
    return clip(`- PR #${pull.number} ${pull.title}: ${labels}${where}`, 2 * MAX_LINE)
  })
  return [
    title,
    ...fit(
      lines,
      budget - sizeOf([title]),
      (left) =>
        `- and ${left.length} more; to see them, ${runIn(`gh pr list --author ${login} --state open`, worktree)}`,
    ),
  ]
}

/**
 * The first lines that fit into a budget of characters, line breaks included. When not all fit,
 * the line `rest(<the lines left out>)` follows them; room for it is kept.
 * @param {string[]} lines
 * @param {number} budget
 * @param {(left: string[]) => string} rest
 * @returns {string[]}
 */
function fit(lines, budget, rest) {
  if (sizeOf(lines) <= budget) return lines
  let room = budget - sizeOf([rest(lines)])
  let count = 0
  while (count < lines.length && lines[count].length + 1 <= room) {
    room -= lines[count].length + 1
    count += 1
  }
  return [...lines.slice(0, count), rest(lines.slice(count))]
}

/**
 * The characters that lines take on stdout, a line break after each.
 * @param {string[]} lines
 * @returns {number}
 */
function sizeOf(lines) {
  return lines.reduce((sum, line) => sum + line.length + 1, 0)
}

/**
 * @param {string} line
 * @param {number} [max]
 * @returns {string}
 */
function clip(line, max = MAX_LINE) {
  return line.length <= max ? line : `${line.slice(0, max - 3)}...`
}

/**
 * CM10 in the main checkout.
 * @param {string} status
 * @param {string} defaultBranch
 * @param {string} worktree
 * @returns {string[]}
 */
function fastForwardLines(status, defaultBranch, worktree) {
  if (status === 'fast-forwarded') {
    return [`The main checkout was fast-forwarded to origin/${defaultBranch}.`]
  }
  if (status === 'behind') {
    return [
      `The main checkout is behind origin/${defaultBranch} and was not fast-forwarded, because it has local changes or is not on ${defaultBranch}; to update it, ${runIn(`git merge --ff-only origin/${defaultBranch}`, worktree)}.`,
    ]
  }
  return []
}

/**
 * @param {{ path: string, status: string, oldPath: string | null }} file
 * @returns {string}
 */
function fileLine(file) {
  return `- ${file.status} ${file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path}`
}

/**
 * True for a failure of GitHub or of gh that leaves the rest of the summary valid.
 * @param {unknown} error
 * @returns {boolean}
 */
function isUnreachable(error) {
  return error instanceof RemoteError || error instanceof PreconditionError
}

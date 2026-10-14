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

/** The most commits and files the summary lists; the rest is counted. */
export const MAX_COMMITS = 30
export const MAX_FILES = 50

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

  const lines = [
    `HackWin session start for ${identity.login} in ${worktree}${task ? `, on task #${task.issue} (${task.branch})` : ''}.`,
    ...problems,
    ...changesLines({ config, identity, recorded, changes, commits, worktree }),
    ...scopeChangeLines(task?.issue ?? null, scopeChanges, own !== null),
    ...waitingLines(waiting),
    ...fastForwardLines(fastForward, defaultBranch, worktree),
    `Recorded ${changes.to.slice(0, 12)} as the main commit this worktree has seen.`,
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
 * @param {object} input
 * @param {Config} input.config
 * @param {Identity} input.identity
 * @param {RecordedMain | null} input.recorded
 * @param {ChangesOnMain} input.changes
 * @param {Commit[]} input.commits
 * @param {string} input.worktree
 * @returns {string[]}
 */
function changesLines({ config, identity, recorded, changes, commits, worktree }) {
  const head = `${config.ref} is at ${changes.to.slice(0, 12)}.`
  if (recorded === null) {
    return [
      `${head} No main commit was recorded in this clone before, so there is no list of the commits that reached main; the next session start lists the commits after this one.`,
    ]
  }
  const where = recorded.where === 'worktree' ? 'for this worktree' : 'in this clone'
  const since = `${recorded.main_sha.slice(0, 12)}, the main commit last recorded ${where} (${recorded.recorded_at})`
  if (changes.from === null) {
    return [
      `${head} The main commit last recorded ${where}, ${recorded.main_sha}, is not in this clone, so there is no list of the commits that reached main.`,
    ]
  }
  if (commits.length === 0) return [`${head} No commit reached main since ${since}.`]

  const lines = [`${head} Commits that reached main since ${since}:`]
  lines.push(
    ...commits.slice(0, MAX_COMMITS).map(({ sha, subject }) => `- ${sha.slice(0, 12)} ${subject}`),
  )
  const range = `${changes.from.slice(0, 12)}..${changes.to.slice(0, 12)}`
  if (commits.length > MAX_COMMITS) {
    lines.push(
      `- and ${commits.length - MAX_COMMITS} more; to see them, ${runIn(`git log --first-parent --oneline ${range}`, worktree)}`,
    )
  }
  if (changes.files.length === 0) return lines

  const shown = changes.files.slice(0, MAX_FILES)
  const own = shown.filter((file) => file.own)
  const other = shown.filter((file) => !file.own)
  lines.push('Files these commits changed, your own scope first:')
  if (own.length > 0) {
    lines.push(`In your roles (${identity.roles.join(', ')}):`, ...own.map(fileLine))
  }
  if (other.length > 0) lines.push('Elsewhere:', ...other.map(fileLine))
  if (changes.files.length > MAX_FILES) {
    lines.push(
      `- and ${changes.files.length - MAX_FILES} more; to see them, ${runIn(`git diff --name-status ${range}`, worktree)}`,
    )
  }
  return lines
}

/**
 * @param {number | null} issue
 * @param {Comment[]} comments
 * @param {boolean} sinceRecord False when the worktree had no record, so every one is listed.
 * @returns {string[]}
 */
function scopeChangeLines(issue, comments, sinceRecord) {
  if (issue === null || comments.length === 0) return []
  const what = sinceRecord ? 'New scope changes' : 'Scope changes'
  const lines = [
    `${what} on task #${issue}, oldest first. A scope change wins over the issue text, and a later one over an earlier one:`,
  ]
  for (const comment of comments) {
    lines.push(`${comment.author}, ${comment.createdAt}:`)
    lines.push(
      ...comment.body
        .trim()
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line) => (line === '' ? '>' : `> ${line}`)),
    )
  }
  return lines
}

/**
 * @param {PullRequest[]} pulls
 * @returns {string[]}
 */
function waitingLines(pulls) {
  if (pulls.length === 0) return []
  return [
    'Your pull requests that wait for you:',
    ...pulls.map((pull) => {
      const labels = pull.labels.filter((label) => WAITING_LABELS.includes(label)).join(', ')
      const where = pull.url ? `; read the Gate's comment on ${pull.url}` : ''
      return `- PR #${pull.number} ${pull.title}: ${labels}${where}`
    }),
  ]
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

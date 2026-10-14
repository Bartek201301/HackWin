// Resuming a task (7.7, "Resuming and releasing", A12): which kind of `take N` a run is, the pull
// request that the Gate handed back with the Gate's comment, and the state of the branch that a
// continue prompt and a fix prompt describe.

/** @import { Git } from '../../core/git/index.js' */
/** @import { Comment, GitHub, PullRequest } from '../../core/github/index.js' */
/** @import { Task } from '../../core/tasks/index.js' */
/** @import { CheckScope } from './checks.js' */
/** @import { BranchUpdate, RefUpdate } from './worktree.js' */

/** The label of a pull request that the Gate handed back (8.2, 9.2). */
export const GATE_FAILED = 'gate:failed'

/** The labels on a pull request that the Gate handed back, in the order a prompt names them. */
export const HANDBACK_LABELS = Object.freeze([GATE_FAILED, 'needs-owner', 'scope-violation'])

/**
 * What `take N` does with the task.
 * - `take`: the task is not the caller's yet; the checks decide whether it can be taken.
 * - `resume`: the caller's own task in progress, for example after a crash, a usage limit or a
 *   cleared session. `unassigned` marks a claim that an earlier `take` left half done: in progress
 *   without an assignee, because it failed between setting the label and adding the assignee.
 * - `fix`: the caller's own task in review whose pull request the Gate labeled `gate:failed`.
 * @typedef {{ kind: 'take' } | { kind: 'resume', unassigned: boolean } | { kind: 'fix', pull: PullRequest }} TakeMode
 */

/**
 * @typedef {object} BranchState
 * @property {string} branch
 * @property {string} head The commit the branch points to.
 * @property {{ ref: string, sha: string, contained: boolean }} main The default branch, and
 *   whether the branch contains it.
 * @property {Array<{ sha: string, subject: string }>} commits The commits of the branch that the
 *   default branch lacks, newest first.
 * @property {{ ref: string, sha: string | null, ahead: number, behind: number }} remote The remote
 *   branch: `ahead` counts the commits it lacks, `behind` the commits the branch lacks.
 * @property {string[]} changes The uncommitted changes and untracked files, as
 *   `git status --short` lists them.
 * @property {boolean} merging A merge is in progress in the worktree.
 * @property {BranchUpdate} update What `take` did to bring the branch up to date.
 */

/**
 * The kind of `take N` for a task: a resume of the caller's own task in progress, also of a claim
 * left half done; a fix of the caller's own task in review whose pull request is labeled
 * `gate:failed`; otherwise a take, which the checks may refuse. A task in review is the caller's
 * own when they are its assignee or the author of its pull request.
 * @param {Task} task
 * @param {CheckScope} scope
 * @returns {Promise<TakeMode>}
 */
export async function modeOf(task, { board, identity }) {
  const login = identity.login.toLowerCase()
  const assigned = task.assignees.some((name) => name.toLowerCase() === login)
  if (task.status === 'in-progress') {
    if (assigned) return { kind: 'resume', unassigned: false }
    if (task.assignees.length === 0) return { kind: 'resume', unassigned: true }
  }
  if (task.status === 'in-review') {
    const pulls = await board.taskPulls(task.number)
    const own = assigned || pulls.some((pull) => pull.author?.toLowerCase() === login)
    const failed = pulls.find((pull) => pull.labels.includes(GATE_FAILED))
    if (own && failed) return { kind: 'fix', pull: failed }
  }
  return { kind: 'take' }
}

/**
 * The Gate's comment on a pull request it handed back: the newest comment of the Lead's account,
 * under which the Gate acts (5.4, A5). A failed Gate run leaves exactly one comment (G21), so the
 * newest one is that of the last failed run.
 * @param {GitHub} github
 * @param {PullRequest} pull
 * @param {string} lead The Lead's login, `team.lead` of hackwin.yml.
 * @returns {Promise<Comment | null>}
 */
export async function gateComment(github, pull, lead) {
  const wanted = lead.toLowerCase()
  const comments = await github.listComments(pull.number)
  return comments.findLast((comment) => comment.author?.toLowerCase() === wanted) ?? null
}

/**
 * The state of the branch in its worktree, after `take` brought it up to date.
 * @param {Git} git Git in the worktree.
 * @param {{ branch: string, mainRef: string, mainSha: string, update: BranchUpdate }} options
 * @returns {Promise<BranchState>}
 */
export async function branchState(git, { branch, mainRef, mainSha, update }) {
  const head = await git.revParse('HEAD')
  const log = await git.run(['log', '--format=%H%x09%s', `${mainSha}..HEAD`])
  const commits = lines(log.stdout).map((line) => {
    const [sha, ...subject] = line.split('\t')
    return { sha, subject: subject.join('\t') }
  })

  const remoteRef = `origin/${branch}`
  const remoteSha = await git.tryRevParse(`refs/remotes/${remoteRef}`)
  let ahead = 0
  let behind = 0
  if (remoteSha !== null) {
    const counts = await git.run(['rev-list', '--left-right', '--count', `${remoteSha}...HEAD`])
    ;[behind, ahead] = counts.stdout.trim().split(/\s+/).map(Number)
  }

  const status = await git.run(['status', '--porcelain'])
  return {
    branch,
    head,
    main: { ref: mainRef, sha: mainSha, contained: await git.isAncestor(mainSha, 'HEAD') },
    commits,
    remote: { ref: remoteRef, sha: remoteSha, ahead, behind },
    changes: lines(status.stdout),
    merging: (await git.tryRevParse('MERGE_HEAD')) !== null,
    update,
  }
}

/**
 * The output line of one ref of the update, or null when nothing needs saying.
 * @param {string} branch
 * @param {RefUpdate} update
 * @returns {{ text: string, warning: boolean } | null}
 */
export function updateLine(branch, { ref, sha, status, reason, conflicts }) {
  const at = sha ? ` ${sha.slice(0, 12)}` : ''
  if (status === 'fast-forward') {
    return { text: `fast-forwarded ${branch} to ${ref}${at}`, warning: false }
  }
  if (status === 'merged') return { text: `merged ${ref}${at} into ${branch}`, warning: false }
  if (status !== 'not-merged') return null
  const files = conflicts.length > 0 ? `: ${conflicts.join(', ')}` : ''
  return {
    text: `${branch} lacks commits of ${ref}${at}, which take did not merge: ${reason}${files}; \`hackwin ship\` merges ${ref} before it checks the branch`,
    warning: true,
  }
}

/**
 * The lines of an output without the empty ones; leading spaces stay.
 * @param {string} output
 * @returns {string[]}
 */
function lines(output) {
  return output.split('\n').filter((line) => line.trim() !== '')
}

// Step 6 of `take` (7.7): the prompt, composed on the member's machine from the issue, the rules
// of the role and the local state. Its seven parts come in the order of 7.7 step 6: the task,
// the role and its paths, where to run, what changed on main, the finish rule, the security
// rules and the personal settings. `take` writes it to `prompts/<issue>.md` (contracts 5.6) and
// records the main commit it describes for the worktree (E5, I6).
//
// A resume (A12) gets a continue prompt, the seven parts plus the state of the branch, and a
// task whose pull request the Gate handed back gets a fix prompt, the seven parts plus the
// Gate's comment and the state of the branch.

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { changesOnMain } from '../../core/changes/index.js'
import { latestMainSeen, promptPath, readMainSeen, writeMainSeen } from '../../core/state/index.js'
import { HANDBACK_LABELS } from './resume.js'

/** @import { CommandContext } from '../../cli/context.js' */
/** @import { Config, Identity } from '../../core/config/index.js' */
/** @import { ChangesOnMain } from '../../core/changes/index.js' */
/** @import { Comment, Issue, PullRequest } from '../../core/github/index.js' */
/** @import { LocalRecord, MainSeen } from '../../core/state/index.js' */
/** @import { TaskBlock } from '../../core/tasks/index.js' */
/** @import { BranchState } from './resume.js' */
/** @import { RefUpdate } from './worktree.js' */

/** The headings of the seven parts, in their order (7.7 step 6). */
export const PROMPT_PARTS = Object.freeze([
  '1. The task',
  '2. Your role and its paths',
  '3. Where to run',
  '4. What changed on main',
  '5. When you finish',
  '6. Security',
  '7. Personal settings',
])

/** The headings of the parts that follow the seven, by the kind of prompt (A12). */
export const EXTRA_PARTS = Object.freeze({
  first: Object.freeze([]),
  continue: Object.freeze(['8. The state of the branch']),
  fix: Object.freeze(["8. The Gate's comment", '9. The state of the branch']),
})

/** A comment that starts with this is a scope change of the task (8.1). */
export const SCOPE_CHANGE = 'Scope change:'

/** The most changed files the prompt lists; the rest is counted. */
export const MAX_CHANGED_FILES = 50

/** The most commits and uncommitted changes the state of the branch lists; the rest is counted. */
export const MAX_BRANCH_LINES = 30

const TASK_MARKER = '# hackwin:task'

/**
 * Where the main commit that the changes start from was recorded.
 * @typedef {MainSeen & { where: 'worktree' | 'clone' }} RecordedMain
 */

/**
 * The kind of prompt: the first prompt of a task, a continue prompt for a resume, or a fix prompt
 * for a pull request that the Gate handed back (A12).
 * @typedef {'first' | 'continue' | 'fix'} PromptKind
 */

/**
 * The pull request that the Gate handed back and the Gate's comment on it.
 * @typedef {object} Handback
 * @property {Pick<PullRequest, 'number' | 'url' | 'labels'>} pull
 * @property {Comment | null} comment
 */

/**
 * Everything the prompt says.
 * @typedef {object} PromptInput
 * @property {PromptKind} [kind] `first` by default.
 * @property {BranchState | null} [state] The state of the branch, for a continue or fix prompt.
 * @property {Handback | null} [handback] For a fix prompt.
 * @property {Pick<Issue, 'number' | 'title' | 'body' | 'url'>} issue
 * @property {TaskBlock} block
 * @property {Comment[]} scopeChanges Oldest first.
 * @property {{ paths: string[], shared: boolean }} role The task's role in owners.yml.
 * @property {string[]} open The `open` list of owners.yml.
 * @property {boolean} isLead True when the caller is the Lead.
 * @property {string} worktree
 * @property {string} branch
 * @property {string} main The main checkout.
 * @property {string} defaultBranch
 * @property {ChangesOnMain} changes
 * @property {RecordedMain | null} recorded The record the changes start from.
 * @property {string | undefined} language The member's answer language.
 * @property {string | undefined} explanationStyle
 * @property {string} projectLanguage
 */

/**
 * @typedef {object} WrittenPrompt
 * @property {PromptKind} kind
 * @property {string} file The absolute path of `prompts/<issue>.md`.
 * @property {string} text
 * @property {ChangesOnMain} changes
 * @property {RecordedMain | null} recorded
 */

/**
 * Compose the prompt of a task, write it to its prompt file and record the main commit for the
 * worktree. The changes on main start from the commit last recorded for this worktree or, when
 * the worktree has none, last recorded anywhere in this clone.
 * @param {CommandContext} ctx
 * @param {object} options
 * @param {Config} options.config
 * @param {Identity} options.identity
 * @param {Issue} options.issue
 * @param {TaskBlock} options.block
 * @param {LocalRecord | null} options.local The join record with the personal settings.
 * @param {string} options.main
 * @param {string} options.worktree
 * @param {string} options.branch
 * @param {string} options.mainSha The commit of the default branch that the prompt describes.
 * @param {PromptKind} [options.kind] `first` by default.
 * @param {BranchState | null} [options.state] For a continue or fix prompt.
 * @param {Handback | null} [options.handback] For a fix prompt.
 * @returns {Promise<WrittenPrompt>}
 */
export async function writeTaskPrompt(ctx, options) {
  const { config, identity, issue, block, local, main, worktree, branch, mainSha } = options
  const { kind = 'first', state = null, handback = null } = options
  const dir = ctx.gitCommonDir
  const own = await readMainSeen(dir, worktree)
  const latest = own ? null : await latestMainSeen(dir)
  /** @type {RecordedMain | null} */
  const recorded = own
    ? { ...own, where: 'worktree' }
    : latest
      ? { ...latest, where: 'clone' }
      : null
  const ownPaths = identity.roles.flatMap((role) => config.owners.roles[role]?.paths ?? [])
  const changes = await changesOnMain(ctx.git, {
    from: recorded?.main_sha ?? null,
    to: mainSha,
    ownPaths,
  })
  const comments = await ctx.github.listComments(issue.number)
  const role = config.owners.roles[block.role]

  const text = composePrompt({
    kind,
    state,
    handback,
    issue,
    block,
    scopeChanges: comments.filter((comment) => comment.body.trimStart().startsWith(SCOPE_CHANGE)),
    role: { paths: role?.paths ?? [], shared: role?.shared === true },
    open: config.owners.open,
    isLead: identity.isLead,
    worktree,
    branch,
    main,
    defaultBranch: config.hackwin.project.default_branch,
    changes,
    recorded,
    language: local?.language,
    explanationStyle: local?.explanation_style,
    projectLanguage: config.hackwin.project.language,
  })

  const file = promptPath(dir, issue.number)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, text)
  await writeMainSeen(dir, worktree, changes.to, ctx.clock.now())
  return { kind, file, text, changes, recorded }
}

/**
 * The prompt text: a title, one line on how it relates to `AGENTS.md`, and the seven parts; a
 * continue prompt adds the state of the branch, a fix prompt the Gate's comment and the state of
 * the branch.
 * @param {PromptInput} input
 * @returns {string}
 */
export function composePrompt(input) {
  const kind = input.kind ?? 'first'
  const parts = [
    taskPart(input),
    rolePart(input),
    wherePart(input),
    changesPart(input),
    finishPart(input),
    securityPart(),
    personalPart(input),
  ]
  if (kind === 'fix') parts.push(handbackPart(input))
  if (kind !== 'first') parts.push(statePart(input))
  const headings = [...PROMPT_PARTS, ...EXTRA_PARTS[kind]]
  const sections = parts.map((lines, index) => [`## ${headings[index]}`, '', ...lines].join('\n'))
  return [
    `# Task #${input.issue.number}: ${input.issue.title}`,
    '',
    introOf(kind),
    '',
    sections.join('\n\n'),
    '',
  ].join('\n')
}

/**
 * The line under the title: what the session does, and that `AGENTS.md` applies.
 * @param {PromptKind} kind
 * @returns {string}
 */
function introOf(kind) {
  const rules = 'The rules of `AGENTS.md` apply; this prompt adds what is specific to the task.'
  if (kind === 'continue') {
    return `You continue this one task in its own worktree. An earlier session worked on it and stopped: do not start over, but read the state of the branch in part 8 and go on from there. ${rules}`
  }
  if (kind === 'fix') {
    return `You fix this one task in its own worktree. Its pull request was handed back by the Gate: part 8 holds the Gate's comment, part 9 the state of the branch. ${rules}`
  }
  return `You work on this one task in its own worktree. ${rules}`
}

/**
 * Part 1: the issue text, the acceptance tests, the deadline as the hard stop time and every
 * scope change.
 * @param {PromptInput} input
 * @returns {string[]}
 */
function taskPart({ issue, block, scopeChanges }) {
  const body = issueText(issue.body)
  const lines = [issue.url ? `Issue: ${issue.url}` : `Issue: #${issue.number}`, '']
  lines.push(body === '' ? 'The issue has no text besides its task block.' : body, '')
  lines.push('### Acceptance tests', '')
  if (block.acceptance_tests.length === 0) lines.push('The task names none.')
  else {
    lines.push('These must pass before you ship:')
    lines.push(...block.acceptance_tests.map((test) => `- \`${test}\``))
  }
  lines.push('', '### Deadline', '')
  lines.push(`${block.deadline}. This is the hard stop time: ship before it.`, '')
  lines.push('### Scope changes', '')
  if (scopeChanges.length === 0) {
    lines.push('None.')
  } else {
    lines.push(
      'Oldest first. A scope change wins over the text above, and a later one over an earlier one.',
    )
    for (const comment of scopeChanges) {
      lines.push('', `${comment.author}, ${comment.createdAt}:`, '')
      lines.push(...comment.body.trim().replace(/\r\n?/g, '\n').split('\n').map(quoted))
    }
  }
  return lines
}

/**
 * Part 2: the role, its owned paths, the task's own paths, and that every other path must not
 * be touched and shared changes are requested from the Lead (I14).
 * @param {PromptInput} input
 * @returns {string[]}
 */
function rolePart({ block, role, open, isLead }) {
  const lines = [`Your role for this task is \`${block.role}\`. It owns these paths:`, '']
  lines.push(...role.paths.map((path) => `- \`${path}\``))
  if (role.shared) lines.push('- every path that no role of `owners.yml` names')
  lines.push('', "The task's own paths, where its changes belong:", '')
  lines.push(...block.paths.map((path) => `- \`${path}\``))
  if (open.length > 0) {
    lines.push(
      '',
      `Anyone may edit the paths on the open list: ${open.map((path) => `\`${path}\``).join(', ')}.`,
    )
  }
  const ask = isLead
    ? 'stop: you are the Lead, so write a separate task for it'
    : 'stop and ask the Lead, who writes a task for it'
  lines.push(
    '',
    `Every other path must not be touched: never edit, move or delete a file outside these paths, not even to fix a typo or a failing test. When the task needs a change outside them, ${ask}.`,
  )
  return lines
}

/**
 * Part 3: the absolute worktree path and the branch.
 * @param {PromptInput} input
 * @returns {string[]}
 */
function wherePart({ worktree, branch, main }) {
  return [
    `- Worktree: \`${worktree}\``,
    `- Branch: \`${branch}\``,
    '',
    `Run every command in this worktree, on this branch. Never work in the main checkout, \`${main}\`, or in another worktree.`,
  ]
}

/**
 * Part 4: the files changed on the default branch since the recorded main commit, the member's
 * own scope first (E5, I6). The first `take` in a clone has no recorded commit and says so.
 * @param {PromptInput} input
 * @returns {string[]}
 */
function changesPart({ changes, recorded, defaultBranch, worktree }) {
  const head = `\`origin/${defaultBranch}\` is at \`${changes.to}\`.`
  if (recorded === null) {
    return [
      head,
      '',
      'No main commit was recorded in this clone before, so there is no list of the files that changed on main. `take` recorded this commit for the worktree, so the next prompt lists the changes after it.',
    ]
  }
  const where = recorded.where === 'worktree' ? 'for this worktree' : 'in this clone'
  const since = `\`${recorded.main_sha}\`, the main commit last recorded ${where} (${recorded.recorded_at})`
  if (changes.from === null) {
    return [
      head,
      '',
      `The main commit last recorded ${where}, \`${recorded.main_sha}\`, is not in this clone, so there is no list of the files that changed on main.`,
    ]
  }
  if (changes.files.length === 0) return [head, '', `No file changed on main since ${since}.`]

  const shown = changes.files.slice(0, MAX_CHANGED_FILES)
  const own = shown.filter((file) => file.own)
  const other = shown.filter((file) => !file.own)
  const lines = [head, '', `Files changed on main since ${since}, your own scope first:`]
  if (own.length > 0) lines.push('', 'In your scope:', '', ...own.map(changeLine))
  if (other.length > 0) lines.push('', 'Elsewhere:', '', ...other.map(changeLine))
  const rest = changes.files.length - shown.length
  if (rest > 0) {
    lines.push(
      '',
      `And ${rest} more. For the full list, run \`git diff --name-status ${changes.from} ${changes.to}\` in \`${worktree}\`.`,
    )
  }
  return lines
}

/**
 * Part 5: commit, `ship`, stop with the pull request number and head SHA, never merge.
 * @param {PromptInput} input
 * @returns {string[]}
 */
function finishPart({ worktree, branch, defaultBranch }) {
  return [
    `1. Commit your work on \`${branch}\`.`,
    `2. Run \`hackwin ship\` in \`${worktree}\`. It merges \`origin/${defaultBranch}\`, runs the checks and opens the pull request.`,
    '3. Stop, and report the pull request number and the full head SHA.',
    '',
    `Never merge a pull request, your own included, and never push to \`${defaultBranch}\`.`,
  ]
}

/**
 * Part 6: the security rules.
 * @returns {string[]}
 */
function securityPart() {
  return [
    '- Never read or print `.env.local`, or any other env file except `.env.example`.',
    '- Leave every database and production config change to the Lead: never apply a migration and never change production configuration, also not outside the repository.',
  ]
}

/**
 * The part of a fix prompt with the pull request that the Gate handed back and the Gate's
 * comment (A12).
 * @param {PromptInput} input
 * @returns {string[]}
 */
function handbackPart({ handback }) {
  if (!handback) throw new TypeError('a fix prompt needs the pull request the Gate handed back')
  const { pull, comment } = handback
  const labels = HANDBACK_LABELS.filter((label) => pull.labels.includes(label))
  const where = pull.url ? ` (${pull.url})` : ''
  const lines = [
    `The Gate handed pull request #${pull.number}${where} back: it is labeled ${labels.map((label) => `\`${label}\``).join(', ')}.`,
    '',
  ]
  if (comment === null) {
    lines.push(
      "The pull request has no comment of the Gate's account. Ask the Lead what the Gate reported before you change anything.",
    )
  } else {
    const link = comment.url ? `, ${comment.url}` : ''
    lines.push(`The Gate's comment, ${comment.createdAt}${link}:`, '')
    lines.push(...comment.body.trim().replace(/\r\n?/g, '\n').split('\n').map(quoted))
  }
  lines.push(
    '',
    `Fix what the comment names, on this branch and inside your paths. Then finish as part 5 says: \`hackwin ship\` updates pull request #${pull.number}.`,
  )
  return lines
}

/**
 * The part of a continue or fix prompt with the state of the branch: its commits, its remote
 * branch, the uncommitted changes and what `take` did to bring it up to date (A12).
 * @param {PromptInput} input
 * @returns {string[]}
 */
function statePart({ state }) {
  if (!state) throw new TypeError('a continue or fix prompt needs the state of the branch')
  const { branch, head, main, remote, commits, changes, update } = state
  const lines = [`- \`${branch}\` is at \`${head}\`.`]
  for (const ref of [update.remote, update.main]) {
    const line = updateText(ref)
    if (line) lines.push(`- ${line}`)
  }
  lines.push(
    main.contained
      ? `- It contains \`${main.ref}\` at \`${main.sha}\`.`
      : `- It does not contain \`${main.ref}\` at \`${main.sha}\`. \`hackwin ship\` merges it; resolve any conflict in your own files then.`,
  )
  lines.push(`- ${remoteText(remote)}`)

  if (commits.length === 0) {
    lines.push(`- It has no commit of its own yet.`)
  } else {
    lines.push(`- Its own commits, which \`${main.ref}\` lacks, newest first:`, '')
    lines.push(
      ...commits
        .slice(0, MAX_BRANCH_LINES)
        .map(({ sha, subject }) => `  - \`${sha.slice(0, 12)}\` ${subject}`),
    )
    if (commits.length > MAX_BRANCH_LINES) {
      lines.push(`  - and ${commits.length - MAX_BRANCH_LINES} more`)
    }
    lines.push('')
  }

  if (state.merging) {
    lines.push(
      '- A merge is in progress in the worktree: resolve its conflicts and commit it, or undo it with `git merge --abort`.',
    )
  }
  if (changes.length === 0) {
    lines.push('- The worktree has no uncommitted changes and no untracked files.')
  } else {
    lines.push(
      "- Uncommitted changes and untracked files in the worktree, as `git status --short` lists them. They are the earlier session's work: keep them unless the task says otherwise.",
      '',
      '```',
      ...changes.slice(0, MAX_BRANCH_LINES),
      ...(changes.length > MAX_BRANCH_LINES
        ? [`and ${changes.length - MAX_BRANCH_LINES} more`]
        : []),
      '```',
    )
  }
  return lines
}

/**
 * What `take` did with one ref of the update, for the state of the branch; null when the branch
 * already contained it or the ref does not exist.
 * @param {RefUpdate} update
 * @returns {string | null}
 */
function updateText({ ref, status, reason, conflicts }) {
  if (status === 'fast-forward') return `\`take\` fast-forwarded it to \`${ref}\`.`
  if (status === 'merged') return `\`take\` merged \`${ref}\` into it.`
  if (status !== 'not-merged') return null
  const files = conflicts.length > 0 ? `: ${conflicts.map((path) => `\`${path}\``).join(', ')}` : ''
  return `\`take\` did not merge \`${ref}\`: ${reason}${files}.`
}

/**
 * @param {BranchState['remote']} remote
 * @returns {string}
 */
function remoteText({ ref, sha, ahead, behind }) {
  if (sha === null) return `\`${ref}\` does not exist: the branch was never pushed.`
  if (ahead === 0 && behind === 0) return `\`${ref}\` is at the same commit.`
  const parts = []
  if (ahead > 0) parts.push(`has ${commitCount(ahead)} that it lacks`)
  if (behind > 0) parts.push(`lacks ${commitCount(behind)} of it`)
  return `\`${ref}\` is at \`${sha}\`: the branch ${parts.join(', and ')}.`
}

/**
 * @param {number} count
 * @returns {string}
 */
function commitCount(count) {
  return `${count} ${count === 1 ? 'commit' : 'commits'}`
}

/**
 * Part 7: the member's personal settings, so they apply in both agents (A14).
 * @param {PromptInput} input
 * @returns {string[]}
 */
function personalPart({ language, explanationStyle, projectLanguage }) {
  const lines = [
    language
      ? `- Answer in this language: ${language}.`
      : `- Answer in the project language: ${projectLanguage}.`,
  ]
  if (explanationStyle) lines.push(`- Explanation style: ${explanationStyle}.`)
  lines.push(
    `- Code, comments, commits, issues and pull requests stay in the project language: ${projectLanguage}.`,
  )
  return lines
}

/**
 * The issue body without its task block, with every heading one level lower so that it sits
 * under the part's heading. Code blocks stay as they are.
 * @param {string | null | undefined} body
 * @returns {string}
 */
export function issueText(body) {
  const lines = (body ?? '').replace(/\r\n?/g, '\n').split('\n')
  /** @type {string[]} */
  const kept = []
  for (let i = 0; i < lines.length; i += 1) {
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i])
    if (!open) {
      kept.push(lines[i].replace(/^(#{1,5})(?=\s)/, '$1#'))
      continue
    }
    let end = i + 1
    while (end < lines.length) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[end])
      if (close && close[1][0] === open[1][0] && close[1].length >= open[1].length) break
      end += 1
    }
    const content = lines.slice(i + 1, end)
    const isBlock = content.find((line) => line.trim() !== '')?.trim() === TASK_MARKER
    if (!isBlock) kept.push(...lines.slice(i, end + 1))
    i = end
  }
  return kept.join('\n').trim()
}

/**
 * @param {ChangesOnMain['files'][number]} file
 * @returns {string}
 */
function changeLine(file) {
  const path = file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path
  return `- ${file.status} \`${path}\``
}

/**
 * @param {string} line
 * @returns {string}
 */
function quoted(line) {
  return line === '' ? '>' : `> ${line}`
}

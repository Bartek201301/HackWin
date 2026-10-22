import { describe, expect, test } from 'vitest'
import { MAX_CHANGED_FILES, composePrompt } from '../../../src/commands/take/prompt.js'

const FROM = 'a'.repeat(40)
const TO = 'b'.repeat(40)

/** A worktree path with a space, which a line to paste must quote. */
const WORKTREE = '/work/My Project.worktrees/7-counter-reset'

/**
 * What the prompt of task 7 says, with these files changed on main since the recorded commit.
 * @param {number} count
 */
function input(count) {
  return {
    issue: { number: 7, title: 'Counter reset', body: '## Problem\nReset.\n', url: '' },
    block: {
      kind: /** @type {const} */ ('task'),
      role: 'counter',
      wave: 1,
      paths: ['src/features/counter/**'],
      depends_on: [],
      acceptance_tests: [],
      deadline: '2026-10-25T12:00:00+02:00',
    },
    scopeChanges: [],
    role: { paths: ['src/features/counter/**'], shared: false },
    open: [],
    isLead: false,
    worktree: WORKTREE,
    branch: 'task/7-counter-reset',
    main: '/work/My Project',
    defaultBranch: 'main',
    changes: {
      from: FROM,
      to: TO,
      files: Array.from({ length: count }, (_, index) => ({
        path: `docs/page-${index}.md`,
        status: 'A',
        oldPath: null,
        own: false,
      })),
    },
    recorded: {
      main_sha: FROM,
      recorded_at: '2026-10-20T10:00:00.000Z',
      where: /** @type {const} */ ('worktree'),
    },
    language: undefined,
    explanationStyle: undefined,
    projectLanguage: 'en',
  }
}

describe('1.5i/prompt-lines: the two lines of the prompt that name the worktree in words are lines a human can paste', () => {
  test('the full list of the files changed on main is one line to paste: cd to the worktree, then git diff', () => {
    const prompt = composePrompt(input(MAX_CHANGED_FILES + 3))
    expect(prompt).toContain(
      `And 3 more. For the full list, run \`cd '${WORKTREE}' && git diff --name-status ${FROM} ${TO}\`.\n`,
    )
    expect(prompt).not.toContain(`in \`${WORKTREE}\``)
  })

  test('step 2 of part 5 is one line to paste: cd to the worktree, then hackwin ship', () => {
    const prompt = composePrompt(input(1))
    expect(prompt).toContain(
      [
        '1. Commit your work on `task/7-counter-reset`.',
        `2. Run \`cd '${WORKTREE}' && hackwin ship\`. It merges \`origin/main\`, runs the checks and opens the pull request.`,
        '3. Stop, and report the pull request number and the full head SHA.',
      ].join('\n'),
    )
  })
})

import { describe, expect, test } from 'vitest'
import { MAX_CHANGED_FILES, composePrompt, issueText } from '../../../src/commands/take/prompt.js'

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

/** The task block of a filled task issue. */
const TASK_BLOCK = [
  '```yaml',
  '# hackwin:task',
  'kind: task',
  'role: counter',
  'wave: 1',
  'paths:',
  '  - "src/features/counter/reset/**"',
  'depends_on: []',
  'acceptance_tests:',
  '  - "test/counter/reset.test.js"',
  'deadline: "2026-10-25T12:00:00+02:00"',
  '```',
]

/**
 * A task issue made from the template of #153 (PR #153, rendered for a team with the roles lead,
 * counter and history), with every field filled but the help comment, the placeholders and the
 * example task left in.
 */
const FROM_TEMPLATE = [
  '<!-- hackwin:begin -->',
  '<!--',
  'Help for writing this task, not part of it: delete this comment and the example at the end before you create the issue.',
  '',
  "The Lead's planning session can write the whole issue for you: tell it what the task must achieve, and it fills in this template and creates the issue with `gh issue create`.",
  '',
  'HackWin reads only the data block below. Fill in:',
  '- role: the one role that does the task. The roles of this team and their paths, from owners.yml:',
  `  - lead, the Lead's shared role: "docs/**", and every path that no other role names`,
  '  - counter: "src/features/counter/**", "test/counter/**"',
  '  - history: "src/features/history/**"',
  '  - open to every role: "README.md"',
  "- paths: the globs the task may change, inside the role's paths or on the open list. Quote each one, as above.",
  '- depends_on: the issues that must be closed before the task can be taken, such as [12, 15], or [].',
  '- acceptance_tests: at least one test file or test id that proves the task. `hackwin ship` runs them with the test command of hackwin.yml, "npm test", followed by the tests.',
  '- deadline: the end of the event, which setup wrote. Write an earlier time in the same form when the task is due sooner.',
  '-->',
  '```yaml',
  '# hackwin:task',
  'kind: task                 # task | proposal | integration | contract-change | foundation',
  'role: counter              # ownership role: lead, counter or history',
  'wave: 2                    # wave number; optional for tasks written by hand and for proposals',
  "paths:                     # allowed paths, globs, inside the role's scope or on the open list",
  '  - "src/features/counter/reset/**"',
  'depends_on: []             # issue numbers',
  'acceptance_tests:',
  '  - "test/counter/reset.test.js"                        # test file or test id',
  'deadline: "2026-10-25T12:00:00+02:00"   # ISO 8601 with offset; the end of the event by default',
  '```',
  '',
  '## Problem',
  '<!-- What is missing or wrong, in terms of the product. -->',
  'The counter cannot go back to zero without a reload.',
  '',
  '## Expected result',
  '<!-- What exists when the task is done, including the interfaces it must respect. -->',
  'A reset button sets the counter to zero.',
  '',
  '## Acceptance criteria',
  '<!-- One line per criterion, each mapped to a test listed above. -->',
  '- `test/counter/reset.test.js`: the button sets the counter to zero.',
  '',
  '## Out of scope',
  '<!-- What this task must not change. -->',
  'The history of the counter.',
  '',
  '<!--',
  'Example of a filled task for this team, not part of this task: delete it before you create the issue. HackWin does not read it.',
  '',
  'Title: counter: a first working version',
  '',
  'kind: task',
  'role: counter',
  'wave: 1',
  'paths:',
  '  - "src/features/counter/**"',
  'depends_on: []',
  'acceptance_tests:',
  '  - "src/features/counter/first-version.test.js"',
  'deadline: "2026-10-25T12:00:00+02:00"',
  '',
  '## Problem',
  'The counter part does not work yet, so the demo cannot show it.',
  '',
  '## Expected result',
  'A first working version of the counter part, built against the types and the mocks of the contracts in docs/hackwin/spec.md.',
  '',
  '## Acceptance criteria',
  '- "src/features/counter/first-version.test.js": the counter part works with the mock data.',
  '',
  '## Out of scope',
  'Every path outside the paths above, and the contracts.',
  '-->',
  '<!-- hackwin:end -->',
].join('\n')

describe('1.5j/comments: the issue text in the prompt leaves out the HTML comments of the issue', () => {
  test('a comment on one line or on several is left out, the hackwin markers included', () => {
    const body = [
      '<!-- hackwin:begin -->',
      ...TASK_BLOCK,
      '',
      '## Problem',
      '<!-- What is missing or wrong, in terms of the product. -->',
      'The counter cannot go back to zero.',
      '<!--',
      'A note for the Lead,',
      'on two lines.',
      '-->',
      '',
      '## Out of scope',
      'The history.',
      '<!-- hackwin:end -->',
    ].join('\n')
    expect(issueText(body)).toBe(
      [
        '### Problem',
        'The counter cannot go back to zero.',
        '',
        '### Out of scope',
        'The history.',
      ].join('\n'),
    )
  })

  test('a comment inside a fenced code block is code and stays', () => {
    const fenced = [
      '```html',
      '<!-- hackwin:begin -->',
      '<p>Counter</p>',
      '<!--',
      'kept',
      '-->',
      '```',
    ]
    const tilde = ['~~~', '<!-- kept too -->', '~~~']
    const body = ['## Example', ...fenced, ...tilde].join('\n')
    expect(issueText(body)).toBe(['### Example', ...fenced, ...tilde].join('\n'))
  })

  test('a fenced block inside a comment goes with the comment', () => {
    const body = [
      'Before.',
      '<!--',
      'An old version of the button:',
      '```html',
      '<button>Reset</button>',
      '```',
      '-->',
      'After.',
    ].join('\n')
    expect(issueText(body)).toBe('Before.\nAfter.')
  })

  test('a line that holds visible text and a comment keeps its text', () => {
    const body = [
      '## Problem <!-- in terms of the product -->',
      'The counter <!-- the one on the home page --> cannot go back to zero.',
      'It keeps <!-- a note that goes on',
      'to the next line --> its value after a reload.',
    ].join('\n')
    expect(issueText(body)).toBe(
      [
        '### Problem',
        'The counter  cannot go back to zero.',
        'It keeps  its value after a reload.',
      ].join('\n'),
    )
  })

  test('an opening <!-- without a closing --> stays as it is, and the text after it too', () => {
    const body = [
      '## Problem',
      'The counter <!-- here --> cannot go back to zero.',
      '<!-- the help, left open',
      '## Expected result',
      'A reset button.',
    ].join('\n')
    expect(issueText(body)).toBe(
      [
        '### Problem',
        'The counter  cannot go back to zero.',
        '<!-- the help, left open',
        '### Expected result',
        'A reset button.',
      ].join('\n'),
    )
  })

  test('a comment in a code span is code and stays', () => {
    const line = 'Delete `<!-- hackwin:begin -->` and ``<!-- `x` -->`` only by hand.'
    expect(issueText(line)).toBe(line)
  })

  test('without comments the text is as before: no task block, headings one level lower, code blocks as they are', () => {
    const body = [
      'Intro.',
      ...TASK_BLOCK,
      '',
      '# Title',
      '## Problem',
      'Text with `code`.',
      '',
      '```js',
      '# not a heading',
      '```',
      '###### Deepest',
    ].join('\n')
    expect(issueText(body)).toBe(
      [
        'Intro.',
        '',
        '## Title',
        '### Problem',
        'Text with `code`.',
        '',
        '```js',
        '# not a heading',
        '```',
        '###### Deepest',
      ].join('\n'),
    )
  })

  test('for an issue made from the template of #153 with the help and the example left in, the prompt holds the sections of the task and neither the help nor the example', () => {
    const base = input(0)
    const prompt = composePrompt({ ...base, issue: { ...base.issue, body: FROM_TEMPLATE } })
    expect(prompt).toContain(
      [
        '## 1. The task',
        '',
        'Issue: #7',
        '',
        '### Problem',
        'The counter cannot go back to zero without a reload.',
        '',
        '### Expected result',
        'A reset button sets the counter to zero.',
        '',
        '### Acceptance criteria',
        '- `test/counter/reset.test.js`: the button sets the counter to zero.',
        '',
        '### Out of scope',
        'The history of the counter.',
        '',
        '### Acceptance tests',
      ].join('\n'),
    )
    expect(prompt).not.toContain('<!--')
    expect(prompt).not.toContain('-->')
    expect(prompt).not.toContain('Help for writing this task')
    expect(prompt).not.toContain('Example of a filled task')
    expect(prompt).not.toContain('a first working version')
    expect(prompt).not.toContain('# hackwin:task')
    expect(prompt.split('### Problem')).toHaveLength(2)
  })

  test('the scope change comments in the prompt stay as they are, their HTML comments included', () => {
    const base = input(0)
    const prompt = composePrompt({
      ...base,
      issue: { ...base.issue, body: '## Problem\n<!-- placeholder -->\nReset.' },
      scopeChanges: [
        {
          id: 1,
          body: 'Scope change: the button also clears the history.\n<!-- asked at the stand-up -->',
          author: 'lead',
          url: '',
          createdAt: '2026-10-21T09:00:00Z',
          updatedAt: '2026-10-21T09:00:00Z',
        },
      ],
    })
    expect(prompt).toContain('### Problem\nReset.\n')
    expect(prompt).toContain(
      [
        'lead, 2026-10-21T09:00:00Z:',
        '',
        '> Scope change: the button also clears the history.',
        '> <!-- asked at the stand-up -->',
      ].join('\n'),
    )
  })
})

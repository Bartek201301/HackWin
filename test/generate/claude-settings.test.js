import { afterEach, describe, expect, test } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PreconditionError } from '../../src/core/runtime/errors.js'
import {
  CLAUDE_HOOKS,
  GIT_RULES,
  HACKWIN_RULES,
  MERGE_RULES,
  SETTINGS_PATH,
  allowRules,
  denyRules,
  mergeClaudeSettings,
  writeClaudeSettings,
} from '../../src/generate/index.js'
import { hackwinObject, nodeProjectFiles } from '../harness/index.js'

const INPUT = { defaultBranch: 'main', commands: hackwinObject(3).commands }

/** @type {string[]} */
const dirs = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** @param {string | null} text */
const merged = (text) => JSON.parse(mergeClaudeSettings(text, INPUT))

/** HackWin's hook group of an event, as the settings hold it. */
const HACKWIN_GROUPS = {
  SessionStart: {
    hooks: [{ type: 'command', command: 'hackwin internal hook session-start' }],
  },
  PreToolUse: {
    matcher: 'Bash|Edit|MultiEdit|Write|NotebookEdit',
    hooks: [{ type: 'command', command: 'hackwin internal hook pre-tool-use' }],
  },
  PostToolUse: {
    matcher: 'Edit|MultiEdit|Write',
    hooks: [{ type: 'command', command: 'hackwin internal hook post-tool-use' }],
  },
}

/** The hooks of settings that hold only HackWin's. */
const HACKWIN_HOOKS = Object.fromEntries(
  Object.entries(HACKWIN_GROUPS).map(([event, group]) => [event, [group]]),
)

/**
 * Whether Claude Code's deny rules refuse a Bash command, by the matching that the permissions
 * documentation shows (https://code.claude.com/docs/en/permissions, "Wildcard patterns" and
 * "Compound commands", read 2026-10-20): the command is split into subcommands at `&&`, `||`,
 * `;`, `|`, `&` and newlines, and a rule `Bash(<pattern>)` refuses a subcommand that the pattern
 * matches as a whole. A trailing ` *` that is the rule's only wildcard also matches the bare
 * command (`Bash(ls *)` matches `ls`). Elsewhere a `*` stands for some text, one character or
 * more; the page does not say whether it also matches empty text (docs/verification.md,
 * question 8). So a command that must be denied is checked without that empty match, and one
 * that must not be denied with it as well (`notDeniedBy`).
 * @param {readonly string[]} rules
 * @param {string} command
 * @param {{ emptyMatch?: boolean }} [reading] `emptyMatch`: a `*` also matches empty text.
 */
function deniedBy(rules, command, { emptyMatch = false } = {}) {
  const subcommands = command.split(/&&|\|\||;|\||&|\n/).map((part) => part.trim())
  return rules.filter((rule) => {
    const pattern = /^Bash\((.*)\)$/.exec(rule)?.[1]
    if (pattern === undefined) return false
    const source = pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    const regex = new RegExp(`^${source.join(emptyMatch ? '.*' : '.+')}$`)
    const bare = pattern.endsWith(' *') && source.length === 2 ? pattern.slice(0, -2) : null
    return subcommands.some((part) => regex.test(part) || part === bare)
  })
}

/**
 * True when no rule denies a command, whether or not a `*` matches empty text.
 * @param {readonly string[]} rules
 * @param {string} command
 */
function notDeniedBy(rules, command) {
  return [false, true].every((emptyMatch) => deniedBy(rules, command, { emptyMatch }).length === 0)
}

describe('1.4c/settings: HackWin keeps the existing content of .claude/settings.json', () => {
  test("only HackWin's keys and list entries are added or replaced", () => {
    const existing = {
      $schema: 'https://json.schemastore.org/claude-code-settings.json',
      model: 'opus',
      env: { FEATURE_FLAG: '1' },
      permissions: {
        allow: ['Bash(npm test *)'],
        deny: ['Read(./secrets/**)', 'Read(./.env)'],
        defaultMode: 'acceptEdits',
      },
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: './scripts/guard.sh' }] },
          // HackWin's entry of an older version: another matcher and a timeout.
          {
            matcher: 'Edit',
            hooks: [{ type: 'command', command: 'hackwin internal hook pre-tool-use', timeout: 5 }],
          },
        ],
        PostToolUse: [
          {
            matcher: 'Write',
            hooks: [
              { type: 'command', command: 'hackwin internal hook post-tool-use' },
              { type: 'command', command: './scripts/lint.sh' },
            ],
          },
        ],
        Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
      },
      statusLine: { type: 'command', command: './scripts/status.sh' },
    }

    const result = merged(JSON.stringify(existing, null, 4))

    expect(Object.keys(result)).toEqual([
      '$schema',
      'model',
      'env',
      'permissions',
      'hooks',
      'statusLine',
    ])
    expect(result.model).toBe('opus')
    expect(result.env).toEqual({ FEATURE_FLAG: '1' })
    expect(result.statusLine).toEqual(existing.statusLine)
    expect(result.permissions).toEqual({
      allow: ['Bash(npm test *)', ...allowRules(INPUT)],
      deny: [
        'Read(./secrets/**)',
        'Read(./.env)',
        ...denyRules(INPUT).filter((rule) => rule !== 'Read(./.env)'),
      ],
      defaultMode: 'acceptEdits',
    })
    expect(result.hooks).toEqual({
      PreToolUse: [existing.hooks.PreToolUse[0], HACKWIN_GROUPS.PreToolUse],
      PostToolUse: [
        HACKWIN_GROUPS.PostToolUse,
        { matcher: 'Write', hooks: [{ type: 'command', command: './scripts/lint.sh' }] },
      ],
      Stop: existing.hooks.Stop,
      SessionStart: [HACKWIN_GROUPS.SessionStart],
    })
  })

  test('merging again changes nothing', () => {
    const once = mergeClaudeSettings(
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [] }] } }),
      INPUT,
    )
    expect(mergeClaudeSettings(once, INPUT)).toBe(once)
  })

  test("the template's settings keep their env rules once and get the hooks and the other rules", () => {
    const template = nodeProjectFiles()[SETTINGS_PATH]
    const result = merged(template)
    expect(result.permissions.deny).toEqual(denyRules(INPUT))
    expect(result.permissions.deny.slice(0, 3)).toEqual(JSON.parse(template).permissions.deny)
    expect(result.hooks).toEqual(HACKWIN_HOOKS)
  })

  test("without a file the settings hold only HackWin's keys, and the file is written once", async () => {
    expect(merged(null)).toEqual({
      permissions: { allow: allowRules(INPUT), deny: denyRules(INPUT) },
      hooks: HACKWIN_HOOKS,
    })
    const root = mkdtempSync(join(tmpdir(), 'hackwin-settings-'))
    dirs.push(root)

    const first = await writeClaudeSettings(root, INPUT)
    const second = await writeClaudeSettings(root, INPUT)

    expect(first).toMatchObject({ path: SETTINGS_PATH, changed: true })
    expect(second).toMatchObject({ path: SETTINGS_PATH, changed: false })
    expect(readFileSync(join(root, SETTINGS_PATH), 'utf8')).toBe(first.content)
  })

  test('a file that is not a settings object is refused with what to correct', () => {
    for (const [text, reason] of [
      ['{ "permissions": ', 'is not valid JSON'],
      ['[]', 'must hold a JSON object'],
      ['{ "permissions": [] }', 'permissions must be an object'],
      ['{ "permissions": { "deny": "Bash(rm *)" } }', 'permissions.deny must be a list'],
      ['{ "permissions": { "allow": "Bash(ls *)" } }', 'permissions.allow must be a list'],
      ['{ "hooks": { "PreToolUse": {} } }', 'hooks.PreToolUse must be a list'],
    ]) {
      let error
      try {
        mergeClaudeSettings(text, INPUT)
      } catch (caught) {
        error = caught
      }
      expect(error, text).toBeInstanceOf(PreconditionError)
      expect(error.message, text).toContain(`${SETTINGS_PATH} ${reason}`)
      expect(error.resolve).toBe(
        `correct ${SETTINGS_PATH}, keeping your own settings, and run the command again`,
      )
    }
  })
})

describe('AC63/deny: the generated settings deny a merge and a push to main', () => {
  test('the deny rules hold the merge patterns of docs/verification.md, and each hook is one call to hackwin internal hook', () => {
    const settings = merged(null)
    expect(MERGE_RULES).toEqual([
      'Bash(gh pr merge *)',
      'Bash(gh api *pulls/*/merge)',
      'Bash(gh api *pulls/*/merge*)',
      'Bash(gh api *mergePullRequest*)',
    ])
    expect(settings.permissions.deny).toEqual(expect.arrayContaining([...MERGE_RULES]))
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining(['Read(./.env)', 'Read(./.env.local)', 'Read(./.env.*.local)']),
    )
    for (const { event, hook } of CLAUDE_HOOKS) {
      expect(settings.hooks[event]).toHaveLength(1)
      expect(settings.hooks[event][0].hooks).toEqual([
        { type: 'command', command: `hackwin internal hook ${hook}` },
      ])
    }
  })

  test('the rules match the usual merge and push spellings, and not the pushes of a task branch', () => {
    const rules = merged(null).permissions.deny
    for (const command of [
      'gh pr merge 14 --merge --match-head-commit 0123456789abcdef0123456789abcdef01234567',
      'gh api -X PUT repos/{owner}/{repo}/pulls/14/merge',
      `gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: "PR_1"}) { clientMutationId } }'`,
      'git fetch && gh pr merge 14 --squash',
      'git push origin main',
      'git push --force origin main',
      'git push origin HEAD:main',
      'git push origin main --force-with-lease',
      'git push origin +main',
      'git push origin HEAD:refs/heads/main',
      'git push --all origin',
      'git push --all',
      'git push origin --all',
      'git push origin --branches --force',
      'git push --mirror',
      'git push backup --mirror',
    ]) {
      expect(deniedBy(rules, command), command).not.toEqual([])
    }
    for (const command of [
      'gh pr view 14',
      'gh api repos/{owner}/{repo}/pulls/14',
      'git push -u origin task/12-fix-main',
      'git push origin task/12-main-menu',
      'git push origin main:task/12-counter-step',
    ]) {
      expect(notDeniedBy(rules, command), command).toBe(true)
    }
  })

  test('the push rules follow the default branch of hackwin.yml', () => {
    const rules = denyRules({ defaultBranch: 'trunk' })
    expect(deniedBy(rules, 'git push origin trunk')).not.toEqual([])
    expect(notDeniedBy(rules, 'git push origin main')).toBe(true)
  })
})

describe('1.4g/regenerate: the deny rules that setup --regenerate writes', () => {
  test('a merge through gh api that ends right at merge is denied without a * that matches empty text', () => {
    const rules = merged(null).permissions.deny
    for (const command of [
      'gh api -X PUT repos/{owner}/{repo}/pulls/14/merge',
      'gh api --method PUT repos/acme/app/pulls/14/merge',
      'gh api repos/acme/app/pulls/14/merge -X PUT -f merge_method=merge',
      'gh api -X PUT "repos/acme/app/pulls/14/merge"',
    ]) {
      expect(deniedBy(rules, command), command).not.toEqual([])
    }
    // The rules of the release before deny the first form only if a * matches empty text.
    const before = rules.filter((rule) => rule !== 'Bash(gh api *pulls/*/merge)')
    const endsAtMerge = 'gh api -X PUT repos/{owner}/{repo}/pulls/14/merge'
    expect(deniedBy(before, endsAtMerge)).toEqual([])
    expect(deniedBy(before, endsAtMerge, { emptyMatch: true })).toEqual([
      'Bash(gh api *pulls/*/merge*)',
    ])
    expect(deniedBy(rules, 'gh api -X PUT repos/{owner}/{repo}/pulls/14/merge')).toEqual([
      'Bash(gh api *pulls/*/merge)',
    ])
  })
})

/**
 * The forms that the deny rules cover, as docs/verification.md row 2 lists them for the default
 * branch `main`: those of its second column and, in the last three, those that a rule covers only
 * if a `*` matches empty text (its third column).
 */
const DENIED_FORMS = [
  'gh pr merge 14 --merge --match-head-commit 0123456789abcdef0123456789abcdef01234567',
  'gh pr merge',
  'gh api -X PUT repos/acme/app/pulls/14/merge',
  'gh api --method PUT repos/acme/app/pulls/14/merge',
  'gh api repos/acme/app/pulls/14/merge -X PUT -f merge_method=merge',
  'gh api -X PUT "repos/acme/app/pulls/14/merge"',
  `gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: "PR_1"}) { clientMutationId } }'`,
  'git push origin main',
  'git push --force origin main',
  'git push origin main --force-with-lease',
  'git push origin HEAD:main',
  'git push origin HEAD:main --force',
  'git push origin +main',
  'git push origin HEAD:refs/heads/main',
  'git push --all origin',
  'git push --all',
  'git push origin --all',
  'git push backup --mirror',
  'git push origin --branches --force',
  'git push -f --all origin',
]

describe('1.4n/allow: the generated settings allow the routine steps of a task session', () => {
  test("the allow list holds the project's commands, read-only git, git add and commit, and hackwin status, take and ship", () => {
    expect(merged(null).permissions.allow).toEqual([
      'Bash(npm ci)',
      'Bash(npm run check)',
      'Bash(npm test -- *)',
      'Bash(npm run format -- *)',
      'Bash(git status *)',
      'Bash(git diff *)',
      'Bash(git log *)',
      'Bash(git add *)',
      'Bash(git commit *)',
      'Bash(hackwin status *)',
      'Bash(hackwin take *)',
      'Bash(hackwin ship *)',
    ])
    expect(allowRules(INPUT)).toEqual(expect.arrayContaining([...GIT_RULES, ...HACKWIN_RULES]))
  })

  test('a command made of several commands gets one rule per part, as Claude Code matches each part', () => {
    const commands = {
      install: 'rm -rf node_modules && npm ci',
      check: 'npm run lint && npm run typecheck || exit 1; npm test 2>&1 | tee check.log',
      test: 'cd web && npx vitest run',
      format: "prettier --write --ignore-path '.a;b|c' --log-level=warn",
    }
    expect(allowRules({ commands }).slice(0, -GIT_RULES.length - HACKWIN_RULES.length)).toEqual([
      'Bash(rm -rf node_modules)',
      'Bash(npm ci)',
      'Bash(npm run lint)',
      'Bash(npm run typecheck)',
      'Bash(exit 1)',
      'Bash(npm test 2>&1)',
      'Bash(tee check.log)',
      'Bash(cd web)',
      'Bash(npx vitest run *)',
      "Bash(prettier --write --ignore-path '.a;b|c' --log-level=warn *)",
    ])
    // A part that two commands share is allowed once.
    const same = { install: 'npm ci', check: 'npm ci && npm test', test: 'npm test', format: 'x' }
    expect(allowRules({ commands: same }).filter((rule) => rule === 'Bash(npm ci)')).toHaveLength(1)
  })

  test('every deny rule and hook stays, and no allow entry matches a command that a deny rule matches', () => {
    const settings = merged(null)
    expect(settings.permissions.deny).toEqual(denyRules(INPUT))
    expect(settings.hooks).toEqual(HACKWIN_HOOKS)
    for (const command of DENIED_FORMS) {
      // Each form is denied, at least where a * matches empty text (verification.md, question 8) ...
      expect(
        deniedBy(settings.permissions.deny, command, { emptyMatch: true }),
        command,
      ).not.toEqual([])
      // ... and no allow entry matches it, whether or not a * matches empty text.
      expect(notDeniedBy(settings.permissions.allow, command), command).toBe(true)
    }
  })

  test("merging keeps the user's own allow entries first and adds only the missing ones", () => {
    const own = ['Bash(make demo)', 'Bash(git status *)', 'WebFetch(domain:example.com)']
    const result = merged(JSON.stringify({ permissions: { allow: own } }))
    expect(result.permissions.allow).toEqual([
      ...own,
      ...allowRules(INPUT).filter((rule) => rule !== 'Bash(git status *)'),
    ])
    expect(mergeClaudeSettings(JSON.stringify(result), INPUT)).toBe(
      `${JSON.stringify(result, null, 2)}\n`,
    )
  })
})

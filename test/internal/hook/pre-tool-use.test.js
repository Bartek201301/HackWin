import { describe, expect, test } from 'vitest'
import { appendFileSync, readFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import semver from 'semver'
import { VERSION } from '../../../src/cli/context.js'
import { exec } from '../../../src/core/runtime/exec.js'
import { mergeClaudeSettings } from '../../../src/generate/index.js'
import { accounts } from '../../harness/index.js'
import {
  bashCall,
  denial,
  editCall,
  preToolUse,
  runClaudeHook,
  writeCall,
} from './claude-fixture.js'
import { createHookFixture, pinnedConfig } from './hook-fixture.js'

const FILES = {
  'README.md': '# Fixture\n',
  'src/features/counter/step.js': 'export const step = "one"\n',
  'src/features/greeting/hello.js': 'export const hello = "one"\n',
  'src/shared/feature.js': 'export const feature = "one"\n',
}

/** A commit message as a here document with an apostrophe, the form Claude Code usually writes. */
const COMMIT = `git commit -m "$(cat <<'EOF'\nReset the counter\n\nDon't merge this by hand.\nEOF\n)"`

/** builder1, who holds `counter` and `todos`, in the worktree of task 12. */
async function builderScene(options = {}) {
  const hooks = await createHookFixture({ files: FILES, ...options })
  const clone = await hooks.joinedClone('builder1')
  const task = await hooks.taskWorktree(clone, 12, 'Counter step')
  /** @param {unknown} event */
  const run = (event) => runClaudeHook('pre-tool-use', { cwd: task.path, env: hooks.env, event })
  return { hooks, clone, task, run }
}

describe('AC55: the PreToolUse hook in a Claude Code session', () => {
  test('an edit outside the role scope is blocked before the file changes; an edit inside it is not', async () => {
    const { task, run } = await builderScene()
    const foreign = join(task.path, 'src/features/greeting/hello.js')

    const blocked = await run(editCall(task.path, foreign))

    expect(blocked.code).toBe(0)
    expect(denial(blocked)).toBe(
      [
        `hackwin: blocked: this edit changes a file outside the roles of ${accounts.builder1.login} (counter, todos)`,
        "  rule: E1: edits stay inside the author's ownership scope",
        `  - src/features/greeting/hello.js: role greeting, held by ${accounts.builder2.login}`,
        '  to resolve: leave the file unchanged; when the change is needed, stop and ask the Lead, who writes a task for it',
      ].join('\n'),
    )
    expect(readFileSync(foreign, 'utf8')).toBe(FILES['src/features/greeting/hello.js'])

    const own = await run(editCall(task.path, join(task.path, 'src/features/counter/step.js')))
    expect(own).toMatchObject({ code: 0, stdout: '', output: null })
  })

  test("gh pr merge is refused, in the Lead's own session too and with bypass permissions on", async () => {
    const hooks = await createHookFixture({ files: FILES })
    const lead = await hooks.joinedClone('lead')
    const command =
      'gh pr merge 14 --merge --match-head-commit 0123456789abcdef0123456789abcdef01234567'

    for (const mode of ['default', 'bypassPermissions']) {
      const result = await runClaudeHook('pre-tool-use', {
        cwd: lead.path,
        env: hooks.env,
        event: bashCall(lead.path, command, { mode }),
      })
      expect(result.code).toBe(0)
      expect(denial(result)).toBe(
        [
          'hackwin: blocked: merging a pull request from an agent session is blocked: only the Gate merges, one pull request at a time, after testing it with the newest main',
          '  rule: E3: no agent session merges; only the Gate does',
          `  - ${command}`,
          `  to resolve: leave the merge to the Gate, which the Lead runs with \`hackwin gate\` in ${lead.path}; stop and report the pull request number and the full head SHA`,
        ].join('\n'),
      )
    }
  })
})

describe('AC63/deny: the PreToolUse hook refuses a merge through gh pr merge and gh api, and a push of every branch', () => {
  test.each([
    ['gh pr merge', 'gh pr merge 14 --merge'],
    ['gh pr merge with flags first', 'gh pr merge --squash --auto 14'],
    [
      'the REST merge endpoint',
      'gh api -X PUT repos/{owner}/{repo}/pulls/14/merge -f merge_method=merge',
    ],
    // The form of the deny rule `Bash(gh api *pulls/*/merge)`.
    [
      'the REST merge endpoint with nothing after merge',
      'gh api -X PUT repos/{owner}/{repo}/pulls/14/merge',
    ],
    [
      'the GraphQL mutation',
      `gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: "PR_kw1"}) { clientMutationId } }'`,
    ],
    [
      'a merge after another command',
      'git fetch origin && GH_REPO=acme/app gh pr merge 14 --merge',
    ],
    ['a merge inside sh -c', `sh -c 'gh pr merge 14 --merge'`],
    ['a merge in a command substitution', 'echo "$(gh pr merge 14 --merge)"'],
    ['gh by its absolute path', '/opt/homebrew/bin/gh pr merge 14 --merge'],
    ['a merge in the then branch of an if', 'if gh pr checks 14; then gh pr merge 14 --merge; fi'],
    ['a merge in the else branch', 'if false; then :; else gh pr merge 14 --merge; fi'],
    ['a merge in a while body', 'while true; do gh pr merge 14 --merge && break; done'],
    ['a merge in a for body', 'for n in 14 15; do gh pr merge $n --merge; done'],
    ['a merge in a case branch', 'case go in go) gh pr merge 14 --merge;; esac'],
    ['a merge in a group', 'gh pr checks 14 && { gh pr merge 14 --merge; }'],
    ['a merge in a subshell', '(cd /tmp && gh pr merge 14 --merge)'],
    ['a negated merge', '! gh pr merge 14 --merge'],
    ['a merge in a function body', 'function land { gh pr merge 14 --merge; }; land'],
    ['a merge after a here document with an apostrophe', `${COMMIT} && gh pr merge 14 --merge`],
    ['a merge in a process substitution', 'cat <(gh pr merge 14 --merge)'],
    ['a merge behind stdbuf', 'stdbuf -oL gh pr merge 14 --merge'],
    ['a merge behind stdbuf with a separate mode', 'stdbuf -o L gh pr merge 14 --merge'],
    ['a merge behind noglob', 'noglob gh pr merge 14 --merge'],
    [
      'an auto-merge through GraphQL',
      `gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {pullRequestId: "PR_kw1"}) { clientMutationId } }'`,
    ],
  ])('%s is refused', async (_name, command) => {
    const { task, run } = await builderScene()
    const result = await run(bashCall(task.path, command))
    expect(denial(result)).toContain('rule: E3: no agent session merges; only the Gate does')
  })

  test.each([['git push origin --all'], ['git push origin --branches'], ['git push --mirror']])(
    '%s, a push of every branch, is refused',
    async (command) => {
      const { task, run } = await builderScene()
      const reason = denial(await run(bashCall(task.path, command)))
      expect(reason).toContain('rule: E2: no direct push to main')
      expect(reason).toContain(`- ${command} in ${task.path}`)
    },
  )

  test('reading a pull request and naming a merge inside text are not refused', async () => {
    const { task, run } = await builderScene()
    for (const command of [
      'gh pr view 14',
      'gh api repos/{owner}/{repo}/pulls/14',
      'gh pr create --title "Counter step" --body "Closes #12. Never gh pr merge it."',
      `git commit -m "$(cat <<'EOF'\nDocument the merge rule\n\ngh pr merge is for the Gate only\nEOF\n)"`,
    ]) {
      expect(await run(bashCall(task.path, command))).toMatchObject({ code: 0, output: null })
    }
  })

  test('a merge is refused without reading the configuration: also in a clone where join never ran', async () => {
    const hooks = await createHookFixture({ files: FILES })
    const { path } = await hooks.fixture.clone('not-joined')

    const result = await runClaudeHook('pre-tool-use', {
      cwd: path,
      env: hooks.env,
      event: bashCall(path, 'gh pr merge 14 --merge'),
    })

    expect(denial(result)).toContain('rule: E3')
  })
})

describe('1.4c/pre-tool-use: edits and the role scope', () => {
  test('the scope is the roles the member holds in hackwin.yml on main, not the role of a task', async () => {
    const { task, run } = await builderScene()
    // Task 12 is a counter task, but todos is a role of builder1 too.
    const todos = await run(writeCall(task.path, join(task.path, 'src/features/todos/list.js')))
    expect(todos.output).toBeNull()

    const shared = await run(writeCall(task.path, join(task.path, 'src/shared/new/thing.js')))
    expect(denial(shared)).toContain(
      `- src/shared/new/thing.js: role shared, held by ${accounts.lead.login}`,
    )
  })

  test('open, ignored and outside files, and spike branches, are not checked', async () => {
    const { hooks, clone, task, run } = await builderScene()
    appendFileSync(join(clone.commonDir, 'info', 'exclude'), 'scratch/\n')
    const spike = join(hooks.fixture.dir, 'spike')
    await clone.git.worktreeAdd(spike, {
      branch: 'spike/try-greeting',
      createBranch: true,
      startPoint: 'origin/main',
    })

    for (const file of [
      join(task.path, 'README.md'),
      join(task.path, 'scratch/notes.md'),
      join(hooks.fixture.dir, 'elsewhere', 'notes.md'),
      join(spike, 'src/features/greeting/hello.js'),
    ]) {
      expect(await run(editCall(task.path, file)), file).toMatchObject({ output: null })
    }
  })

  test('a file reached through a symbolic link, in any worktree of the clone, is checked in its checkout', async () => {
    const { hooks, clone, task, run } = await builderScene()
    const link = join(hooks.fixture.dir, 'link')
    symlinkSync(task.path, link)

    const linked = await run(editCall(link, join(link, 'src/features/greeting/hello.js')))
    expect(denial(linked)).toContain('- src/features/greeting/hello.js: role greeting')

    // An edit in the main checkout of the clone, from the task's session.
    const main = await run(editCall(task.path, join(clone.path, 'src/features/greeting/hello.js')))
    expect(denial(main)).toContain('- src/features/greeting/hello.js: role greeting')
  })

  test("the Lead is told to write a task for another role's file", async () => {
    const hooks = await createHookFixture({ files: FILES })
    const lead = await hooks.joinedClone('lead')

    const result = await runClaudeHook('pre-tool-use', {
      cwd: lead.path,
      env: hooks.env,
      event: preToolUse(lead.path, 'NotebookEdit', {
        notebook_path: join(lead.path, 'src/features/counter/explore.ipynb'),
        new_source: 'print(1)',
      }),
    })

    expect(denial(result)).toContain(
      'to resolve: leave the file unchanged; when the change is needed, write a task for the role that owns it',
    )
  })

  test('without the join record an edit of a repository file exits 2 and names hackwin join', async () => {
    const hooks = await createHookFixture({ files: FILES })
    const { path } = await hooks.fixture.clone('not-joined')

    const result = await runClaudeHook('pre-tool-use', {
      cwd: path,
      env: hooks.env,
      event: editCall(path, join(path, 'src/features/counter/step.js')),
    })

    expect(result.code).toBe(2)
    expect(result.stderr).toContain(`to resolve: run \`hackwin join\` in ${path}`)
  })

  test('tools that change no file pass without a check', async () => {
    const { task, run } = await builderScene()
    for (const event of [
      preToolUse(task.path, 'Read', { file_path: join(task.path, 'src/shared/feature.js') }),
      bashCall(task.path, 'npm test -- src/features/counter'),
    ]) {
      expect(await run(event)).toMatchObject({ code: 0, stdout: '', stderr: '' })
    }
  })

  test('an event that is not a PreToolUse event exits 2', async () => {
    const { task, run } = await builderScene()
    const result = await run({ hook_event_name: 'PostToolUse', cwd: task.path })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain(
      'expects the PreToolUse event of Claude Code as a JSON object on stdin, not the PostToolUse event',
    )
  })
})

describe('1.4c/pre-tool-use: pushes to the default branch', () => {
  test.each([
    ['git push origin main'],
    ['git push origin HEAD:main'],
    ['git push --force origin +main'],
    ['git push origin HEAD:refs/heads/main'],
    ['git push origin --delete main'],
    ['git push --all origin'],
    ['git add . && git commit -m wip && git push -u origin main 2>&1'],
    ['if git diff --quiet; then git push origin main; fi'],
    ['for remote in origin; do git push $remote main; done'],
    ['{ git push origin main; }'],
    [`${COMMIT} && git push origin main`],
    ['cat <(git push origin main)'],
    ['stdbuf -oL git push origin main'],
    ['git -c push.default=current push origin main'],
  ])('%s is refused from a task worktree', async (command) => {
    const { task, run } = await builderScene()
    const reason = denial(await run(bashCall(task.path, command)))
    expect(reason).toContain(
      "hackwin: blocked: a change of main without a pull request is blocked: main changes only through the Gate's merges of pull requests",
    )
    expect(reason).toContain('rule: E2: no direct push to main')
    expect(reason).toContain(`to resolve: run \`hackwin ship\` in ${task.path}`)
  })

  test('a push of the task branch passes, with or without a refspec', async () => {
    const { task, run } = await builderScene()
    for (const command of [
      `git push -u origin ${task.branch}`,
      'git push',
      'git push origin HEAD',
      'git push origin main:task/12-counter-step',
      `${COMMIT} && git push -u origin task/12-counter-step`,
      'git push origin task/12-counter-step > >(tee push.log)',
    ]) {
      expect(await run(bashCall(task.path, command)), command).toMatchObject({ output: null })
    }
  })

  test('a push without a refspec where main is checked out is refused, also through git -C and cd', async () => {
    const { clone, task, run } = await builderScene()
    for (const [cwd, command] of [
      [clone.path, 'git push'],
      [clone.path, 'git push origin HEAD'],
      [task.path, `git -C ${clone.path} push`],
      [task.path, `cd ${clone.path} && git push`],
    ]) {
      const reason = denial(await run(bashCall(cwd, command)))
      expect(reason, command).toContain('rule: E2: no direct push to main')
      expect(reason, command).toContain(`to resolve: run \`hackwin take\` in ${clone.path}`)
    }
  })
})

describe('1.4c/pre-tool-use: a push without a refspec goes where git would send it', () => {
  test('a task branch whose upstream is main is refused with push.default=upstream', async () => {
    const { task, run } = await builderScene()
    await task.git.run(['config', `branch.${task.branch}.remote`, 'origin'])
    await task.git.run(['config', `branch.${task.branch}.merge`, 'refs/heads/main'])
    await task.git.run(['config', 'push.default', 'upstream'])

    for (const command of ['git push', 'git push origin']) {
      const reason = denial(await run(bashCall(task.path, command)))
      expect(reason, command).toContain('rule: E2: no direct push to main')
      expect(reason, command).toContain(`- ${command} in ${task.path}`)
    }
  })

  test('push.default=matching, set in the clone or with git -c, is refused', async () => {
    const { task, run } = await builderScene()
    expect(denial(await run(bashCall(task.path, 'git -c push.default=matching push')))).toContain(
      'rule: E2',
    )
    await task.git.run(['config', 'push.default', 'matching'])
    expect(denial(await run(bashCall(task.path, 'git push')))).toContain('rule: E2')
    expect(await run(bashCall(task.path, 'git -c push.default=nothing push'))).toMatchObject({
      output: null,
    })
  })

  test('a push refspec of the remote that leads to main is refused', async () => {
    const { task, run } = await builderScene()
    await task.git.run(['config', 'remote.origin.push', 'HEAD:refs/heads/main'])
    expect(denial(await run(bashCall(task.path, 'git push')))).toContain('rule: E2')

    await task.git.run(['config', 'remote.origin.push', 'refs/heads/*:refs/heads/*'])
    expect(denial(await run(bashCall(task.path, 'git push origin')))).toContain('rule: E2')

    await task.git.run(['config', 'remote.origin.push', 'refs/heads/task/*:refs/heads/task/*'])
    expect(await run(bashCall(task.path, 'git push'))).toMatchObject({ output: null })
  })
})

describe('1.4c/pre-tool-use: gh api calls that update the default branch without a pull request', () => {
  test.each([
    [
      'a REST merge into main',
      'gh api -X POST repos/{owner}/{repo}/merges -f base=main -f head=task/12-counter-step',
    ],
    [
      'a REST merge with the implicit POST',
      'gh api repos/{owner}/{repo}/merges -f base=main -f head=x',
    ],
    [
      'a REST merge whose base the command does not show',
      'gh api repos/{owner}/{repo}/merges --input merge.json',
    ],
    [
      'a change of the ref of main',
      'gh api -X PATCH repos/{owner}/{repo}/git/refs/heads/main -f sha=0123abcd -F force=true',
    ],
    [
      'a deletion of the ref of main',
      'gh api --method DELETE /repos/{owner}/{repo}/git/refs/heads/main',
    ],
    [
      'a creation of the ref of main',
      'gh api repos/{owner}/{repo}/git/refs -f ref=refs/heads/main -f sha=0123abcd',
    ],
    [
      'the GraphQL mutation mergeBranch',
      `gh api graphql -f query='mutation { mergeBranch(input: {repositoryId: "R_1", base: "main", head: "x"}) { clientMutationId } }'`,
    ],
    [
      'the GraphQL mutation updateRef',
      `gh api graphql -f query='mutation { updateRef(input: {refId: "REF_1", oid: "0123abcd"}) { clientMutationId } }'`,
    ],
    [
      'the GraphQL mutation updateRefs',
      `gh api graphql -f query='mutation { updateRefs(input: {repositoryId: "R_1", refUpdates: []}) { clientMutationId } }'`,
    ],
  ])('%s is refused', async (_name, command) => {
    const { task, run } = await builderScene()
    const reason = denial(await run(bashCall(task.path, command)))
    expect(reason).toContain('rule: E2: no direct push to main')
    expect(reason).toContain(`to resolve: run \`hackwin ship\` in ${task.path}`)
  })

  test('reading the ref of main and updating another branch are not refused', async () => {
    const { task, run } = await builderScene()
    for (const command of [
      'gh api repos/{owner}/{repo}/git/refs/heads/main',
      'gh api repos/{owner}/{repo}/git/ref/heads/main --jq .object.sha',
      'gh api -X POST repos/{owner}/{repo}/merges -f base=task/12-counter-step -f head=main',
      'gh api -X PATCH repos/{owner}/{repo}/git/refs/heads/task/12-counter-step -f sha=0123abcd',
    ]) {
      expect(await run(bashCall(task.path, command)), command).toMatchObject({ output: null })
    }
  })
})

describe('1.4c/version: CM12 in the PreToolUse hook, offline', () => {
  test('a CLI older than the version pinned on the local origin/main exits 2 with the install command before an edit or a push', async () => {
    const running = semver.parse(VERSION)
    const newer = `${running?.major}.${running?.minor}.${(running?.patch ?? 0) + 1}`
    const { task, run } = await builderScene({ config: pinnedConfig(newer) })

    for (const event of [
      editCall(task.path, join(task.path, 'src/features/counter/step.js')),
      bashCall(task.path, `git push -u origin ${task.branch}`),
    ]) {
      const result = await run(event)
      expect(result.code).toBe(2)
      expect(result.stderr).toContain(`is older than ${newer}`)
      expect(result.stderr).toContain(`to resolve: run \`npm install -g hackwin@${newer}\``)
    }
  })

  test('a newer bug fix release of the same phase warns on stderr and checks as usual', async () => {
    const running = semver.parse(VERSION)
    const older = `${running?.major}.${running?.minor}.0-0`
    const { task, run } = await builderScene({ config: pinnedConfig(older) })

    const result = await run(editCall(task.path, join(task.path, 'src/features/greeting/hello.js')))

    expect(result.stderr).toBe(
      `warning: hackwin ${VERSION} is newer than ${older}, the version pinned in hackwin.yml; continuing\n`,
    )
    expect(denial(result)).toContain('rule: E1')
  })
})

describe('1.4c/pre-tool-use: the command line of the settings', () => {
  test('the PreToolUse command of the settings runs the hackwin on PATH with the event on stdin', async () => {
    const { task, hooks } = await builderScene()
    const settings = JSON.parse(mergeClaudeSettings(null, { defaultBranch: 'main' }))
    const [handler] = settings.hooks.PreToolUse[0].hooks
    const event = editCall(task.path, join(task.path, 'src/features/greeting/hello.js'))

    const ran = await exec('/bin/sh', ['-c', handler.command], {
      cwd: task.path,
      env: hooks.env,
      input: JSON.stringify(event),
    })

    expect(ran.code).toBe(0)
    expect(JSON.parse(ran.stdout).hookSpecificOutput).toMatchObject({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
    })
  })
})

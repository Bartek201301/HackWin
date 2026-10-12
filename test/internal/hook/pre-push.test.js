import { describe, expect, test } from 'vitest'
import { exec } from '../../../src/core/runtime/exec.js'
import { parsePushLines } from '../../../src/internal/hook/pre-push.js'
import { commit, createHookFixture, recordGreen, remoteHead, runHook } from './hook-fixture.js'

const ZERO = '0'.repeat(40)

/** A task worktree of builder1 with one commit that the pre-commit hook let through. */
async function taskWithCommit(issue = 30) {
  const hooks = await createHookFixture()
  const clone = await hooks.joinedClone('builder1')
  const task = await hooks.taskWorktree(clone, issue, 'Counter step')
  const committed = await commit(task.git, { 'src/features/counter/step.js': 'export {}\n' })
  expect(committed.code).toBe(0)
  return { hooks, clone, task, sha: await task.git.revParse('HEAD') }
}

/**
 * @param {import('../../../src/core/git/index.js').Git} git
 * @param {string[]} args
 */
function push(git, args) {
  return git.run(['push', '--quiet', ...args], { allowFailure: true })
}

describe('AC18: the pre-push hook requires the check record', () => {
  test('a manual git push of a commit without a check record is blocked', async () => {
    const { task, sha } = await taskWithCommit()

    const result = await push(task.git, ['-u', 'origin', task.branch])

    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain(
      'hackwin internal hook pre-push: blocked: the pushed commit of a task branch has no green check record',
    )
    expect(result.stderr).toContain('rule: E4: no push without green checks on the pushed commit')
    expect(result.stderr).toContain(`- ${task.branch} at ${sha}: no green check record`)
    expect(result.stderr).toContain(`to resolve: run \`hackwin ship\` in ${task.path}`)
    expect(await remoteHead(task.git, task.branch)).toBeNull()
  })

  test('a script that runs a failing check, then ;, then a push does not push', async () => {
    // HackYeah F3: `<check> ; git push` pushed although the check had failed. `false` stands for
    // the failing check; `;` runs the push anyway, and only the hook can stop it.
    const { hooks, task, sha } = await taskWithCommit()
    const script = (/** @type {string} */ check) =>
      exec('sh', ['-c', `${check} ; git push --quiet -u origin ${task.branch}`], {
        cwd: task.path,
        env: hooks.env,
      })

    const failed = await script('false')

    expect(failed.code).not.toBe(0)
    expect(failed.stderr).toContain('rule: E4: no push without green checks on the pushed commit')
    expect(await remoteHead(task.git, task.branch)).toBeNull()

    // Once every check passed, `ship` writes the record, and the same push goes through.
    await recordGreen(task, sha)
    const passed = await script('true')
    expect(passed.code).toBe(0)
    expect(await remoteHead(task.git, task.branch)).toBe(sha)
  })
})

describe('AC54/hooks: the pre-push hook and history rewrites', () => {
  test('a push that rewrites the history of a pushed task branch is blocked by the pre-push hook', async () => {
    const { task, sha } = await taskWithCommit()
    await recordGreen(task, sha)
    expect((await push(task.git, ['-u', 'origin', task.branch])).code).toBe(0)

    await task.git.run(['commit', '--quiet', '--amend', '-m', 'Rewritten'])
    const rewritten = await task.git.revParse('HEAD')
    await recordGreen(task, rewritten)
    const result = await push(task.git, ['--force', 'origin', task.branch])

    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('rule: E12: main is merged in, never rebased or force pushed')
    expect(result.stderr).toContain(
      `- ${task.branch}: ${sha} on origin is not in the history of ${rewritten}`,
    )
    expect(result.stderr).toContain(
      `to resolve: run \`git pull --no-rebase origin ${task.branch}\` in ${task.path}`,
    )
    expect(await remoteHead(task.git, task.branch)).toBe(sha)
  })
})

describe('AC2/pre-push: a push to the default branch', () => {
  test('in a clone with active hooks, git push origin main is rejected by the pre-push hook', async () => {
    const hooks = await createHookFixture()
    const clone = await hooks.joinedClone('lead')
    const before = await remoteHead(clone.git, 'main')
    // The pre-commit hook blocks the commit on main first; --no-verify skips it, not the push.
    expect((await commit(clone.git, { 'README.md': '# On main\n' }, ['--no-verify'])).code).toBe(0)
    const sha = await clone.git.revParse('HEAD')

    const result = await push(clone.git, ['origin', 'main'])

    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain(
      "hackwin internal hook pre-push: blocked: a push to main is blocked: main changes only through the Gate's merges of pull requests",
    )
    expect(result.stderr).toContain('rule: E2: no direct push to main')
    expect(result.stderr).toContain(`- origin: refs/heads/main to ${sha}`)
    expect(result.stderr).toContain(`to resolve: run \`hackwin take\` in ${clone.path}`)
    expect(await remoteHead(clone.git, 'main')).toBe(before)
  })
})

describe('1.4a/pre-push: exemptions and other refs', () => {
  test('tags and spike branches need no check record, but a spike branch is not rewritten either', async () => {
    const { task } = await taskWithCommit()
    await task.git.run(['tag', 'v0.0.1'])
    expect((await push(task.git, ['origin', 'v0.0.1'])).code).toBe(0)

    await task.git.run(['switch', '--quiet', '-c', 'spike/counter-idea'])
    expect((await commit(task.git, { 'src/features/greeting/idea.js': 'export {}\n' })).code).toBe(
      0,
    )
    const spike = await task.git.revParse('HEAD')
    expect((await push(task.git, ['origin', 'spike/counter-idea'])).code).toBe(0)
    expect(await remoteHead(task.git, 'spike/counter-idea')).toBe(spike)

    await task.git.run(['commit', '--quiet', '--amend', '-m', 'Rewritten idea'])
    const rewrite = await push(task.git, ['--force', 'origin', 'spike/counter-idea'])
    expect(rewrite.code).not.toBe(0)
    expect(rewrite.stderr).toContain('rule: E12:')
    expect(await remoteHead(task.git, 'spike/counter-idea')).toBe(spike)
  })

  test('deleting a remote task branch is allowed; deleting the default branch is blocked', async () => {
    const { task, sha } = await taskWithCommit()
    await recordGreen(task, sha)
    expect((await push(task.git, ['-u', 'origin', task.branch])).code).toBe(0)

    expect((await push(task.git, ['origin', '--delete', task.branch])).code).toBe(0)
    expect(await remoteHead(task.git, task.branch)).toBeNull()

    const main = await push(task.git, ['origin', '--delete', 'main'])
    expect(main.code).not.toBe(0)
    expect(main.stderr).toContain('rule: E2: no direct push to main')
    expect(main.stderr).toContain('- origin: delete refs/heads/main')
  })

  test('refs outside refs/heads, branches that are neither task nor spike, and unchanged refs pass', async () => {
    const { hooks, clone, task, sha } = await taskWithCommit()
    const run = (/** @type {string} */ stdin) =>
      runHook('pre-push', {
        cwd: clone.path,
        env: hooks.env,
        args: ['origin', hooks.fixture.origin],
        stdin,
      })

    expect((await run(`refs/notes/commits ${sha} refs/notes/commits ${ZERO}\n`)).code).toBe(0)
    expect((await run(`refs/heads/x ${sha} refs/heads/experiment ${ZERO}\n`)).code).toBe(0)
    expect(
      (await run(`refs/heads/${task.branch} ${sha} refs/heads/${task.branch} ${sha}\n`)).code,
    ).toBe(0)
    expect((await run('')).code).toBe(0)
  })

  test('a push from another checkout names the worktree of the task; a remote commit this clone lacks is a rewrite', async () => {
    const { hooks, clone, task, sha } = await taskWithCommit()
    const run = (/** @type {string} */ stdin) =>
      runHook('pre-push', {
        cwd: clone.path,
        env: hooks.env,
        args: ['origin', hooks.fixture.origin],
        stdin,
      })

    const unchecked = await run(
      `refs/heads/${task.branch} ${sha} refs/heads/${task.branch} ${ZERO}\n`,
    )
    expect(unchecked.code).toBe(1)
    expect(unchecked.json.error).toMatchObject({
      kind: 'blocked',
      rule: 'E4: no push without green checks on the pushed commit',
      objects: [`${task.branch} at ${sha}: no green check record`],
      resolve: { command: 'hackwin ship', dir: task.path },
    })

    const unknown = 'f'.repeat(40)
    const rewrite = await run(
      `refs/heads/${task.branch} ${sha} refs/heads/${task.branch} ${unknown}\n`,
    )
    expect(rewrite.code).toBe(1)
    expect(rewrite.json.error.rule).toBe('E12: main is merged in, never rebased or force pushed')
    expect(rewrite.json.error.objects).toEqual([
      `${task.branch}: ${unknown} on origin is not in the history of ${sha}`,
    ])
  })

  test('a malformed ref line exits 2', async () => {
    const { hooks, clone } = await taskWithCommit()
    const { code, json } = await runHook('pre-push', {
      cwd: clone.path,
      env: hooks.env,
      args: ['origin', hooks.fixture.origin],
      stdin: 'refs/heads/main\n',
    })
    expect(code).toBe(2)
    expect(json.error.kind).toBe('usage')
  })
})

describe('1.4a/pre-push: the ref lines', () => {
  test('parsePushLines reads one update per line and skips empty lines', () => {
    const sha = 'a'.repeat(40)
    expect(
      parsePushLines(
        `refs/heads/task/1-a ${sha} refs/heads/task/1-a ${ZERO}\n\n(delete) ${ZERO} refs/heads/old ${sha}\n`,
      ),
    ).toEqual([
      {
        localRef: 'refs/heads/task/1-a',
        localSha: sha,
        remoteRef: 'refs/heads/task/1-a',
        remoteSha: ZERO,
      },
      { localRef: '(delete)', localSha: ZERO, remoteRef: 'refs/heads/old', remoteSha: sha },
    ])
  })
})

import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { delimiter, join } from 'node:path'
import { VERSION } from '../../../src/cli/context.js'
import { createGit } from '../../../src/core/git/index.js'
import { PreconditionError, createOutput } from '../../../src/core/runtime/index.js'
import { bootstrap, stageFiles } from '../../../src/commands/setup/bootstrap.js'
import { teamConfig } from '../../harness/index.js'
import {
  createSetupFixture,
  runSetup,
  slowOrigin,
  snapshot,
  teamAnswers,
  waitFor,
  writes,
} from './setup-fixture.js'

/** A GitHub token of the built-in pattern, made at run time so that no source line holds one. */
const TOKEN = ['gh', 'p_', 'A1b2'.repeat(9)].join('')

/** @param {import('../../harness/index.js').Fixture} fixture */
async function originMain(fixture) {
  const { stdout } = await fixture.git.run(['ls-remote', fixture.origin, 'refs/heads/main'])
  return stdout.split(/\s+/)[0]
}

/**
 * The state that must not change when setup fails: the checkout's files, its HEAD, its index and
 * origin's main.
 * @param {import('../../harness/index.js').Fixture} fixture
 */
async function state(fixture) {
  return {
    files: snapshot(fixture.main),
    head: await fixture.git.tryRevParse('HEAD'),
    index: (await fixture.git.run(['ls-files', '--stage'])).stdout,
    origin: await originMain(fixture),
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

/**
 * Call steps 8 and 9 directly, as setup does after its questions, with the configuration of a
 * fixture team of 3 and the Node fixture's owners.yml kept.
 * @param {import('../../harness/index.js').Fixture} fixture
 * @param {{ signals?: any, env?: Record<string, string | undefined> }} [options]
 */
async function runBootstrap(fixture, { env = fixture.env, ...options } = {}) {
  let stderr = ''
  const out = createOutput({
    stdout: { write: () => true },
    stderr: { write: (chunk) => ((stderr += chunk), true) },
    json: false,
  })
  const ctx = /** @type {any} */ ({
    repoRoot: fixture.main,
    env,
    git: createGit({ cwd: fixture.main, env }),
    out,
  })
  const result = await bootstrap(
    ctx,
    {
      branch: 'main',
      head: await fixture.git.tryRevParse('HEAD'),
      version: VERSION,
      language: 'en',
      hackwin: teamConfig(3).files['hackwin.yml'],
      owners: null,
      secretPatterns: [],
    },
    options,
  )
  return { result, stderr }
}

/**
 * A stand-in for the process's signals that a test fires by hand.
 */
function fakeSignals() {
  /** @type {Map<string, Set<() => void>>} */
  const handlers = new Map()
  return {
    on(/** @type {string} */ signal, /** @type {() => void} */ handler) {
      if (!handlers.has(signal)) handlers.set(signal, new Set())
      handlers.get(signal)?.add(handler)
      return this
    },
    off(/** @type {string} */ signal, /** @type {() => void} */ handler) {
      handlers.get(signal)?.delete(handler)
      return this
    },
    /** @param {string} signal */
    fire(signal) {
      for (const handler of handlers.get(signal) ?? []) handler()
    },
    /** @param {string} signal */
    listening(signal) {
      return (handlers.get(signal)?.size ?? 0) > 0
    },
  }
}

describe('1.4d/bootstrap: the commit holds only what setup writes, and no secret', () => {
  test('1.4d/bootstrap: files of 6.4 that the project ignores stop setup before any change', async () => {
    const { fixture, fake } = await createSetupFixture({
      nodeProject: false,
      files: {
        'README.md': '# App\n',
        'package.json': '{ "name": "app" }\n',
        '.gitignore': '.env*\n.claude/\n',
      },
    })
    // Ignored, untracked and holding secrets: git status shows nothing.
    writeFileSync(join(fixture.main, '.env.example'), `API_KEY=${TOKEN}\n`)
    mkdirSync(join(fixture.main, '.claude'))
    writeFileSync(
      join(fixture.main, '.claude', 'settings.json'),
      `{ "env": { "TOKEN": "${TOKEN}" } }\n`,
    )
    expect(await fixture.git.isClean()).toBe(true)
    const before = await state(fixture)
    const answers = teamAnswers(1, (a) => {
      a.roles = { shared: { shared: true, paths: [] } }
      a.team.members[0].roles = ['shared']
      a.paths.contracts = []
    })
    const result = await runSetup(fixture, fake, { answers })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('the project ignores files that setup commits:')
    expect(result.stderr).toContain('.claude/settings.json (.gitignore:2: .claude/)')
    expect(result.stderr).toContain('.env.example (.gitignore:1: .env*)')
    expect(await state(fixture)).toEqual(before)
    expect(writes(fake)).toEqual([])
  })

  test('1.4d/bootstrap: a secret in a file setup writes stops setup before the commit; nothing changes', async () => {
    const { fixture, fake } = await createSetupFixture()
    const before = await state(fixture)
    const answers = teamAnswers(3, (a) => {
      a.commands.check = `GITHUB_TOKEN=${TOKEN} npm run check`
    })
    const result = await runSetup(fixture, fake, { answers })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('setup would commit a secret; it stopped before the commit')
    expect(result.stderr).toMatch(/hackwin\.yml:\d+: github-token/)
    expect(result.stderr).not.toContain(TOKEN)
    expect(await state(fixture)).toEqual(before)
    expect(writes(fake)).toEqual([])
  })

  test('1.4d/bootstrap: what else is staged in the checkout stays out of the commit and stays staged', async () => {
    const { fixture } = await createSetupFixture()
    writeFileSync(join(fixture.main, 'NOTES.md'), 'staged in another terminal\n')
    await fixture.git.run(['add', 'NOTES.md'])
    const { result } = await runBootstrap(fixture)
    const { stdout: files } = await fixture.git.run([
      'show',
      '--name-only',
      '--format=',
      result.commit,
    ])
    expect(files.split('\n')).not.toContain('NOTES.md')
    expect(result.written).not.toContain('NOTES.md')
    expect(await fixture.git.revParse('HEAD')).toBe(result.commit)
    expect(await originMain(fixture)).toBe(result.commit)
    const { stdout: staged } = await fixture.git.run(['diff', '--cached', '--name-only'])
    expect(staged.trim()).toBe('NOTES.md')
    const { stdout: status } = await fixture.git.run(['status', '--porcelain'])
    expect(status.trim()).toBe('A  NOTES.md')
  })

  test('1.4d/bootstrap: the push sends the bootstrap commit alone, without tags', async () => {
    const { fixture, fake } = await createSetupFixture()
    await fixture.git.run(['tag', '--annotate', '--message', 'local tag', 'v0.0.1'])
    await fixture.git.configSet('push.followTags', 'true')
    const result = await runSetup(fixture, fake, { answers: teamAnswers(3) })
    expect(result.code).toBe(0)
    const { stdout: tags } = await fixture.git.run(['ls-remote', '--tags', fixture.origin])
    expect(tags.trim()).toBe('')
  })
})

describe('AC6/files: symlinks and interrupts', () => {
  test('AC6/files: a CLAUDE.md that links to AGENTS.md stays a link, and AGENTS.md gets the rules', async () => {
    const { fixture, fake } = await createSetupFixture()
    rmSync(join(fixture.main, 'CLAUDE.md'))
    symlinkSync('AGENTS.md', join(fixture.main, 'CLAUDE.md'))
    await fixture.commit('Link CLAUDE.md to AGENTS.md', { push: true })
    const result = await runSetup(fixture, fake, { answers: teamAnswers(3) })
    expect(result.code).toBe(0)
    expect(lstatSync(join(fixture.main, 'CLAUDE.md')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(fixture.main, 'CLAUDE.md'))).toBe('AGENTS.md')
    const { stdout: agents } = await fixture.git.run(['show', 'HEAD:AGENTS.md'])
    expect(agents).toContain('run `hackwin ship` in the worktree of your task')
    expect(agents).toContain('<!-- Project rules: add your own rules below this line')
    expect(agents).not.toContain('@AGENTS.md')
    const { stdout: files } = await fixture.git.run(['show', '--name-only', '--format=', 'HEAD'])
    expect(files.split('\n')).not.toContain('CLAUDE.md')
    expect(await fixture.git.isClean()).toBe(true)
  })

  test('AC6/files: setup never writes through any other symlink, and changes nothing', async () => {
    const cases = [
      {
        name: 'AGENTS.md to another file',
        make: (/** @type {string} */ main) => {
          mkdirSync(join(main, 'rules'))
          writeFileSync(join(main, 'rules', 'agents.md'), '# Our rules\n')
          rmSync(join(main, 'AGENTS.md'))
          symlinkSync('rules/agents.md', join(main, 'AGENTS.md'))
        },
        message: 'hackwin writes AGENTS.md, but AGENTS.md is a symbolic link to rules/agents.md',
      },
      {
        name: 'the directory of the hook shims',
        make: (/** @type {string} */ main) => {
          mkdirSync(join(main, 'tools', 'hooks'), { recursive: true })
          writeFileSync(join(main, 'tools', 'hooks', 'README.md'), 'hooks\n')
          symlinkSync('tools/hooks', join(main, '.githooks'))
        },
        message:
          'hackwin writes .githooks/pre-commit, but .githooks/pre-commit lies under .githooks, which is a symbolic link to tools/hooks',
      },
    ]
    for (const { name, make, message } of cases) {
      const { fixture, fake } = await createSetupFixture()
      make(fixture.main)
      await fixture.commit(`Link ${name}`, { push: true })
      const before = await state(fixture)
      const result = await runSetup(fixture, fake, { answers: teamAnswers(3) })
      expect(result.code, name).toBe(2)
      expect(result.stderr, name).toContain(message)
      expect(result.stderr, name).toContain('never writes through a link it did not create')
      expect(await state(fixture), name).toEqual(before)
    }
  })

  test('AC6/files: an interrupt before the push puts every file back and changes nothing on GitHub', async () => {
    const { fixture } = await createSetupFixture()
    const before = await state(fixture)
    const signals = fakeSignals()
    const original = signals.on.bind(signals)
    // The interrupt arrives as soon as setup listens for it, while it writes the files.
    signals.on = (signal, handler) => {
      const value = original(signal, handler)
      if (signal === 'SIGINT') queueMicrotask(() => signals.fire('SIGINT'))
      return value
    }
    const run = runBootstrap(fixture, { signals })
    await expect(run).rejects.toThrow(PreconditionError)
    await expect(run).rejects.toThrow(
      'setup was interrupted before its push: it put every file back, and nothing changed on GitHub',
    )
    expect(await state(fixture)).toEqual(before)
    expect(signals.listening('SIGINT')).toBe(false)
  })

  test('AC6/files: an interrupt during a push that fails puts every file back', async () => {
    const { fixture } = await createSetupFixture()
    const marker = slowOrigin(fixture, false)
    const before = await state(fixture)
    const signals = fakeSignals()
    const run = runBootstrap(fixture, { signals })
    await waitFor(marker)
    signals.fire('SIGTERM')
    await expect(run).rejects.toThrow('setup was interrupted before its push')
    rmSync(marker)
    expect(await state(fixture)).toEqual(before)
  })

  test('AC6/files: an interrupt during a push that succeeds lets setup finish the local branch', async () => {
    const { fixture } = await createSetupFixture()
    const marker = slowOrigin(fixture, true)
    const signals = fakeSignals()
    const run = runBootstrap(fixture, { signals })
    await waitFor(marker)
    signals.fire('SIGINT')
    const { result } = await run
    rmSync(marker)
    expect(await originMain(fixture)).toBe(result.commit)
    expect(await fixture.git.revParse('HEAD')).toBe(result.commit)
    expect(await fixture.git.isClean()).toBe(true)
    expect(signals.listening('SIGINT')).toBe(false)
    // Setup stops here, before the steps after the push, for `setup --resume`.
    expect(result.interrupted).toBe(true)
  })
})

describe('1.4f/bootstrap: the gaps of the re-review of PR #65', () => {
  test('1.4f/bootstrap: when the push fails and origin cannot be asked, setup says it could not check, not that nothing changed', async () => {
    const { fixture, fake } = await createSetupFixture()
    // The push is refused, and origin is gone before setup asks it with git ls-remote.
    const hook = join(fixture.origin, 'hooks', 'pre-receive')
    writeFileSync(
      hook,
      `#!/bin/sh\ncat >/dev/null\nmv '${fixture.origin}' '${fixture.origin}.gone'\nexit 1\n`,
    )
    chmodSync(hook, 0o755)
    const files = snapshot(fixture.main)
    const head = await fixture.git.revParse('HEAD')
    const result = await runSetup(fixture, fake, { answers: teamAnswers(3) })
    expect(result.code).toBe(3)
    expect(result.stderr).toMatch(
      /setup could not check whether its bootstrap commit [0-9a-f]{40} reached origin\/main: the push failed, and git ls-remote failed too\. Setup put its files back; the commit may be on origin/,
    )
    expect(result.stderr).not.toContain('nothing changed on GitHub')
    expect(result.stderr).toContain(
      `to resolve: run \`git ls-remote origin refs/heads/main\` in ${fixture.main}: when it prints`,
    )
    expect(result.stderr).toContain(
      `run \`hackwin setup --resume\` in ${fixture.main}, which first fast-forwards main to origin/main, since the checkout is as clean as before; otherwise`,
    )
    expect(snapshot(fixture.main)).toEqual(files)
    expect(await fixture.git.revParse('HEAD')).toBe(head)
  })

  test('1.4f/bootstrap: a push that GitHub refuses for a missing workflow scope names the scope to add; nothing changes', async () => {
    const { fixture, fake } = await createSetupFixture()
    // GitHub's answer to the Lead's push on hackwin-fixture-a, 15 October 2026.
    const hook = join(fixture.origin, 'hooks', 'pre-receive')
    writeFileSync(
      hook,
      "#!/bin/sh\ncat >/dev/null\necho 'refusing to allow an OAuth App to create or update workflow `.github/workflows/hackwin.yml` without `workflow` scope' >&2\nexit 1\n",
    )
    chmodSync(hook, 0o755)
    const before = await state(fixture)
    const result = await runSetup(fixture, fake, { answers: teamAnswers(3) })
    expect(result.code).toBe(3)
    expect(result.stderr).toContain(
      'GitHub refuses a push that creates a workflow file from a login without the workflow scope, and the bootstrap commit creates .github/workflows/hackwin.yml',
    )
    expect(result.stderr).toContain(
      `to resolve: add the scope to the gh login that git pushes with: run \`gh auth refresh -s workflow\` in any directory, then run \`hackwin setup\` in ${fixture.main}`,
    )
    expect(await state(fixture)).toEqual(before)
    expect(writes(fake)).toEqual([])
  })

  test('1.4f/bootstrap: the interrupt handlers are removed when setup fails before it writes anything', async () => {
    const { fixture } = await createSetupFixture()
    const before = await state(fixture)
    const signals = fakeSignals()
    // mkdtemp of the scratch directory fails: TMPDIR names a directory that does not exist.
    vi.stubEnv('TMPDIR', join(fixture.dir, 'missing'))
    await expect(runBootstrap(fixture, { signals })).rejects.toThrow(/ENOENT/)
    vi.unstubAllEnvs()
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      expect(signals.listening(signal), signal).toBe(false)
    }
    expect(await state(fixture)).toEqual(before)
  })

  test('1.4f/bootstrap: the git calls after the push run in a process group of their own, out of reach of a Ctrl+C in the terminal', async () => {
    const { fixture } = await createSetupFixture()
    // A git first on PATH that notes its process group and the git command, then runs git.
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
    const bin = join(fixture.dir, 'git-bin')
    const log = join(fixture.dir, 'git-groups.log')
    mkdirSync(bin)
    writeFileSync(
      join(bin, 'git'),
      `#!/bin/sh\necho "$(ps -o pgid= -p $$ | tr -d ' ') $*" >> '${log}'\nexec '${realGit}' "$@"\n`,
    )
    chmodSync(join(bin, 'git'), 0o755)
    const env = { ...fixture.env, PATH: `${bin}${delimiter}${fixture.env.PATH}` }
    const { result } = await runBootstrap(fixture, { env })
    expect(await originMain(fixture)).toBe(result.commit)

    const own = execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], {
      encoding: 'utf8',
    }).trim()
    const calls = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        // The git command is the first word that is no option and no value of `-c`.
        const [group, ...args] = line.split(' ')
        const command = args.find((arg, index) => !arg.startsWith('-') && args[index - 1] !== '-c')
        return { group, command }
      })
    const pushAt = calls.findIndex((call) => call.command === 'push')
    expect(pushAt).toBeGreaterThan(-1)
    const after = calls.slice(pushAt + 1)
    expect(after.map((call) => call.command)).toEqual(['diff', 'update-ref', 'reset'])
    for (const call of after) expect(call.group, call.command).not.toBe(own)
    expect(calls[pushAt].group).toBe(own)
  })

  test('1.4f/bootstrap: a kept file under a symlinked directory gets the message about the link, not a failed git check-ignore', async () => {
    const { fixture, fake } = await createSetupFixture()
    // The research skill of .agents/ is kept as it is (6.5), and .agents is a link.
    await fixture.git.run(['mv', '.agents', 'shared-agents'])
    symlinkSync('shared-agents', join(fixture.main, '.agents'))
    await fixture.commit('Link .agents to shared-agents', { push: true })
    const before = await state(fixture)
    const result = await runSetup(fixture, fake, { answers: teamAnswers(3) })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain(
      'hackwin writes .agents/skills/research/SKILL.md, but .agents/skills/research/SKILL.md lies under .agents, which is a symbolic link to shared-agents; hackwin never writes through a link it did not create',
    )
    expect(result.stderr).not.toContain('check-ignore')
    expect(await state(fixture)).toEqual(before)
    expect(writes(fake)).toEqual([])
  })

  test('1.4f/bootstrap: an empty list of files is never staged as the whole tree; setup makes no commit', async () => {
    const { fixture } = await createSetupFixture()
    const index = join(fixture.dir, 'index')
    const git = createGit({ cwd: fixture.main, env: { ...fixture.env, GIT_INDEX_FILE: index } })
    writeFileSync(join(fixture.main, 'stray.txt'), 'stray\n')
    await expect(stageFiles(git, [])).rejects.toThrow('setup found no file of its own to commit')
    expect(existsSync(index)).toBe(false)

    // A second bootstrap over files that are as setup writes them: nothing of setup's changes.
    const { result } = await runBootstrap(fixture)
    const before = await state(fixture)
    await expect(runBootstrap(fixture)).rejects.toThrow('setup found no file of its own to commit')
    expect(await state(fixture)).toEqual(before)
    expect(await originMain(fixture)).toBe(result.commit)
  })
})

import { describe, expect, test } from 'vitest'
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
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { VERSION } from '../../../src/cli/context.js'
import { createGit } from '../../../src/core/git/index.js'
import { PreconditionError, createOutput } from '../../../src/core/runtime/index.js'
import { bootstrap } from '../../../src/commands/setup/bootstrap.js'
import { teamConfig } from '../../harness/index.js'
import { createSetupFixture, runSetup, snapshot, teamAnswers, writes } from './setup-fixture.js'

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

/**
 * Call steps 8 and 9 directly, as setup does after its questions, with the configuration of a
 * fixture team of 3 and the Node fixture's owners.yml kept.
 * @param {import('../../harness/index.js').Fixture} fixture
 * @param {{ signals?: any }} [options]
 */
async function runBootstrap(fixture, options = {}) {
  let stderr = ''
  const out = createOutput({
    stdout: { write: () => true },
    stderr: { write: (chunk) => ((stderr += chunk), true) },
    json: false,
  })
  const ctx = /** @type {any} */ ({
    repoRoot: fixture.main,
    env: fixture.env,
    git: createGit({ cwd: fixture.main, env: fixture.env }),
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

/**
 * A pre-receive hook on the fixture's origin that marks its start, waits, and then accepts or
 * refuses the push.
 * @param {import('../../harness/index.js').Fixture} fixture
 * @param {boolean} accept
 */
function slowOrigin(fixture, accept) {
  const marker = join(fixture.dir, 'push-started')
  const hook = join(fixture.origin, 'hooks', 'pre-receive')
  writeFileSync(
    hook,
    `#!/bin/sh\ncat >/dev/null\ntouch '${marker}'\nsleep 1\n${accept ? 'exit 0' : 'echo refused >&2\nexit 1'}\n`,
  )
  chmodSync(hook, 0o755)
  return marker
}

/** @param {string} file */
async function waitFor(file) {
  for (let tries = 0; tries < 200 && !existsSync(file); tries += 1) await sleep(25)
  if (!existsSync(file)) throw new Error(`${file} did not appear`)
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
  })
})

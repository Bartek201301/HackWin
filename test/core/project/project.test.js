import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createGit } from '../../../src/core/git/index.js'
import {
  formatCheck,
  generatedFileCheck,
  runAcceptanceTests,
  runCheck,
  runInstall,
} from '../../../src/core/project/index.js'
import { ConfigError, quoteShellArg } from '../../../src/core/runtime/index.js'
import { createRepoWithOrigin } from '../git/temp-repo.js'

/** @type {ReturnType<typeof createRepoWithOrigin>} */
let repo
/** The directory of the stand-in project tools, outside the checkout. */
let tools = ''

beforeEach(() => {
  repo = createRepoWithOrigin()
  tools = join(repo.dir, 'tools')
  mkdirSync(tools)
  for (const [name, source] of Object.entries(TOOLS)) writeFileSync(join(tools, name), source)
})

afterEach(() => repo.cleanup())

// Stand-ins for a project's commands. Each one appends its arguments to calls.log beside it.
const TOOLS = {
  'install.mjs': `
    import { appendFileSync, writeFileSync } from 'node:fs'
    appendFileSync(new URL('calls.log', import.meta.url), 'install\\n')
    writeFileSync('installed.txt', 'yes\\n')
    console.log('installed')
  `,
  // Runs the named test files: a file that contains FAIL fails.
  'test.mjs': `
    import { appendFileSync, readFileSync } from 'node:fs'
    const files = process.argv.slice(2)
    appendFileSync(new URL('calls.log', import.meta.url), 'test ' + files.join(' ') + '\\n')
    let failed = 0
    for (const file of files) {
      const ok = !readFileSync(file, 'utf8').includes('FAIL')
      if (!ok) failed += 1
      console.log((ok ? 'PASS ' : 'FAIL ') + file)
    }
    console.log(failed + ' failed')
    process.exit(failed > 0 ? 1 : 0)
  `,
  // Formats the named files: removes trailing spaces.
  'format.mjs': `
    import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
    const files = process.argv.slice(2)
    appendFileSync(new URL('calls.log', import.meta.url), 'format ' + files.join(' ') + '\\n')
    for (const file of files) {
      writeFileSync(file, readFileSync(file, 'utf8').replace(/[ \\t]+$/gm, ''))
    }
  `,
  // Writes generated/version.js with the text of GENERATED, or exits with GENERATE_EXIT.
  'generate.mjs': `
    import { mkdirSync, writeFileSync } from 'node:fs'
    mkdirSync('generated', { recursive: true })
    writeFileSync('generated/version.js', 'export const version = ' + JSON.stringify(process.argv[2] ?? '1') + '\\n')
    writeFileSync('generated/untracked.log', 'build output\\n')
    process.exit(Number(process.argv[3] ?? 0))
  `,
}

/** @param {string} tool */
function node(tool) {
  return `${quoteShellArg(process.execPath)} ${quoteShellArg(join(tools, tool))}`
}

/**
 * The configuration of the stand-in project.
 * @param {{ manifests?: string[], generate?: string | null, commands?: Record<string, string> }} [options]
 */
function configOf({ manifests = ['package.json'], generate = null, commands = {} } = {}) {
  return {
    hackwin: {
      commands: {
        install: node('install.mjs'),
        check: `${node('test.mjs')} check.txt`,
        test: node('test.mjs'),
        format: node('format.mjs'),
        generate,
        ...commands,
      },
      paths: { manifests },
    },
  }
}

/** The calls of the stand-in tools so far. */
function calls() {
  const file = join(tools, 'calls.log')
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : []
}

/**
 * Commit files on main of the clone.
 * @param {Record<string, string>} files
 */
function commit(files) {
  for (const [path, text] of Object.entries(files)) repo.write(join(repo.clone, path), text)
  repo.git(repo.clone, 'add', '.')
  repo.git(repo.clone, 'commit', '--quiet', '-m', 'files')
}

describe('AC76/install-skip: the install step waits for a manifest', () => {
  test('without a file that matches paths.manifests, install is skipped with a notice', async () => {
    const result = await runInstall({ cwd: repo.clone, config: configOf() })
    expect(result).toEqual({
      skipped: true,
      notice: 'install skipped: no file matches paths.manifests (package.json)',
    })
    expect(calls()).toEqual([])
    expect(existsSync(join(repo.clone, 'installed.txt'))).toBe(false)
  })

  test('once a manifest exists, even before it is committed, install runs', async () => {
    repo.write(join(repo.clone, 'apps/web/package.json'), '{}\n')
    const config = configOf({ manifests: ['apps/*/package.json'] })
    const result = await runInstall({ cwd: repo.clone, config })
    expect(result).toMatchObject({ ok: true, code: 0, timedOut: false, tail: ['installed'] })
    expect(calls()).toEqual(['install'])
    expect(existsSync(join(repo.clone, 'installed.txt'))).toBe(true)
  })

  test('an ignored file does not count as a manifest', async () => {
    commit({ '.gitignore': 'vendor/\n' })
    repo.write(join(repo.clone, 'vendor/lib/package.json'), '{}\n')
    const result = await runInstall({
      cwd: repo.clone,
      config: configOf({ manifests: ['**/package.json'] }),
    })
    expect(result).toMatchObject({ skipped: true })
  })
})

describe('1.3c/acceptance-tests: every acceptance test is an existing file (T5)', () => {
  beforeEach(() => {
    commit({
      'test/login.test.js': 'login works\n',
      'test/logout.test.js': 'FAIL: logout keeps the session\n',
    })
  })

  test('an entry that is not an existing file fails before anything runs, also a test id', async () => {
    const files = ['test/login.test.js', 'AC11', '1.3a/registry', 'test', '../tools/test.mjs']
    const result = await runAcceptanceTests({ cwd: repo.clone, config: configOf(), files })
    expect(result).toEqual({
      ok: false,
      missing: ['AC11', '1.3a/registry', 'test', '../tools/test.mjs'],
      run: null,
    })
    expect(calls()).toEqual([])
  })

  test('passing tests run with commands.test and the files appended', async () => {
    const result = await runAcceptanceTests({
      cwd: repo.clone,
      config: configOf(),
      files: ['test/login.test.js'],
    })
    expect(result.ok).toBe(true)
    expect(result.missing).toEqual([])
    expect(result.run).toMatchObject({
      ok: true,
      code: 0,
      tail: ['PASS test/login.test.js', '0 failed'],
    })
    expect(result.run?.command).toBe(`${node('test.mjs')} test/login.test.js`)
    expect(calls()).toEqual(['test test/login.test.js'])
  })

  test('a failing test fails the run and is reported with the log tail', async () => {
    const logFile = join(repo.dir, 'logs', 'acceptance.log')
    const result = await runAcceptanceTests({
      cwd: repo.clone,
      config: configOf(),
      files: ['test/login.test.js', 'test/logout.test.js'],
      logFile,
    })
    expect(result.ok).toBe(false)
    expect(result.run).toMatchObject({ ok: false, code: 1, timedOut: false, logFile })
    expect(result.run?.tail).toEqual([
      'PASS test/login.test.js',
      'FAIL test/logout.test.js',
      '1 failed',
    ])
    expect(readFileSync(logFile, 'utf8')).toContain('FAIL test/logout.test.js')
  })

  test('without entries nothing runs', async () => {
    const result = await runAcceptanceTests({ cwd: repo.clone, config: configOf(), files: [] })
    expect(result).toEqual({ ok: true, missing: [], run: null })
    expect(calls()).toEqual([])
  })
})

describe('1.3c/format-check: only the changed files are format checked (E14)', () => {
  beforeEach(() => {
    commit({
      'src/clean.js': 'const a = 1\n',
      'src/messy.js': 'const b = 2   \n',
      'src/untouched.js': 'const c = 3   \n',
    })
  })

  test('formatted changed files pass, and the formatter gets only those files', async () => {
    const result = await formatCheck({
      cwd: repo.clone,
      config: configOf(),
      files: ['src/clean.js'],
    })
    expect(result).toMatchObject({ ok: true, unformatted: [], run: { ok: true } })
    expect(calls()).toEqual(['format src/clean.js'])
  })

  test('an unformatted changed file fails and keeps its content; deleted files are left out', async () => {
    repo.git(repo.clone, 'rm', '--quiet', 'src/clean.js')
    const files = ['src/clean.js', 'src/messy.js']
    const result = await formatCheck({ cwd: repo.clone, config: configOf(), files })
    expect(result.ok).toBe(false)
    expect(result.unformatted).toEqual(['src/messy.js'])
    expect(result.run?.ok).toBe(true)
    expect(calls()).toEqual(['format src/messy.js'])
    // The check never changes the checkout.
    expect(readFileSync(join(repo.clone, 'src/messy.js'), 'utf8')).toBe('const b = 2   \n')
    expect(readFileSync(join(repo.clone, 'src/untouched.js'), 'utf8')).toBe('const c = 3   \n')
  })

  test('without changed files nothing runs', async () => {
    const result = await formatCheck({ cwd: repo.clone, config: configOf(), files: [] })
    expect(result).toEqual({ ok: true, unformatted: [], run: null })
    expect(calls()).toEqual([])
  })
})

describe('1.3c/generate-check: commands.generate must not change a tracked file (E10)', () => {
  /** @type {import('../../../src/core/git/index.js').Git} */
  let git

  beforeEach(() => {
    commit({ 'generated/version.js': 'export const version = "1"\n', 'src/app.js': 'app\n' })
    git = createGit({ cwd: repo.clone, env: repo.env })
  })

  test('a generate command that changes a tracked file fails, and the file is restored', async () => {
    const config = configOf({ generate: `${node('generate.mjs')} 2` })
    const result = await generatedFileCheck({ cwd: repo.clone, config, git })
    expect(result.ok).toBe(false)
    expect(result.changed).toEqual(['generated/version.js'])
    expect(result.run?.ok).toBe(true)
    expect(readFileSync(join(repo.clone, 'generated/version.js'), 'utf8')).toBe(
      'export const version = "1"\n',
    )
    expect(repo.git(repo.clone, 'status', '--porcelain', '--untracked-files=no')).toBe('')
  })

  test('current generated files pass; new untracked output does not count', async () => {
    const config = configOf({ generate: `${node('generate.mjs')} 1` })
    const result = await generatedFileCheck({ cwd: repo.clone, config, git })
    expect(result).toMatchObject({ ok: true, changed: [], run: { ok: true } })
    expect(existsSync(join(repo.clone, 'generated/untracked.log'))).toBe(true)
  })

  test('changes made before the check do not count and stay in place', async () => {
    repo.write(join(repo.clone, 'src/app.js'), 'app, edited\n')
    const config = configOf({ generate: `${node('generate.mjs')} 1` })
    const result = await generatedFileCheck({ cwd: repo.clone, config, git })
    expect(result).toMatchObject({ ok: true, changed: [] })
    expect(readFileSync(join(repo.clone, 'src/app.js'), 'utf8')).toBe('app, edited\n')
  })

  test('a generate command that fails fails the check', async () => {
    const config = configOf({ generate: `${node('generate.mjs')} 1 3` })
    const result = await generatedFileCheck({ cwd: repo.clone, config, git })
    expect(result.ok).toBe(false)
    expect(result.changed).toEqual([])
    expect(result.run).toMatchObject({ ok: false, code: 3 })
  })

  test('without commands.generate the check passes without a run', async () => {
    const result = await generatedFileCheck({ cwd: repo.clone, config: configOf(), git })
    expect(result).toEqual({ ok: true, changed: [], run: null })
  })
})

describe('1.3c/project: every project command has a timeout and reports its log tail', () => {
  test('runCheck runs commands.check and reports the exit status and the tail', async () => {
    commit({ 'check.txt': 'all good\n' })
    const passed = await runCheck({ cwd: repo.clone, config: configOf() })
    expect(passed).toMatchObject({ ok: true, code: 0, tail: ['PASS check.txt', '0 failed'] })

    commit({ 'check.txt': 'FAIL\n' })
    const failed = await runCheck({ cwd: repo.clone, config: configOf() })
    expect(failed).toMatchObject({ ok: false, code: 1, tail: ['FAIL check.txt', '1 failed'] })
    expect(failed.durationMs).toBeGreaterThanOrEqual(0)
  })

  test('a command that runs past its timeout is stopped and fails', async () => {
    const config = configOf({ commands: { check: 'echo started; sleep 10' } })
    const result = await runCheck({ cwd: repo.clone, config, timeoutMs: 300 })
    expect(result).toMatchObject({ ok: false, timedOut: true, tail: ['started'] })
    expect(result.durationMs).toBeLessThan(5000)
  })

  test('every project command runs with the environment the caller gives, process.env by default', async () => {
    commit({ 'package.json': '{}\n', 'check.txt': 'all good\n', 'tests/a.test.txt': 'ok\n' })
    const log = join(tools, 'env.log')
    /** @param {string} name */
    const probe = (name) =>
      `echo ${name} "\${PROBE_GIVEN-unset}" "\${PROBE_SECRET-unset}" >> ${quoteShellArg(log)}`
    const config = configOf({
      generate: probe('generate'),
      commands: {
        install: probe('install'),
        check: probe('check'),
        test: probe('test'),
        format: probe('format'),
      },
    })
    const runAll = async (/** @type {Record<string, string | undefined> | undefined} */ env) => {
      const cwd = repo.clone
      expect(await runInstall({ cwd, config, env })).toMatchObject({ ok: true })
      expect(await runCheck({ cwd, config, env })).toMatchObject({ ok: true })
      const files = ['tests/a.test.txt']
      expect(await runAcceptanceTests({ cwd, config, files, env })).toMatchObject({ ok: true })
      expect(await formatCheck({ cwd, config, files: ['check.txt'], env })).toMatchObject({
        ok: true,
      })
      const git = createGit({ cwd, env: repo.env })
      expect(await generatedFileCheck({ cwd, config, git, env })).toMatchObject({ ok: true })
      const lines = readFileSync(log, 'utf8').trim().split('\n')
      writeFileSync(log, '')
      // The test and format commands get the files appended after the redirection.
      return lines.map((line) => line.split(' ').slice(0, 3).join(' '))
    }

    process.env.PROBE_SECRET = 'from-process'
    try {
      const { PROBE_SECRET, ...rest } = process.env
      expect(await runAll({ ...rest, PROBE_GIVEN: 'given' })).toEqual([
        'install given unset',
        'check given unset',
        'test given unset',
        'format given unset',
        'generate given unset',
      ])
      expect(await runAll(undefined)).toEqual([
        'install unset from-process',
        'check unset from-process',
        'test unset from-process',
        'format unset from-process',
        'generate unset from-process',
      ])
    } finally {
      delete process.env.PROBE_SECRET
    }
  })

  test('a missing command is a configuration error naming its key', async () => {
    const config = configOf({ commands: { check: '' } })
    const error = await runCheck({ cwd: repo.clone, config }).catch((e) => e)
    expect(error).toBeInstanceOf(ConfigError)
    expect(error.key).toBe('commands.check')
  })
})

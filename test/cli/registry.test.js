import { afterEach, describe, expect, test } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import picomatch from 'picomatch'
import { parse } from 'yaml'
import { COMMANDS, HOOK_NAMES, PLUMBING, resolveCommand } from '../../src/cli/registry.js'
import { main } from '../../src/cli/main.js'
import { UsageError } from '../../src/core/runtime/errors.js'
import { createRepoWithOrigin, createScratch } from '../core/git/temp-repo.js'

const root = fileURLToPath(new URL('../../', import.meta.url))
const bin = join(root, 'bin', 'hackwin.js')

/** @param {string[]} args */
function hackwin(args, cwd = root) {
  return spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8' })
}

function sink() {
  return {
    text: '',
    /** @param {string} chunk */
    write(chunk) {
      this.text += chunk
    },
  }
}

/** @type {Array<() => void>} */
const cleanups = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

describe('1.3a/registry: the command registry', () => {
  test('hackwin --help lists exactly setup, join, take, ship, status and gate', () => {
    const result = hackwin(['--help'])
    expect(result.status).toBe(0)
    const lines = result.stdout.split('\n')
    const start = lines.indexOf('Commands:') + 1
    const end = lines.indexOf('', start)
    const listed = lines.slice(start, end).map((line) => line.trim().split(/\s+/)[0])
    expect(listed).toEqual(['setup', 'join', 'take', 'ship', 'status', 'gate'])
    expect(result.stdout).not.toContain('internal')
  })

  test('--version prints the package version', () => {
    const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const result = hackwin(['--version'])
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`${version}\n`)
  })

  test('internal hook <name> and internal ci resolve to their module paths', () => {
    for (const hook of HOOK_NAMES) {
      const { entry, rest } = resolveCommand(['internal', 'hook', hook, 'origin', 'url'])
      expect(entry.module).toBe(`src/internal/hook/${hook}.js`)
      expect(rest).toEqual(['origin', 'url'])
    }
    expect(resolveCommand(['internal', 'ci']).entry.module).toBe('src/internal/ci/index.js')
    for (const command of COMMANDS) {
      expect(resolveCommand([command.name]).entry.module).toBe(
        `src/commands/${command.name}/index.js`,
      )
    }
    expect(HOOK_NAMES).toEqual([
      'pre-commit',
      'pre-push',
      'session-start',
      'pre-tool-use',
      'post-tool-use',
    ])
  })

  test("every module path lies in its owner's directory in owners.yml", () => {
    const owners = parse(readFileSync(join(root, 'owners.yml'), 'utf8'))
    for (const entry of [...COMMANDS, ...PLUMBING]) {
      const globs = owners.roles[entry.owner].paths
      expect(picomatch.isMatch(entry.module, globs), `${entry.name}: ${entry.module}`).toBe(true)
    }
  })

  test('an unknown command exits 2', () => {
    for (const args of [
      ['nope'],
      ['internal', 'nope'],
      ['internal', 'hook', 'nope'],
      ['internal', 'hook'],
      ['--nope'],
      [],
    ]) {
      const result = hackwin(args)
      expect(result.status, args.join(' ')).toBe(2)
    }
    expect(hackwin(['nope']).stderr).toContain('unknown command: nope')
    expect(() => resolveCommand(['internal', 'hook', 'post-merge'])).toThrow(UsageError)
  })

  test('a known command whose module does not exist yet exits 2 and names it', async () => {
    const repo = createRepoWithOrigin()
    cleanups.push(repo.cleanup)
    const empty = createScratch()
    cleanups.push(empty.cleanup)
    for (const entry of [...COMMANDS, ...PLUMBING]) {
      const stderr = sink()
      const code = await main(entry.name.split(' '), {
        cwd: repo.clone,
        env: repo.env,
        stdout: sink(),
        stderr,
        moduleRoot: empty.dir,
      })
      expect(code, entry.name).toBe(2)
      expect(stderr.text).toBe(
        `hackwin ${entry.name}: not built yet: ${entry.module} does not exist\n`,
      )
    }
  })

  test('modules load lazily: a broken module of another command does not matter', async () => {
    const repo = createRepoWithOrigin()
    cleanups.push(repo.cleanup)
    const modules = createScratch()
    cleanups.push(modules.cleanup)
    modules.write(join(modules.dir, 'src/commands/ship/index.js'), 'this is not javascript')
    modules.write(
      join(modules.dir, 'src/commands/status/index.js'),
      "export async function run() { return { lines: ['status ran'] } }\n",
    )
    const stdout = sink()
    const code = await main(['status'], {
      cwd: repo.clone,
      env: repo.env,
      stdout,
      stderr: sink(),
      moduleRoot: modules.dir,
    })
    expect(code).toBe(0)
    expect(stdout.text).toBe('status ran\n')
  })

  test('command help shows the usage without loading the module', () => {
    const result = hackwin(['take', '--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Usage: hackwin take [N] [--release]')
  })

  test('the binary runs from any directory of a checkout', () => {
    const repo = createRepoWithOrigin()
    cleanups.push(repo.cleanup)
    const output = execFileSync(process.execPath, [bin, '--help'], {
      cwd: repo.clone,
      encoding: 'utf8',
    })
    expect(output).toContain('Usage: hackwin <command> [options]')
  })
})

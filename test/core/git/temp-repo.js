// Temporary git repositories for the tests of task 1.3a, isolated from the user's git
// configuration: own HOME, no global or system config, no inherited GIT_* variables.

import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'

/**
 * A scratch directory with an isolated git environment. Call cleanup() when done.
 * @returns {{ dir: string, env: Record<string, string | undefined>, git: (cwd: string, ...args: string[]) => string, write: (path: string, text: string) => void, cleanup: () => void }}
 */
export function createScratch() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hackwin-test-')))
  const home = join(dir, 'home')
  mkdirSync(home)
  writeFileSync(
    join(home, '.gitconfig'),
    '[user]\n\tname = HackWin Test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n',
  )
  /** @type {Record<string, string | undefined>} */
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_') && key !== 'HACKWIN_CALLER') env[key] = value
  }
  Object.assign(env, {
    HOME: home,
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
  })
  return {
    dir,
    env,
    git: (cwd, ...args) =>
      execFileSync('git', args, {
        cwd,
        env: /** @type {NodeJS.ProcessEnv} */ (env),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    write: (path, text) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text)
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/**
 * A bare origin with one commit on main, and a clone of it as the main checkout.
 * @returns {ReturnType<typeof createScratch> & { origin: string, clone: string }}
 */
export function createRepoWithOrigin() {
  const scratch = createScratch()
  const origin = join(scratch.dir, 'origin.git')
  const clone = join(scratch.dir, 'clone')
  scratch.git(scratch.dir, 'init', '--quiet', '--bare', origin)
  scratch.git(scratch.dir, 'clone', '--quiet', origin, clone)
  scratch.write(join(clone, 'README.md'), 'readme\n')
  scratch.git(clone, 'add', '.')
  scratch.git(clone, 'commit', '--quiet', '-m', 'initial')
  scratch.git(clone, 'push', '--quiet', 'origin', 'main')
  return { ...scratch, origin, clone }
}

// A fixture for the git hook tests: an offline team repository whose main holds the generated
// hook shims, as the bootstrap commit of `setup` leaves it, and a `hackwin` command first on PATH
// that runs the CLI of this checkout. Clones are joined (the join record and core.hooksPath), so
// every `git commit` and `git push` in them runs the real hooks.

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { VERSION } from '../../../src/cli/context.js'
import { main } from '../../../src/cli/main.js'
import { quoteShellArg } from '../../../src/core/runtime/exec.js'
import { writeCheckRecord } from '../../../src/core/state/index.js'
import { branchName, slugOf } from '../../../src/core/tasks/index.js'
import { taskWorktreePath } from '../../../src/core/worktrees/index.js'
import { writeGeneratedFiles } from '../../../src/generate/index.js'
import { accounts, createFixture, teamConfig } from '../../harness/index.js'

/** @import { Git } from '../../../src/core/git/index.js' */
/** @import { FixtureOptions } from '../../harness/fixture.js' */

const CLI = fileURLToPath(new URL('../../../bin/hackwin.js', import.meta.url))

/**
 * @typedef {object} Checkout
 * @property {string} path
 * @property {Git} git Git with the `hackwin` command on PATH, so the hooks run.
 * @property {string} commonDir
 */

/**
 * @param {FixtureOptions} [options] A team of 3 by default.
 */
export async function createHookFixture(options = {}) {
  const fixture = await createFixture({ team: 3, ...options })
  await writeGeneratedFiles(fixture.main, { version: VERSION })
  await fixture.commit('Add the git hook shims', { push: true })

  const bin = join(fixture.dir, 'bin')
  mkdirSync(bin)
  writeFileSync(
    join(bin, 'hackwin'),
    `#!/bin/sh\nexec ${quoteShellArg(process.execPath)} ${quoteShellArg(CLI)} "$@"\n`,
  )
  chmodSync(join(bin, 'hackwin'), 0o755)
  const env = { ...fixture.env, PATH: `${bin}:${fixture.env.PATH}` }
  /** @param {string} cwd */
  const gitAt = (cwd) => fixture.gitAt(cwd).with({ env })

  return {
    fixture,
    /** The environment of the fixture with `hackwin` on PATH. */
    env,
    gitAt,

    /**
     * A new clone in which `join` completed for this member.
     * @param {keyof typeof accounts} [member]
     * @returns {Promise<Checkout>}
     */
    async joinedClone(member = 'builder1') {
      const login = accounts[member].login
      const clone = await fixture.joinedClone({ name: `clone-${member}`, login })
      return { path: clone.path, git: gitAt(clone.path), commonDir: clone.commonDir }
    },

    /**
     * The worktree of a task in a clone, on `task/<N>-<slug>` from origin/main, at its path of A9.
     * @param {Checkout} clone
     * @param {number} issue
     * @param {string} [title]
     * @returns {Promise<Checkout & { branch: string }>}
     */
    async taskWorktree(clone, issue, title = 'Task') {
      const branch = branchName(issue, title)
      const path = taskWorktreePath(clone.path, issue, slugOf(title))
      await clone.git.fetch()
      await clone.git.worktreeAdd(path, { branch, createBranch: true, startPoint: 'origin/main' })
      return { path, git: gitAt(path), commonDir: clone.commonDir, branch }
    },
  }
}

/**
 * Write files under a checkout, relative to its top level.
 * @param {string} root
 * @param {Record<string, string>} files
 */
export function writeFiles(root, files) {
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
}

/**
 * Write and stage files, then run `git commit`, which runs the pre-commit hook.
 * @param {Git} git
 * @param {Record<string, string>} files
 * @param {string[]} [extra] More arguments of git commit, for example `--no-verify`.
 */
export async function commit(git, files, extra = []) {
  writeFiles(git.cwd, files)
  await git.run(['add', '--all'])
  return git.run(['commit', '--quiet', '-m', 'Change', ...extra], { allowFailure: true })
}

/**
 * Write the green check record of a commit, as `ship` does after every check passed.
 * @param {Checkout & { branch: string }} worktree
 * @param {string} sha
 */
export async function recordGreen(worktree, sha) {
  await writeCheckRecord(worktree.commonDir, {
    sha,
    branch: worktree.branch,
    issue: Number(/^task\/(\d+)/.exec(worktree.branch)?.[1] ?? 0),
    created_at: new Date().toISOString(),
    cli_version: VERSION,
    checks: ['scope', 'secrets', 'format', 'generated', 'check', 'acceptance'].map((name) => ({
      name,
      result: 'passed',
    })),
  })
}

/**
 * The commit a branch points to on the origin, or null.
 * @param {Git} git Any checkout of the fixture.
 * @param {string} branch
 */
export async function remoteHead(git, branch) {
  const result = await git.run(['ls-remote', '--heads', 'origin', branch], { allowFailure: true })
  return result.stdout.split('\t')[0].trim() || null
}

/**
 * Run `hackwin internal hook <hook>` in-process, as git would, with --json.
 * @param {string} hook
 * @param {object} options
 * @param {string} options.cwd
 * @param {Record<string, string | undefined>} options.env
 * @param {string[]} [options.args]
 * @param {string} [options.stdin]
 */
export async function runHook(hook, { cwd, env, args = [], stdin = '' }) {
  let stdout = ''
  let stderr = ''
  const code = await main(['internal', 'hook', hook, ...args, '--json'], {
    cwd,
    env,
    stdin: Readable.from([stdin]),
    stdout: { write: (chunk) => (stdout += chunk) },
    stderr: { write: (chunk) => (stderr += chunk) },
  })
  return { code, json: JSON.parse(stdout), stderr }
}

/**
 * The configuration of a team of 3 that pins another CLI version.
 * @param {string} pinned
 */
export function pinnedConfig(pinned) {
  const config = teamConfig(3)
  config.hackwin.cli_version = pinned
  return { hackwin: config.hackwin, owners: config.owners }
}

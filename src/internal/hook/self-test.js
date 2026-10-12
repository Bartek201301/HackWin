// The self test of the active git hooks, for `join` (7.2 step 5): core.hooksPath points at
// `.githooks`, each shim is there and executable, and git, running the hook the way it runs it
// for a commit or a push, reaches the hackwin CLI.
//
// In self test mode a hook first names itself and its version, then checks exactly as always,
// so the mode never skips a rule. A hook that passes or blocks (exit 0 or 1) works; on the
// default branch the pre-commit hook blocks, which is the answer the test expects there. A hook
// that cannot apply its rules at all (exit 2 or more, for example an older CLI) fails the test.

import { access, constants } from 'node:fs/promises'
import { join } from 'node:path'
import { GIT_HOOKS, shimPath } from '../../generate/index.js'
import { HOOKS_PATH, checkHooksPath } from '../../core/worktrees/index.js'

/** @import { CommandContext } from '../../cli/context.js' */
/** @import { Git } from '../../core/git/index.js' */
/** @import { Resolve } from '../../core/runtime/errors.js' */
/** @import { GitHook } from '../../generate/index.js' */

/** Set to `1`, a hook names itself and its version before it checks. */
export const SELF_TEST_ENV = 'HACKWIN_HOOK_SELF_TEST'

/**
 * @typedef {object} HookCheck
 * @property {'core.hooksPath' | GitHook} name
 * @property {boolean} ok
 * @property {string} detail What the check found.
 * @property {Resolve} [resolve] How to fix a failed check.
 */

/**
 * @typedef {object} SelfTestResult
 * @property {boolean} ok True when every check passed.
 * @property {HookCheck[]} checks `core.hooksPath`, then one check per hook.
 */

/**
 * In self test mode, print the line that tells the self test that git reached this hook.
 * @param {CommandContext} ctx
 */
export function announceSelfTest(ctx) {
  if (ctx.env[SELF_TEST_ENV] === '1') {
    ctx.out.line(`hackwin ${ctx.command}: self test, hackwin ${ctx.version}`)
  }
}

/**
 * Test the git hooks of a checkout.
 * @param {Git} git Git in the checkout that `join` prepares.
 * @returns {Promise<SelfTestResult>}
 */
export async function selfTestHooks(git) {
  const top = await git.topLevel()
  const hooksPath = await checkHooksPath(git)
  /** @type {HookCheck[]} */
  const checks = [
    hooksPath.ok
      ? { name: 'core.hooksPath', ok: true, detail: `core.hooksPath is ${HOOKS_PATH}` }
      : {
          name: 'core.hooksPath',
          ok: false,
          detail:
            hooksPath.value === null
              ? 'core.hooksPath is not set'
              : `core.hooksPath is ${hooksPath.value}, not ${HOOKS_PATH}`,
          resolve: { command: `git config core.hooksPath ${HOOKS_PATH}`, dir: top },
        },
  ]
  for (const hook of GIT_HOOKS) checks.push(await testHook(git, top, hook))
  return { ok: checks.every((check) => check.ok), checks }
}

/**
 * @param {Git} git
 * @param {string} top
 * @param {GitHook} hook
 * @returns {Promise<HookCheck>}
 */
async function testHook(git, top, hook) {
  const path = shimPath(hook)
  try {
    await access(join(top, path), constants.X_OK)
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        name: hook,
        ok: false,
        detail: `${path} is missing`,
        resolve:
          'bring this checkout up to date with origin/main, where the bootstrap commit of setup added the hook shims',
      }
    }
    return {
      name: hook,
      ok: false,
      detail: `${path} is not executable`,
      resolve: { command: `chmod +x ${path}`, dir: top },
    }
  }
  const env = { ...(git.options.env ?? process.env), [SELF_TEST_ENV]: '1' }
  const result = await git
    .with({ hooksOff: false, env })
    .run(['hook', 'run', hook], { allowFailure: true })
  const output = `${result.stdout}\n${result.stderr}`
  const announced = new RegExp(`^hackwin internal hook ${hook}: self test, hackwin (\\S+)$`, 'm')
  const match = announced.exec(output)
  if (match && (result.code === 0 || result.code === 1)) {
    return { name: hook, ok: true, detail: `${path} runs hackwin ${match[1]}` }
  }
  if (match) {
    const error = new RegExp(`^hackwin internal hook ${hook}: (?!self test, )(.*)$`, 'm').exec(
      output,
    )
    return {
      name: hook,
      ok: false,
      detail: `${path} runs hackwin ${match[1]}, which exits ${result.code}${error ? `: ${error[1]}` : ''}`,
      resolve: { command: `git hook run ${hook}`, dir: top },
    }
  }
  if (result.code === 127 || /hackwin: (?:command )?not found/.test(output)) {
    return {
      name: hook,
      ok: false,
      detail: `${path} cannot run hackwin: the command is not on the PATH`,
      resolve:
        'install hackwin so that the `hackwin` command is on the PATH of the shell that runs git',
    }
  }
  const last = result.tail.filter((line) => line.trim() !== '').at(-1)
  return {
    name: hook,
    ok: false,
    detail: `${path} does not reach hackwin${last ? `: ${last.trim()}` : `; it exits ${result.code}`}`,
    resolve: { command: `${SELF_TEST_ENV}=1 git hook run ${hook}`, dir: top },
  }
}

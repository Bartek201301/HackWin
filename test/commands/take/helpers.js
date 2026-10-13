// Helpers of the `take` tests: task issues and pull requests for the fake GitHub, an in-process
// run of `hackwin take`, and fake agent programs. No test starts a real agent (plan section 9,
// decision 9): a run that may start one gets a PATH that holds only the fake programs and
// wrappers of the few real ones it needs, so a real `claude` or `codex` is never found.

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { expect } from 'vitest'
import { main } from '../../../src/cli/main.js'
import { yaml } from '../../harness/index.js'

/** @typedef {import('../../harness/index.js').Fixture} Fixture */
/** @typedef {import('../../harness/index.js').FakeGitHub} FakeGitHub */

export const DEADLINE = '2026-10-25T12:00:00+02:00'

/**
 * The body of a task issue written by hand from the template (8.1).
 * @param {{ role: string, paths: string[], depends_on?: number[], wave?: number | null, deadline?: string, acceptance_tests?: string[] }} block
 */
export function taskBody({
  role,
  paths,
  depends_on = [],
  wave = 1,
  deadline = DEADLINE,
  acceptance_tests = ['test/features.test.js'],
}) {
  const data = { kind: 'task', role, ...(wave === null ? {} : { wave }), paths, depends_on }
  return blockBody(yaml({ ...data, acceptance_tests, deadline }).trimEnd())
}

/** @param {string} yamlText The block without the marker line. */
export function blockBody(yamlText) {
  return [
    '```yaml',
    '# hackwin:task',
    yamlText,
    '```',
    '',
    '## Problem',
    'Something is missing.',
    '',
    '## Expected result',
    'It exists.',
    '',
    '## Acceptance criteria',
    '- It works.',
    '',
    '## Out of scope',
    '- Everything else.',
  ].join('\n')
}

/**
 * A task issue for the fake GitHub.
 * @param {number} number
 * @param {Parameters<typeof taskBody>[0] & { title?: string, labels?: string[], assignees?: string[], state?: 'open' | 'closed', comments?: Array<{ body: string, author?: string }> }} options
 */
export function task(
  number,
  { title, labels = ['ready'], assignees = [], state, comments, ...block },
) {
  return {
    number,
    title: title ?? `Task ${number}`,
    body: taskBody(block),
    labels,
    assignees,
    ...(state ? { state } : {}),
    ...(comments ? { comments } : {}),
  }
}

/**
 * An open pull request that changes these files.
 * @param {number} number
 * @param {Array<string | { path: string, previousPath: string }>} files
 */
export function pull(number, files) {
  return {
    number,
    title: `Pull request ${number}`,
    head: `task/${number - 1}-other`,
    files: files.map((file) =>
      typeof file === 'string'
        ? { path: file, status: 'modified', previousPath: null }
        : { path: file.path, status: 'renamed', previousPath: file.previousPath },
    ),
  }
}

/**
 * Run `hackwin take` in-process in a checkout, as this login, against the fake GitHub. With
 * `tty`, stdin and stdout are terminals, so the caller kind is `terminal` unless the environment
 * sets HACKWIN_CALLER.
 * @param {Fixture} fixture
 * @param {string} cwd
 * @param {FakeGitHub} fake
 * @param {string} login
 * @param {string[]} [args]
 * @param {{ env?: Record<string, string | undefined>, tty?: boolean }} [options]
 */
export async function take(fixture, cwd, fake, login, args = [], { env, tty = false } = {}) {
  let stdout = ''
  let stderr = ''
  const code = await main(['take', ...args], {
    cwd,
    env: env ?? fixture.env,
    stdin: Object.assign(Readable.from([]), { isTTY: tty }),
    stdout: { write: (chunk) => (stdout += chunk), isTTY: tty },
    stderr: { write: (chunk) => (stderr += chunk) },
    ghExecutor: fake.as(login),
  })
  return { code, stdout, stderr }
}

/**
 * A directory of programs for a run that may start an agent, and an environment whose PATH is
 * only that directory: fake `claude` and `codex` that record their directory and arguments, and
 * wrappers that run the real `git` and `cat` by their absolute paths.
 * @param {Fixture} fixture
 * @param {string} name
 * @param {{ claude?: boolean, codex?: boolean }} [options] Leave a fake agent out with false.
 */
export function agentBin(fixture, name, { claude = true, codex = true } = {}) {
  const bin = join(fixture.dir, `${name}-bin`)
  const log = join(fixture.dir, `${name}-agents`)
  mkdirSync(bin, { recursive: true })
  mkdirSync(log, { recursive: true })
  const script = (file, text) => {
    writeFileSync(join(bin, file), `#!/bin/sh\n${text}`)
    chmodSync(join(bin, file), 0o755)
  }
  for (const program of ['git', 'cat']) {
    const real = execFileSync('/bin/sh', ['-c', `command -v ${program}`], {
      encoding: 'utf8',
    }).trim()
    script(program, `exec '${real}' "$@"\n`)
  }
  for (const [agent, wanted] of /** @type {const} */ ([
    ['claude', claude],
    ['codex', codex],
  ])) {
    if (!wanted) continue
    const at = (suffix) => `'${join(log, `${agent}.${suffix}`)}'`
    script(
      agent,
      [
        `pwd -P > ${at('cwd')}`,
        `printf '%s' "$#" > ${at('argc')}`,
        'i=0',
        'for arg in "$@"; do',
        '  i=$((i + 1))',
        `  printf '%s' "$arg" > '${log}/${agent}.arg'$i`,
        'done',
        '',
      ].join('\n'),
    )
  }
  const read = (agent, suffix) => readFileSync(join(log, `${agent}.${suffix}`), 'utf8')
  return {
    env: { ...fixture.env, PATH: bin },
    /** @param {'claude' | 'codex'} agent */
    called: (agent) => existsSync(join(log, `${agent}.cwd`)),
    /**
     * The directory and arguments of the agent's last start.
     * @param {'claude' | 'codex'} agent
     */
    call(agent) {
      const count = Number(read(agent, 'argc'))
      const args = Array.from({ length: count }, (_, index) => read(agent, `arg${index + 1}`))
      return { cwd: read(agent, 'cwd').trimEnd(), args }
    },
    /** Forget the recorded starts. */
    reset() {
      rmSync(log, { recursive: true, force: true })
      mkdirSync(log, { recursive: true })
    },
  }
}

/**
 * Expect each text to occur in `text`, each after the one before.
 * @param {string} text
 * @param {string[]} parts
 */
export function expectInOrder(text, parts) {
  let at = -1
  for (const part of parts) {
    const next = text.indexOf(part, at + 1)
    expect(next, `"${part}" after position ${at}`).toBeGreaterThan(at)
    at = next
  }
}

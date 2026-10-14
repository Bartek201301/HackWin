// The install step of the generated workflow, run the way GitHub runs a step with `shell: bash`,
// in a checkout at the head commit of a pull request, with a stand-in `npm` that records its
// arguments instead of installing anything.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { exec, quoteShellArg } from '../../src/core/runtime/exec.js'
import { renderWorkflow } from '../../src/generate/index.js'

/**
 * The install step of the workflow that a version generates.
 * @param {string} version
 * @returns {{ name: string, shell: string, env: Record<string, string>, run: string }}
 */
export function installStep(version) {
  const workflow = parse(renderWorkflow({ version }))
  return workflow.jobs.hackwin.steps.find(
    (/** @type {{ name: string }} */ step) => step.name === 'Install the hackwin CLI',
  )
}

/**
 * Run the install step of the workflow.
 * @param {object} options
 * @param {string} options.version The version that generates the workflow.
 * @param {string} options.cwd A checkout at the head commit of the pull request.
 * @param {string} options.dir A new scratch directory for the script, the stand-in and its log.
 * @param {Record<string, string | undefined>} options.env
 * @param {string} [options.baseRef] The base branch of the pull request.
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string, npm: string[] }>}
 *   `npm` holds the arguments of each call of npm.
 */
export async function runInstallStep({ version, cwd, dir, env, baseRef = 'main' }) {
  const step = installStep(version)
  if (step.shell !== 'bash') throw new Error(`the install step runs in ${step.shell}, not bash`)
  mkdirSync(join(dir, 'bin'), { recursive: true })
  const log = join(dir, 'npm.log')
  writeFileSync(join(dir, 'bin', 'npm'), `#!/bin/sh\necho "$@" >> ${quoteShellArg(log)}\n`, {
    mode: 0o755,
  })
  writeFileSync(join(dir, 'install.sh'), step.run)
  // GitHub runs `shell: bash` as `bash --noprofile --norc -eo pipefail {0}`.
  const result = await exec(
    'bash',
    ['--noprofile', '--norc', '-eo', 'pipefail', join(dir, 'install.sh')],
    { cwd, env: { ...env, PATH: `${join(dir, 'bin')}:${env.PATH}`, BASE_REF: baseRef } },
  )
  const npm = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []
  return { code: result.code, stdout: result.stdout, stderr: result.stderr, npm }
}

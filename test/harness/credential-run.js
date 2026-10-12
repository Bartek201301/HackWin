// A run on a fixture repository for the test 1.3d/no-credential-output, as a child process: it
// uses the token of builder1 in every way a scenario does (gh calls, a failing gh call, a clone
// and a push over HTTPS) and prints one JSON line with what it did. The test searches this
// process's output and its run log for the token.
//
// Usage: node test/harness/credential-run.js <run log file>, with HACKWIN_TEST_BUILDER_TOKEN set.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { builderToken, captureCredential } from './accounts.js'
import { withFixtureRepo } from './fixture-repo.js'

captureCredential()
const [logFile] = process.argv.slice(2)
const BRANCH = 'hackwin-harness-credential-check'

const summary = await withFixtureRepo(
  'hackwin-fixture-a',
  async (repo) => {
    const lead = repo.github('lead')
    const builder = repo.github('builder1')
    const login = await builder.login()

    // A failing call as builder1, printed the way a failing test prints it.
    let failure = null
    try {
      await builder.api('repos/{owner}/{repo}/issues/999999999')
    } catch (error) {
      failure = error.message
      console.error(error.stack)
      console.error(JSON.stringify(error.toJSON?.() ?? {}))
    }

    // Git over HTTPS as builder1: the token goes to git's credential helper through GH_TOKEN.
    await deleteBranch(lead, BRANCH)
    const clone = await repo.clone('builder1')
    await clone.git.run(['checkout', '--quiet', '-b', BRANCH])
    writeFileSync(join(clone.path, 'credential-check.txt'), 'checked\n')
    await clone.git.run(['add', '--all'])
    await clone.git.run(['commit', '--quiet', '-m', 'Credential check (test harness)'])
    await clone.git.push({ refspecs: [`HEAD:refs/heads/${BRANCH}`] })
    const remote = await clone.git.run(['ls-remote', 'origin', `refs/heads/${BRANCH}`])
    const pushed = remote.stdout.trim().split(/\s+/)[0] === (await clone.git.revParse('HEAD'))
    await deleteBranch(lead, BRANCH)

    // Files the run wrote: git configs, the clone, gh's config directory of builder1.
    const token = /** @type {string} */ (builderToken())
    const files = listFiles(repo.tempDir)
    const filesWithToken = files.filter((file) => readFileSync(file).includes(token))
    return {
      builder1: login,
      pushed,
      failure,
      filesChecked: files.length,
      filesWithToken: filesWithToken.map((file) => file.slice(repo.tempDir.length + 1)),
      tempDir: repo.tempDir,
    }
  },
  { logFile },
)
console.log(JSON.stringify(summary))

/**
 * @param {import('../../src/core/github/index.js').GitHub} github
 * @param {string} branch
 */
async function deleteBranch(github, branch) {
  try {
    await github.api(`repos/{owner}/{repo}/git/refs/heads/${branch}`, { method: 'DELETE' })
  } catch (error) {
    if (![404, 422].includes(error.status)) throw error
  }
}

/**
 * Every file below a directory.
 * @param {string} dir
 * @returns {string[]}
 */
function listFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
}

// The CI workflow (6.4, 10.2): `.github/workflows/hackwin.yml`, one job named `hackwin` on every
// pull request event that opens a pull request or changes its head. It installs the CLI version
// pinned in hackwin.yml on the base branch, or the version the pull request names when it changes
// `cli_version` to a release of the same phase (20.6, A60), and runs `hackwin internal ci`, where
// all logic lives. A pull request that sets a version of another phase gets the base branch's
// version, whose `internal ci` fails it in step 1 [D10]. `internal ci` picks the version the same
// way and fails when another one runs it.

import { REPOSITORY_URL } from '../cli/context.js'
import { installCommand } from '../core/config/index.js'
import { generatedBy } from './header.js'

/** @import { GeneratedFileSpec, GenerateInput } from './manifest.js' */

/** The path of the workflow, relative to the repository root. */
export const WORKFLOW_PATH = '.github/workflows/hackwin.yml'

/** The job, and so the name of the check that branch rules require and the Gate waits for. */
export const CI_JOB = 'hackwin'

/** The pull request events that open a pull request or change its head. */
export const CI_EVENTS = Object.freeze(['opened', 'reopened', 'synchronize'])

/** The Node version of the job: the minimum that hackwin supports (A1). */
export const CI_NODE_VERSION = 22

/**
 * The install command of a version (contracts 6.3) with the version left to the shell variable
 * `$version`: the URL of the `.tgz` for a pre-release, the npm package otherwise.
 * @param {boolean} prerelease
 * @returns {string}
 */
function installTemplate(prerelease) {
  const sample = prerelease ? '0.0.0-sample.0' : '0.0.0'
  return installCommand(sample, REPOSITORY_URL).replaceAll(sample, '$version')
}

/**
 * The script of the install step. It reads `cli_version` of hackwin.yml on the base branch, at
 * the commit the pull request started from (its merge base) and on its head commit, picks the
 * version as 10.2 says and installs it. The pull request changes `cli_version` when its head
 * differs from its merge base, so a newer version on the base branch is not its change.
 * `$version` holds only the characters of a version, so it needs no quotes.
 * @returns {string[]}
 */
export function installScript() {
  return [
    'git fetch --no-tags --quiet origin "+refs/heads/$BASE_REF:refs/remotes/origin/$BASE_REF"',
    '# cli_version of hackwin.yml at a commit, or nothing',
    'pinned() {',
    String.raw`  git show "$1:hackwin.yml" 2>/dev/null | sed -n -E "s/^cli_version:[[:space:]]*[\"']?([0-9A-Za-z.+-]+)[\"']?[[:space:]]*(#.*)?\$/\1/p" | sed -n 1p || true`,
    '}',
    '# the phase of a version: its major and minor numbers',
    'phase() {',
    '  echo "$1" | cut -d. -f1,2',
    '}',
    'base=$(pinned "refs/remotes/origin/$BASE_REF")',
    'proposed=$(pinned HEAD)',
    'if [ -z "$base" ]; then',
    '  echo "hackwin.yml on $BASE_REF pins no cli_version" >&2',
    '  exit 1',
    'fi',
    'fork=$(git merge-base "refs/remotes/origin/$BASE_REF" HEAD || true)',
    'started=$base',
    'if [ -n "$fork" ]; then',
    '  started=$(pinned "$fork")',
    'fi',
    'version=$base',
    'if [ -n "$proposed" ] && [ "$proposed" != "$started" ] && [ "$(phase "$proposed")" = "$(phase "$base")" ]; then',
    '  version=$proposed',
    '  echo "this pull request sets cli_version to $version; installing hackwin $version"',
    'else',
    '  echo "hackwin.yml on $BASE_REF pins $version; installing hackwin $version"',
    'fi',
    'case "$(echo "$version" | cut -d+ -f1)" in',
    `  *-*) ${installTemplate(true)} ;;`,
    `  *) ${installTemplate(false)} ;;`,
    'esac',
  ]
}

/**
 * The workflow of a CLI version.
 * @param {GenerateInput} input
 * @returns {string}
 */
export function renderWorkflow({ version }) {
  return [
    `# ${generatedBy(version)}`,
    '#',
    '# The hackwin check. On every pull request event that opens a pull request or changes its',
    '# head, it installs the CLI version that hackwin.yml pins on the base branch, or the version',
    '# that the pull request itself sets as cli_version when that is a release of the same phase,',
    '# and runs `hackwin internal ci`: configuration, task link, scope of the author, secret scan,',
    '# generated files, merge with the current base branch, format check, the project check and',
    "# the task's acceptance tests.",
    'name: hackwin',
    '',
    'on:',
    '  pull_request:',
    `    types: [${CI_EVENTS.join(', ')}]`,
    '',
    'permissions:',
    '  contents: read',
    '  issues: read',
    '  pull-requests: read',
    '',
    'concurrency:',
    '  group: hackwin-${{ github.event.pull_request.number }}',
    '  cancel-in-progress: true',
    '',
    'jobs:',
    `  ${CI_JOB}:`,
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: Check out the head commit of the pull request',
    '        uses: actions/checkout@v7',
    '        with:',
    '          ref: ${{ github.event.pull_request.head.sha }}',
    '          fetch-depth: 0',
    '',
    '      - name: Set up Node.js',
    '        uses: actions/setup-node@v7',
    '        with:',
    `          node-version: ${CI_NODE_VERSION}`,
    '',
    '      - name: Install the hackwin CLI',
    '        shell: bash',
    '        env:',
    '          BASE_REF: ${{ github.event.pull_request.base.ref }}',
    '        run: |',
    ...installScript().map((line) => `          ${line}`),
    '',
    '      - name: Run the hackwin checks',
    '        env:',
    '          GH_TOKEN: ${{ github.token }}',
    '        run: hackwin internal ci',
    '',
  ].join('\n')
}

/** The entry of the workflow in the generated file manifest. */
export const WORKFLOW_FILE = Object.freeze(
  /** @type {GeneratedFileSpec} */ ({ path: WORKFLOW_PATH, mode: 0o644, render: renderWorkflow }),
)

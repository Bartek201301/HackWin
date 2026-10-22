import { describe, expect, test } from 'vitest'
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import semver from 'semver'
import { VERSION } from '../../../src/cli/context.js'
import { loadProposedConfig } from '../../../src/core/config/index.js'
import { createGitHub } from '../../../src/core/github/index.js'
import { undo } from '../../../src/commands/setup/regenerate.js'
import {
  MANIFEST,
  SETTINGS_PATH,
  denyRules,
  mergeClaudeSettings,
  planProjectFiles,
  renderAgentsBlock,
  staleGeneratedFiles,
  writeGeneratedFiles,
} from '../../../src/generate/index.js'
import {
  accounts,
  hackwinObject,
  nodeProjectFiles,
  ownersObject,
  yaml,
} from '../../harness/index.js'
import { LEAD, createSetupFixture, runHackwin, snapshot, writes } from './setup-fixture.js'

const running = /** @type {semver.SemVer} */ (semver.parse(VERSION))

/** A release of the phase of this CLI that is older than it, as before a bug fix release. */
const LOWER = `${running.major}.${running.minor}.0-0`

/** A release of the next phase. */
const OTHER_PHASE = `${running.major}.${running.minor + 1}.0`

/** The deny rules that this release adds to those of the release before it. */
const ADDED_RULES = [
  'Bash(gh api *pulls/*/merge)',
  'Bash(git push --all *)',
  'Bash(git push --branches *)',
  'Bash(git push --mirror *)',
  'Bash(git push *--all)',
  'Bash(git push *--branches)',
  'Bash(git push *--mirror)',
]

const INPUT = { defaultBranch: 'main', language: 'en' }

/** hackwin.yml of a team of three pinned to a version, with a comment of the Lead's. */
function hackwinText(version) {
  return `# Our project. The Lead keeps this comment.\n${yaml({ ...hackwinObject(3), cli_version: version })}`
}

/** AGENTS.md with the Lead's own lines around HackWin's block of an earlier release. */
const OLD_AGENTS = [
  '# Team rules',
  '',
  'Our own introduction.',
  '',
  '<!-- hackwin:begin -->',
  `The rules of hackwin ${LOWER}.`,
  '<!-- hackwin:end -->',
  '',
  'Our own rules after the block.',
  '',
].join('\n')

/** .claude/settings.json of the earlier release, with the Lead's own key and rule. */
function oldSettings() {
  const own = { model: 'opus', permissions: { deny: ['Bash(rm -rf /*)'] } }
  const settings = JSON.parse(mergeClaudeSettings(JSON.stringify(own), INPUT))
  settings.permissions.deny = settings.permissions.deny.filter(
    (/** @type {string} */ rule) => !ADDED_RULES.includes(rule),
  )
  return `${JSON.stringify(settings, null, 2)}\n`
}

/**
 * The body of a task issue of a role, in the format of 8.1.
 * @param {string} role
 * @param {string[]} paths
 */
function taskBody(role, paths) {
  const block = yaml({
    kind: 'task',
    role,
    wave: 1,
    paths,
    depends_on: [],
    acceptance_tests: ['test/release.test.js'],
    deadline: '2026-10-25T12:00:00+02:00',
  })
  return [
    '```yaml',
    '# hackwin:task',
    block.trimEnd(),
    '```',
    '',
    '## Problem',
    `hackwin ${VERSION} is a bug fix release.`,
  ].join('\n')
}

/**
 * A project configured with the release LOWER, as before the procedure of 20.6: main pins LOWER
 * and holds its generated files, HackWin's block of that release in AGENTS.md and its settings.
 * A task issue of `role` exists on the fake GitHub, written by the Lead, and its worktree is on
 * its task branch. Then the clone is joined, so its git hooks run.
 * @param {object} [options]
 * @param {string} [options.pinned] `cli_version` on main.
 * @param {string} [options.role] The role of the task.
 * @param {Record<string, string>} [options.branchFiles] A commit of these files on the task branch.
 * @param {Record<string, string>} [options.mainFiles] More files of the release's commit on main.
 */
async function createProject({
  pinned = LOWER,
  role = 'shared',
  branchFiles,
  mainFiles = {},
} = {}) {
  const setup = await createSetupFixture({
    nodeProject: false,
    config: { hackwin: hackwinText(pinned), owners: ownersObject() },
  })
  const { fixture, fake } = setup
  await writeGeneratedFiles(fixture.main, { version: pinned })
  const current = Object.fromEntries(
    planProjectFiles(() => null, INPUT).map((change) => [change.path, change.content]),
  )
  symlinkSync('AGENTS.md', join(fixture.main, 'CLAUDE.md'))
  await fixture.commit(`Files of hackwin ${pinned}`, {
    push: true,
    files: {
      'AGENTS.md': OLD_AGENTS,
      [SETTINGS_PATH]: oldSettings(),
      '.gitignore': /** @type {string} */ (current['.gitignore']),
      '.github/pull_request_template.md': /** @type {string} */ (
        current['.github/pull_request_template.md']
      ),
      ...mainFiles,
    },
  })
  const github = createGitHub({ executor: fake.as(LEAD), repo: fake.state.repo })
  const paths =
    role === 'shared'
      ? ['hackwin.yml', '.githooks/**', '.claude/**', '.github/**', 'AGENTS.md']
      : [`src/features/${role}/**`]
  const issue = await github.createIssue({ title: 'Bug fix release', body: taskBody(role, paths) })
  const worktree = await fixture.worktree({
    issue: issue.number,
    title: 'Bug fix release',
    files: branchFiles,
  })
  await fixture.join()
  return { ...setup, worktree }
}

/**
 * Run `hackwin setup --regenerate` in a directory, as the Lead unless another login is given.
 * @param {Awaited<ReturnType<typeof createProject>>} project
 * @param {{ cwd?: string, login?: string, args?: string[] }} [options]
 */
function regenerate(project, { cwd = project.worktree.path, login, args = [] } = {}) {
  return runHackwin(project.fixture, project.fake, ['setup', '--regenerate', ...args], {
    cwd,
    login,
  })
}

/**
 * The files a commit changed, without rename detection.
 * @param {import('../../../src/core/git/index.js').Git} git
 * @param {string} commit
 */
async function changedBy(git, commit) {
  const { stdout } = await git.run(['diff-tree', '--no-commit-id', '-r', '--name-only', commit])
  return stdout.split('\n').filter(Boolean).sort()
}

describe('1.4g/regenerate: setup --regenerate in a task worktree of the shared role', () => {
  test('rewrites exactly the generated files, HackWin blocks and cli_version, and commits them for ship', async () => {
    const project = await createProject()
    const { fixture, fake, worktree } = project
    const before = await worktree.git.revParse('HEAD')
    const mainBefore = await fixture.git.revParse('origin/main')
    const mainFiles = snapshot(fixture.main)

    const result = await regenerate(project)
    expect(result.stderr).toContain(`warning: `)
    expect(result.code).toBe(0)

    // One commit on the task branch, with exactly HackWin's files.
    const commit = await worktree.git.revParse('HEAD')
    expect(await worktree.git.revParse('HEAD~1')).toBe(before)
    expect(await changedBy(worktree.git, commit)).toEqual(
      [...MANIFEST.map((file) => file.path), 'AGENTS.md', SETTINGS_PATH, 'hackwin.yml'].sort(),
    )
    expect(await worktree.git.isClean()).toBe(true)
    expect(result.stdout).toContain(`committed as ${commit} on ${worktree.branch}`)
    expect(result.stdout).toContain(`cli_version ${LOWER} -> ${VERSION}`)
    expect(result.stdout).toContain(`run \`cd ${worktree.path} && hackwin ship\``)

    // The generated files are those of the running version.
    expect(await staleGeneratedFiles(worktree.path, { version: VERSION })).toEqual([])
    // hackwin.yml: only the value of cli_version changed, the Lead's comment stays.
    const pinned = hackwinText(LOWER)
    expect(pinned).toContain(`cli_version: ${LOWER}\n`)
    expect(readFileSync(join(worktree.path, 'hackwin.yml'), 'utf8')).toBe(
      pinned.replace(`cli_version: ${LOWER}\n`, `cli_version: ${VERSION}\n`),
    )
    const proposed = await loadProposedConfig(worktree.git)
    expect(proposed.hackwin.cli_version).toBe(VERSION)
    // AGENTS.md: HackWin's block replaced, the Lead's lines kept.
    expect(readFileSync(join(worktree.path, 'AGENTS.md'), 'utf8')).toBe(
      OLD_AGENTS.replace(
        /<!-- hackwin:begin -->[\s\S]*<!-- hackwin:end -->/,
        renderAgentsBlock(INPUT),
      ),
    )
    // The settings: the rules this release adds, after the Lead's own key and rule.
    const settings = JSON.parse(readFileSync(join(worktree.path, SETTINGS_PATH), 'utf8'))
    expect(settings.model).toBe('opus')
    expect(settings.permissions.deny[0]).toBe('Bash(rm -rf /*)')
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(denyRules(INPUT)))
    expect(settings.permissions.deny.slice(-ADDED_RULES.length)).toEqual(ADDED_RULES)
    // Files that hold no block, or do not exist, stay as they are: no document is created.
    expect(existsSync(join(worktree.path, '.github/ISSUE_TEMPLATE/hackwin-task.md'))).toBe(false)
    expect(existsSync(join(worktree.path, 'docs/hackwin/documents.md'))).toBe(false)
    expect(existsSync(join(worktree.path, '.env.example'))).toBe(false)

    // Nothing else changed: the main checkout, origin's main and GitHub.
    expect(snapshot(fixture.main)).toEqual(mainFiles)
    expect(await fixture.git.revParse('origin/main')).toBe(mainBefore)
    expect(writes(fake).filter((call) => !call.endpoint.endsWith('/issues'))).toEqual([])
  })

  test('with the documents of the Release 1 template it creates, changes and deletes no file under docs/hackwin/', async () => {
    const template = nodeProjectFiles()
    const documents = Object.fromEntries(
      Object.entries(template).filter(([path]) => path.startsWith('docs/hackwin/')),
    )
    expect(Object.keys(documents).sort()).toEqual(
      ['before-the-event', 'design', 'epics', 'manual-workflow', 'non-code', 'prd', 'spec'].map(
        (name) => `docs/hackwin/${name}.md`,
      ),
    )
    const project = await createProject({ mainFiles: documents })
    const { worktree } = project
    /** @param {Record<string, string>} files */
    const underDocs = (files) =>
      Object.fromEntries(Object.entries(files).filter(([path]) => path.startsWith('docs/')))
    const before = underDocs(snapshot(worktree.path))

    const result = await regenerate(project)
    expect(result.code).toBe(0)
    const changed = await changedBy(worktree.git, await worktree.git.revParse('HEAD'))
    expect(changed.length).toBeGreaterThan(0)
    expect(changed.filter((path) => path.startsWith('docs/'))).toEqual([])
    expect(underDocs(snapshot(worktree.path))).toEqual(before)
    expect(existsSync(join(worktree.path, 'docs/hackwin/documents.md'))).toBe(false)
    for (const [path, content] of Object.entries(documents)) {
      expect(readFileSync(join(worktree.path, path), 'utf8'), path).toBe(content)
    }
  })

  test('a second run finds nothing to change and makes no commit', async () => {
    const project = await createProject()
    expect((await regenerate(project)).code).toBe(0)
    const head = await project.worktree.git.revParse('HEAD')

    const again = await regenerate(project)
    expect(again.stderr).not.toContain('hackwin setup --regenerate:')
    expect(again.code).toBe(0)
    expect(again.stdout).toContain('nothing to regenerate or commit')
    expect(await project.worktree.git.revParse('HEAD')).toBe(head)
  })

  test('on the default branch it exits 2, names the procedure of 20.6 and changes nothing', async () => {
    const project = await createProject()
    const files = snapshot(project.fixture.main)
    const head = await project.fixture.git.revParse('HEAD')

    const result = await regenerate(project, { cwd: project.fixture.main })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain(`${project.fixture.main} is on the default branch main`)
    expect(result.stderr).toContain('(20.6)')
    expect(result.stderr).toContain(
      'writes a task of the shared role for the release, takes it, runs `hackwin setup --regenerate` in its worktree and ships it',
    )
    expect(result.stderr).toContain(`run \`cd ${project.fixture.main} && hackwin take <N>\``)
    expect(snapshot(project.fixture.main)).toEqual(files)
    expect(await project.fixture.git.revParse('HEAD')).toBe(head)
  })

  test('on a branch that is not a task branch it exits 2 and names the procedure', async () => {
    const project = await createProject()
    await project.worktree.git.run(['checkout', '--quiet', '-b', 'experiment'])
    const result = await regenerate(project)
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('is on the branch experiment, not in a task worktree')
    expect(result.stderr).toContain('(20.6)')
    expect(await project.worktree.git.isClean()).toBe(true)
  })

  test('in a task of another role, or as a member who does not hold the shared role, it exits 2 and writes nothing', async () => {
    const counter = await createProject({ role: 'counter' })
    const other = await regenerate(counter)
    expect(other.code).toBe(2)
    expect(other.stderr).toContain(
      `runs in a task of the shared role shared, and #${counter.worktree.issue} is a task of the role counter`,
    )
    expect(await counter.worktree.git.isClean()).toBe(true)

    const shared = await createProject()
    const builder = await regenerate(shared, { login: accounts.builder1.login })
    expect(builder.code).toBe(2)
    expect(builder.stderr).toContain(
      `rewrites files of the shared role shared, which ${accounts.builder1.login} does not hold`,
    )
    expect(await shared.worktree.git.isClean()).toBe(true)
  })

  test('with changes in the working tree it exits 2, names them and writes nothing', async () => {
    const project = await createProject()
    writeFileSync(join(project.worktree.path, 'notes.txt'), 'draft\n')
    const result = await regenerate(project)
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('has a change: notes.txt')
    expect(await staleGeneratedFiles(project.worktree.path, { version: LOWER })).toEqual([])
  })

  test('when the commit fails, every file is put back as the branch has it', async () => {
    const project = await createProject()
    const hooks = join(project.fixture.dir, 'refusing-hooks')
    mkdirSync(hooks)
    writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\necho refused >&2\nexit 1\n')
    chmodSync(join(hooks, 'pre-commit'), 0o755)
    await project.fixture.git.run(['config', 'core.hooksPath', hooks])
    const head = await project.worktree.git.revParse('HEAD')
    const files = snapshot(project.worktree.path)

    const result = await regenerate(project)
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('refused')
    expect(result.stderr).toContain(
      `setup --regenerate stopped and put back the files it wrote in ${project.worktree.path}`,
    )
    expect(await project.worktree.git.revParse('HEAD')).toBe(head)
    expect(await project.worktree.git.isClean()).toBe(true)
    expect(snapshot(project.worktree.path)).toEqual(files)
  })

  // Root writes a read-only file all the same, so the failure cannot be made there.
  test.skipIf(process.getuid?.() === 0)(
    'when a write fails, the error is reported and the files written before it are put back',
    async () => {
      const project = await createProject()
      // The second shim cannot be written; the first one is written before it.
      chmodSync(join(project.worktree.path, '.githooks/pre-push'), 0o555)
      const head = await project.worktree.git.revParse('HEAD')

      const result = await regenerate(project)
      expect(result.code).toBe(2)
      expect(result.stderr).toContain('EACCES')
      expect(result.stderr).toContain(
        `setup --regenerate stopped and put back the files it wrote in ${project.worktree.path}`,
      )
      expect(await project.worktree.git.revParse('HEAD')).toBe(head)
      expect(await project.worktree.git.isClean()).toBe(true)
      expect(await staleGeneratedFiles(project.worktree.path, { version: LOWER })).toEqual([])
    },
  )

  test('a failure while putting the files back is a warning, so the error that stopped it stays the one reported', async () => {
    /** @type {string[]} */
    const warnings = []
    const ctx = {
      git: {
        run: async () => {
          throw new Error('git status failed')
        },
      },
      out: { warn: (/** @type {string} */ text) => warnings.push(text) },
    }
    await expect(undo(/** @type {any} */ (ctx), { path: '/repo' }, [])).resolves.toBeUndefined()
    await expect(
      undo(/** @type {any} */ (ctx), { path: '/repo' }, ['hackwin.yml']),
    ).resolves.toBeUndefined()
    expect(warnings).toEqual([
      'setup --regenerate could not put back its files in /repo: git status failed; check `git status` there',
      'setup --regenerate could not put back its files in /repo: git status failed; check `git status` there',
    ])
  })

  test('on a repository that is not configured it exits 2 and names setup', async () => {
    const { fixture, fake } = await createSetupFixture({ nodeProject: false })
    const result = await runHackwin(fixture, fake, ['setup', '--regenerate'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('setup --regenerate runs on a configured repository')
    expect(await fixture.git.isClean()).toBe(true)
  })

  test('with --resume or --answers it exits 2', async () => {
    const project = await createProject()
    for (const args of [['--resume'], ['--answers', 'answers.yml']]) {
      const result = await regenerate(project, { args })
      expect(result.code, args[0]).toBe(2)
      expect(result.stderr).toContain('setup --regenerate takes neither --resume nor --answers')
    }
    expect(await project.worktree.git.isClean()).toBe(true)
  })
})

describe('AC77/regenerate: setup --regenerate run with a CLI of another phase exits 2', () => {
  test('when origin/main pins a release of another phase', async () => {
    const project = await createProject({ pinned: OTHER_PHASE })
    const head = await project.worktree.git.revParse('HEAD')
    const result = await regenerate(project)
    expect(result.code).toBe(2)
    expect(result.stderr).toContain(OTHER_PHASE)
    expect(result.stderr).toContain('npm install -g')
    expect(await project.worktree.git.revParse('HEAD')).toBe(head)
    expect(await staleGeneratedFiles(project.worktree.path, { version: OTHER_PHASE })).toEqual([])
  })

  test("when the task branch's own cli_version is of another phase", async () => {
    const project = await createProject({
      branchFiles: { 'hackwin.yml': hackwinText(OTHER_PHASE) },
    })
    const head = await project.worktree.git.revParse('HEAD')
    const result = await regenerate(project)
    expect(result.code).toBe(2)
    expect(result.stderr).toContain(`cli_version (${OTHER_PHASE}) is of phase`)
    expect(result.stderr).toContain('a project stays on the phase it started with [D10]')
    expect(await project.worktree.git.revParse('HEAD')).toBe(head)
    expect(await project.worktree.git.isClean()).toBe(true)
    expect(await staleGeneratedFiles(project.worktree.path, { version: LOWER })).toEqual([])
  })
})

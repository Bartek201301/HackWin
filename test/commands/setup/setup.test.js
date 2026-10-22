import { describe, expect, test } from 'vitest'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { VERSION } from '../../../src/cli/context.js'
import { loadConfig } from '../../../src/core/config/index.js'
import {
  CLAUDE_HOOKS,
  MANIFEST,
  PROJECT_FILES,
  SETTINGS_PATH,
  TEMPLATE_CHECK_WORKFLOW,
  TEMPLATE_CHECK_WORKFLOW_PATH,
  WORKFLOW_PATH,
  allowRules,
  denyRules,
  planProjectFiles,
  projectInput,
  renderTaskTemplate,
  staleGeneratedFiles,
} from '../../../src/generate/index.js'
import { COMMANDS } from '../../../src/cli/registry.js'
import { accounts, nodeProjectFiles, teamConfig } from '../../harness/index.js'
import {
  EVENT,
  LEAD,
  createSetupFixture,
  runSetup,
  snapshot,
  teamAnswers,
  writes,
} from './setup-fixture.js'

/** Every committed file of 6.4 for the commands of the registry. */
const COMMITTED_FILES = [
  'hackwin.yml',
  'owners.yml',
  ...MANIFEST.map((file) => file.path),
  SETTINGS_PATH,
  ...PROJECT_FILES.map((file) => file.path).filter((path) => path !== TEMPLATE_CHECK_WORKFLOW_PATH),
].sort()

/**
 * The files a commit changed, with their status, without rename detection.
 * @param {import('../../harness/index.js').Fixture} fixture
 * @param {string} commit
 */
async function filesOf(fixture, commit) {
  const { stdout } = await fixture.git.run([
    'diff-tree',
    '--root',
    '--no-commit-id',
    '-r',
    '--no-renames',
    '--name-status',
    commit,
  ])
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, path] = line.split('\t')
      return { status, path }
    })
}

/** @param {import('../../harness/index.js').Fixture} fixture */
async function originMain(fixture) {
  const { stdout } = await fixture.git.run(['ls-remote', fixture.origin, 'refs/heads/main'])
  return stdout.split(/\s+/)[0]
}

describe('1.4d/bootstrap: the bootstrap commit', () => {
  test('1.4d/bootstrap: holds every committed file of 6.4 for the commands of the registry and nothing else', async () => {
    const { fixture, fake } = await createSetupFixture({
      nodeProject: false,
      files: { 'README.md': '# App\n', 'package.json': '{ "name": "app" }\n' },
    })
    const before = await fixture.git.revParse('HEAD')
    const answers = teamAnswers(3, (a) => {
      a.roles = { shared: { shared: true, paths: [] }, counter: { paths: ['src/counter/**'] } }
      a.team.members[1].roles = ['counter']
      a.team.members.splice(2, 1)
      a.paths.contracts = []
    })
    const result = await runSetup(fixture, fake, { answers })
    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)

    const commit = await fixture.git.revParse('HEAD')
    expect(await fixture.git.revParse('HEAD~1')).toBe(before)
    expect(await originMain(fixture)).toBe(commit)
    const changed = await filesOf(fixture, commit)
    expect(changed.every((file) => file.status === 'A')).toBe(true)
    expect(changed.map((file) => file.path).sort()).toEqual(COMMITTED_FILES)
    expect(result.stdout).toContain(`bootstrap commit ${commit} pushed to origin/main`)
    expect(await fixture.git.isClean()).toBe(true)

    // One wrapper per command of the registry, the generated files as the generators render them.
    for (const { name } of COMMANDS) {
      expect(changed.map((file) => file.path)).toContain(`.claude/skills/${name}/SKILL.md`)
    }
    expect(await staleGeneratedFiles(fixture.main, { version: VERSION })).toEqual([])
    const config = await loadConfig(fixture.git)
    expect(config.hackwin.cli_version).toBe(VERSION)
    expect(config.hackwin.team.lead).toBe(LEAD)
    expect(config.hackwin.resolver.enabled).toBe(false)
    const settings = JSON.parse(readFileSync(join(fixture.main, SETTINGS_PATH), 'utf8'))
    expect(settings.permissions.deny).toEqual(denyRules({ defaultBranch: 'main' }))
    expect(Object.keys(settings.hooks)).toEqual(CLAUDE_HOOKS.map((hook) => hook.event))
    expect(readFileSync(join(fixture.main, '.env.example'), 'utf8')).toBe('')
    // On GitHub, steps 10 to 13 write labels, rule sets and the push protection setting only.
    expect(writes(fake).length).toBeGreaterThan(0)
    for (const call of writes(fake)) {
      expect(call.endpoint).toMatch(/^repos\/\{owner\}\/\{repo\}(\/labels|\/rulesets)?$/)
    }
  })

  test('1.4d/bootstrap: commits and pushes with the member hooks switched off', async () => {
    const { fixture, fake } = await createSetupFixture()
    // Hooks that refuse everything, as the hooks of 1.4a refuse a commit on main and a push to it.
    const hooks = join(fixture.dir, 'refusing-hooks')
    mkdirSync(hooks)
    for (const hook of ['pre-commit', 'commit-msg', 'pre-push']) {
      writeFileSync(join(hooks, hook), '#!/bin/sh\necho "refused by the hook" >&2\nexit 1\n')
      chmodSync(join(hooks, hook), 0o755)
    }
    await fixture.git.configSet('core.hooksPath', hooks)
    const result = await runSetup(fixture, fake, { answers: teamAnswers(3) })
    expect(result.stderr).not.toContain('refused')
    expect(result.code).toBe(0)
    expect(await originMain(fixture)).toBe(await fixture.git.revParse('HEAD'))
  })

  test('1.4d/bootstrap: in an empty repository the bootstrap commit is the first commit', async () => {
    const { fixture, fake } = await createSetupFixture({ nodeProject: false })
    // A new clone of a repository without commits.
    const bare = join(fixture.dir, 'empty.git')
    await fixture.git.run(['init', '--quiet', '--bare', bare])
    await fixture.git.run(['clone', '--quiet', bare, join(fixture.dir, 'empty')])
    const cwd = join(fixture.dir, 'empty')
    const answers = teamAnswers(1, (a) => {
      a.roles = { shared: { shared: true, paths: [] } }
      a.team.members[0].roles = ['shared']
      a.paths.contracts = []
    })
    const result = await runSetup(fixture, fake, { answers, cwd })
    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
    const git = fixture.gitAt(cwd)
    const commit = await git.revParse('HEAD')
    expect(await git.tryRevParse('HEAD~1')).toBeNull()
    const { stdout } = await git.run(['ls-tree', '-r', '--name-only', commit])
    expect(stdout.trim().split('\n').sort()).toEqual(COMMITTED_FILES)
  })
})

/** The terminal answers of a solo team on the Node fixture that accept every proposal. */
const SOLO_INPUT = [
  '1', // people
  '', // the Lead's login: the gh login
  'Solo', // the Lead's name
  '', // agent: claude
  '', // sessions: 2
  '', // keep the roles of owners.yml
  '', // the Lead holds every role
  '', // keep the detected commands
  '', // no smoke test
  '', // keep the path groups
  EVENT.start,
  EVENT.end,
  '', // project language: en
  '', // answer language of join: the project language
  '', // explanation style of join: concise
]

describe('AC3: setup proposes the stack commands of a Node project', () => {
  test('AC3: an answers file without commands gets the detected install, check, test and format commands', async () => {
    const { fixture, fake } = await createSetupFixture()
    const answers = teamAnswers(3, (a) => delete a.commands)
    const result = await runSetup(fixture, fake, { answers })
    expect(result.code).toBe(0)
    const { hackwin } = await loadConfig(fixture.git)
    expect(hackwin.commands).toEqual({
      install: 'npm ci',
      check: 'npm run check',
      test: 'npm test --',
      format: 'npm run format --',
      generate: null,
      lockfile_regen: 'npm install --package-lock-only',
      smoke: null,
    })
    expect(hackwin.paths.manifests).toEqual(['package.json'])
    expect(hackwin.paths.lockfiles).toEqual(['package-lock.json'])
  })

  test('AC3: in a terminal the Lead only confirms the detected commands', async () => {
    const { fixture, fake } = await createSetupFixture()
    const result = await runSetup(fixture, fake, { tty: true, input: SOLO_INPUT })
    expect(result.stderr).not.toContain('hackwin setup:')
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(
      'Stack commands, detected from package.json and package-lock.json (npm):',
    )
    for (const line of [
      'install: npm ci',
      'check: npm run check',
      'test: npm test --',
      'format: npm run format --',
    ]) {
      expect(result.stdout).toContain(`  ${line}\n`)
    }
    const { hackwin } = await loadConfig(fixture.git)
    expect(hackwin.commands.install).toBe('npm ci')
    expect(hackwin.commands.check).toBe('npm run check')
    expect(hackwin.commands.test).toBe('npm test --')
    expect(hackwin.commands.format).toBe('npm run format --')
    expect(hackwin.team.members).toEqual([
      {
        name: 'Solo',
        github: LEAD,
        roles: ['shared', 'counter', 'todos', 'greeting'],
        agent: 'claude',
        sessions: 2,
      },
    ])
    expect(hackwin.project.event).toEqual(EVENT)
  })
})

describe('AC4: setup refuses a team or a configuration that breaks the rules', () => {
  test('AC4: setup with 5 members exits 2 and changes nothing', async () => {
    const { fixture, fake } = await createSetupFixture()
    const before = snapshot(fixture.main)
    const answers = teamAnswers(4, (a) => {
      a.team.members.push({
        name: 'Five',
        github: 'someone-else',
        roles: ['greeting'],
        agent: 'claude',
        sessions: 1,
      })
    })
    const result = await runSetup(fixture, fake, { answers })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('team.members has 5 entries')
    expect(result.stderr).toContain('setup refuses more (A34)')
    expect(snapshot(fixture.main)).toEqual(before)
    expect(writes(fake)).toEqual([])
  })

  test('AC4: 5 people typed in a terminal exit 2', async () => {
    const { fixture, fake } = await createSetupFixture()
    const result = await runSetup(fixture, fake, { tty: true, input: ['5'] })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('setup refuses 5 (A34)')
  })

  test('AC4: a second setup on a configured repository exits 2: changes go through a pull request by the Lead', async () => {
    const team = teamConfig(3)
    const { fixture, fake } = await createSetupFixture({
      config: { hackwin: team.hackwin, owners: team.owners },
    })
    const before = await fixture.git.revParse('HEAD')
    const result = await runSetup(fixture, fake, { answers: teamAnswers(3) })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('this repository is configured already')
    expect(result.stderr).toContain('Configuration changes go through a pull request by the Lead')
    expect(await fixture.git.revParse('HEAD')).toBe(before)
    expect(writes(fake)).toEqual([])
  })

  test('AC4: an owners.yml with overlapping globs is rejected and names the key', async () => {
    const { fixture, fake } = await createSetupFixture({
      files: {
        'owners.yml':
          'schema: 1\nroles:\n  shared:\n    shared: true\n    paths: ["src/**"]\n  counter:\n    paths: ["src/features/counter/**"]\nopen: [README.md]\n',
      },
    })
    const answers = teamAnswers(3, (a) => {
      delete a.roles
      delete a.open
      a.team.members[1].roles = ['counter']
      a.team.members.splice(2, 1)
    })
    const result = await runSetup(fixture, fake, { answers })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain(
      'owners.yml: roles.counter.paths[0] (src/features/counter/**) overlaps roles.shared.paths[0]',
    )
    expect(result.stderr).toContain('key: roles.counter.paths[0]')
  })

  test('AC4: overlapping globs in the answers file are rejected and name the key', async () => {
    const { fixture, fake } = await createSetupFixture()
    const answers = teamAnswers(3, (a) => {
      a.roles.todos.paths = ['src/features/**']
    })
    const result = await runSetup(fixture, fake, { answers })
    expect(result.code).toBe(2)
    expect(result.stderr).toMatch(
      /the answers file .*answers\.yml: roles\.todos\.paths\[0\] \(src\/features\/\*\*\) overlaps/,
    )
  })

  test('AC4: a hackwin.yml on main that breaks a validation rule of 6.1 makes setup exit 2 and name the key', async () => {
    const team = teamConfig(3)
    team.hackwin.team.members[0].agent = 'codex'
    const { fixture, fake } = await createSetupFixture({
      config: { hackwin: team.hackwin, owners: team.owners },
    })
    const result = await runSetup(fixture, fake, { answers: teamAnswers(3) })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain(
      'hackwin.yml: team.members[0].agent must be claude for the Lead',
    )
    expect(result.stderr).toContain('key: team.members[0].agent')
  })
})

describe('AC6/files: a failed setup changes nothing; existing files are treated as 6.5 says', () => {
  test('AC6/files: a refused push leaves the checkout, origin and GitHub as they were', async () => {
    const { fixture, fake } = await createSetupFixture()
    const hook = join(fixture.origin, 'hooks', 'pre-receive')
    writeFileSync(hook, '#!/bin/sh\necho "push refused for the test" >&2\nexit 1\n')
    chmodSync(hook, 0o755)
    const head = await fixture.git.revParse('HEAD')
    const before = snapshot(fixture.main)
    const result = await runSetup(fixture, fake, { answers: teamAnswers(3) })
    expect(result.code).toBe(3)
    expect(result.stderr).toContain('push refused for the test')
    expect(await fixture.git.revParse('HEAD')).toBe(head)
    expect(await fixture.git.isClean()).toBe(true)
    expect(snapshot(fixture.main)).toEqual(before)
    expect(await originMain(fixture)).toBe(head)
    expect(writes(fake)).toEqual([])
  })

  test('AC6/files: a settings file that is not JSON stops setup before it writes anything', async () => {
    const { fixture, fake } = await createSetupFixture({
      files: { [SETTINGS_PATH]: '{ "permissions": ' },
    })
    const before = snapshot(fixture.main)
    const result = await runSetup(fixture, fake, { answers: teamAnswers(3) })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain(`${SETTINGS_PATH} is not valid JSON`)
    expect(snapshot(fixture.main)).toEqual(before)
    expect(existsSync(join(fixture.main, '.githooks'))).toBe(false)
    expect(existsSync(join(fixture.main, 'hackwin.yml'))).toBe(false)
    expect(await fixture.git.isClean()).toBe(true)
    expect(writes(fake)).toEqual([])
  })

  test('AC6/files: on a repository from the template, setup keeps the team lines and the documents, replaces its own blocks and the generated files, adds documents.md and using-hackwin.md and removes the unchanged check.yml', async () => {
    const template = nodeProjectFiles()
    const ownRule = '- Team rule: every component has a story.\n'
    const changedSkill = `${template['.claude/skills/research/SKILL.md']}\nOur own addition.\n`
    const changedPrd = '# Product requirements\n\nWritten by the team.\n'
    const { fixture, fake } = await createSetupFixture({
      files: {
        [TEMPLATE_CHECK_WORKFLOW_PATH]: TEMPLATE_CHECK_WORKFLOW,
        'AGENTS.md': `${template['AGENTS.md']}${ownRule}`,
        '.claude/skills/research/SKILL.md': changedSkill,
        'docs/hackwin/prd.md': changedPrd,
        // A stale wrapper of an earlier version, overwritten as a generated file.
        '.claude/skills/take/SKILL.md': 'old wrapper\n',
      },
    })
    const result = await runSetup(fixture, fake, { answers: teamAnswers(3) })
    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
    const commit = await fixture.git.revParse('HEAD')
    const changed = await filesOf(fixture, commit)
    const read = (/** @type {string} */ path) => readFileSync(join(fixture.main, path), 'utf8')
    const input = projectInput(await loadConfig(fixture.git))

    // The template's unchanged check.yml is removed; nothing outside 6.4 changes.
    expect(changed).toContainEqual({ status: 'D', path: TEMPLATE_CHECK_WORKFLOW_PATH })
    for (const { path } of changed) {
      expect([...COMMITTED_FILES, TEMPLATE_CHECK_WORKFLOW_PATH]).toContain(path)
    }

    // AGENTS.md: HackWin's block replaced, the team's lines kept.
    const agents = read('AGENTS.md')
    expect(
      agents.endsWith(
        `<!-- Project rules: add your own rules below this line, outside the hackwin block. -->\n${ownRule}`,
      ),
    ).toBe(true)
    expect(agents).toContain('run `hackwin ship` in the worktree of your task')
    expect(agents).toContain('GitHub shows every pull request as `BLOCKED`')
    expect(agents).toContain('The project language is English.')
    expect(agents).not.toContain('Only the Lead merges.')
    expect(agents.match(/hackwin:begin/g)).toHaveLength(1)

    // The task issue template: HackWin's block names the team's roles, the rest stays.
    const taskTemplate = '.github/ISSUE_TEMPLATE/hackwin-task.md'
    expect(changed).toContainEqual({ status: 'M', path: taskTemplate })
    expect(read(taskTemplate)).toBe(
      template[taskTemplate].replace(
        /<!-- hackwin:begin -->[\s\S]*<!-- hackwin:end -->/,
        () => renderTaskTemplate(input).block,
      ),
    )

    // Files whose block is already HackWin's and the research files stay.
    const unchanged = [
      'CLAUDE.md',
      '.github/pull_request_template.md',
      '.gitignore',
      '.env.example',
      '.claude/skills/research/SKILL.md',
      '.agents/skills/research/SKILL.md',
      '.claude/agents/research.md',
      'owners.yml',
    ]
    for (const path of unchanged) expect(changed.map((file) => file.path)).not.toContain(path)
    expect(read('.claude/skills/research/SKILL.md')).toBe(changedSkill)
    expect(read('owners.yml')).toBe(template['owners.yml'])

    // The documents and guides of the template stay byte for byte; the guides to the documents
    // and to the CLI are added.
    const documents = [
      'prd',
      'spec',
      'design',
      'epics',
      'non-code',
      'before-the-event',
      'manual-workflow',
    ].map((name) => `docs/hackwin/${name}.md`)
    for (const path of documents) {
      expect(changed.map((file) => file.path)).not.toContain(path)
      expect(read(path), path).toBe(path === 'docs/hackwin/prd.md' ? changedPrd : template[path])
    }
    for (const guide of ['docs/hackwin/documents.md', 'docs/hackwin/using-hackwin.md']) {
      expect(template[guide]).toBeUndefined()
      expect(changed).toContainEqual({ status: 'A', path: guide })
      expect(read(guide)).toBe(
        planProjectFiles(() => null, input).find((change) => change.path === guide)?.content,
      )
    }

    // The generated files are overwritten; the settings keep the template's rules and get the
    // allow list with the project's commands.
    expect(await staleGeneratedFiles(fixture.main, { version: VERSION })).toEqual([])
    const settings = JSON.parse(read(SETTINGS_PATH))
    expect(settings.permissions.deny.slice(0, 3)).toEqual(
      JSON.parse(template[SETTINGS_PATH]).permissions.deny,
    )
    expect(settings.permissions.allow).toEqual(allowRules(input))
    expect(settings.permissions.allow).toContain(`Bash(${input.commands.test} *)`)
    expect(Object.keys(settings.hooks)).toEqual(CLAUDE_HOOKS.map((hook) => hook.event))
    expect(changed).toContainEqual({ status: 'A', path: WORKFLOW_PATH })
  })

  test('AC6/files: a check.yml the team changed stays, with a notice', async () => {
    const { fixture, fake } = await createSetupFixture()
    const result = await runSetup(fixture, fake, { answers: teamAnswers(3) })
    expect(result.code).toBe(0)
    expect(result.stderr).toContain(
      `warning: ${TEMPLATE_CHECK_WORKFLOW_PATH} was changed by the team, so it stays; the hackwin job of ${WORKFLOW_PATH} now runs the project's check as well`,
    )
    expect(readFileSync(join(fixture.main, TEMPLATE_CHECK_WORKFLOW_PATH), 'utf8')).toBe(
      nodeProjectFiles()[TEMPLATE_CHECK_WORKFLOW_PATH],
    )
  })

  test('AC6/files: a broken hackwin block stops setup before it writes anything', async () => {
    const { fixture, fake } = await createSetupFixture({
      files: { 'CLAUDE.md': '<!-- hackwin:begin -->\n@AGENTS.md\n' },
    })
    const before = snapshot(fixture.main)
    const result = await runSetup(fixture, fake, { answers: teamAnswers(3) })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('CLAUDE.md holds a broken hackwin block')
    expect(snapshot(fixture.main)).toEqual(before)
  })
})

describe('AC76/setup: setup is run by the Lead, whose agent is Claude Code', () => {
  test('AC76/setup: setup under an account other than the one named as the Lead exits 2', async () => {
    const { fixture, fake } = await createSetupFixture()
    // builder1 may administer the repository, so that only the Lead's identity is wrong.
    fake.state.collaborators[accounts.builder1.login] = 'admin'
    const before = snapshot(fixture.main)
    const result = await runSetup(fixture, fake, {
      answers: teamAnswers(3),
      login: accounts.builder1.login,
    })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain(
      `the Lead is ${LEAD}, but gh is logged in as ${accounts.builder1.login}: setup must be run by the Lead`,
    )
    expect(snapshot(fixture.main)).toEqual(before)
    expect(writes(fake)).toEqual([])
  })

  test('AC76/setup: a Lead login typed in a terminal that is not the gh login exits 2', async () => {
    const { fixture, fake } = await createSetupFixture()
    const result = await runSetup(fixture, fake, {
      tty: true,
      input: ['3', accounts.builder1.login],
    })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain(
      `the Lead is ${accounts.builder1.login}, but gh is logged in as ${LEAD}`,
    )
  })

  test('AC76/setup: answers that give the Lead the agent codex exit 2 and name the reason', async () => {
    const { fixture, fake } = await createSetupFixture()
    const answers = teamAnswers(3, (a) => {
      a.team.members[0].agent = 'codex'
    })
    const result = await runSetup(fixture, fake, { answers })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('team.members[0].agent is codex')
    expect(result.stderr).toContain(
      "the Claude Code deny rule is the only block against a merge by the Lead's own sessions",
    )
    expect(result.stderr).toContain('key: team.members[0].agent')
    expect(writes(fake)).toEqual([])
  })

  test('AC76/setup: in a terminal, codex for the Lead is refused with the reason and asked again', async () => {
    const { fixture, fake } = await createSetupFixture()
    const input = [...SOLO_INPUT]
    input.splice(3, 1, 'codex', 'claude')
    const result = await runSetup(fixture, fake, { tty: true, input })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("setup refuses codex here: the Lead's agent must be claude")
    const { hackwin } = await loadConfig(fixture.git)
    expect(hackwin.team.members[0].agent).toBe('claude')
  })
})

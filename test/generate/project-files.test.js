import { describe, expect, test } from 'vitest'
import { parse } from 'yaml'
import { PreconditionError } from '../../src/core/runtime/errors.js'
import { parseHackwinConfig, parseOwners, validateConfig } from '../../src/core/config/index.js'
import { parseTaskBlock } from '../../src/core/tasks/index.js'
import {
  HASH_MARKERS,
  HTML_MARKERS,
  PROJECT_FILES,
  TEMPLATE_CHECK_WORKFLOW,
  TEMPLATE_CHECK_WORKFLOW_PATH,
  languageName,
  planBlockFiles,
  planProjectFiles,
  projectInput,
  renderAgentsBlock,
  renderHackwinConfig,
  renderOwners,
  renderTaskTemplate,
  withBlock,
  withCliVersion,
} from '../../src/generate/index.js'
import { nodeProjectFiles, teamConfig } from '../harness/index.js'

/** The input of a team of three on the roles of the Node fixture (shared, counter, todos, greeting). */
const TEAM = teamConfig(3)
const INPUT = projectInput(TEAM)

/** The files of the template, which the Node fixture holds unchanged except where noted. */
const TEMPLATE = nodeProjectFiles()

/** The template files that the Node fixture's project changed. */
const CHANGED_IN_FIXTURE = ['.gitignore', TEMPLATE_CHECK_WORKFLOW_PATH]

/** The guide to the documents, which Release 1 did not have (plan section 9, decision 12). */
const GUIDE = 'docs/hackwin/documents.md'

/**
 * The template file whose text changed since Release 1: it names the six documents, and its first
 * lines point to the guide to the CLI.
 */
const MANUAL_WORKFLOW = 'docs/hackwin/manual-workflow.md'

/** The guide to the CLI, which Release 1 did not have (#146). */
const USING = 'docs/hackwin/using-hackwin.md'

/** The task issue template, whose block is rendered from hackwin.yml and owners.yml (#146). */
const TASK_TEMPLATE = '.github/ISSUE_TEMPLATE/hackwin-task.md'

/** The paragraph under the title of the manual workflow that points to the guide to the CLI. */
const CLI_POINTER =
  'This is the method without the HackWin CLI. A team that uses the CLI follows `using-hackwin.md` instead, where `hackwin take` composes the prompt, `hackwin ship` opens the pull request and the Gate merges.'

/** The documents that the guide covers, in its order. */
const DOCUMENTS = ['prd.md', 'spec.md', 'architecture.md', 'design.md', 'epics.md', 'non-code.md']

/**
 * @param {Record<string, string>} files
 * @param {typeof INPUT} [input]
 */
function plan(files, input = INPUT) {
  return Object.fromEntries(
    planProjectFiles((path) => files[path] ?? null, input).map((change) => [change.path, change]),
  )
}

describe('1.4d/blocks: HackWin block in a team file', () => {
  const block = `${HTML_MARKERS.begin}\nnew\n${HTML_MARKERS.end}`
  const options = { block, whole: `${block}\n`, markers: HTML_MARKERS, path: 'AGENTS.md' }

  test('1.4d/blocks: a missing or empty file becomes the whole template', () => {
    expect(withBlock(null, options)).toBe(`${block}\n`)
    expect(withBlock('  \n', options)).toBe(`${block}\n`)
  })

  test('1.4d/blocks: an existing block is replaced and every other line kept', () => {
    const text = `# Ours\n\n${HTML_MARKERS.begin}\nold\nlines\n${HTML_MARKERS.end}\n\nmore of ours\n`
    expect(withBlock(text, options)).toBe(`# Ours\n\n${block}\n\nmore of ours\n`)
  })

  test('1.4d/blocks: a file without a block gets it after an empty line', () => {
    expect(withBlock('node_modules/\n\n\n', { ...options, markers: HASH_MARKERS })).toBe(
      `node_modules/\n\n${block}\n`,
    )
  })

  test('1.4d/blocks: a begin without an end, an end alone and two blocks are refused', () => {
    for (const text of [
      `${HTML_MARKERS.begin}\nx\n`,
      `x\n${HTML_MARKERS.end}\n`,
      `${block}\n${block}\n`,
    ]) {
      expect(() => withBlock(text, options)).toThrow(PreconditionError)
    }
  })

  test('1.4d/blocks: a marker inside a line is not a marker', () => {
    const text = `see ${HTML_MARKERS.begin} in the docs\n`
    expect(withBlock(text, options)).toBe(`${text}\n${block}\n`)
  })
})

describe('1.4d/files: the files of the template', () => {
  test('1.4d/files: the texts that did not change are those of Release 1 (the template in the Node fixture)', () => {
    const empty = plan({})
    for (const spec of PROJECT_FILES) {
      const path = spec.path
      if (path === TEMPLATE_CHECK_WORKFLOW_PATH || path === 'AGENTS.md') continue
      if (CHANGED_IN_FIXTURE.includes(path) || path === GUIDE || path === MANUAL_WORKFLOW) continue
      if (path === USING || path === TASK_TEMPLATE) continue
      expect(empty[path], path).toEqual({ path, action: 'write', content: TEMPLATE[path] })
    }
    // The manual workflow differs only in its steps on the documents and the foundation task,
    // and in the paragraph under its title that points to the guide to the CLI.
    const workflow = /** @type {string} */ (empty[MANUAL_WORKFLOW].content)
    const steps = /^(1\. \*\*Documents\.\*\*|2\. \*\*The foundation task\.\*\*) /
    /** @param {string} text */
    const others = (text) => text.split('\n').filter((line) => !steps.test(line))
    expect(others(workflow.replace(`${CLI_POINTER}\n\n`, ''))).toEqual(
      others(TEMPLATE[MANUAL_WORKFLOW]),
    )
    expect(workflow).not.toBe(TEMPLATE[MANUAL_WORKFLOW])
  })

  test('1.4d/files: on the template, the blocks of AGENTS.md and the task issue template change, documents.md and using-hackwin.md are added and every other file is kept', () => {
    const changes = plan(TEMPLATE)
    expect(
      Object.values(changes)
        .filter((change) => change.action !== 'keep')
        .map((change) => change.path),
    ).toEqual(['AGENTS.md', TASK_TEMPLATE, GUIDE, USING])
    expect(changes[GUIDE]).toEqual(plan({})[GUIDE])
    expect(changes[USING]).toEqual(plan({})[USING])
    expect(changes[TEMPLATE_CHECK_WORKFLOW_PATH].notice).toContain('was changed by the team')
  })

  test("1.4d/files: the template's unchanged check.yml is removed, also with other line endings", () => {
    expect(plan({ [TEMPLATE_CHECK_WORKFLOW_PATH]: TEMPLATE_CHECK_WORKFLOW })).toMatchObject({
      [TEMPLATE_CHECK_WORKFLOW_PATH]: { action: 'remove' },
    })
    const crlf = TEMPLATE_CHECK_WORKFLOW.replace(/\n/g, '\r\n')
    expect(
      plan({ [TEMPLATE_CHECK_WORKFLOW_PATH]: crlf })[TEMPLATE_CHECK_WORKFLOW_PATH].action,
    ).toBe('remove')
    expect(plan({})[TEMPLATE_CHECK_WORKFLOW_PATH]).toEqual({
      path: TEMPLATE_CHECK_WORKFLOW_PATH,
      action: 'keep',
    })
  })

  test('1.4d/files: an existing guide, research file or .env.example is kept as it is', () => {
    const files = {
      [GUIDE]: 'ours\n',
      [MANUAL_WORKFLOW]: 'ours\n',
      '.claude/agents/research.md': 'ours\n',
      '.env.example': 'API_KEY=\n',
    }
    const changes = plan(files)
    for (const path of Object.keys(files)) expect(changes[path]).toEqual({ path, action: 'keep' })
  })

  test('1.4d/files: the AGENTS.md block names the commands, the language, the branch and the BLOCKED state', () => {
    const block = renderAgentsBlock({ defaultBranch: 'trunk', language: 'pl' })
    expect(block.startsWith(HTML_MARKERS.begin)).toBe(true)
    expect(block.endsWith(HTML_MARKERS.end)).toBe(true)
    expect(block).toContain('The project language is Polish.')
    expect(block).toContain('`hackwin take [<issue>]`')
    expect(block).toContain('run `hackwin ship` in the worktree of your task')
    expect(block).toContain('Never push to `trunk`.')
    expect(block).toContain(
      "While the update restriction on `trunk` is active, GitHub shows every pull request as `BLOCKED`, the Lead's included. This is expected: the Gate merges it.",
    )
    expect(block).not.toMatch(/\{\{|`main`|origin\/main/)
    // It claims only the checks that exist, and binds the agent beyond them.
    expect(block).not.toContain('HackWin enforces these rules')
    expect(block).toContain("on `trunk` by GitHub's branch rules where GitHub offers them")
    expect(block).toContain('never reading `.env.local` in a Codex session, are checked by nothing')
    expect(block).toContain('Every rule binds you whether or not a check catches it.')
    // Every path has one role (A16); the Lead's planning session works in the main checkout (3.2).
    expect(block).toContain(
      '`owners.yml` gives every path exactly one ownership role: a path that no role names belongs to the shared role.',
    )
    expect(block).toContain("Only the Lead's planning session works in the main checkout.")
    expect(languageName('not a language')).toBe('not a language')
  })
})

/**
 * The parts of the guide to the documents: the text under each level 2 heading that names a file,
 * by that file. The example of `epics.md` holds a level 2 heading of its own and stays in its part.
 * @param {string} guide
 * @returns {Record<string, string>}
 */
function guideParts(guide) {
  /** @type {Record<string, string>} */
  const parts = {}
  for (const part of guide.split(/^## (?=`)/m).slice(1)) {
    parts[/** @type {string} */ (/^`([^`]+)`/.exec(part)?.[1])] = part
  }
  return parts
}

describe('1.4l/documents: one guide to six documents instead of the skeletons', () => {
  const empty = plan({})
  const guide = /** @type {string} */ (empty[GUIDE]?.content)
  const parts = guideParts(guide ?? '')

  test('1.4l/documents: on an empty repository, documents.md, before-the-event.md, manual-workflow.md and using-hackwin.md are the only files planned under docs/hackwin/', () => {
    const planned = Object.keys(empty).filter((path) => path.startsWith('docs/'))
    expect(planned.sort()).toEqual([
      'docs/hackwin/before-the-event.md',
      GUIDE,
      MANUAL_WORKFLOW,
      USING,
    ])
    for (const path of planned) expect(empty[path].action, path).toBe('write')
    expect(guide).toContain(
      '`setup` creates only this guide: the Lead or the planning session creates each document when they start writing it.',
    )
  })

  test('1.4l/documents: documents.md says of each of the six documents what it holds, why it matters, who writes it, when, and suggested headings', () => {
    expect(Object.keys(parts)).toEqual(DOCUMENTS)
    for (const name of DOCUMENTS) {
      for (const label of [
        '**What it holds.** ',
        '**Why it matters.** ',
        '**Who writes it.** The Lead',
        '**When.** ',
        '**Suggested headings.**',
      ]) {
        expect(parts[name], `${name}: ${label}`).toContain(label)
      }
    }
  })

  test('1.4l/documents: architecture.md holds what design.md held, and design.md is the visual design', () => {
    expect(parts['architecture.md']).toContain(
      'the architecture, the directory layout and ownership, and the contracts and mocks',
    )
    expect(parts['design.md']).toContain(
      'the colors, the fonts, the style of components, the tone of the text, and reference images or links',
    )
    expect(parts['design.md']).toContain(
      'The visual tokens (colors, fonts, sizes, spacing) go into shared code in the foundation task, so that every role uses the same ones.',
    )
    expect(parts['design.md']).toContain('A project without a user interface skips this file.')
  })

  test('1.4l/documents: what the skeletons said stays: the owner, the detailed points of contact, the format of epics.md and keys only in non-code.md', () => {
    expect(guide).toContain('**The Lead owns every document.**')
    expect(guide).toContain(
      'The points of contact must be detailed**: types, API, database schema and acceptance criteria.',
    )
    expect(parts['spec.md']).toContain(
      'The points of contact between the roles, in detail: types, API, database schema and acceptance criteria.',
    )
    expect(parts['spec.md']).toContain('Parallel work depends on it.')
    expect(parts['epics.md']).toContain(
      'One level 2 heading per epic, then a line `Role: <ownership role>`, then free text.',
    )
    expect(parts['epics.md']).toContain('## Epic name\nRole: workbench\n')
    expect(parts['epics.md']).toContain('Only the next wave becomes task issues')
    expect(parts['non-code.md']).toContain(
      'Name keys only: secret values go into `.env.local`, never into this file.',
    )
  })

  test('1.4l/documents: the manual workflow names the six documents and documents.md', () => {
    const workflow = /** @type {string} */ (empty[MANUAL_WORKFLOW].content)
    const step = workflow.split('\n').find((line) => line.startsWith('1. **Documents.**')) ?? ''
    for (const name of [...DOCUMENTS, 'documents.md']) expect(step).toContain(`\`${name}\``)
  })
})

describe('1.4d/links: symlinks among the team files', () => {
  /** @param {string} target */
  const link = (path, target, resolved = target) => ({ path, target, resolved })

  test('1.4d/links: a CLAUDE.md that links to AGENTS.md is kept', () => {
    const changes = planProjectFiles(
      (path) => (path === 'CLAUDE.md' ? TEMPLATE['AGENTS.md'] : null),
      INPUT,
      (path) => (path === 'CLAUDE.md' ? link('CLAUDE.md', 'AGENTS.md') : null),
    )
    expect(changes.find((change) => change.path === 'CLAUDE.md')).toEqual({
      path: 'CLAUDE.md',
      action: 'keep',
    })
  })

  test('1.4d/links: a file that would be written through another link is refused', () => {
    const linkOf = (/** @type {string} */ path) =>
      path === 'CLAUDE.md' ? link('CLAUDE.md', 'docs/ai.md') : null
    expect(() => planProjectFiles(() => null, INPUT, linkOf)).toThrow(
      'hackwin writes CLAUDE.md, but CLAUDE.md is a symbolic link to docs/ai.md',
    )
    const underDocs = (/** @type {string} */ path) =>
      path.startsWith('docs/') ? link('docs', '../shared-docs', null) : null
    expect(() => planProjectFiles(() => null, INPUT, underDocs)).toThrow(
      'docs/hackwin/before-the-event.md lies under docs, which is a symbolic link to ../shared-docs',
    )
  })

  test('1.4d/links: a kept file may be a link', () => {
    const linkOf = (/** @type {string} */ path) =>
      path === '.agents/skills/research/SKILL.md'
        ? link(
            path,
            '../../../.claude/skills/research/SKILL.md',
            '.claude/skills/research/SKILL.md',
          )
        : null
    const changes = planProjectFiles((path) => TEMPLATE[path] ?? null, INPUT, linkOf)
    expect(
      changes.find((change) => change.path === '.agents/skills/research/SKILL.md')?.action,
    ).toBe('keep')
  })
})

describe('1.4d/config-files: hackwin.yml and owners.yml', () => {
  test('1.4d/config-files: the rendered files parse back to the same configuration', () => {
    const team = teamConfig(4)
    const hackwin = parseHackwinConfig(renderHackwinConfig(/** @type {any} */ (team.hackwin)))
    const owners = parseOwners(renderOwners(/** @type {any} */ (team.owners)))
    expect(hackwin).toEqual(team.hackwin)
    expect(owners).toEqual(parseOwners(team.files['owners.yml']))
    expect(() => validateConfig(hackwin, owners)).not.toThrow()
  })

  test('1.4d/config-files: a long command stays on one line', () => {
    const team = teamConfig(1)
    team.hackwin.commands.check = `${'npm run lint && '.repeat(10)}npm test`
    const text = renderHackwinConfig(/** @type {any} */ (team.hackwin))
    expect(text).toContain(`check: ${team.hackwin.commands.check}\n`)
    expect(parse(text).commands.check).toBe(team.hackwin.commands.check)
  })
})

describe('1.4g/regenerate: what setup --regenerate rewrites in the kept files', () => {
  test("only the files with HackWin's block that exist are planned, and only their block changes", () => {
    const agents = `# Ours\n\n${HTML_MARKERS.begin}\nold rules\n${HTML_MARKERS.end}\n\nOurs too.\n`
    const files = {
      'AGENTS.md': agents,
      '.gitignore': 'node_modules/\n',
      '.env.example': 'API_URL=\n',
      'docs/hackwin/prd.md': '# Our PRD\n',
      [TEMPLATE_CHECK_WORKFLOW_PATH]: TEMPLATE_CHECK_WORKFLOW,
    }
    const changes = planBlockFiles((path) => files[path] ?? null, INPUT)
    expect(changes.map((change) => change.path)).toEqual(['AGENTS.md', '.gitignore'])
    expect(changes[0]).toEqual({
      path: 'AGENTS.md',
      action: 'write',
      content: `# Ours\n\n${renderAgentsBlock(INPUT)}\n\nOurs too.\n`,
    })
    expect(changes[1].content).toMatch(
      /^node_modules\/\n\n# hackwin:begin\n[\s\S]*# hackwin:end\n$/,
    )
  })

  test('no file under docs/hackwin/ is planned, on the Release 1 template or without documents', () => {
    for (const files of [TEMPLATE, {}]) {
      const changes = planBlockFiles((path) => files[path] ?? null, INPUT)
      expect(changes.filter((change) => change.path.startsWith('docs/'))).toEqual([])
    }
  })

  test('a current block is kept, and a write through a link is refused', () => {
    const current = Object.fromEntries(
      planProjectFiles(() => null, INPUT).map((change) => [change.path, change.content ?? null]),
    )
    const kept = planBlockFiles((path) => current[path] ?? null, INPUT)
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.every((change) => change.action === 'keep')).toBe(true)
    const linkOf = (/** @type {string} */ path) =>
      path === 'AGENTS.md' ? { path, target: '../rules.md', resolved: null } : null
    expect(() =>
      planBlockFiles((path) => (path === 'AGENTS.md' ? '# Ours\n' : null), INPUT, linkOf),
    ).toThrow('hackwin writes AGENTS.md, but AGENTS.md is a symbolic link to ../rules.md')
  })

  test('cli_version changes in place, in its quotes, and every other character stays', () => {
    const plain = '# Ours\nschema: 1\ncli_version: 0.1.0 # pinned\nproject:\n  language: en\n'
    expect(withCliVersion(plain, '0.1.1-pre.2')).toBe(
      '# Ours\nschema: 1\ncli_version: 0.1.1-pre.2 # pinned\nproject:\n  language: en\n',
    )
    expect(withCliVersion('cli_version: "0.1.0"\r\nschema: 1\r\n', '0.1.1')).toBe(
      'cli_version: "0.1.1"\r\nschema: 1\r\n',
    )
    expect(withCliVersion("cli_version: '0.1.0'\n", '0.1.1')).toBe("cli_version: '0.1.1'\n")
    const team = teamConfig(3)
    const rendered = renderHackwinConfig(/** @type {any} */ (team.hackwin))
    expect(parseHackwinConfig(withCliVersion(rendered, '0.1.9')).cli_version).toBe('0.1.9')
  })

  test('a hackwin.yml without a cli_version written as one value is a ConfigError on cli_version', () => {
    for (const text of [
      'schema: 1\n',
      'cli_version: [0.1.0]\n',
      'cli_version: |\n  0.1.0\n',
      ': [\n',
    ]) {
      expect(() => withCliVersion(text, '0.1.1'), text).toThrow(
        expect.objectContaining({ kind: 'config', key: 'cli_version' }),
      )
    }
  })
})

/**
 * The text of a file that `setup` plans on an empty repository.
 * @param {string} path
 * @param {typeof INPUT} [input]
 */
function planned(path, input = INPUT) {
  return /** @type {string} */ (plan({}, input)[path].content)
}

/** No em dash and no en dash in the texts that #146 changed. */
const DASHES = /[\u2013\u2014]/

describe('1.4n/guide: the guide to the CLI', () => {
  const guide = planned(USING)

  test('1.4n/guide: on an empty repository setup plans using-hackwin.md, and it keeps an existing one as it is', () => {
    expect(plan({})[USING]).toEqual({ path: USING, action: 'write', content: guide })
    expect(guide.startsWith('# Using HackWin\n')).toBe(true)
    expect(plan({ [USING]: 'ours\n' })[USING]).toEqual({ path: USING, action: 'keep' })
    expect(planBlockFiles(() => 'ours\n', INPUT).map((change) => change.path)).not.toContain(USING)
  })

  test('1.4n/guide: it covers the roles, the terminals, the loop, the Gate, status, refusals, writing a task and the permission mode', () => {
    const headings = guide.split('\n').filter((line) => line.startsWith('## '))
    expect(headings).toEqual([
      '## 1. Roles',
      '## 2. The terminals',
      '## 3. The loop',
      '## 4. The Gate, and why pull requests show BLOCKED',
      '## 5. `hackwin status`',
      '## 6. When HackWin refuses',
      '## 7. Writing a task',
      '## 8. Permission mode of the agent sessions',
    ])
    for (const text of [
      // The terminals each person keeps open.
      '| Lead | The planning session | The main checkout |',
      '| Lead | The Gate | The main checkout | `hackwin gate`, for the whole event.',
      '| Every member, the Lead included | One terminal per task, 1 or 2 at a time | Start in the main checkout |',
      // The loop: take with no number first, work, commit, ship.
      '1. **Take.** In the main checkout, run `hackwin take`. With no number it takes the next task of your roles',
      '2. **Work.**',
      '3. **Commit.**',
      '4. **Ship.** The session runs `hackwin ship` in the worktree.',
      // The Gate and BLOCKED.
      "GitHub shows every pull request as `BLOCKED`, the Lead's included. This is expected",
      // Refusals.
      'to resolve: run `cd <directory> && <command>`',
      '| The Gate fails your pull request (`gate:failed`',
      // A task, by hand or by the planning session.
      "**Ask the planning session.** Tell the Lead's planning session what the task must achieve",
      'Choose New issue, then the template "HackWin task"',
      // The permission mode, and why the hooks keep the sessions safe.
      '**Recommended for task sessions: auto mode, or bypass permissions.**',
      "**Why HackWin's hooks keep these sessions safe.**",
      'Claude Code applies deny rules and `PreToolUse` hook refusals in every permission mode, bypass permissions included, and no allow rule overrides them.',
    ]) {
      expect(guide, text).toContain(text)
    }
  })

  test('1.4n/guide: the texts that #146 changed hold no em dash and no en dash', () => {
    for (const text of [
      guide,
      planned(MANUAL_WORKFLOW),
      planned(TASK_TEMPLATE),
      renderAgentsBlock(INPUT),
    ]) {
      expect(text).not.toMatch(DASHES)
    }
  })
})

describe('1.4n/manual-workflow: the method by hand points to the guide to the CLI', () => {
  test('1.4n/manual-workflow: its first lines say that it is the method without the CLI and point to using-hackwin.md; the rest stays', () => {
    const workflow = planned(MANUAL_WORKFLOW)
    const lines = workflow.split('\n')
    expect(lines.slice(0, 3)).toEqual(['# The HackYeah method by hand', '', CLI_POINTER])
    expect(CLI_POINTER).toContain('the method without the HackWin CLI')
    expect(CLI_POINTER).toContain('`using-hackwin.md`')
    // Without the pointer, the text is the one that setup wrote before #146 (1.4d/files names
    // the two steps that differ from Release 1).
    const rest = workflow.replace(`${CLI_POINTER}\n\n`, '')
    expect(rest.startsWith('# The HackYeah method by hand\n\nThis guide runs the method')).toBe(
      true,
    )
    expect(rest.split('\n')).toHaveLength(lines.length - 2)
  })
})

describe('1.4n/agents-block: take with the issue number optional', () => {
  test("1.4n/agents-block: the AGENTS.md block shows hackwin take [<issue>] and says that without a number it takes the next task of the caller's roles", () => {
    const block = renderAgentsBlock(INPUT)
    expect(block).toContain(
      "- `hackwin take [<issue>]` creates the worktree of a task, on its own branch `task/<issue>-<slug>` from the current `origin/main`. The issue number is optional: without it, `hackwin take` takes the next task of the caller's roles. Work only in that worktree.",
    )
    expect(block).not.toContain('`hackwin take <issue>`')
  })
})

/**
 * An issue body made from the task issue template: GitHub drops the front matter, and the Lead
 * fills in the fields of the data block.
 * @param {string} template
 * @param {{ role: string, wave: number, paths: string[], depends_on: number[], acceptance_tests: string[] }} fields
 */
function filledBody(template, fields) {
  const list = (/** @type {string[]} */ items) => items.map((item) => `  - ${JSON.stringify(item)}`)
  const body = template
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/^role: {2,}#/m, `role: ${fields.role}  #`)
    .replace(/^wave: {2,}#/m, `wave: ${fields.wave}  #`)
    .replace(/^(paths: +#.*)\n {2}-\n/m, (_, line) => `${line}\n${list(fields.paths).join('\n')}\n`)
    .replace(/^depends_on: \[\]/m, `depends_on: ${JSON.stringify(fields.depends_on)}`)
    .replace(
      /^acceptance_tests:\n {2}- +(#.*)\n/m,
      (_, comment) =>
        `acceptance_tests:\n${list(fields.acceptance_tests).join('\n')}  ${comment}\n`,
    )
  expect(body).not.toBe(template)
  return body
}

/** The HTML comment of the template that holds the example task. */
const EXAMPLE = /<!--\nExample of a filled task for this team[\s\S]*?-->\n/

describe('1.4n/task-template: the task issue template knows the team', () => {
  const template = planned(TASK_TEMPLATE)
  const config = { hackwin: TEAM.hackwin, owners: TEAM.owners }

  test('1.4n/task-template: it names the roles and their paths, the event end as the deadline, one example in comments, and the planning session', () => {
    expect(template).toContain(
      '  - shared, the Lead\'s shared role: "src/shared/**", "docs/**", ".github/**", and every path that no other role names\n' +
        '  - counter: "src/features/counter/**"\n' +
        '  - todos: "src/features/todos/**"\n' +
        '  - greeting: "src/features/greeting/**"\n' +
        '  - open to every role: "README.md"\n',
    )
    expect(template).toContain(
      'role:                      # ownership role: shared, counter, todos or greeting\n',
    )
    expect(TEAM.hackwin.project.event.end).toBe('2026-10-25T15:00:00+02:00')
    expect(template).toContain(
      'deadline: "2026-10-25T15:00:00+02:00"   # ISO 8601 with offset; the end of the event by default\n',
    )
    expect(template).toContain(
      "The Lead's planning session can write the whole issue for you: tell it what the task must achieve, and it fills in this template and creates the issue with `gh issue create`.",
    )
    expect(template).toContain(
      'the test command of hackwin.yml, "npm test --", followed by the tests',
    )
    // The example sits in an HTML comment, as does the help, inside HackWin's block.
    const example = EXAMPLE.exec(template)?.[0] ?? ''
    expect(example).toContain(
      'kind: task\nrole: counter\nwave: 1\npaths:\n  - "src/features/counter/**"\n',
    )
    expect(example).toContain('deadline: "2026-10-25T15:00:00+02:00"\n')
    expect(example).not.toMatch(/```|~~~|# hackwin:task/)
    expect(template.indexOf(example)).toBeLessThan(template.indexOf(HTML_MARKERS.end))
    // The text outside the block, the front matter, is that of Release 1.
    const before = (/** @type {string} */ text) => text.slice(0, text.indexOf(HTML_MARKERS.begin))
    expect(before(template)).toBe(before(TEMPLATE[TASK_TEMPLATE]))
  })

  test('1.4n/task-template: a body made from the template gives parseTaskBlock exactly its fields, and the example adds no field and no error', () => {
    const fields = {
      role: 'todos',
      wave: 2,
      paths: ['src/features/todos/**', 'README.md'],
      depends_on: [7, 9],
      acceptance_tests: ['src/features/todos/list.test.js'],
    }
    const body = filledBody(template, fields)
    const expected = {
      isTask: true,
      valid: true,
      block: { kind: 'task', ...fields, deadline: TEAM.hackwin.project.event.end },
    }
    expect(parseTaskBlock(body, config)).toEqual(expected)
    expect(body).toMatch(EXAMPLE)
    expect(parseTaskBlock(body.replace(EXAMPLE, ''), config)).toEqual(expected)
    // The template as GitHub offers it, before the Lead fills it in, is a task with errors only
    // in the fields left empty.
    const empty = parseTaskBlock(template.replace(/^---\n[\s\S]*?\n---\n/, ''), config)
    expect(empty).toEqual({
      isTask: true,
      valid: false,
      errors: [
        'role is missing',
        'paths must be a list of non-empty strings',
        'acceptance_tests must be a list of non-empty strings',
      ],
    })
  })

  test('1.4n/task-template: the example is a valid task of this team, and stays inside its role in every team shape', () => {
    /** @param {string} text */
    const exampleBlock = (text) => {
      const lines = (EXAMPLE.exec(text)?.[0] ?? '').split('\n')
      const from = lines.indexOf('kind: task')
      const to = lines.findIndex((line) => line.startsWith('deadline: '))
      return ['```yaml', '# hackwin:task', ...lines.slice(from, to + 1), '```'].join('\n')
    }
    expect(parseTaskBlock(exampleBlock(template), config)).toMatchObject({
      valid: true,
      block: {
        role: 'counter',
        paths: ['src/features/counter/**'],
        acceptance_tests: ['src/features/counter/first-version.test.js'],
      },
    })
    // A solo team whose only role has a file and a directory: the test file lies in the directory.
    const solo = {
      hackwin: TEAM.hackwin,
      owners: {
        schema: 1,
        roles: { core: { shared: true, paths: ['README.md', 'lib/**'] } },
        open: [],
      },
    }
    const soloTemplate = renderTaskTemplate(projectInput(solo)).whole
    expect(parseTaskBlock(exampleBlock(soloTemplate), solo)).toMatchObject({
      valid: true,
      block: { role: 'core', paths: ['lib/**'], acceptance_tests: ['lib/first-version.test.js'] },
    })
    expect(soloTemplate).toContain('# ownership role: core\n')
    expect(soloTemplate).not.toContain('open to every role')
  })

  test('1.4n/task-template: a value of owners.yml cannot end a comment or the block', () => {
    const owners = {
      schema: 1,
      roles: {
        shared: { shared: true, paths: [] },
        web: { paths: ['web-->x/**', 'a\n<!-- hackwin:end -->/**'] },
      },
      open: [],
    }
    const { whole } = renderTaskTemplate({ ...INPUT, owners })
    // The comments end where the template's own comments end: no value adds a `-->`.
    const ends = (/** @type {string} */ text) => text.split('-->').length
    expect(ends(whole)).toBe(ends(renderTaskTemplate(INPUT).whole))
    expect(whole.match(/^<!-- hackwin:end -->$/gm)).toHaveLength(1)
    expect(whole).toContain(
      "  - shared, the Lead's shared role: every path that no other role names\n",
    )
  })

  test('1.4n/task-template: setup --regenerate writes the block from the current hackwin.yml and owners.yml, and keeps the rest of the file', () => {
    const release1 = TEMPLATE[TASK_TEMPLATE]
    const ours = `${release1}\nOur own note after the block.\n`
    const read = (/** @type {string} */ path) => (path === TASK_TEMPLATE ? ours : null)
    const [change] = planBlockFiles(read, INPUT).filter((entry) => entry.path === TASK_TEMPLATE)
    expect(change).toEqual({
      path: TASK_TEMPLATE,
      action: 'write',
      content: withBlock(ours, {
        block: renderTaskTemplate(INPUT).block,
        whole: template,
        markers: HTML_MARKERS,
        path: TASK_TEMPLATE,
      }),
    })
    expect(change.content).toContain('\nOur own note after the block.\n')
    // A changed hackwin.yml and owners.yml change the block.
    const changed = structuredClone(config)
    changed.hackwin.project.event.end = '2026-10-26T12:00:00+01:00'
    changed.owners.roles.payments = { paths: ['src/features/payments/**'] }
    const again = planBlockFiles(
      (path) => (path === TASK_TEMPLATE ? /** @type {string} */ (change.content) : null),
      projectInput(changed),
    ).find((entry) => entry.path === TASK_TEMPLATE)
    expect(again?.action).toBe('write')
    expect(again?.content).toContain('deadline: "2026-10-26T12:00:00+01:00"')
    expect(again?.content).toContain('  - payments: "src/features/payments/**"\n')
    expect(again?.content).toContain('\nOur own note after the block.\n')
  })
})

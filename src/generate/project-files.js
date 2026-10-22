// The committed files of 6.4 that belong to the team or the Lead, as opposed to the generated
// files of the manifest: `AGENTS.md`, `CLAUDE.md`, the pull request and task issue templates,
// `.gitignore` and `.env.example`, the guides under `docs/hackwin/`, the research skill and
// subagent, and the template's own CI workflow. `setup` treats an existing copy as 6.5 says: it
// adds or replaces only its own block, creates a missing guide, keeps the research files, and
// removes the template's `check.yml` when the team has not changed it. The texts are those of
// Release 1 (the hackwin-template repository, 20.1), kept under `templates/`; the `hackwin` block
// of `AGENTS.md` names the commands of Phase 1, which the template's does not (A59). In place of
// Release 1's five document skeletons, `setup` creates the guide `documents.md` to six documents,
// which the Lead creates when writing them, and `manual-workflow.md` names them (plan section 9,
// decision 12). A project's own documents are never created, changed or removed.
//
// For a team that uses the CLI, `setup` also creates the guide `using-hackwin.md`, and
// `manual-workflow.md` points to it (#146). The block of the task issue template is rendered from
// hackwin.yml and owners.yml: the team's roles and their paths, the test command, the event end
// as the default deadline, and one filled example task in an HTML comment. The data block's
// format and the parser of 8.1 stay as they are: the example has no fenced block, so
// `parseTaskBlock` never reads it.

import { readFileSync } from 'node:fs'
import { createMatcher } from '../core/config/index.js'
import { HASH_MARKERS, HTML_MARKERS, blockOf, withBlock } from './blocks.js'
import { linkError } from './links.js'

/** @import { HackwinConfig, Owners } from '../core/config/index.js' */
/** @import { ProjectCommands, SettingsInput } from './claude-settings.js' */
/** @import { Link } from './links.js' */

/**
 * What the files are rendered from.
 * @typedef {object} ProjectInput
 * @property {string} defaultBranch `project.default_branch` of hackwin.yml.
 * @property {string} language `project.language` of hackwin.yml (A37).
 * @property {string} eventEnd `project.event.end` of hackwin.yml: the default deadline of a task.
 * @property {Owners} owners owners.yml: the roles, their paths and the open list.
 * @property {Pick<ProjectCommands, 'test'>} commands `commands` of hackwin.yml.
 */

/**
 * What `setup` renders the team's files and the Claude Code settings from.
 * @param {{ hackwin: HackwinConfig, owners: Owners }} config
 * @returns {ProjectInput & SettingsInput}
 */
export function projectInput({ hackwin, owners }) {
  return {
    defaultBranch: hackwin.project.default_branch,
    language: hackwin.project.language,
    eventEnd: hackwin.project.event.end,
    owners,
    commands: hackwin.commands,
  }
}

/**
 * What `setup` does with one file. `write` and `remove` change the checkout; `keep` leaves the
 * file as it is.
 * @typedef {object} ProjectFileChange
 * @property {string} path Relative to the repository root.
 * @property {'write' | 'remove' | 'keep'} action
 * @property {string} [content] The new text, for `write`.
 * @property {string} [notice] A line for the Lead, for a file kept with a reason.
 */

/**
 * @typedef {object} ProjectFileSpec
 * @property {string} path
 * @property {(existing: string | null, input: ProjectInput, link: Link | null) => ProjectFileChange} plan
 *   `link` is the symlink on the way to the file, or null.
 * @property {boolean} [block] True for a file that holds HackWin's block.
 */

/**
 * @param {string} name A file under templates/.
 * @returns {string}
 */
function template(name) {
  return readFileSync(new URL(`./templates/${name}`, import.meta.url), 'utf8')
}

/** The template's own CI workflow, which the `hackwin` workflow replaces (6.5, 20.1). */
export const TEMPLATE_CHECK_WORKFLOW_PATH = '.github/workflows/check.yml'

/** The template's `check.yml` as Release 1 ships it. */
export const TEMPLATE_CHECK_WORKFLOW = template('check-workflow.yml')

/** The comment under the block of a new `AGENTS.md`, as in the template. */
const PROJECT_RULES_LINE =
  '<!-- Project rules: add your own rules below this line, outside the hackwin block. -->'

/**
 * The `hackwin` block of `AGENTS.md`: the rules of 6.4 with the commands of Phase 1, the
 * project language and the default branch.
 * @param {Pick<ProjectInput, 'defaultBranch' | 'language'>} input
 * @returns {string}
 */
export function renderAgentsBlock({ defaultBranch, language }) {
  if (!defaultBranch) throw new TypeError('the AGENTS.md block needs the default branch')
  return template('agents-block.md')
    .replaceAll('{{language}}', languageName(language))
    .replaceAll('{{branch}}', defaultBranch)
    .replace(/\n$/, '')
}

/**
 * The `hackwin` block of the task issue template and the whole file of a new project (8.1, I2):
 * the data block with the event end as its deadline, the roles of owners.yml and their paths,
 * and one filled example task of this team, in HTML comments.
 * @param {Pick<ProjectInput, 'eventEnd' | 'owners' | 'commands'>} input
 * @returns {{ block: string, whole: string }}
 */
export function renderTaskTemplate({ eventEnd, owners, commands }) {
  if (!eventEnd) throw new TypeError('the task issue template needs the event end')
  const names = Object.keys(owners.roles)
  /** @type {Record<string, string>} */
  const values = {
    role_names:
      names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`,
    roles: roleLines(owners).join('\n'),
    test: inComment(commands.test),
    deadline: JSON.stringify(eventEnd),
    example: exampleTask({ eventEnd, owners }).join('\n'),
  }
  const whole = template('task-issue-template.md').replace(
    /\{\{(\w+)\}\}/g,
    (_, key) => values[key],
  )
  return { block: blockOf(whole, HTML_MARKERS), whole }
}

/**
 * The roles of owners.yml with their paths, and the open list, one line each.
 * @param {Owners} owners
 * @returns {string[]}
 */
function roleLines({ roles, open }) {
  const lines = Object.entries(roles).map(([name, role]) => {
    const paths = role.paths.map(inComment)
    if (role.shared) {
      const rest = 'every path that no other role names'
      return `  - ${name}, the Lead's shared role: ${paths.length === 0 ? rest : `${paths.join(', ')}, and ${rest}`}`
    }
    return `  - ${name}: ${paths.length === 0 ? 'no paths yet' : paths.join(', ')}`
  })
  if (open.length > 0) lines.push(`  - open to every role: ${open.map(inComment).join(', ')}`)
  return lines
}

/**
 * A filled task of this team: a role other than the shared one where there is one, a glob of the
 * role, and a test file inside that glob, so that the example stays inside the role.
 * @param {Pick<ProjectInput, 'eventEnd' | 'owners'>} input
 * @returns {string[]}
 */
function exampleTask({ eventEnd, owners }) {
  const names = Object.keys(owners.roles)
  const shared = names.filter((name) => owners.roles[name].shared)
  const choices = [...names.filter((name) => !owners.roles[name].shared), ...shared].flatMap(
    (role) =>
      owners.roles[role].paths.map((glob) => ({
        role,
        glob,
        test: `${literalDirectory(glob)}first-version.test.js`,
      })),
  )
  // Without any glob in owners.yml, every path belongs to the shared role (A16).
  const fallback = { role: shared[0], glob: '**', test: 'first-version.test.js' }
  const { role, glob, test } =
    choices.find((choice) => createMatcher([choice.glob])(choice.test)) ?? choices[0] ?? fallback
  return [
    `Title: ${role}: a first working version`,
    '',
    'kind: task',
    `role: ${role}`,
    'wave: 1',
    'paths:',
    `  - ${inComment(glob)}`,
    'depends_on: []',
    'acceptance_tests:',
    `  - ${inComment(test)}`,
    `deadline: ${JSON.stringify(eventEnd)}`,
    '',
    '## Problem',
    `The ${role} part does not work yet, so the demo cannot show it.`,
    '',
    '## Expected result',
    `A first working version of the ${role} part, built against the types and the mocks of the contracts in docs/hackwin/spec.md.`,
    '',
    '## Acceptance criteria',
    `- ${inComment(test)}: the ${role} part works with the mock data.`,
    '',
    '## Out of scope',
    'Every path outside the paths above, and the contracts.',
  ]
}

/**
 * The directories at the start of a glob that hold no wildcard, each with its `/`: `src/app/`
 * for `src/app/**`, nothing for `README.md`.
 * @param {string} glob
 * @returns {string}
 */
function literalDirectory(glob) {
  const segments = glob.split('/')
  const wildcard = segments.findIndex((segment) => /[*?{\\]/.test(segment))
  const end = wildcard === -1 ? segments.length - 1 : wildcard
  return segments
    .slice(0, end)
    .map((segment) => `${segment}/`)
    .join('')
}

/**
 * A value of hackwin.yml or owners.yml inside an HTML comment: quoted as in YAML, so that a line
 * break stays one line, and without `-->`, which would end the comment.
 * @param {string} value
 * @returns {string}
 */
function inComment(value) {
  return JSON.stringify(value).replaceAll('-->', '--\\u003e')
}

/**
 * The English name of a language code such as `en` or `pt-BR`, or the text itself when it is
 * not a known code.
 * @param {string} language
 * @returns {string}
 */
export function languageName(language) {
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' }).of(language)
    return name ?? language
  } catch {
    return language
  }
}

/**
 * A file with HackWin's block (6.5).
 * @param {string} path
 * @param {import('./blocks.js').Markers} markers
 * @param {(input: ProjectInput) => { block: string, whole: string }} render
 * @returns {ProjectFileSpec}
 */
function blockFile(path, markers, render) {
  return {
    path,
    block: true,
    plan(existing, input) {
      const content = withBlock(existing, { ...render(input), markers, path })
      return content === existing ? { path, action: 'keep' } : { path, action: 'write', content }
    },
  }
}

/**
 * A file that is created when missing and otherwise kept as it is (6.5).
 * @param {string} path
 * @param {string} content
 * @returns {ProjectFileSpec}
 */
function missingFile(path, content) {
  return {
    path,
    plan: (existing) =>
      existing === null ? { path, action: 'write', content } : { path, action: 'keep' },
  }
}

/**
 * A template whose whole text is the file of a new project.
 * @param {string} name
 * @param {import('./blocks.js').Markers} markers
 */
function wholeTemplate(name, markers) {
  const whole = template(name)
  return () => ({ block: blockOf(whole, markers), whole })
}

/**
 * `CLAUDE.md`, which imports `AGENTS.md`. A `CLAUDE.md` that is a symlink to `AGENTS.md` gives
 * Claude Code the same rules and stays as it is.
 * @returns {ProjectFileSpec}
 */
function claudeFile() {
  const spec = blockFile('CLAUDE.md', HTML_MARKERS, () => {
    const block = [HTML_MARKERS.begin, '@AGENTS.md', HTML_MARKERS.end].join('\n')
    return { block, whole: `${block}\n` }
  })
  return {
    path: spec.path,
    block: true,
    plan: (existing, input, link) =>
      link?.path === spec.path && link.resolved === 'AGENTS.md'
        ? { path: spec.path, action: 'keep' }
        : spec.plan(existing, input, link),
  }
}

const RESEARCH_SKILL = template('research-skill.md')

/** The files of this module, in the order `setup` writes them. */
export const PROJECT_FILES = Object.freeze(
  /** @type {ProjectFileSpec[]} */ ([
    blockFile('AGENTS.md', HTML_MARKERS, (input) => {
      const block = renderAgentsBlock(input)
      return { block, whole: `${block}\n\n${PROJECT_RULES_LINE}\n` }
    }),
    claudeFile(),
    blockFile(
      '.github/pull_request_template.md',
      HTML_MARKERS,
      wholeTemplate('pull-request-template.md', HTML_MARKERS),
    ),
    blockFile('.github/ISSUE_TEMPLATE/hackwin-task.md', HTML_MARKERS, renderTaskTemplate),
    blockFile('.gitignore', HASH_MARKERS, () => {
      const block = [
        HASH_MARKERS.begin,
        'CLAUDE.local.md',
        '.env.local',
        '.env.*.local',
        'hackwin-report.md',
        'hackwin-report.json',
        HASH_MARKERS.end,
      ].join('\n')
      return { block, whole: `${block}\n` }
    }),
    missingFile('.env.example', ''),
    ...['before-the-event', 'manual-workflow', 'documents', 'using-hackwin'].map((name) =>
      missingFile(`docs/hackwin/${name}.md`, template(`${name}.md`)),
    ),
    missingFile('.claude/skills/research/SKILL.md', RESEARCH_SKILL),
    missingFile('.agents/skills/research/SKILL.md', RESEARCH_SKILL),
    missingFile('.claude/agents/research.md', template('research-agent.md')),
    {
      path: TEMPLATE_CHECK_WORKFLOW_PATH,
      plan(existing) {
        const path = TEMPLATE_CHECK_WORKFLOW_PATH
        if (existing === null) return { path, action: 'keep' }
        if (normalize(existing) === normalize(TEMPLATE_CHECK_WORKFLOW)) {
          return { path, action: 'remove' }
        }
        return {
          path,
          action: 'keep',
          notice: `${path} was changed by the team, so it stays; the hackwin job of .github/workflows/hackwin.yml now runs the project's check as well`,
        }
      },
    },
  ]),
)

/**
 * What `setup` does with each file of PROJECT_FILES in a checkout. A file that would be written or
 * removed through a symlink is refused before anything changes.
 * @param {(path: string) => string | null} read The text of a file of the checkout, or null.
 * @param {ProjectInput} input
 * @param {(path: string) => Link | null} [linkOf] The symlink on the way to a file, or null.
 * @returns {ProjectFileChange[]}
 */
export function planProjectFiles(read, input, linkOf = () => null) {
  return PROJECT_FILES.map((spec) => {
    const link = linkOf(spec.path)
    const change = spec.plan(read(spec.path), input, link)
    if (change.action !== 'keep' && link !== null) throw linkError(spec.path, link)
    return change
  })
}

/**
 * What `setup --regenerate` does with the files of PROJECT_FILES that hold HackWin's block: in each
 * one that exists, the block is replaced, or added when the file has none (6.5). A missing file
 * stays missing, and the guides, the research files and the template's CI workflow are not
 * touched: only the block is HackWin's.
 * @param {(path: string) => string | null} read The text of a file of the checkout, or null.
 * @param {ProjectInput} input
 * @param {(path: string) => Link | null} [linkOf] The symlink on the way to a file, or null.
 * @returns {ProjectFileChange[]} One change for each block file that exists.
 */
export function planBlockFiles(read, input, linkOf = () => null) {
  return PROJECT_FILES.flatMap((spec) => {
    if (!spec.block) return []
    const existing = read(spec.path)
    if (existing === null) return []
    const link = linkOf(spec.path)
    const change = spec.plan(existing, input, link)
    if (change.action !== 'keep' && link !== null) throw linkError(spec.path, link)
    return [change]
  })
}

/**
 * Line endings and trailing white space do not make a file changed.
 * @param {string} text
 * @returns {string}
 */
function normalize(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trimEnd()
}

// The committed files of 6.4 that belong to the team or the Lead, as opposed to the generated
// files of the manifest: `AGENTS.md`, `CLAUDE.md`, the pull request and task issue templates,
// `.gitignore` and `.env.example`, the documents under `docs/hackwin/`, the research skill and
// subagent, and the template's own CI workflow. `setup` treats an existing copy as 6.5 says: it
// adds or replaces only its own block, creates a missing document, keeps the research files, and
// removes the template's `check.yml` when the team has not changed it. The texts are those of
// Release 1 (the hackwin-template repository, 20.1), kept under `templates/`; the `hackwin` block
// of `AGENTS.md` names the commands of Phase 1, which the template's does not (A59).

import { readFileSync } from 'node:fs'
import { HASH_MARKERS, HTML_MARKERS, blockOf, withBlock } from './blocks.js'
import { linkError } from './links.js'

/** @import { Link } from './links.js' */

/**
 * What the files are rendered from.
 * @typedef {object} ProjectInput
 * @property {string} defaultBranch `project.default_branch` of hackwin.yml.
 * @property {string} language `project.language` of hackwin.yml (A37).
 */

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
 * @param {ProjectInput} input
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
    blockFile(
      '.github/ISSUE_TEMPLATE/hackwin-task.md',
      HTML_MARKERS,
      wholeTemplate('task-issue-template.md', HTML_MARKERS),
    ),
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
    ...['before-the-event', 'manual-workflow', 'prd', 'spec', 'design', 'epics', 'non-code'].map(
      (name) => missingFile(`docs/hackwin/${name}.md`, template(`${name}.md`)),
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
 * stays missing, and the documents, the research files and the template's CI workflow are not
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

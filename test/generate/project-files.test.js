import { describe, expect, test } from 'vitest'
import { parse } from 'yaml'
import { PreconditionError } from '../../src/core/runtime/errors.js'
import { parseHackwinConfig, parseOwners, validateConfig } from '../../src/core/config/index.js'
import {
  HASH_MARKERS,
  HTML_MARKERS,
  PROJECT_FILES,
  TEMPLATE_CHECK_WORKFLOW,
  TEMPLATE_CHECK_WORKFLOW_PATH,
  languageName,
  planProjectFiles,
  renderAgentsBlock,
  renderHackwinConfig,
  renderOwners,
  withBlock,
} from '../../src/generate/index.js'
import { nodeProjectFiles, teamConfig } from '../harness/index.js'

const INPUT = { defaultBranch: 'main', language: 'en' }

/** The files of the template, which the Node fixture holds unchanged except where noted. */
const TEMPLATE = nodeProjectFiles()

/** The template files that the Node fixture's project changed. */
const CHANGED_IN_FIXTURE = ['.gitignore', TEMPLATE_CHECK_WORKFLOW_PATH]

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
  test('1.4d/files: the texts are those of Release 1 (the template in the Node fixture)', () => {
    const empty = plan({})
    for (const spec of PROJECT_FILES) {
      const path = spec.path
      if (path === TEMPLATE_CHECK_WORKFLOW_PATH || path === 'AGENTS.md') continue
      if (CHANGED_IN_FIXTURE.includes(path)) continue
      expect(empty[path], path).toEqual({ path, action: 'write', content: TEMPLATE[path] })
    }
  })

  test('1.4d/files: on the template, only the AGENTS.md block changes', () => {
    const changes = plan(TEMPLATE)
    expect(
      Object.values(changes)
        .filter((change) => change.action !== 'keep')
        .map((change) => change.path),
    ).toEqual(['AGENTS.md'])
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

  test('1.4d/files: an existing document, research file or .env.example is kept as it is', () => {
    const files = {
      'docs/hackwin/spec.md': 'ours\n',
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
    expect(block).toContain('`hackwin take <issue>`')
    expect(block).toContain('run `hackwin ship` in the worktree of your task')
    expect(block).toContain('Never push to `trunk`.')
    expect(block).toContain(
      "While the update restriction on `trunk` is active, GitHub shows every pull request as `BLOCKED`, the Lead's included. This is expected: the Gate merges it.",
    )
    expect(block).not.toMatch(/\{\{|`main`|origin\/main/)
    expect(languageName('not a language')).toBe('not a language')
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

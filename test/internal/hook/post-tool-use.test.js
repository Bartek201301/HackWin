import { describe, expect, test } from 'vitest'
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { quoteShellArg } from '../../../src/core/runtime/exec.js'
import { teamConfig } from '../../harness/index.js'
import { afterEdit, preToolUse, runClaudeHook } from './claude-fixture.js'
import { createHookFixture, writeFiles } from './hook-fixture.js'

// The project's formatter: removes trailing spaces from the files it is given, and records each
// call, one line of arguments, in the file named by FORMAT_LOG. A file that contains BROKEN makes
// it fail.
const FORMAT_TOOL = `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
const files = process.argv.slice(2)
appendFileSync(process.env.FORMAT_LOG, files.join(' ') + '\\n')
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  if (text.includes('BROKEN')) {
    console.error(file + ': cannot parse BROKEN')
    process.exit(2)
  }
  writeFileSync(file, text.replace(/[ \\t]+$/gm, ''))
}
`

const UNFORMATTED = 'export const step = 1   \nexport const next = 2\t\n'
const FORMATTED = 'export const step = 1\nexport const next = 2\n'

async function formatScene() {
  const config = teamConfig(3)
  config.hackwin.commands.format = `${quoteShellArg(process.execPath)} tools/format.mjs`
  const hooks = await createHookFixture({
    config: { hackwin: config.hackwin, owners: config.owners },
    files: { 'README.md': '# Fixture\n', 'tools/format.mjs': FORMAT_TOOL },
  })
  const clone = await hooks.joinedClone('builder1')
  const task = await hooks.taskWorktree(clone, 12, 'Counter step')
  const log = join(hooks.fixture.dir, 'format.log')
  const env = { ...hooks.env, FORMAT_LOG: log }
  /** @param {unknown} event */
  const run = (event) => runClaudeHook('post-tool-use', { cwd: task.path, env, event })
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [])
  return { hooks, clone, task, run, calls }
}

describe('AC55: the PostToolUse hook in a Claude Code session', () => {
  test('after an edit only the edited file is reformatted', async () => {
    const { task, run, calls } = await formatScene()
    writeFiles(task.path, {
      'src/features/counter/step.js': UNFORMATTED,
      'src/features/counter/other.js': UNFORMATTED,
    })

    const result = await run(
      afterEdit(task.path, 'Edit', join(task.path, 'src/features/counter/step.js')),
    )

    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' })
    expect(readFileSync(join(task.path, 'src/features/counter/step.js'), 'utf8')).toBe(FORMATTED)
    expect(readFileSync(join(task.path, 'src/features/counter/other.js'), 'utf8')).toBe(UNFORMATTED)
    expect(calls()).toEqual(['src/features/counter/step.js'])
  })
})

describe('1.4c/post-tool-use: what the hook formats', () => {
  test('a written file is formatted in the checkout that holds it, whichever directory the session is in', async () => {
    const { clone, task, run, calls } = await formatScene()
    writeFiles(clone.path, { 'docs/notes.md': 'Notes   \n' })

    await run(afterEdit(task.path, 'Write', join(clone.path, 'docs/notes.md')))

    expect(readFileSync(join(clone.path, 'docs/notes.md'), 'utf8')).toBe('Notes\n')
    expect(calls()).toEqual(['docs/notes.md'])
  })

  test('a file outside the checkouts, an ignored file, a deleted file and other tools are left alone', async () => {
    const { hooks, clone, task, run, calls } = await formatScene()
    appendFileSync(join(clone.commonDir, 'info', 'exclude'), 'scratch/\n')
    writeFiles(task.path, { 'scratch/notes.md': 'x   \n', 'src/features/counter/gone.js': 'x\n' })
    writeFiles(hooks.fixture.dir, { 'elsewhere/notes.md': 'x   \n' })
    rmSync(join(task.path, 'src/features/counter/gone.js'))

    for (const event of [
      afterEdit(task.path, 'Write', join(task.path, 'scratch/notes.md')),
      afterEdit(task.path, 'Write', join(hooks.fixture.dir, 'elsewhere/notes.md')),
      afterEdit(task.path, 'Edit', join(task.path, 'src/features/counter/gone.js')),
      {
        ...preToolUse(task.path, 'Read', { file_path: join(task.path, 'README.md') }),
        hook_event_name: 'PostToolUse',
      },
    ]) {
      expect(await run(event)).toMatchObject({ code: 0, stdout: '' })
    }
    expect(calls()).toEqual([])
    expect(readFileSync(join(task.path, 'scratch/notes.md'), 'utf8')).toBe('x   \n')
  })

  test('when the formatter fails, the session gets its output, and the file stays as the edit left it', async () => {
    const { task, run } = await formatScene()
    writeFiles(task.path, { 'src/features/counter/step.js': 'BROKEN   \n' })

    const result = await run(
      afterEdit(task.path, 'Edit', join(task.path, 'src/features/counter/step.js')),
    )

    expect(result.code).toBe(0)
    expect(result.output.decision).toBe('block')
    expect(result.output.reason).toContain(
      `hackwin: src/features/counter/step.js is not formatted: \`${quoteShellArg(process.execPath)} tools/format.mjs src/features/counter/step.js\` in ${task.path} exited 2.`,
    )
    expect(result.output.reason).toContain('src/features/counter/step.js: cannot parse BROKEN')
    expect(readFileSync(join(task.path, 'src/features/counter/step.js'), 'utf8')).toBe(
      'BROKEN   \n',
    )
  })
})

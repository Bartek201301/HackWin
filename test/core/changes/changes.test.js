import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createGit } from '../../../src/core/git/index.js'
import { changesOnMain } from '../../../src/core/changes/index.js'
import { createRepoWithOrigin } from '../git/temp-repo.js'

/** @type {ReturnType<typeof createRepoWithOrigin>} */
let repo
/** @type {import('../../../src/core/git/index.js').Git} */
let git
/** A second clone that pushes to main, as the Gate's merges do. */
let other = ''

beforeEach(() => {
  repo = createRepoWithOrigin()
  git = createGit({ cwd: repo.clone, env: repo.env })
  other = join(repo.dir, 'other')
  repo.git(repo.dir, 'clone', '--quiet', repo.origin, other)
})

afterEach(() => repo.cleanup())

/**
 * Change files on main from the other clone and push. A null text deletes the file.
 * @param {Record<string, string | null>} files
 */
function pushToMain(files) {
  for (const [path, text] of Object.entries(files)) {
    if (text === null) repo.git(other, 'rm', '--quiet', path)
    else repo.write(join(other, path), text)
  }
  repo.git(other, 'add', '-A')
  repo.git(other, 'commit', '--quiet', '-m', 'merge a task')
  repo.git(other, 'push', '--quiet', 'origin', 'main')
  return repo.git(other, 'rev-parse', 'HEAD').trim()
}

describe('1.3c/changes: what changed on main since the recorded commit (E5, I6)', () => {
  test('the changed files are listed with the caller own scope first', async () => {
    pushToMain({ 'docs/guide.md': 'guide\n', 'src/features/workbench/old.ts': 'old\n' })
    const recorded = repo.git(other, 'rev-parse', 'HEAD').trim()
    pushToMain({
      'README.md': 'readme, edited\n',
      'src/app/main.ts': 'main\n',
      'src/features/workbench/panel.ts': 'panel\n',
      'src/features/detection/model.ts': 'model\n',
      'docs/guide.md': null,
    })
    const head = pushToMain({ 'src/features/workbench/table.ts': 'table\n' })
    await git.fetch()

    const result = await changesOnMain(git, {
      from: recorded,
      ownPaths: ['src/features/workbench/**'],
    })
    expect(result.from).toBe(recorded)
    expect(result.to).toBe(head)
    expect(result.files).toEqual([
      { path: 'src/features/workbench/panel.ts', status: 'A', oldPath: null, own: true },
      { path: 'src/features/workbench/table.ts', status: 'A', oldPath: null, own: true },
      { path: 'README.md', status: 'M', oldPath: null, own: false },
      { path: 'docs/guide.md', status: 'D', oldPath: null, own: false },
      { path: 'src/app/main.ts', status: 'A', oldPath: null, own: false },
      { path: 'src/features/detection/model.ts', status: 'A', oldPath: null, own: false },
    ])
  })

  test('a file renamed out of the caller scope still counts as their own', async () => {
    pushToMain({ 'src/features/workbench/panel.ts': 'export const panel = "a long enough line"\n' })
    const recorded = repo.git(other, 'rev-parse', 'HEAD').trim()
    mkdirSync(join(other, 'src/shared'))
    repo.git(other, 'mv', 'src/features/workbench/panel.ts', 'src/shared/panel.ts')
    repo.git(other, 'commit', '--quiet', '-m', 'move the panel')
    repo.git(other, 'push', '--quiet', 'origin', 'main')
    await git.fetch()

    const result = await changesOnMain(git, {
      from: recorded,
      ownPaths: ['src/features/workbench/**'],
    })
    expect(result.files).toEqual([
      {
        path: 'src/shared/panel.ts',
        status: 'R',
        oldPath: 'src/features/workbench/panel.ts',
        own: true,
      },
    ])
  })

  test('without a recorded commit the list is empty and from stays null', async () => {
    const head = pushToMain({ 'a.txt': 'a\n' })
    await git.fetch()
    expect(await changesOnMain(git, { from: null })).toEqual({ from: null, to: head, files: [] })
    expect(await changesOnMain(git)).toEqual({ from: null, to: head, files: [] })
    // A recorded commit that this clone does not have counts as no record.
    expect(await changesOnMain(git, { from: 'c'.repeat(40) })).toEqual({
      from: null,
      to: head,
      files: [],
    })
  })

  test('nothing changed since the recorded commit gives an empty list', async () => {
    const head = repo.git(repo.clone, 'rev-parse', 'origin/main').trim()
    expect(await changesOnMain(git, { from: head, ownPaths: ['**'] })).toEqual({
      from: head,
      to: head,
      files: [],
    })
  })
})

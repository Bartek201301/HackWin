import { afterEach, describe, expect, test } from 'vitest'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseGateMarker } from '../../../src/commands/gate/comment.js'
import { parseDigestLine } from '../../../src/commands/gate/digest.js'
import { BUILDER1, BUILDER2, LEAD, createScene, task } from './scene.js'

/** @typedef {import('./scene.js').Scene} Scene */

/** @type {Scene[]} */
let scenes = []

afterEach(async () => {
  await Promise.all(scenes.map((scene) => scene.cleanup()))
  scenes = []
})

/**
 * Programs named like the model CLIs, first on PATH, that leave a file when they run.
 * @param {Scene} s
 * @returns {string} The file a run leaves.
 */
function modelTraps(s) {
  const bin = join(s.fixture.dir, 'model-bin')
  const marker = join(s.fixture.dir, 'model-called')
  mkdirSync(bin, { recursive: true })
  for (const name of ['claude', 'codex']) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> '${marker}'\n`)
    chmodSync(join(bin, name), 0o755)
  }
  s.fixture.env.PATH = `${bin}:${s.fixture.env.PATH}`
  return marker
}

/**
 * Open a pull request and merge it with a merge commit, as the Gate does.
 * @param {Scene} s
 * @param {{ branch: string, author: string, issue: number, files: Record<string, string> }} pull
 */
async function mergedPull(s, { branch, author, issue, files }) {
  await s.push(branch, { files })
  const pr = await s.openPull({ branch, author, task: issue })
  await s.as(LEAD).api(`repos/{owner}/{repo}/pulls/${pr}/merge`, {
    method: 'PUT',
    body: { merge_method: 'merge' },
  })
  return pr
}

describe('AC42: before Phase 3 every conflict at stage 6 goes back to the author', () => {
  test('a conflict in any file gets gate:failed, needs-owner and the script generated comment, and no model is called', async () => {
    const s = await scene({
      issues: [task(60, 'counter'), task(62, 'greeting'), task(64, 'counter')],
      files: { 'src/features/counter/count.js': 'export const count = 0\n' },
    })
    const branch = 'task/64-counter-start'
    const head = await s.push(branch, {
      files: {
        'src/features/counter/count.js': 'export const count = 2\n',
        'README.md': '# Fixture of the counter\n',
      },
    })
    const counter = await mergedPull(s, {
      branch: 'task/60-counter-one',
      author: BUILDER1,
      issue: 60,
      files: { 'src/features/counter/count.js': 'export const count = 1\n' },
    })
    const readme = await mergedPull(s, {
      branch: 'task/62-greeting-readme',
      author: BUILDER2,
      issue: 62,
      files: { 'README.md': '# Fixture with a greeting\n' },
    })
    const pr = await s.openPull({ branch, author: BUILDER1, task: 64 })
    const marker = modelTraps(s)
    await s.start()

    await s.ended(pr, 'needs-owner')
    expect(
      s.labels(pr).filter((label) => label.startsWith('gate:') || label === 'needs-owner'),
    ).toEqual(expect.arrayContaining(['gate:failed', 'needs-owner']))
    expect(s.labels(pr)).not.toContain('gate:testing')
    const comments = s.comments(pr)
    expect(comments).toHaveLength(1)
    const [comment] = comments
    expect(parseGateMarker(comment.body)).toEqual({
      pr,
      sha: head,
      stage: 'conflicts',
      result: 'needs-owner',
    })
    expect(comment.body).toContain('failed at stage 6, conflicts')
    expect(comment.body).toContain('conflicts with main')
    expect(comment.body).toContain(`- \`README.md\`: changed by #${readme}`)
    expect(comment.body).toContain(`- \`src/features/counter/count.js\`: changed by #${counter}`)
    expect(comment.body).toContain('`hackwin take 64` in your main checkout of the repository')
    expect(existsSync(marker)).toBe(false)

    const lines = s.digest().map(parseDigestLine)
    expect(lines).toEqual([
      expect.objectContaining({
        pr,
        author: BUILDER1,
        result: 'needs-owner',
        stage: 'conflicts',
        note: 'conflict in 2 files',
      }),
    ])
    expect(s.out).toMatch(
      new RegExp(
        `^\\d\\d:\\d\\d #${pr} ${BUILDER1} needs-owner stage=conflicts \\d+s conflict in 2 files$`,
        'm',
      ),
    )
    await s.quit()
    expect(s.state()).toMatchObject({ queue: [] })
    expect(s.state().prs[String(pr)]).toMatchObject({
      stage: 'conflicts',
      result: 'needs-owner',
      failures: [expect.objectContaining({ stage: 'conflicts', sha: head })],
    })
    expect(s.state().attention).toEqual([])
  })
})

/** @param {Parameters<typeof createScene>[0]} [options] */
async function scene(options) {
  const created = await createScene(options)
  scenes.push(created)
  return created
}

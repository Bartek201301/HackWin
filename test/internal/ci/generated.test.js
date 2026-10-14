import { describe, expect, test } from 'vitest'
import { VERSION } from '../../../src/cli/context.js'
import { renderShim, renderWorkflow } from '../../../src/generate/index.js'
import { accounts } from '../../harness/index.js'
import { GENERATE, LOWER, WORK, createCiScene, sceneConfig } from './ci-fixture.js'

const lead = accounts.lead.login

describe('AC54/ci: stale generated files fail CI', () => {
  test('a pull request after which commands.generate changes a tracked file fails CI (E10)', async () => {
    const config = sceneConfig((hackwin) => {
      hackwin.commands.generate = GENERATE
    })
    const scene = await createCiScene({ config })
    const branch = 'task/12-counter-reset'
    // Two new counter files: src/shared/counter-files.txt on the branch is stale.
    const head = await scene.push(branch, WORK)

    const result = await scene.runCi({ branch, head })

    expect(result.code).toBe(1)
    expect(result.json.error).toMatchObject({
      kind: 'blocked',
      rule: 'E10: generated files are produced only by the Lead and are current',
      objects: ['src/shared/counter-files.txt'],
    })
    expect(result.json.error.message).toMatch(/^step 7, merge with the base branch: /)
    expect(scene.leftovers()).toEqual([])
  })

  test('a pull request whose hackwin generated files come from another version fails CI (E19)', async () => {
    const scene = await createCiScene()
    const branch = 'task/20-shared-change'
    const head = await scene.push(branch, {
      '.github/workflows/hackwin.yml': renderWorkflow({ version: LOWER }),
    })

    const result = await scene.runCi({ branch, head, author: lead })

    expect(result.code).toBe(1)
    expect(result.json.error).toMatchObject({
      kind: 'blocked',
      rule: 'E19: generated wrappers and hook shims are not edited by hand',
      objects: [
        `.github/workflows/hackwin.yml: its content differs from what hackwin ${VERSION} generates`,
      ],
    })
    expect(result.json.error.message).toBe(
      `step 6, generated files: 1 generated file of the branch differs from the output of hackwin ${VERSION}`,
    )
  })
})

describe('1.4b/generated: generated files edited by hand', () => {
  test('a pull request of the Lead that edits a hook shim by hand, or drops its executable bit, fails CI (E19)', async () => {
    const scene = await createCiScene()
    const branch = 'task/20-shared-change'
    const clone = await scene.fixture.clone('lead')
    await clone.git.run(['checkout', '--quiet', '-b', branch, 'origin/main'])
    const shim = renderShim('pre-commit', { version: VERSION })
    await scene.fixture.commit('Edit the shims', {
      dir: clone.path,
      files: { '.githooks/pre-commit': `${shim}exit 0\n` },
    })
    await clone.git.run(['update-index', '--chmod=-x', '.githooks/pre-push'])
    await clone.git.run(['commit', '--quiet', '-m', 'Drop the executable bit'])
    await clone.git.push({ refspecs: [`HEAD:refs/heads/${branch}`] })
    const head = await clone.git.revParse('HEAD')

    const result = await scene.runCi({ branch, head, author: lead })

    expect(result.code).toBe(1)
    expect(result.json.error.objects).toEqual([
      `.githooks/pre-commit: its content differs from what hackwin ${VERSION} generates`,
      '.githooks/pre-push: its executable bit differs',
    ])
  })
})

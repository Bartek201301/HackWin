import { describe, expect, test } from 'vitest'
import { join } from 'node:path'
import semver from 'semver'
import { REPOSITORY_URL, VERSION } from '../../../src/cli/context.js'
import { installCommand } from '../../../src/core/config/index.js'
import { writeGeneratedFiles } from '../../../src/generate/index.js'
import { accounts, ownersObject, yaml } from '../../harness/index.js'
import { runInstallStep } from '../../generate/install-step.js'
import {
  ALL_STEPS,
  LOWER,
  OTHER_PHASE,
  WORK,
  createCiScene,
  sceneConfig,
  stepsOf,
} from './ci-fixture.js'

const lead = accounts.lead.login

describe('AC4/ci: owners.yml with overlapping globs', () => {
  test('a pull request that proposes an owners.yml with overlapping globs fails CI', async () => {
    const scene = await createCiScene()
    const owners = ownersObject()
    owners.roles.counter.paths = ['src/features/**']
    const branch = 'task/20-shared-change'
    const head = await scene.push(branch, { 'owners.yml': yaml(owners) })

    const result = await scene.runCi({ branch, head, author: lead })

    expect(result.code).toBe(2)
    expect(result.json.error.kind).toBe('config')
    expect(result.json.error.message).toContain('owners.yml')
    expect(result.json.error.message).toContain('a path matches at most one role')
    expect(result.stderr).not.toContain('step 1, ')
  })

  test('an owners.yml with overlapping globs on the base branch fails CI', async () => {
    const config = sceneConfig()
    const owners = ownersObject()
    owners.roles.greeting.paths = ['src/features/**']
    const scene = await createCiScene({ config: { hackwin: config.hackwin, owners: yaml(owners) } })
    const branch = 'task/12-counter-reset'
    const head = await scene.push(branch, WORK)

    const result = await scene.runCi({ branch, head })

    expect(result.code).toBe(2)
    expect(result.json.error.kind).toBe('config')
    expect(result.json.error.message).toContain('a path matches at most one role')
  })

  test('a valid proposed owners.yml passes step 1 and names what it validated', async () => {
    const scene = await createCiScene()
    const owners = ownersObject()
    owners.open = ['README.md', 'CONTRIBUTING.md']
    const branch = 'task/20-shared-change'
    const head = await scene.push(branch, { 'owners.yml': yaml(owners) })

    const result = await scene.runCi({ branch, head, author: lead })

    expect(result.code).toBe(0)
    expect(result.stderr).toContain(
      `step 1, configuration: hackwin.yml and owners.yml of origin/main apply; the proposed owners.yml is valid; checked with hackwin ${VERSION}`,
    )
  })
})

describe('AC77/ci: the CLI version a pull request is checked with', () => {
  test('a pull request that raises cli_version to a patch of the same phase is checked with the version it names', async () => {
    expect(semver.lt(LOWER, VERSION)).toBe(true)
    // main pins LOWER and holds its generated files, as before a bug fix release.
    const config = sceneConfig((hackwin) => {
      hackwin.cli_version = LOWER
    })
    const scene = await createCiScene({ config })
    await writeGeneratedFiles(scene.fixture.main, { version: LOWER })
    await scene.fixture.commit(`Generated files of hackwin ${LOWER}`, { push: true })

    // The Lead's pull request: the raised cli_version and the output of setup --regenerate.
    const raised = sceneConfig()
    const branch = 'task/20-shared-change'
    const clone = await scene.fixture.clone('lead')
    await clone.git.run(['checkout', '--quiet', '-b', branch, 'origin/main'])
    await writeGeneratedFiles(clone.path, { version: VERSION })
    await scene.fixture.commit(`Install hackwin ${VERSION}`, {
      dir: clone.path,
      files: { 'hackwin.yml': yaml(raised.hackwin) },
    })
    await clone.git.push({ refspecs: [`HEAD:refs/heads/${branch}`] })
    const head = await clone.git.revParse('HEAD')

    const result = await scene.runCi({ branch, head, author: lead })

    // The workflow installs the version the pull request names ...
    const install = await runInstallStep({
      version: LOWER,
      cwd: result.checkout.path,
      dir: join(scene.fixture.dir, 'install-raised'),
      env: scene.fixture.env,
    })
    expect(install.code).toBe(0)
    expect(install.npm).toEqual([installCommand(VERSION, REPOSITORY_URL).replace(/^npm /, '')])
    // ... and that version passes every step.
    expect(result.code).toBe(0)
    expect(stepsOf(result)).toEqual(ALL_STEPS)
    expect(result.stderr).toContain(
      `checked with hackwin ${VERSION}, the version this pull request sets`,
    )
  })

  test('a pull request that leaves cli_version alone is checked with the version on the base branch', async () => {
    const config = sceneConfig((hackwin) => {
      hackwin.cli_version = LOWER
    })
    const scene = await createCiScene({ config })
    await writeGeneratedFiles(scene.fixture.main, { version: LOWER })
    await scene.fixture.commit(`Generated files of hackwin ${LOWER}`, { push: true })
    const branch = 'task/12-counter-reset'
    const head = await scene.push(branch, WORK)

    const result = await scene.runCi({ branch, head })

    const install = await runInstallStep({
      version: LOWER,
      cwd: result.checkout.path,
      dir: join(scene.fixture.dir, 'install-base'),
      env: scene.fixture.env,
    })
    expect(install.npm).toEqual([installCommand(LOWER, REPOSITORY_URL).replace(/^npm /, '')])
    // Run by another version than the one it is checked with, the check refuses to start.
    expect(result.code).toBe(2)
    expect(result.json.error).toMatchObject({
      kind: 'precondition',
      message: `hackwin ${VERSION} runs this check, but pull request #30 is checked with hackwin ${LOWER}, the version hackwin.yml pins on origin/main`,
      resolve: { command: installCommand(LOWER, REPOSITORY_URL), dir: 'any directory' },
    })
  })

  test('a pull request that sets cli_version to a release of another phase fails CI', async () => {
    const scene = await createCiScene()
    const other = sceneConfig((hackwin) => {
      hackwin.cli_version = OTHER_PHASE
    })
    const branch = 'task/20-shared-change'
    const head = await scene.push(branch, { 'hackwin.yml': yaml(other.hackwin) })

    const result = await scene.runCi({ branch, head, author: lead })

    // The workflow installs the version of the base branch, not the other phase's ...
    const install = await runInstallStep({
      version: VERSION,
      cwd: result.checkout.path,
      dir: join(scene.fixture.dir, 'install-other'),
      env: scene.fixture.env,
    })
    expect(install.npm).toEqual([installCommand(VERSION, REPOSITORY_URL).replace(/^npm /, '')])
    // ... whose step 1 fails the pull request [D10].
    expect(result.code).toBe(2)
    expect(result.json.error).toMatchObject({ kind: 'config', key: 'cli_version' })
    expect(result.json.error.message).toContain(`(${OTHER_PHASE}) is of phase`)
  })
})

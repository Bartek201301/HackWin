import { describe, expect, test } from 'vitest'
import { BUILTIN_PATTERNS } from '../../../src/core/secrets/index.js'
import { WORK, createCiScene, sceneConfig } from './ci-fixture.js'

// Secret-shaped strings, built at run time so that no scanner flags this file itself.
/** Matches only TEAM_PATTERN, a pattern of the team's own hackwin.yml that GitHub does not know. */
const teamSecret = ['hwtest', 'q7w3e9r1t5y2u8i4o6p0a1s3'].join('_')
const TEAM_PATTERN = 'hwtest_[a-z0-9]{24}'

describe('AC80/ci: the secret scan in CI', () => {
  test('a test secret that matches a HackWin pattern but no pattern GitHub recognizes fails CI', async () => {
    const config = sceneConfig((hackwin) => {
      hackwin.gate.secret_patterns = [TEAM_PATTERN]
    })
    const scene = await createCiScene({ config })
    const branch = 'task/12-counter-reset'
    const head = await scene.push(branch, {
      ...WORK,
      'src/features/counter/key.js': `export const key = '${teamSecret}'\n`,
    })
    expect(BUILTIN_PATTERNS.some((pattern) => pattern.regex.test(teamSecret))).toBe(false)

    const result = await scene.runCi({ branch, head })

    expect(result.code).toBe(1)
    expect(result.json.error).toMatchObject({
      kind: 'blocked',
      rule: 'E6: no env file other than .env.example and no secret is committed',
      objects: ['src/features/counter/key.js:1: gate.secret_patterns[0]'],
    })
    expect(result.json.error.message).toMatch(/^step 4, secret scan: /)
    expect(result.stderr).not.toContain(teamSecret)
    expect(JSON.stringify(result.json)).not.toContain(teamSecret)
  })

  test('an added env file other than .env.example fails CI', async () => {
    const scene = await createCiScene()
    const branch = 'task/12-counter-reset'
    const head = await scene.push(branch, { ...WORK, 'src/features/counter/.env.local': 'A=1\n' })

    const result = await scene.runCi({ branch, head })

    expect(result.code).toBe(1)
    expect(result.json.error.objects).toEqual(['src/features/counter/.env.local: env-file'])
  })
})

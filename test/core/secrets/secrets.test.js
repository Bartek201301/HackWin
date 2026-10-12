import { afterEach, describe, expect, test } from 'vitest'
import { join } from 'node:path'
import {
  BUILTIN_PATTERNS,
  formatFinding,
  scanAddedFiles,
  scanAddedLines,
  scanDiff,
} from '../../../src/core/secrets/index.js'
import { createGit } from '../../../src/core/git/index.js'
import { ConfigError } from '../../../src/core/runtime/errors.js'
import { createRepoWithOrigin } from '../git/temp-repo.js'

// Secret-shaped strings, built at run time so that no scanner flags this file itself.
const githubToken = ['ghp', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('_')
const awsKey = ['AKIA', 'Z3XQ7PLM2NB6VC4K'].join('')
const jwt = [
  'eyJhbGciOiJIUzI1NiJ9',
  'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
  'c2lnbmF0dXJlLXNpZ25hdHVyZQ',
].join('.')

/** The pattern of the manual workflow guide that raised the false positive on sandbox PR #1. */
const guidePattern = 'eyJ[A-Za-z0-9_-]{20}'

/** A real-shaped sha512 integrity hash (88 base64 characters) that contains `eyJ`. */
const integrity =
  'sha512-Qx7eyJk2LmNpQrStUvWxYz0123456789abcdefghijABCDEFGHIJKLmnopqrstuvwxyzAB+/CdEf12GhIjKlMn=='

/** @type {Array<() => void>} */
const cleanups = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

describe('1.3b/secrets: added lines and env files', () => {
  test('a matching line is reported with file, line and pattern name, never the matched text', () => {
    const findings = scanAddedLines([
      { path: 'src/api.js', line: 12, text: `const token = '${githubToken}'` },
      { path: 'src/api.js', line: 13, text: 'const nothing = "plain text"' },
      { path: 'config/aws.js', line: 3, text: `key: ${awsKey}` },
      { path: 'src/auth.js', line: 7, text: `const session = "${jwt}"` },
    ])
    expect(findings).toEqual([
      { path: 'src/api.js', line: 12, pattern: 'github-token' },
      { path: 'config/aws.js', line: 3, pattern: 'aws-access-key-id' },
      { path: 'src/auth.js', line: 7, pattern: 'json-web-token' },
    ])
    const printed = JSON.stringify(findings) + findings.map(formatFinding).join('\n')
    for (const secret of [githubToken, awsKey, jwt]) expect(printed).not.toContain(secret)
    expect(findings.map(formatFinding)).toEqual([
      'src/api.js:12: github-token',
      'config/aws.js:3: aws-access-key-id',
      'src/auth.js:7: json-web-token',
    ])
  })

  test('gate.secret_patterns are added to the built-in list and named by their key', () => {
    const lines = [{ path: 'src/a.js', line: 1, text: 'const key = "acme-live-1234567890"' }]
    expect(scanAddedLines(lines)).toEqual([])
    expect(scanAddedLines(lines, { extraPatterns: ['acme-live-[0-9]{10}'] })).toEqual([
      { path: 'src/a.js', line: 1, pattern: 'gate.secret_patterns[0]' },
    ])
    expect(() => scanAddedLines(lines, { extraPatterns: ['(unclosed'] })).toThrow(ConfigError)
  })

  test('one finding per line and pattern, even with several matches', () => {
    const text = `${githubToken} ${githubToken}`
    expect(scanAddedLines([{ path: 'x.js', line: 1, text }])).toHaveLength(1)
  })

  test('every built-in pattern has a name and a regular expression', () => {
    expect(BUILTIN_PATTERNS.length).toBeGreaterThan(5)
    for (const { name, regex } of BUILTIN_PATTERNS) {
      expect(name).toMatch(/^[a-z0-9-]+$/)
      expect(regex).toBeInstanceOf(RegExp)
    }
  })

  test('an added .env.local is rejected and .env.example is not', () => {
    const findings = scanAddedFiles([
      { status: 'A', path: '.env.local', oldPath: null },
      { status: 'A', path: '.env.example', oldPath: null },
      { status: 'A', path: 'apps/web/.env', oldPath: null },
      { status: 'R', path: '.env.production.local', oldPath: '.env.example' },
      { status: 'D', path: '.env.old', oldPath: null },
      { status: 'A', path: 'src/env.js', oldPath: null },
      { status: 'A', path: 'docs/.envrc-notes.md', oldPath: null },
    ])
    expect(findings).toEqual([
      { path: '.env.local', line: null, pattern: 'env-file' },
      { path: 'apps/web/.env', line: null, pattern: 'env-file' },
      { path: '.env.production.local', line: null, pattern: 'env-file' },
    ])
    expect(formatFinding(findings[0])).toBe('.env.local: env-file')
  })

  test('scanDiff runs both scans on the staged changes of a real repository', async () => {
    const repo = createRepoWithOrigin()
    cleanups.push(repo.cleanup)
    repo.write(join(repo.clone, '.env.local'), 'API_KEY=whatever\n')
    repo.write(join(repo.clone, '.env.example'), 'API_KEY=\n')
    repo.write(
      join(repo.clone, 'src/client.js'),
      `// client\nexport const token = '${githubToken}'\n`,
    )
    repo.git(repo.clone, 'add', '.')
    const git = createGit({ cwd: repo.clone, env: repo.env })
    const findings = await scanDiff(git, { staged: true })
    expect(findings).toEqual([
      { path: '.env.local', line: null, pattern: 'env-file' },
      { path: 'src/client.js', line: 2, pattern: 'github-token' },
    ])
  })
})

describe('1.3b/secrets-lockfile: package integrity hashes in lockfiles are not secrets', () => {
  const hashLine = `      "integrity": "${integrity}",`

  test('the fixture hash has the shape of a sha512 integrity hash and contains eyJ', () => {
    expect(integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/)
    expect(new RegExp(guidePattern).test(integrity)).toBe(true)
  })

  test('an added package-lock.json line whose sha512 hash contains eyJ is not reported', () => {
    const lines = [{ path: 'package-lock.json', line: 1985, text: hashLine }]
    expect(scanAddedLines(lines, { extraPatterns: [guidePattern] })).toEqual([])
  })

  test('a line matching a secret pattern in the same lockfile still is', () => {
    const findings = scanAddedLines(
      [
        { path: 'package-lock.json', line: 1985, text: hashLine },
        { path: 'package-lock.json', line: 1990, text: `      "resolved": "${jwt}",` },
        { path: 'package-lock.json', line: 1991, text: `      "token": "${githubToken}",` },
      ],
      { extraPatterns: [guidePattern] },
    )
    expect(findings).toEqual([
      { path: 'package-lock.json', line: 1990, pattern: 'json-web-token' },
      { path: 'package-lock.json', line: 1990, pattern: 'gate.secret_patterns[0]' },
      { path: 'package-lock.json', line: 1991, pattern: 'github-token' },
    ])
  })

  test('a match next to a hash on the same line is still reported', () => {
    const text = `"integrity": "${integrity}", "x": "eyJabcdefghijklmnopqrstuvw"`
    expect(
      scanAddedLines([{ path: 'package-lock.json', line: 3, text }], {
        extraPatterns: [guidePattern],
      }),
    ).toEqual([{ path: 'package-lock.json', line: 3, pattern: 'gate.secret_patterns[0]' }])
  })

  test('the same hash outside a lockfile, or with a wrong length, is still reported', () => {
    const options = { extraPatterns: [guidePattern] }
    expect(
      scanAddedLines([{ path: 'src/data.json', line: 1, text: hashLine }], options),
    ).toHaveLength(1)
    const short = hashLine.replace('KlMn==', '==')
    expect(
      scanAddedLines([{ path: 'package-lock.json', line: 1, text: short }], options),
    ).toHaveLength(1)
  })

  test('yarn.lock and pnpm-lock.yaml hashes are not reported either', () => {
    const options = { extraPatterns: [guidePattern] }
    const lines = [
      { path: 'yarn.lock', line: 4, text: `  integrity ${integrity}` },
      {
        path: 'apps/web/pnpm-lock.yaml',
        line: 9,
        text: `    resolution: {integrity: ${integrity}}`,
      },
    ]
    expect(scanAddedLines(lines, options)).toEqual([])
  })
})

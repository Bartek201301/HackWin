// The secret scan (E6, A41): a built-in pattern list plus `gate.secret_patterns`, applied to the
// added lines of a diff, and the rejection of every added env file except `.env.example`. A
// finding names the file, the line and the pattern, never the matched text. Used by the
// pre-commit hook, CI, `ship` and the Gate. See docs/build/contracts.md section 4.6.

import { ConfigError } from '../runtime/errors.js'

/** @import { AddedLine, ChangedFile, DiffRange, Git } from '../git/index.js' */

/**
 * @typedef {object} SecretPattern
 * @property {string} name
 * @property {RegExp} regex
 */

/**
 * @typedef {object} Finding
 * @property {string} path
 * @property {number | null} line The line in the new file; null for a finding about the whole file.
 * @property {string} pattern The pattern's name, `env-file` for an env file.
 */

/** The built-in patterns (A41): token formats that only a secret has. */
export const BUILTIN_PATTERNS = Object.freeze(
  /** @type {SecretPattern[]} */ ([
    { name: 'private-key', regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/ },
    { name: 'aws-access-key-id', regex: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/ },
    {
      name: 'aws-secret-access-key',
      regex: /aws_?secret_?access_?key["']?\s*[:=]\s*["']?[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])/i,
    },
    { name: 'github-token', regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/ },
    { name: 'github-fine-grained-token', regex: /\bgithub_pat_[A-Za-z0-9_]{22,}/ },
    { name: 'gitlab-token', regex: /\bglpat-[A-Za-z0-9_-]{20,}/ },
    { name: 'slack-token', regex: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
    { name: 'slack-webhook', regex: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_/-]{20,}/ },
    { name: 'stripe-secret-key', regex: /\b[rs]k_live_[A-Za-z0-9]{16,}/ },
    { name: 'google-api-key', regex: /\bAIza[0-9A-Za-z_-]{35}/ },
    { name: 'anthropic-api-key', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
    {
      name: 'openai-api-key',
      regex:
        /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|\bsk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}/,
    },
    { name: 'npm-token', regex: /\bnpm_[A-Za-z0-9]{36}\b/ },
    {
      name: 'json-web-token',
      regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
    },
  ]).map((pattern) => Object.freeze(pattern)),
)

/** The one env file that may be committed. */
const ENV_EXAMPLE = '.env.example'

/** Lockfiles whose package integrity hashes are not secrets. */
const LOCKFILES = Object.freeze([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
])

/** The length of the base64 digest of each integrity algorithm, padding included. */
const DIGEST_LENGTH = Object.freeze({ sha1: 28, sha256: 44, sha384: 64, sha512: 88 })

/** An integrity hash `<algorithm>-<base64>` as lockfiles write it (Subresource Integrity). */
const INTEGRITY =
  /(?<![A-Za-z0-9+/=_-])(sha1|sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})(?![A-Za-z0-9+/=])/g

/**
 * Scan added lines for secret patterns. A match that lies inside the integrity hash of a
 * package in a lockfile is not a finding; any other match in the same file is. One finding per
 * line and pattern.
 * @param {AddedLine[]} lines From `git.addedLines`.
 * @param {{ extraPatterns?: string[] }} [options] `gate.secret_patterns`.
 * @returns {Finding[]}
 */
export function scanAddedLines(lines, { extraPatterns = [] } = {}) {
  const patterns = [...BUILTIN_PATTERNS, ...extraPatterns.map(compileExtra)].map(
    ({ name, regex }) => ({
      name,
      regex: new RegExp(regex.source, `${regex.flags.replace('g', '')}g`),
    }),
  )
  /** @type {Finding[]} */
  const findings = []
  for (const { path, line, text } of lines) {
    const hashes = isLockfile(path) ? integritySpans(text) : []
    for (const { name, regex } of patterns) {
      for (const match of text.matchAll(regex)) {
        const start = match.index
        const end = start + match[0].length
        if (hashes.some((span) => start >= span.start && end <= span.end)) continue
        findings.push({ path, line, pattern: name })
        break
      }
    }
  }
  return findings
}

/**
 * A finding with the pattern `env-file` for every env file that a change adds or changes,
 * except `.env.example`. Deleting an env file is no finding.
 * @param {ChangedFile[]} files From `git.changedFiles`.
 * @returns {Finding[]}
 */
export function scanAddedFiles(files) {
  return files
    .filter((file) => file.status !== 'D' && isEnvFile(file.path))
    .map((file) => ({ path: file.path, line: null, pattern: 'env-file' }))
}

/**
 * Both scans of one diff: the env files it adds and the secret patterns in its added lines.
 * @param {Git} git
 * @param {DiffRange} range
 * @param {{ extraPatterns?: string[] }} [options]
 * @returns {Promise<Finding[]>}
 */
export async function scanDiff(git, range, { extraPatterns = [] } = {}) {
  const [files, lines] = await Promise.all([git.changedFiles(range), git.addedLines(range)])
  return [...scanAddedFiles(files), ...scanAddedLines(lines, { extraPatterns })]
}

/**
 * `<path>:<line>: <pattern>`, or `<path>: env-file` for a finding about the whole file.
 * @param {Finding} finding
 * @returns {string}
 */
export function formatFinding(finding) {
  const where = finding.line === null ? finding.path : `${finding.path}:${finding.line}`
  return `${where}: ${finding.pattern}`
}

/**
 * An env file: `.env` or `.env.<anything>` in any directory, except `.env.example`.
 * @param {string} path
 * @returns {boolean}
 */
function isEnvFile(path) {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return name !== ENV_EXAMPLE && (name === '.env' || name.startsWith('.env.'))
}

/**
 * @param {string} path
 * @returns {boolean}
 */
function isLockfile(path) {
  return LOCKFILES.includes(path.slice(path.lastIndexOf('/') + 1))
}

/**
 * Where the integrity hashes of a line are: `<algorithm>-<base64>` with a digest of exactly the
 * algorithm's length.
 * @param {string} text
 * @returns {Array<{ start: number, end: number }>}
 */
function integritySpans(text) {
  /** @type {Array<{ start: number, end: number }>} */
  const spans = []
  for (const match of text.matchAll(INTEGRITY)) {
    const algorithm = /** @type {keyof typeof DIGEST_LENGTH} */ (match[1])
    if (match[2].length === DIGEST_LENGTH[algorithm]) {
      spans.push({ start: match.index, end: match.index + match[0].length })
    }
  }
  return spans
}

/**
 * @param {string} source
 * @param {number} index
 * @returns {SecretPattern}
 */
function compileExtra(source, index) {
  const name = `gate.secret_patterns[${index}]`
  try {
    return { name, regex: new RegExp(source) }
  } catch (error) {
    throw new ConfigError(
      `hackwin.yml: ${name} is not a valid regular expression: ${error.message}`,
      {
        key: name,
        details: { file: 'hackwin.yml' },
      },
    )
  }
}

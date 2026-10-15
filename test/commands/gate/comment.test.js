import { describe, expect, test } from 'vitest'
import {
  failureComment,
  formatGateMarker,
  latestGateComment,
  parseGateMarker,
} from '../../../src/commands/gate/comment.js'

const SHA = '0123456789abcdef0123456789abcdef01234567'
const OTHER = 'fedcba9876543210fedcba9876543210fedcba98'
const LEAD = 'the-lead'

/**
 * @param {number} id
 * @param {string} body
 * @param {string} [author]
 */
function comment(id, body, author = LEAD) {
  return {
    id,
    body,
    author,
    url: `https://github.com/acme/app/pull/12#issuecomment-${id}`,
    createdAt: '2026-10-24T10:00:00Z',
    updatedAt: '2026-10-24T10:00:00Z',
  }
}

/**
 * The milliseconds one parse takes.
 * @param {string} body
 */
function timed(body) {
  const start = performance.now()
  parseGateMarker(body)
  return performance.now() - start
}

describe('1.6c/marker: every Gate comment starts with a marker that names the pull request, the head SHA, the stage and the result', () => {
  test('the marker of a failure comment parses back', () => {
    const marker = { pr: 12, sha: SHA, stage: 'scope', result: 'scope-violation' }
    const body = failureComment({
      marker,
      title: 'stage 3, scope',
      reason: 'a file lies outside',
      details: ['`a.js`'],
      next: 'take it out',
      main: OTHER,
    })
    expect(body.split('\n')[0]).toBe(
      `<!-- hackwin:gate-comment pr=12 sha=${SHA} stage=scope result=scope-violation -->`,
    )
    expect(parseGateMarker(body)).toEqual(marker)
    expect(body).toContain('**HackWin Gate: failed at stage 3, scope.**')
    expect(body).toContain('**Reason:** a file lies outside')
    expect(body).toContain('- `a.js`')
    expect(body).toContain('**Next action:** take it out')
    expect(body).toContain(`Head \`${SHA}\`, tested against main \`${OTHER}\`.`)
    expect(parseGateMarker(body.replace(/\n/g, '\r\n'))).toEqual(marker)
    const line = formatGateMarker(marker)
    expect(parseGateMarker(line)).toEqual(marker)
    const sha256 = `${SHA}${'a'.repeat(24)}`
    expect(parseGateMarker(formatGateMarker({ ...marker, sha: sha256 }))?.sha).toBe(sha256)
  })

  test('only the exact marker at the very start of the body counts', () => {
    const line = formatGateMarker({ pr: 12, sha: SHA, stage: 'conflicts', result: 'needs-owner' })
    const refused = [
      'Thanks!',
      '',
      `> ${line}\n> quoted`,
      `Hello\n${line}`,
      `    ${line}`,
      `\t${line}`,
      `﻿${line}`,
      ` ${line}`,
      ` ${line}`,
      `\`\`\`\n${line}\n\`\`\``,
      `${line} tail`,
      `${line}tail`,
      line.replace(' -->', ' extra=1 -->'),
      line.replace('pr=12 ', 'pr=12 pr=13 '),
      line.replace(' result=needs-owner', ''),
      line.replace(`pr=12 sha=${SHA}`, `sha=${SHA} pr=12`),
      line.replace(SHA, SHA.slice(0, 12)),
      line.replace(SHA, SHA.toUpperCase()),
      line.replace('pr=12', 'pr=0'),
      line.replace('pr=12', 'pr=012'),
      line.replace('stage=conflicts', 'stage=Conflicts'),
      line.replace('<!-- ', '<!--  '),
      line.toUpperCase(),
    ]
    for (const body of refused) expect(parseGateMarker(body), JSON.stringify(body)).toBeNull()
    expect(parseGateMarker(null)).toBeNull()
    expect(parseGateMarker(undefined)).toBeNull()
    expect(() =>
      formatGateMarker({ pr: 12, sha: 'abc', stage: 'scope', result: 'failed' }),
    ).toThrow(TypeError)
    expect(() =>
      formatGateMarker({ pr: 12, sha: SHA, stage: 'stage 3', result: 'failed' }),
    ).toThrow(TypeError)
  })

  test('a parse takes time linear in the body, also for bodies built to make a pattern backtrack', () => {
    const prefix = '<!-- hackwin:gate-comment '
    const bodies = [
      // The shape that took 10 s with 24 repeats in the parser of the first head of #64.
      `${prefix}${'a=a '.repeat(100_000)}`,
      `${prefix}${'a=a'.repeat(100_000)}`,
      `${prefix}pr=1 sha=${SHA} stage=${'a-'.repeat(100_000)}`,
      `${prefix}pr=1 sha=${SHA} stage=a result=${'a-'.repeat(100_000)}-->`,
      `${prefix}pr=${'1'.repeat(100_000)}`,
      `${prefix}pr=1 sha=${'0'.repeat(100_000)}`,
    ]
    for (const [index, body] of bodies.entries()) {
      expect(parseGateMarker(body) === null, `body ${index} is no marker`).toBe(true)
      expect(timed(body), `body ${index}`).toBeLessThan(250)
    }
  })

  test("the Gate's newest comment of the pull request is found among the Lead's comments only", () => {
    const gate = (
      /** @type {number} */ id,
      /** @type {number} */ pr,
      /** @type {string} */ sha,
      /** @type {string} */ author = LEAD,
    ) =>
      comment(
        id,
        failureComment({
          marker: { pr, sha, stage: 'task-link', result: 'failed' },
          title: 'stage 2, task link',
          reason: `reason ${id}`,
          next: 'fix it',
        }),
        author,
      )
    const comments = [
      gate(1, 12, SHA),
      gate(2, 12, OTHER, 'The-Lead'),
      gate(3, 13, SHA),
      gate(4, 12, SHA, 'someone-else'),
      comment(5, 'The Lead, by hand: I will look at it.'),
      { ...gate(6, 12, SHA), author: null },
    ]
    const found = latestGateComment(comments, { pr: 12, lead: LEAD })
    expect(found?.comment.id).toBe(2)
    expect(found?.marker).toEqual({ pr: 12, sha: OTHER, stage: 'task-link', result: 'failed' })
    expect(latestGateComment(comments, { pr: 13, lead: 'THE-LEAD' })?.comment.id).toBe(3)
    expect(latestGateComment(comments, { pr: 14, lead: LEAD })).toBeNull()
    expect(latestGateComment(comments.slice(3), { pr: 12, lead: LEAD })).toBeNull()
  })
})

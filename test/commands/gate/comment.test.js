import { describe, expect, test } from 'vitest'
import {
  failureComment,
  formatGateMarker,
  latestGateComment,
  parseGateMarker,
} from '../../../src/commands/gate/comment.js'

const SHA = '0123456789abcdef0123456789abcdef01234567'
const OTHER = 'fedcba9876543210fedcba9876543210fedcba98'

/**
 * @param {number} id
 * @param {string} body
 */
function comment(id, body) {
  return {
    id,
    body,
    author: 'lead',
    url: `https://github.com/acme/app/pull/12#issuecomment-${id}`,
    createdAt: '2026-10-24T10:00:00Z',
    updatedAt: '2026-10-24T10:00:00Z',
  }
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
  })

  test('a comment without the marker on its first line, or with a broken one, is no Gate comment', () => {
    const line = formatGateMarker({ pr: 12, sha: SHA, stage: 'conflicts', result: 'needs-owner' })
    expect(parseGateMarker('Thanks!')).toBeNull()
    expect(parseGateMarker(null)).toBeNull()
    expect(parseGateMarker(`> ${line}\n> quoted`)).toBeNull()
    expect(parseGateMarker(`Hello\n${line}`)).toBeNull()
    expect(parseGateMarker(line.replace(SHA, SHA.slice(0, 12)))).toBeNull()
    expect(parseGateMarker(line.replace('pr=12', 'pr=0'))).toBeNull()
    expect(parseGateMarker(line.replace('pr=12 ', 'pr=12 pr=13 '))).toBeNull()
    expect(parseGateMarker(line.replace(' result=needs-owner', ''))).toBeNull()
    expect(() =>
      formatGateMarker({ pr: 12, sha: 'abc', stage: 'scope', result: 'failed' }),
    ).toThrow(TypeError)
    expect(() =>
      formatGateMarker({ pr: 12, sha: SHA, stage: 'stage 3', result: 'failed' }),
    ).toThrow(TypeError)
  })

  test("the Gate's newest comment of the pull request is found behind a later comment written by hand", () => {
    const gate = (/** @type {number} */ id, /** @type {number} */ pr, /** @type {string} */ sha) =>
      comment(
        id,
        failureComment({
          marker: { pr, sha, stage: 'task-link', result: 'failed' },
          title: 'stage 2, task link',
          reason: `reason ${id}`,
          next: 'fix it',
        }),
      )
    const comments = [
      gate(1, 12, SHA),
      gate(2, 12, OTHER),
      gate(3, 13, SHA),
      comment(4, 'The Lead, by hand: I will look at it.'),
    ]
    const found = latestGateComment(comments, 12)
    expect(found?.comment.id).toBe(2)
    expect(found?.marker).toEqual({ pr: 12, sha: OTHER, stage: 'task-link', result: 'failed' })
    expect(latestGateComment(comments, 14)).toBeNull()
  })
})

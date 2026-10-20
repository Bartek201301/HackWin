// Reading back what setup wrote on GitHub (steps 11 to 13). One read right after a write proves
// nothing: GitHub's reads lag its writes, and not steadily. On hackwin-fixture-a on
// 15 October 2026 the Lead read push protection about every half second after each PATCH. After
// `disabled`, reads gave the new value from 0 to 2.1 s, the old one from 2.6 to 4.1 s, and the new
// one from 4.6 s to the end at 20 s. After `enabled`, the new value from 0 to 2.3 s, the old one
// from 2.7 to 9.8 s, and the new one from 10.2 s to 20 s.
//
// So setup reads a setting once a second and takes a value only when at least SETTLE.minMs have
// passed since its last write and every read of the last SETTLE.stableMs agreed. That GitHub's
// reads hold the written value from then on is assumed: it was observed only in the two runs
// above. A value that never settles within SETTLE.maxMs is reported as unsettled, with the last
// read.
//
// A read that fails for a reason that may pass, a network failure or a server error, is a missed
// sample: the wait goes on, and the reads before it no longer count as agreeing. A refusal ends
// the wait at once. When the budget runs out after a read failed, the wait ends with a RemoteError
// (exit 3) that names the last failure. Reads that run side by side share a stop: when one ends
// with an error, the others end at their next read.

import { RemoteError, runIn } from '../../core/runtime/index.js'

/** @import { Clock } from '../../core/runtime/index.js' */

/** The timing of a read back, in milliseconds. */
export const SETTLE = Object.freeze({
  /** Between two reads. */
  intervalMs: 1_000,
  /** From the last write to the earliest read that counts. */
  minMs: 15_000,
  /** How long every read must have agreed. */
  stableMs: 5_000,
  /** From the last write to giving up on a settled value. */
  maxMs: 60_000,
})

/**
 * @template T
 * @typedef {object} Settled
 * @property {T} value The value that held, or the last read when it did not settle.
 * @property {boolean} settled
 * @property {number} reads The reads that answered.
 * @property {number} changes How often a read differed from the one before it.
 * @property {number} failures The reads that failed for a reason that may pass.
 */

/**
 * Read back side by side; the first error stops the others.
 * @typedef {object} Stop
 * @property {unknown} [error] The error that ended one of the reads.
 */

/**
 * True for a failed read that may pass: gh failed without an HTTP status (a timeout, a failed name
 * lookup, a reset connection, a cut answer), or GitHub answered 429 or 5xx. Any other status is a
 * refusal that will not go away, such as 401, 403, 404 or 422.
 * @param {unknown} error
 * @returns {boolean}
 */
export function isPassingFailure(error) {
  if (!(error instanceof RemoteError)) return false
  const status = error.status
  return status === undefined || status === 429 || status >= 500
}

/**
 * Read a setting until it settles.
 * @template T
 * @param {Clock} clock
 * @param {() => Promise<T>} read
 * @param {object} options
 * @param {number} options.since The time of the last write, in milliseconds since the epoch.
 * @param {string} options.what What is read, for the error, such as `the push protection setting`.
 * @param {Stop} [options.stop] Shared by the reads that run side by side.
 * @param {(value: T) => string} [options.key] What two reads compare; JSON by default.
 * @returns {Promise<Settled<T>>}
 */
export async function settledRead(
  clock,
  read,
  { since, what, stop = {}, key = (value) => JSON.stringify(value) },
) {
  /** @type {{ value: T } | null} */
  let last = null
  /** The time from which every read agreed; null after a failed read. */
  let agreedSince = /** @type {number | null} */ (null)
  /** @type {RemoteError | null} */
  let failure = null
  let reads = 0
  let changes = 0
  let failures = 0
  for (let first = true; ; first = false) {
    if (!first) await clock.sleep(SETTLE.intervalMs)
    if (stop.error !== undefined) throw stop.error
    try {
      const value = await read()
      if (stop.error !== undefined) throw stop.error
      reads += 1
      if (last !== null && key(value) !== key(last.value)) changes += 1
      if (last === null || agreedSince === null || key(value) !== key(last.value)) {
        agreedSince = clock.now().getTime()
      }
      last = { value }
    } catch (error) {
      if (stop.error === undefined && isPassingFailure(error)) {
        failures += 1
        failure = /** @type {RemoteError} */ (error)
        agreedSince = null
      } else {
        stop.error ??= error
        throw error
      }
    }
    const now = clock.now().getTime()
    if (last !== null && agreedSince !== null) {
      if (now - since >= SETTLE.minMs && now - agreedSince >= SETTLE.stableMs) {
        return { value: last.value, settled: true, reads, changes, failures }
      }
    }
    if (now - since >= SETTLE.maxMs) {
      if (failure === null && last !== null) {
        return { value: last.value, settled: false, reads, changes, failures }
      }
      const error = gaveUp(what, failure, failures)
      stop.error ??= error
      throw error
    }
  }
}

/**
 * The error when the budget ran out after reads had failed.
 * @param {string} what
 * @param {RemoteError | null} failure The last failed read.
 * @param {number} failures
 * @returns {RemoteError}
 */
function gaveUp(what, failure, failures) {
  const tail = /** @type {string[]} */ (failure?.details?.tail ?? [])
  return new RemoteError(
    `setup could not read back ${what} steadily within ${SETTLE.maxMs / 1000} s: ${failures} ${failures === 1 ? 'read' : 'reads'} failed, the last with: ${failure?.message ?? 'no answer'}`,
    { status: failure?.status, tail, cause: failure ?? undefined },
  )
}

/**
 * The summary note for a setting whose reads did not settle; the line before it shows the last
 * read.
 * @param {string} what For example `push protection setting`.
 * @param {Settled<unknown>} read
 * @param {string} root The main checkout, for the resume command.
 * @returns {string}
 */
export function unsettled(what, read, root) {
  return `the ${what} read back from GitHub changed ${read.changes} times in ${SETTLE.maxMs / 1000} s, and the line above shows the last read; GitHub may hold another value. To read it again later, ${runIn('hackwin setup --resume', root)}`
}

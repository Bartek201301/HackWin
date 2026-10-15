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

import { runIn } from '../../core/runtime/index.js'

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
 * @property {number} reads
 * @property {number} changes How often a read differed from the one before it.
 */

/**
 * Read a setting until it settles.
 * @template T
 * @param {Clock} clock
 * @param {() => Promise<T>} read
 * @param {object} options
 * @param {number} options.since The time of the last write, in milliseconds since the epoch.
 * @param {(value: T) => string} [options.key] What two reads compare; JSON by default.
 * @returns {Promise<Settled<T>>}
 */
export async function settledRead(clock, read, { since, key = (value) => JSON.stringify(value) }) {
  let value = await read()
  let agreedSince = clock.now().getTime()
  let reads = 1
  let changes = 0
  for (;;) {
    const now = clock.now().getTime()
    if (now - since >= SETTLE.minMs && now - agreedSince >= SETTLE.stableMs) {
      return { value, settled: true, reads, changes }
    }
    if (now - since >= SETTLE.maxMs) return { value, settled: false, reads, changes }
    await clock.sleep(SETTLE.intervalMs)
    const next = await read()
    reads += 1
    if (key(next) !== key(value)) {
      value = next
      agreedSince = clock.now().getTime()
      changes += 1
    }
  }
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

// The injectable clock. Commands read the time and wait only through ctx.clock, so tests can run
// a Gate loop or a timeout without real waiting.

/**
 * @typedef {object} Clock
 * @property {() => Date} now
 * @property {(ms: number) => Promise<void>} sleep
 */

/** The real clock. @type {Clock} */
export const systemClock = Object.freeze({
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
})

/**
 * @typedef {Clock & { advance(ms: number): void, set(time: Date | string): void }} FakeClock
 */

/**
 * A clock for tests: `sleep` moves the time forward at once instead of waiting.
 * @param {Date | string} [start]
 * @returns {FakeClock}
 */
export function createFakeClock(start = '2026-01-01T00:00:00.000Z') {
  let time = new Date(start).getTime()
  return {
    now: () => new Date(time),
    sleep: async (ms) => {
      time += ms
    },
    advance: (ms) => {
      time += ms
    },
    set: (value) => {
      time = new Date(value).getTime()
    },
  }
}

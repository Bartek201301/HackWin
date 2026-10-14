// The runtime every command builds on: exit codes and errors, output, process execution, the
// clock and the caller kind. See docs/build/contracts.md.

export {
  EXIT,
  HackwinError,
  BlockedError,
  ConfigError,
  PreconditionError,
  UsageError,
  NotBuiltError,
  GitError,
  RemoteError,
  exitCodeOf,
} from './errors.js'
export { createOutput, runIn, formatResolve, formatError } from './output.js'
export { exec, execShell, quoteShellArg, DEFAULT_TAIL_LINES } from './exec.js'
export { systemClock, createFakeClock } from './clock.js'
export { detectCallerKind, CALLER_ENV } from './caller.js'

/** @typedef {import('./errors.js').RunIn} RunIn */
/** @typedef {import('./errors.js').Resolve} Resolve */
/** @typedef {import('./errors.js').ErrorJson} ErrorJson */
/** @typedef {import('./output.js').Output} Output */
/** @typedef {import('./output.js').Writer} Writer */
/** @typedef {import('./exec.js').ExecOptions} ExecOptions */
/** @typedef {import('./exec.js').ExecResult} ExecResult */
/** @typedef {import('./clock.js').Clock} Clock */
/** @typedef {import('./clock.js').FakeClock} FakeClock */
/** @typedef {import('./caller.js').CallerKind} CallerKind */

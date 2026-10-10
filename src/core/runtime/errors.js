// Exit codes (CM2) and the typed errors that commands throw. The runner maps each error to its
// exit code and prints it; a command never calls process.exit itself.

/** Exit codes of every hackwin command (CM2). */
export const EXIT = Object.freeze({
  /** Success. */
  OK: 0,
  /** A rule or check blocked the action. */
  BLOCKED: 1,
  /** Configuration or precondition error. */
  PRECONDITION: 2,
  /** GitHub or network failure. */
  REMOTE: 3,
})

/**
 * A command to run and the directory to run it in (CM4).
 * @typedef {object} RunIn
 * @property {string} command
 * @property {string} dir Absolute path, or a phrase such as "any directory" when the place does not matter.
 */

/**
 * How to resolve an error: a command with its directory, or a plain instruction that names no
 * command, such as "ask the Lead to add you to hackwin.yml".
 * @typedef {RunIn | string} Resolve
 */

/**
 * The JSON form of an error, printed by the runner with --json.
 * @typedef {object} ErrorJson
 * @property {string} kind
 * @property {string} message
 * @property {Resolve} [resolve]
 * @property {string} [rule]
 * @property {string[]} [objects]
 * @property {string} [key]
 * @property {Record<string, unknown>} [details]
 */

/** Base class of every error that carries an exit code. */
export class HackwinError extends Error {
  /**
   * @param {string} message
   * @param {object} options
   * @param {number} options.exitCode
   * @param {string} options.kind
   * @param {Resolve} [options.resolve]
   * @param {Record<string, unknown>} [options.details]
   * @param {unknown} [options.cause]
   */
  constructor(message, { exitCode, kind, resolve, details, cause }) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = new.target.name
    this.exitCode = exitCode
    this.kind = kind
    this.resolve = resolve
    this.details = details
  }

  /** @returns {ErrorJson} */
  toJSON() {
    /** @type {ErrorJson} */
    const json = { kind: this.kind, message: this.message }
    if (this.resolve !== undefined) json.resolve = this.resolve
    if (this.details !== undefined) json.details = this.details
    return json
  }
}

/**
 * A rule or check blocked the action (exit 1). CM5: it names the rule, the files or objects
 * involved, and how to resolve it.
 */
export class BlockedError extends HackwinError {
  /**
   * @param {string} message
   * @param {object} options
   * @param {string} options.rule The rule, for example "E1 scope".
   * @param {string[]} options.objects The files or objects involved, at least one.
   * @param {Resolve} options.resolve
   * @param {Record<string, unknown>} [options.details]
   * @param {unknown} [options.cause]
   */
  constructor(message, { rule, objects, resolve, details, cause }) {
    if (!rule) throw new TypeError('BlockedError needs the rule (CM5)')
    if (!Array.isArray(objects) || objects.length === 0) {
      throw new TypeError('BlockedError needs the files or objects involved (CM5)')
    }
    assertResolve(resolve, 'BlockedError')
    super(message, { exitCode: EXIT.BLOCKED, kind: 'blocked', resolve, details, cause })
    this.rule = rule
    this.objects = objects
  }

  toJSON() {
    return { ...super.toJSON(), rule: this.rule, objects: this.objects }
  }
}

/** The configuration is invalid (exit 2). It names the key, for example `team.members`. */
export class ConfigError extends HackwinError {
  /**
   * @param {string} message
   * @param {object} [options]
   * @param {string} [options.key] The key that breaks a rule, in dotted form.
   * @param {Resolve} [options.resolve]
   * @param {Record<string, unknown>} [options.details]
   * @param {unknown} [options.cause]
   */
  constructor(message, { key, resolve, details, cause } = {}) {
    super(message, { exitCode: EXIT.PRECONDITION, kind: 'config', resolve, details, cause })
    this.key = key
  }

  toJSON() {
    return this.key === undefined ? super.toJSON() : { ...super.toJSON(), key: this.key }
  }
}

/** A precondition of the command does not hold (exit 2), for example `join` has not run. */
export class PreconditionError extends HackwinError {
  /**
   * @param {string} message
   * @param {object} [options]
   * @param {Resolve} [options.resolve]
   * @param {Record<string, unknown>} [options.details]
   * @param {unknown} [options.cause]
   */
  constructor(message, { resolve, details, cause } = {}) {
    super(message, { exitCode: EXIT.PRECONDITION, kind: 'precondition', resolve, details, cause })
  }
}

/** The command line is wrong: unknown command, unknown flag, missing argument (exit 2). */
export class UsageError extends HackwinError {
  /**
   * @param {string} message
   * @param {object} [options]
   * @param {Resolve} [options.resolve]
   */
  constructor(message, { resolve } = {}) {
    super(message, { exitCode: EXIT.PRECONDITION, kind: 'usage', resolve })
  }
}

/** A known command whose module does not exist yet (exit 2). */
export class NotBuiltError extends HackwinError {
  /**
   * @param {string} command
   * @param {string} module Module path relative to the package root.
   * @param {string} [reason] Default: the module does not exist yet.
   */
  constructor(command, module, reason = `not built yet: ${module} does not exist`) {
    super(reason, {
      exitCode: EXIT.PRECONDITION,
      kind: 'not-built',
      details: { command, module },
    })
  }
}

/** A git command failed for a local reason (exit 2). Fetch and push failures are RemoteError. */
export class GitError extends HackwinError {
  /**
   * @param {string} message
   * @param {object} options
   * @param {string[]} options.args The git arguments.
   * @param {number | null} options.code
   * @param {string[]} options.tail The last lines of the output.
   */
  constructor(message, { args, code, tail }) {
    super(message, { exitCode: EXIT.PRECONDITION, kind: 'git', details: { args, code, tail } })
  }
}

/** GitHub or the network failed (exit 3): a failing `gh` call, fetch or push. */
export class RemoteError extends HackwinError {
  /**
   * @param {string} message
   * @param {object} [options]
   * @param {number} [options.status] HTTP status, when GitHub answered with one.
   * @param {string[]} [options.tail] The last lines of the output.
   * @param {Resolve} [options.resolve]
   * @param {unknown} [options.cause]
   */
  constructor(message, { status, tail, resolve, cause } = {}) {
    super(message, {
      exitCode: EXIT.REMOTE,
      kind: 'remote',
      resolve,
      details: { status: status ?? null, tail: tail ?? [] },
      cause,
    })
    this.status = status
  }
}

/**
 * The exit code for any thrown value. An error that is not a HackwinError is a bug in hackwin and
 * exits 2, the code for an error that the caller cannot fix by retrying.
 * @param {unknown} error
 * @returns {number}
 */
export function exitCodeOf(error) {
  return error instanceof HackwinError ? error.exitCode : EXIT.PRECONDITION
}

/**
 * @param {unknown} resolve
 * @param {string} owner
 */
function assertResolve(resolve, owner) {
  if (typeof resolve === 'string' && resolve.trim() !== '') return
  if (
    resolve !== null &&
    typeof resolve === 'object' &&
    'command' in resolve &&
    'dir' in resolve &&
    typeof resolve.command === 'string' &&
    resolve.command !== '' &&
    typeof resolve.dir === 'string' &&
    resolve.dir !== ''
  ) {
    return
  }
  throw new TypeError(`${owner} needs how to resolve it: { command, dir } (CM4) or an instruction`)
}

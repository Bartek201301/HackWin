// Reading the parsed YAML of hackwin.yml and owners.yml. Every complaint is a ConfigError that
// names the file and the key exactly as the file spells it, for example
// `team.members[1].sessions` (zero-based index).

import { parseDocument } from 'yaml'
import { ConfigError } from '../runtime/errors.js'

/**
 * A ConfigError for one key of one file.
 * @param {string} file `hackwin.yml` or `owners.yml`.
 * @param {string | undefined} key
 * @param {string} message What is wrong, as the rest of a sentence that starts with the key.
 * @returns {ConfigError}
 */
export function configError(file, key, message) {
  return new ConfigError(key ? `${file}: ${key} ${message}` : `${file}: ${message}`, {
    key,
    details: { file },
  })
}

/**
 * Parse YAML text. Syntax errors and duplicate keys are ConfigErrors.
 * @param {string} file
 * @param {string} text
 * @returns {unknown}
 */
export function parseYaml(file, text) {
  const document = parseDocument(text)
  const [error] = document.errors
  if (error) {
    // The first line of the message ends with the place, for example "at line 2, column 9:".
    const reason = error.message.split('\n')[0].replace(/:$/, '')
    throw configError(file, undefined, `is not valid YAML: ${reason}`)
  }
  return document.toJS()
}

/**
 * Typed access to the keys of one mapping.
 */
export class Fields {
  /**
   * @param {string} file
   * @param {string} prefix The dotted key of this mapping, empty at the top.
   * @param {unknown} value
   * @param {string[]} known The keys this mapping may have.
   */
  constructor(file, prefix, value, known) {
    this.file = file
    this.prefix = prefix
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw configError(file, prefix || undefined, 'must be a mapping')
    }
    /** @type {Record<string, unknown>} */
    this.value = /** @type {Record<string, unknown>} */ (value)
    for (const key of Object.keys(this.value)) {
      if (!known.includes(key)) throw this.error(key, 'is not a known key')
    }
  }

  /**
   * @param {string} key
   * @returns {string}
   */
  key(key) {
    return this.prefix ? `${this.prefix}.${key}` : key
  }

  /**
   * @param {string} key
   * @param {string} message
   * @returns {ConfigError}
   */
  error(key, message) {
    return configError(this.file, this.key(key), message)
  }

  /** @param {string} key */
  has(key) {
    return this.value[key] !== undefined && this.value[key] !== null
  }

  /**
   * A nested mapping. Absent or null counts as empty when `optional`.
   * @param {string} key
   * @param {string[]} known
   * @param {{ optional?: boolean }} [options]
   * @returns {Fields}
   */
  mapping(key, known, { optional = false } = {}) {
    if (!this.has(key)) {
      if (optional) return new Fields(this.file, this.key(key), {}, known)
      throw this.error(key, 'is missing')
    }
    return new Fields(this.file, this.key(key), this.value[key], known)
  }

  /**
   * @param {string} key
   * @param {{ fallback?: string, nonEmpty?: boolean }} [options] Without `fallback` the key is
   *   required.
   * @returns {string}
   */
  string(key, { fallback, nonEmpty = true } = {}) {
    if (!this.has(key)) {
      if (fallback !== undefined) return fallback
      throw this.error(key, nonEmpty ? 'is missing; it must be a non-empty string' : 'is missing')
    }
    const value = this.value[key]
    if (typeof value !== 'string') throw this.error(key, 'must be a string')
    if (nonEmpty && value.trim() === '') throw this.error(key, 'must not be empty')
    return value
  }

  /**
   * A non-empty string or null; absent is null.
   * @param {string} key
   * @returns {string | null}
   */
  optionalString(key) {
    if (!this.has(key)) return null
    return this.string(key)
  }

  /**
   * @param {string} key
   * @param {{ fallback?: number, min?: number }} [options] Without `fallback` the key is required.
   * @returns {number}
   */
  integer(key, { fallback, min = 0 } = {}) {
    if (!this.has(key)) {
      if (fallback !== undefined) return fallback
      throw this.error(key, 'is missing')
    }
    const value = this.value[key]
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw this.error(key, 'must be an integer')
    }
    if (value < min) throw this.error(key, `must be ${min} or more, not ${value}`)
    return value
  }

  /**
   * @param {string} key
   * @param {boolean} fallback
   * @returns {boolean}
   */
  boolean(key, fallback) {
    if (!this.has(key)) return fallback
    const value = this.value[key]
    if (typeof value !== 'boolean') throw this.error(key, 'must be true or false')
    return value
  }

  /**
   * A list of strings; absent or null is an empty list.
   * @param {string} key
   * @param {{ check?: (item: string) => string | null }} [options] `check` gives a reason to
   *   reject an item, or null.
   * @returns {string[]}
   */
  strings(key, { check } = {}) {
    if (!this.has(key)) return []
    const value = this.value[key]
    if (!Array.isArray(value)) throw this.error(key, 'must be a list')
    return value.map((item, index) => {
      const itemKey = `${key}[${index}]`
      if (typeof item !== 'string' || item === '') {
        throw this.error(itemKey, 'must be a non-empty string')
      }
      const reason = check?.(item)
      if (reason) throw this.error(itemKey, `(${item}) ${reason}`)
      return item
    })
  }

  /**
   * A list of anything, for lists of mappings.
   * @param {string} key
   * @returns {unknown[]}
   */
  list(key) {
    if (!this.has(key)) throw this.error(key, 'is missing')
    const value = this.value[key]
    if (!Array.isArray(value)) throw this.error(key, 'must be a list')
    return value
  }
}

/**
 * True for an ISO 8601 date and time with an offset, such as `2026-10-17T23:59:00+02:00`.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isIsoTimeWithOffset(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  )
}

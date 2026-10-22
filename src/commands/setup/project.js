// Steps 6 and 7 of `setup` (7.1): the event's start and end, the project language (A37) and the
// default branch, and the repository's visibility, which setup reports and never changes. An event
// time is ISO 8601 with an offset in hackwin.yml; setup also takes `YYYY-MM-DD HH:MM`, read in the
// time zone of this machine, and stores and shows it with the offset that holds on that day.

import { languageName } from '../../generate/index.js'

/** @import { HackwinConfig } from '../../core/config/index.js' */
/** @import { Questions } from './questions.js' */

/** The project language when nobody names another (A37). */
export const DEFAULT_LANGUAGE = 'en'

/** An example of the time format of hackwin.yml. */
const TIME_EXAMPLE = '2026-10-24T09:00:00+02:00'

/** An example of the time format that setup asks for. */
const LOCAL_EXAMPLE = '2026-10-24 09:00'

/** What the questions of step 6 decide, in the words of the team. */
export const PROJECT_INTRO =
  'The event and the language: when the event begins, when the submission is due, which status counts down to, and the language of code, commits, issues and pull requests.'

/**
 * The `project` section of hackwin.yml.
 * @param {Questions} questions
 * @param {object} options
 * @param {string} options.defaultBranch The repository's default branch on GitHub.
 * @returns {Promise<HackwinConfig['project']>}
 */
export async function askProject(questions, { defaultBranch }) {
  const branch = questions.given('project.default_branch')
  if (branch !== undefined && branch !== defaultBranch) {
    throw questions.error(
      'project.default_branch',
      `(${String(branch)}) is not the default branch of the repository on GitHub, ${defaultBranch}`,
    )
  }
  if (
    questions.interactive &&
    ['project.event.start', 'project.event.end', 'project.language'].some(
      (key) => !questions.has(key),
    )
  ) {
    questions.say(PROJECT_INTRO)
  }
  const start = await askTime(
    questions,
    'project.event.start',
    'Event start, the hour the event begins',
  )
  const end = await askTime(
    questions,
    'project.event.end',
    'Event end, the submission deadline',
    start,
  )

  /** @type {unknown} */
  let language = questions.given('project.language')
  if (language === undefined) {
    language = questions.interactive
      ? await questions.ask('Project language of code, commits, issues and pull requests', {
          fallback: DEFAULT_LANGUAGE,
        })
      : DEFAULT_LANGUAGE
  }
  if (typeof language !== 'string' || language.trim() === '') {
    throw questions.error('project.language', 'must be a language, such as en')
  }
  questions.say(
    `project: event from ${start} to ${end}, language ${languageName(language.trim())}, default branch ${defaultBranch}`,
  )
  return { default_branch: defaultBranch, language: language.trim(), event: { start, end } }
}

/**
 * Step 7: the visibility, for the summary line. Public is the default recommendation, because a
 * public repository gets GitHub's branch rules for free; setup never changes it.
 * @param {Questions} questions
 * @param {{ nameWithOwner: string, visibility: string }} repository
 * @returns {string}
 */
export function reportVisibility(questions, { nameWithOwner, visibility }) {
  const line =
    visibility === 'public'
      ? `visibility: ${nameWithOwner} is public, the recommended setting: GitHub's branch rules are free on a public repository`
      : `visibility: ${nameWithOwner} is ${visibility}; setup does not change that. Public is recommended: GitHub's branch rules are free on a public repository, and a private repository of a personal account on a free plan gets none`
  questions.say(line)
  return visibility
}

/**
 * An event time from the answers file or the terminal, as hackwin.yml stores it, and for the end,
 * after the start. A time given as `YYYY-MM-DD HH:MM` is shown as stored.
 * @param {Questions} questions
 * @param {string} key
 * @param {string} question
 * @param {string} [after] The start, which the end must follow.
 * @returns {Promise<string>}
 */
async function askTime(questions, key, question, after) {
  const zone = machineZone()
  const name = question.split(',')[0]
  /** @returns {{ time: string, problem?: undefined } | { problem: string }} */
  const read = (/** @type {unknown} */ value) => {
    const time = typeof value === 'string' ? eventTime(value) : null
    if (time === SKIPPED) {
      return {
        problem: `is a time that the clock of this machine skips in ${zone}, such as an hour lost to daylight saving time`,
      }
    }
    if (time === null) {
      return {
        problem: `must be a date and time as YYYY-MM-DD HH:MM, such as ${LOCAL_EXAMPLE}, or an ISO 8601 time with an offset, such as ${TIME_EXAMPLE}`,
      }
    }
    if (after !== undefined && Date.parse(time) <= Date.parse(after)) {
      return { problem: `must be after the event start, ${after}` }
    }
    return { time }
  }
  /** @type {unknown} */
  let value
  if (questions.has(key)) {
    value = questions.given(key)
  } else if (questions.interactive) {
    value = await questions.ask(
      `${question}, as YYYY-MM-DD HH:MM in ${zone}, such as ${LOCAL_EXAMPLE}`,
      { check: (answer) => read(answer).problem ?? null },
    )
  } else {
    throw questions.missing(key, `the ${question.toLowerCase()}`)
  }
  const result = read(value)
  if (result.problem !== undefined) throw questions.error(key, result.problem)
  if (result.time !== value) questions.say(`  ${name}: ${result.time}, in ${zone}`)
  return result.time
}

/** What eventTime returns for a time that the clock of this machine skips. */
const SKIPPED = 'skipped'

/**
 * An event time as hackwin.yml stores it: ISO 8601 with an offset as it is, or `YYYY-MM-DD HH:MM`
 * read in the time zone of this machine, with seconds and the offset that holds at that time.
 * SKIPPED for a time that the clock skips there, such as an hour lost to daylight saving time;
 * null for anything else.
 * @param {string} value
 * @returns {string | null}
 */
export function eventTime(value) {
  if (isTimeWithOffset(value)) return value
  const match = /^(\d{4})-(\d{2})-(\d{2}) +(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (match === null) return null
  const typed = match.slice(1).map(Number)
  const [year, month, day, hour, minute] = typed
  const utc = new Date(Date.UTC(year, month - 1, day, hour, minute))
  const utcFields = [
    utc.getUTCFullYear(),
    utc.getUTCMonth() + 1,
    utc.getUTCDate(),
    utc.getUTCHours(),
    utc.getUTCMinutes(),
  ]
  // A day or an hour that no calendar has, such as 2026-02-30 or 25:00.
  if (utcFields.join() !== typed.join()) return null
  const local = new Date(year, month - 1, day, hour, minute)
  const localFields = [
    local.getFullYear(),
    local.getMonth() + 1,
    local.getDate(),
    local.getHours(),
    local.getMinutes(),
  ]
  if (localFields.join() !== typed.join()) return SKIPPED
  const offset = -local.getTimezoneOffset()
  const pad = (/** @type {number} */ number) => String(number).padStart(2, '0')
  const sign = offset < 0 ? '-' : '+'
  const zone = `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00${zone}`
}

/**
 * The name of the time zone of this machine, such as Europe/Warsaw.
 * @returns {string}
 */
function machineZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'the time zone of this machine'
}

/**
 * The time format of `project.event` in hackwin.yml (6.1).
 * @param {string} value
 * @returns {boolean}
 */
function isTimeWithOffset(value) {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  )
}

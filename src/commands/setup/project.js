// Steps 6 and 7 of `setup` (7.1): the event's start and end, the project language (A37) and the
// default branch, and the repository's visibility, which setup reports and never changes.

import { languageName } from '../../generate/index.js'

/** @import { HackwinConfig } from '../../core/config/index.js' */
/** @import { Questions } from './questions.js' */

/** The project language when nobody names another (A37). */
export const DEFAULT_LANGUAGE = 'en'

/** An example of the time format, for the questions. */
const TIME_EXAMPLE = '2026-10-24T09:00:00+02:00'

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
 * An event time from the answers file or the terminal: ISO 8601 with an offset, and for the end,
 * after the start.
 * @param {Questions} questions
 * @param {string} key
 * @param {string} question
 * @param {string} [after] The start, which the end must follow.
 * @returns {Promise<string>}
 */
async function askTime(questions, key, question, after) {
  const problem = (/** @type {unknown} */ value) => {
    if (typeof value !== 'string' || !isTimeWithOffset(value)) {
      return `must be an ISO 8601 time with an offset, such as ${TIME_EXAMPLE}`
    }
    if (after !== undefined && Date.parse(value) <= Date.parse(after)) {
      return `must be after the event start, ${after}`
    }
    return null
  }
  if (questions.has(key)) {
    const value = questions.given(key)
    const reason = problem(value)
    if (reason !== null) throw questions.error(key, reason)
    return /** @type {string} */ (value)
  }
  if (!questions.interactive) throw questions.missing(key, `the ${question.toLowerCase()}`)
  return questions.ask(`${question}, as ${TIME_EXAMPLE}`, {
    check: (value) => problem(value),
  })
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

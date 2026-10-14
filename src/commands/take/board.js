// What `take` reads from GitHub: the open task issues, the state of each dependency, the open
// pull requests and the files of each. Each list is read once per run and only when a step needs
// it, so a task that fails an early check costs no pull request calls.

import { toTask } from '../../core/tasks/index.js'

/** @import { GitHub, Issue, PullRequest } from '../../core/github/index.js' */
/** @import { Config } from '../../core/config/index.js' */
/** @import { Task } from '../../core/tasks/index.js' */

/**
 * @typedef {object} OpenPull
 * @property {number} number
 * @property {string} title
 * @property {string[]} paths Every path the pull request changes; both paths of a rename.
 */

/**
 * @typedef {object} Board
 * @property {() => Promise<Task[]>} tasks The open task issues, valid or not, by number.
 * @property {(number: number) => Promise<Issue | null>} issue An issue by number; null when it
 *   does not exist.
 * @property {() => Promise<PullRequest[]>} openPulls The open pull requests, drafts included,
 *   by number.
 * @property {() => Promise<OpenPull[]>} pulls The open pull requests with the paths each changes.
 */

/**
 * @param {GitHub} github
 * @param {Config} config
 * @returns {Board}
 */
export function createBoard(github, config) {
  /** @type {Promise<Issue[]> | undefined} */
  let openIssues
  /** @type {Promise<Task[]> | undefined} */
  let tasks
  /** @type {Promise<PullRequest[]> | undefined} */
  let openPulls
  /** @type {Promise<OpenPull[]> | undefined} */
  let pulls
  /** @type {Map<number, Promise<Issue | null>>} */
  const issues = new Map()

  const listOpen = () => (openIssues ??= github.listIssues({ state: 'open' }))
  const listOpenPulls = () =>
    (openPulls ??= github
      .listPullRequests({ state: 'open' })
      .then((list) => list.sort((a, b) => a.number - b.number)))

  return {
    tasks() {
      tasks ??= listOpen().then((list) =>
        list
          .map((issue) => toTask(issue, config))
          .filter((task) => task !== null)
          .sort((a, b) => a.number - b.number),
      )
      return tasks
    },

    issue(number) {
      let found = issues.get(number)
      if (!found) {
        found = listOpen().then(
          (list) => list.find((issue) => issue.number === number) ?? github.getIssue(number),
        )
        issues.set(number, found)
      }
      return found
    },

    openPulls: listOpenPulls,

    pulls() {
      pulls ??= listOpenPulls().then((list) =>
        Promise.all(
          list.map(async (pull) => ({
            number: pull.number,
            title: pull.title,
            paths: (await github.listPullRequestFiles(pull.number)).flatMap((file) =>
              file.previousPath ? [file.path, file.previousPath] : [file.path],
            ),
          })),
        ),
      )
      return pulls
    },
  }
}

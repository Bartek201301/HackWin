// The label catalogue of section 8.2, which `setup` creates, and the task status transitions as
// label edits (8.3). The `role:<name>` labels depend on owners.yml and come from roleLabel.

/** @import { GitHub, Label } from '../github/index.js' */

/** Every label of 8.2 except the `role:` labels: name, color (six hex digits) and description. */
export const LABELS = Object.freeze(
  /** @type {Label[]} */ ([
    {
      name: 'ready',
      color: '0e8a16',
      description: 'Released for work and takeable: its dependencies are closed',
    },
    {
      name: 'blocked',
      color: 'd93f0b',
      description: 'Released for work, waiting for a dependency',
    },
    { name: 'in-progress', color: 'fbca04', description: 'A session works on it' },
    {
      name: 'in-review',
      color: '1d76db',
      description: 'A pull request exists and waits for the Gate',
    },
    { name: 'cut', color: '6a737d', description: 'Dropped by decision of the Lead' },
    { name: 'proposal', color: 'c5def5', description: 'A proposal for a task (Phase 2)' },
    { name: 'needs-lead', color: 'd876e3', description: 'Waits for the Lead (Phase 2)' },
    { name: 'integration', color: 'bfdadc', description: 'An integration task (Phase 2)' },
    {
      name: 'contract-change',
      color: 'f9d0c4',
      description: 'A contract change request (Phase 2)',
    },
    { name: 'approved', color: 'c2e0c6', description: 'Accepted by the Lead (Phase 2)' },
    {
      name: 'contract-changed',
      color: 'fef2c0',
      description: 'An approved contract change affects this work (Phase 2)',
    },
    { name: 'gate:queued', color: 'ededed', description: 'Gate: waits in the merge queue' },
    {
      name: 'gate:testing',
      color: '0052cc',
      description: 'Gate: tests the merge with the newest main',
    },
    {
      name: 'gate:waiting-ci',
      color: '5319e7',
      description: 'Gate: waits for CI on the exact head SHA',
    },
    { name: 'gate:merged', color: '0e8a16', description: 'Gate: merged' },
    {
      name: 'gate:failed',
      color: 'b60205',
      description: "Gate: a stage failed; see the Gate's comment",
    },
    { name: 'needs-owner', color: 'e99695', description: 'The pull request author must act' },
    {
      name: 'scope-violation',
      color: 'b60205',
      description: "Changes files outside its author's scope",
    },
    {
      name: 'hotspot',
      color: 'f9d0c4',
      description: 'Another open pull request changes the same file (Phase 3)',
    },
    {
      name: 'gate-status',
      color: '000000',
      description: 'The status issue of the Gate; not a task',
    },
  ]).map((label) => Object.freeze(label)),
)

/** The labels that carry the status of an open task (8.3). `cut` is the Lead's and stays. */
export const STATUS_LABELS = Object.freeze(['ready', 'blocked', 'in-progress', 'in-review'])

/** The statuses that setTaskStatus sets. */
const SETTABLE = Object.freeze(['ready', 'in-progress', 'in-review'])

/**
 * The label of an ownership role.
 * @param {string} role
 * @returns {string}
 */
export function roleLabel(role) {
  return `role:${role}`
}

/**
 * Set the status of a task as a label edit only (8.3): add this status label, then remove the
 * other status labels the issue carries. Adding first means the issue is never without a status.
 * @param {GitHub} github
 * @param {number} number
 * @param {'ready' | 'in-progress' | 'in-review'} status
 * @returns {Promise<string[]>} The labels of the issue afterwards.
 */
export async function setTaskStatus(github, number, status) {
  if (!SETTABLE.includes(status)) {
    throw new TypeError(`setTaskStatus sets ${SETTABLE.join(', ')}, not ${status}`)
  }
  const labels = await github.addLabels(number, [status])
  const stale = labels.filter((label) => label !== status && STATUS_LABELS.includes(label))
  for (const label of stale) await github.removeLabel(number, label)
  return labels.filter((label) => !stale.includes(label))
}

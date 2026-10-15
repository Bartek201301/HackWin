// Step 10 of `setup` (7.1), its first half: every label of 8.2 on GitHub, from the catalogue of
// src/core/tasks, with the `role:` label of each ownership role of owners.yml. A label that
// exists already, in any letter case, stays as the team has it, so a rerun never creates a
// second one (CM3).

import { LABELS, roleLabel } from '../../core/tasks/index.js'

/** @import { GitHub, Label } from '../../core/github/index.js' */

/** The color of the `role:` labels. */
const ROLE_COLOR = 'bfd4f2'

/**
 * The labels of 8.2 for these ownership roles: the `role:` labels first, as 8.2 lists them.
 * @param {readonly string[]} roles The role names of owners.yml.
 * @returns {Label[]}
 */
export function labelCatalogue(roles) {
  return [
    ...roles.map((role) => ({
      name: roleLabel(role),
      color: ROLE_COLOR,
      description: `Ownership role ${role} of owners.yml`,
    })),
    ...LABELS,
  ]
}

/**
 * Create every label of the catalogue that the repository lacks.
 * @param {GitHub} github
 * @param {readonly string[]} roles
 * @returns {Promise<{ created: string[], existing: string[] }>} The names created now, and those
 *   that were there.
 */
export async function createLabels(github, roles) {
  const present = new Set((await github.listLabels()).map((label) => label.name.toLowerCase()))
  const created = []
  const existing = []
  for (const label of labelCatalogue(roles)) {
    if (present.has(label.name.toLowerCase())) {
      existing.push(label.name)
      continue
    }
    await github.createLabel(label)
    present.add(label.name.toLowerCase())
    created.push(label.name)
  }
  return { created, existing }
}

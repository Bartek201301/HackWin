// `hackwin gate` (7.5): the Gate, run by the Lead in a separate terminal on the Lead's laptop for
// the whole event. It tests and merges pull requests one at a time without a model (section 9).

import { startGate } from './gate.js'

/** @import { CommandContext, CommandResult } from '../../cli/context.js' */

/**
 * @param {CommandContext} ctx
 * @returns {Promise<CommandResult>}
 */
export async function run(ctx) {
  return startGate(ctx)
}

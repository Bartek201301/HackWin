// Attention items (9.6, G18) [D3]: the Lead is interrupted only for five types, each an item in
// the state file that the status issue shows until it closes (A54). A pull request has at most
// one open item of a type: a later finding of the same type updates its text. The Gate prints
//
//   ATTENTION <type> #<PR>: <what the Lead must do>
//
// in its terminal when an item opens or its text changes. When a secret item opens, the Gate
// also raises one operating system notification, or rings the terminal bell where none is shown
// (G26) [D16]. The other types raise neither.

/** @import { Gate } from './gate.js' */
/** @import { AttentionItem } from './state.js' */
/** @import { Notifier } from './notify.js' */

/** The five attention types (G18). */
export const ATTENTION_TYPES = Object.freeze([
  'migration',
  'production-config',
  'scope-violation',
  'repeated-failure',
  'secret',
])

/** The terminal bell (G26), rung when no notification is shown. */
export const BELL = '\u0007'

/**
 * The attention line of an item.
 * @param {Pick<AttentionItem, 'type' | 'pr' | 'todo'>} item
 * @returns {string}
 */
export function attentionLine({ type, pr, todo }) {
  return `ATTENTION ${type} #${pr}: ${todo}`
}

/**
 * The open item of this type for the pull request, or undefined.
 * @param {Gate} gate
 * @param {string} type
 * @param {number} pr
 * @returns {AttentionItem | undefined}
 */
export function openItem(gate, type, pr) {
  return gate.state.attention.find(
    (item) => item.type === type && Number(item.pr) === pr && !item.resolved_at,
  )
}

/**
 * Open an attention item, or update the text of the open item of this type for the pull request.
 * Prints the attention line when the item opens or its text changes; a secret item that opens
 * also notifies (G26).
 * @param {Gate} gate
 * @param {Notifier} notifier
 * @param {{ type: string, pr: number, todo: string }} raised
 * @returns {Promise<{ item: AttentionItem, opened: boolean }>}
 */
export async function raiseAttention(gate, notifier, { type, pr, todo }) {
  const open = openItem(gate, type, pr)
  if (open) {
    if (open.todo !== todo) {
      open.todo = todo
      gate.ctx.out.line(attentionLine(open))
    }
    return { item: open, opened: false }
  }
  /** @type {AttentionItem} */
  const item = { type, pr, since: gate.ctx.clock.now().toISOString(), todo, resolved_at: null }
  gate.state.attention.push(item)
  gate.ctx.out.line(attentionLine(item))
  if (type === 'secret') await notifySecret(gate, notifier, item)
  return { item, opened: true }
}

/**
 * Close the open items of these types for the pull request (9.6), with a line that says why.
 * @param {Gate} gate
 * @param {{ pr: number, types: readonly string[], why: string }} closing
 * @returns {AttentionItem[]} The items it closed.
 */
export function closeAttention(gate, { pr, types, why }) {
  const at = gate.ctx.clock.now().toISOString()
  const closed = gate.state.attention.filter(
    (item) => types.includes(item.type) && Number(item.pr) === pr && !item.resolved_at,
  )
  for (const item of closed) {
    item.resolved_at = at
    gate.line(`#${pr}: the ${item.type} attention item is closed: ${why}`)
  }
  return closed
}

/**
 * One operating system notification for a secret item, or the terminal bell when the platform
 * shows none or the command fails (G26, docs/verification.md row 18).
 * @param {Gate} gate
 * @param {Notifier} notifier
 * @param {AttentionItem} item
 */
async function notifySecret(gate, notifier, item) {
  /** @type {{ shown: boolean, reason: string | null }} */
  let notified
  try {
    notified = await notifier({ title: `HackWin Gate: secret in #${item.pr}`, message: item.todo })
  } catch (error) {
    notified = { shown: false, reason: error instanceof Error ? error.message : String(error) }
  }
  if (notified.shown) return
  gate.ctx.out.write(BELL)
  gate.line(
    `no operating system notification for the secret in #${item.pr} (${notified.reason ?? 'not shown'}), so the terminal bell rang`,
  )
}

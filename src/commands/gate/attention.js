// Attention items (9.6, G18) [D3]: the Lead is interrupted only for five types, each an item in
// the state file that the status issue shows until it closes (A54). A pull request has at most
// one open item of a type: a later finding of the same type updates its text. A repeated failure
// is the exception: it names the stage whose pass closes it (9.6), so a pull request has at most
// one open repeated failure item per stage, and one more per stage for failures that ran across
// queue items (repeated.js), which the pass of any queue item closes. The Gate prints
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

/** The attention types that close when the pull request is merged or closed (9.6). */
export const CLOSED_WITH_THE_PULL = Object.freeze([
  'migration',
  'production-config',
  'scope-violation',
  'repeated-failure',
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
 * What tells one attention item from another: the type and the pull request, and for a repeated
 * failure also the stage and whether it ran across queue items. An item across queue items
 * belongs to its stage alone: a longer run of failures updates it, whatever pull request failed
 * last.
 * @typedef {object} AttentionKey
 * @property {string} type
 * @property {number} pr
 * @property {string | null} [stage]
 * @property {boolean} [across]
 */

/**
 * True when the item is the one of this key.
 * @param {AttentionItem} item
 * @param {AttentionKey} key
 * @returns {boolean}
 */
function isItemOf(item, { type, pr, stage = null, across = false }) {
  if (item.type !== type) return false
  if (type !== 'repeated-failure') return Number(item.pr) === pr
  if ((item.stage ?? null) !== stage || Boolean(item.across) !== across) return false
  return across || Number(item.pr) === pr
}

/**
 * The open item of this key, or undefined.
 * @param {Gate} gate
 * @param {AttentionKey} key
 * @returns {AttentionItem | undefined}
 */
export function openItem(gate, key) {
  return gate.state.attention.find((item) => !item.resolved_at && isItemOf(item, key))
}

/**
 * Open an attention item, or update the text of the open item of its key. Prints the attention
 * line when the item opens or its text changes; a secret item that opens also notifies (G26).
 * @param {Gate} gate
 * @param {Notifier} notifier
 * @param {AttentionKey & { todo: string }} raised `stage` and `across` count for a repeated
 *   failure only.
 * @returns {Promise<{ item: AttentionItem, opened: boolean }>}
 */
export async function raiseAttention(gate, notifier, { todo, ...key }) {
  const open = openItem(gate, key)
  if (open) {
    if (open.todo !== todo) {
      open.todo = todo
      gate.ctx.out.line(attentionLine(open))
    }
    return { item: open, opened: false }
  }
  const { type, pr } = key
  /** @type {AttentionItem} */
  const item = { type, pr, since: gate.ctx.clock.now().toISOString(), todo, resolved_at: null }
  if (type === 'repeated-failure') {
    item.stage = key.stage ?? null
    if (key.across) item.across = true
  }
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
  return closeItems(gate, (item) => types.includes(item.type) && Number(item.pr) === pr, why)
}

/**
 * Close the open repeated failure items that a pass of this stage closes (9.6): those of the pull
 * request for the stage, and those for the stage that ran across queue items.
 * @param {Gate} gate
 * @param {{ pr: number, stage: string, why: string }} passed
 * @returns {AttentionItem[]} The items it closed.
 */
export function closeOnPass(gate, { pr, stage, why }) {
  return closeItems(
    gate,
    (item) =>
      item.type === 'repeated-failure' &&
      (item.stage ?? null) === stage &&
      (item.across === true || Number(item.pr) === pr),
    why,
  )
}

/**
 * Close the open items that `which` selects, each with a line that says why.
 * @param {Gate} gate
 * @param {(item: AttentionItem) => boolean} which
 * @param {string} why
 * @returns {AttentionItem[]}
 */
function closeItems(gate, which, why) {
  const at = gate.ctx.clock.now().toISOString()
  const closed = gate.state.attention.filter((item) => !item.resolved_at && which(item))
  for (const item of closed) {
    item.resolved_at = at
    gate.line(`#${item.pr}: the ${item.type} attention item is closed: ${why}`)
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

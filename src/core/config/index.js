// Configuration, ownership, identity, the version check and the fast-forward of the main
// checkout. See docs/build/contracts.md section 4.4.

export { loadConfig, loadProposedConfig } from './load.js'
export { parseHackwinConfig } from './hackwin.js'
export { parseOwners } from './owners.js'
export { validateConfig } from './validate.js'
export { ownerOf, rolesOf, scopeCheck } from './ownership.js'
export { resolveIdentity } from './identity.js'
export { checkVersion, installCommand } from './version.js'
export { fastForwardMainCheckout } from './checkout.js'

/** @typedef {import('./load.js').Config} Config */
/** @typedef {import('./hackwin.js').HackwinConfig} HackwinConfig */
/** @typedef {import('./hackwin.js').Member} Member */
/** @typedef {import('./owners.js').Owners} Owners */
/** @typedef {import('./owners.js').Role} Role */
/** @typedef {import('./ownership.js').Owner} Owner */
/** @typedef {import('./ownership.js').ScopeResult} ScopeResult */
/** @typedef {import('./ownership.js').ScopeViolation} ScopeViolation */
/** @typedef {import('./identity.js').Identity} Identity */
/** @typedef {import('./version.js').VersionStatus} VersionStatus */
/** @typedef {import('./checkout.js').FastForwardStatus} FastForwardStatus */

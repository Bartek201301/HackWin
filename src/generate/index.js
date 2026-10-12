// Generators and templates of every committed file that HackWin generates (6.4), and the
// generated file manifest.

export { MANIFEST, generatedFiles, writeGeneratedFiles, staleGeneratedFiles } from './manifest.js'
export { GIT_HOOKS, SHIM_FILES, renderShim, shimPath } from './githooks.js'
export { generatedBy } from './header.js'

/** @typedef {import('./manifest.js').GenerateInput} GenerateInput */
/** @typedef {import('./manifest.js').GeneratedFileSpec} GeneratedFileSpec */
/** @typedef {import('./manifest.js').GeneratedFile} GeneratedFile */
/** @typedef {import('./manifest.js').StaleFile} StaleFile */
/** @typedef {import('./githooks.js').GitHook} GitHook */

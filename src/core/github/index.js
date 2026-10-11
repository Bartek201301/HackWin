// GitHub access through gh (CM7): the executor seam and the client with typed helpers.
// See docs/build/contracts.md.

export { createGhExecutor, GH_TIMEOUT_MS } from './executor.js'
export { GitHub, createGitHub, ghFailure, nullWhenNotFound } from './client.js'
export { parseGitHubRemote } from './remote.js'

/** @typedef {import('./executor.js').GhExecutor} GhExecutor */
/** @typedef {import('./executor.js').GhCall} GhCall */
/** @typedef {import('./executor.js').GhResult} GhResult */
/** @typedef {import('./client.js').Issue} Issue */
/** @typedef {import('./client.js').PullRequest} PullRequest */
/** @typedef {import('./client.js').PullRequestFile} PullRequestFile */
/** @typedef {import('./client.js').Comment} Comment */
/** @typedef {import('./client.js').Label} Label */
/** @typedef {import('./client.js').Repository} Repository */
/** @typedef {import('./client.js').ApiOptions} ApiOptions */

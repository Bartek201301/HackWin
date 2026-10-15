// Generators and templates of every committed file of 6.4: the generated files and their
// manifest, the Claude Code settings, the files that keep HackWin's own block, the documents and
// research files of the template, hackwin.yml and owners.yml.

export { MANIFEST, generatedFiles, writeGeneratedFiles, staleGeneratedFiles } from './manifest.js'
export { GIT_HOOKS, SHIM_FILES, renderShim, shimPath } from './githooks.js'
export { generatedBy } from './header.js'
export {
  CI_EVENTS,
  CI_JOB,
  CI_NODE_VERSION,
  WORKFLOW_FILE,
  WORKFLOW_PATH,
  installScript,
  renderWorkflow,
} from './workflow.js'
export {
  WRAPPER_FILES,
  WRAPPER_TIMEOUT_MS,
  renderWrapper,
  wrapperCommandLine,
  wrapperPath,
} from './wrappers.js'
export {
  CHECKED_TOOLS,
  CLAUDE_HOOKS,
  ENV_READ_RULES,
  FORMATTED_TOOLS,
  MERGE_RULES,
  SETTINGS_PATH,
  denyRules,
  hookCommand,
  isHackwinHandler,
  mergeClaudeSettings,
  pushRules,
  writeClaudeSettings,
} from './claude-settings.js'
export { HASH_MARKERS, HTML_MARKERS, blockOf, findBlock, withBlock } from './blocks.js'
export {
  PROJECT_FILES,
  TEMPLATE_CHECK_WORKFLOW,
  TEMPLATE_CHECK_WORKFLOW_PATH,
  languageName,
  planProjectFiles,
  renderAgentsBlock,
} from './project-files.js'
export { CONFIG_FILES, renderHackwinConfig, renderOwners } from './config-files.js'
export { linkError, linkOn, refuseLinks } from './links.js'

/** @typedef {import('./manifest.js').GenerateInput} GenerateInput */
/** @typedef {import('./manifest.js').GeneratedFileSpec} GeneratedFileSpec */
/** @typedef {import('./manifest.js').GeneratedFile} GeneratedFile */
/** @typedef {import('./manifest.js').StaleFile} StaleFile */
/** @typedef {import('./githooks.js').GitHook} GitHook */
/** @typedef {import('./claude-settings.js').SettingsInput} SettingsInput */
/** @typedef {import('./blocks.js').Markers} Markers */
/** @typedef {import('./project-files.js').ProjectInput} ProjectInput */
/** @typedef {import('./project-files.js').ProjectFileChange} ProjectFileChange */
/** @typedef {import('./links.js').Link} Link */

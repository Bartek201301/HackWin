// Generators and templates of every committed file that HackWin generates (6.4), and the
// generated file manifest.

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

/** @typedef {import('./manifest.js').GenerateInput} GenerateInput */
/** @typedef {import('./manifest.js').GeneratedFileSpec} GeneratedFileSpec */
/** @typedef {import('./manifest.js').GeneratedFile} GeneratedFile */
/** @typedef {import('./manifest.js').StaleFile} StaleFile */
/** @typedef {import('./githooks.js').GitHook} GitHook */
/** @typedef {import('./claude-settings.js').SettingsInput} SettingsInput */

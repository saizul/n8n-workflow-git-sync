/**
 * Programmatic API. Everything the CLI does is available as plain functions
 * so that the pieces can be reused in scripts and other tools.
 */
export { run, VERSION } from './cli.js';
export { EXIT, CliError, UsageError, ConfigError, ApiError, ConflictError, ValidationError } from './errors.js';
export { loadRc, resolveConfig, normalizeBaseUrl, RC_FILE_NAME } from './config.js';
export { HttpClient } from './http.js';
export { N8nClient, createClient, toWritableWorkflow } from './api.js';
export { normalizeWorkflow, serializeWorkflow, contentHash, tagNames } from './workflow/normalize.js';
export { loadWorkflows, readManifest, writeManifest, readIdMap, writeIdMap, workflowRelativePath, MANIFEST_FILE } from './workflow/store.js';
export { validateWorkflow, isValid } from './workflow/validate.js';
export { buildGraph, findCycles, findOrphans, findUnreachable } from './workflow/graph.js';
export { toMermaid, toDot } from './workflow/render.js';
export { findSecrets, findWorkflowSecrets, maskSecret } from './secrets/detector.js';
export { redactWorkflow, REDACTION_MARKER } from './secrets/redact.js';
export { lintWorkflow, resolveRules, summarize, shouldFail } from './lint/engine.js';
export { RULES, getRule } from './lint/rules/index.js';
export { formatFindings, formatText, formatJson, formatSarif, formatGithub } from './lint/formatters.js';
export { diffWorkflows, diffWorkflowSets } from './diff/semantic.js';
export { formatSetDiffText, formatSetDiffJson } from './diff/format.js';
export { generateCatalogue, summarizeWorkflow } from './docs/catalogue.js';
export { createSnapshot, verifySnapshot, listSnapshots, pruneSnapshots, resolveSnapshot } from './backup/snapshot.js';
export { pullWorkflows } from './sync/pull.js';
export { pushWorkflows, planActivation } from './sync/push.js';
export { remapCredentials, remapWorkflowReferences } from './sync/remap.js';

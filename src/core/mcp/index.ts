/**
 * @layer core/mcp
 * Barrel — re-exports the public surface of the MCP tool layer.
 *
 * Consumers (server/mcp transport, tests) import from '@core/mcp'.
 * The concrete transport (stdio / HTTP) belongs in `server/` — never here.
 */

export type { McpToolDefinition } from './tools';
export { buildMcpTools } from './tools';

export type { McpTextContent, McpShapedResult, McpToolCallResult } from './dispatch';
export { shapeToolCallContent, applyMcpToolCall } from './dispatch';

export type { McpResourceDescriptor, McpResourceContent, CadResourceUri } from './resources';
export {
  listMcpResources,
  readMcpResource,
  readConventionsResource,
  CAD_RESOURCE_URIS,
} from './resources';

export { CONVENTIONS_GUIDE, CONVENTIONS_URI } from './conventions';

export type {
  McpPromptMessage,
  McpPromptArgument,
  McpPromptDescriptor,
  McpPromptResult,
} from './prompts';
export { listMcpPrompts, getMcpPrompt } from './prompts';

export type { EntityDelta, DocPatch } from './docPatch';
export { computeDocPatch, applyDocPatch } from './docPatch';

export type {
  CadExchangePort,
  ExchangeDeps,
  ExchangeCommandResult,
  ProgramRun,
  PythonLanguage,
  StepFile,
} from './exchangeTools';
export {
  buildExchangeToolDefinitions,
  applyExchangeToolCall,
  exportStepFile,
} from './exchangeTools';

export type { ToolSearchResult, DiscoveryOutcome } from './discovery';
export {
  buildDiscoveryToolDefinitions,
  applyDiscoveryToolCall,
  searchTools,
  SEARCH_TOOLS_DEFAULT_LIMIT,
  SEARCH_TOOLS_MAX_LIMIT,
} from './discovery';

export type { ToolsetName, ParsedToolsets } from './toolsets';
export {
  TOOLSET_NAMES,
  TOOLSETS,
  parseToolsets,
  toolsetOf,
  isToolEnabled,
  isPromptEnabled,
} from './toolsets';

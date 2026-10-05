/**
 * @layer mcp
 * Barrel — the public surface of the MCP tool layer, imported by `server/` and tests. Types and
 * helpers used only inside one module stay private to it. The concrete transport (stdio / HTTP)
 * belongs in `server/` — never here.
 */

export { buildMcpTools } from './tools';
export { shapeToolCallContent } from './dispatch';
export { listMcpResources, readMcpResource, CAD_RESOURCE_URIS } from './resources';
export { CONVENTIONS_GUIDE, CONVENTIONS_URI } from './conventions';
export { listMcpPrompts, getMcpPrompt } from './prompts';

export type { CadExchangePort, ProgramRun, PythonLanguage } from './exchangeTools';
export {
  buildExchangeToolDefinitions,
  applyExchangeToolCall,
  exportStepFile,
} from './exchangeTools';

export type { ToolSearchResult } from './discovery';
export {
  buildAllMcpTools,
  buildDiscoveryToolDefinitions,
  applyDiscoveryToolCall,
  searchTools,
} from './discovery';

export type { ToolsetName } from './toolsets';
export {
  TOOLSET_NAMES,
  TOOLSETS,
  parseToolsets,
  toolsetOf,
  isToolEnabled,
  isPromptEnabled,
} from './toolsets';

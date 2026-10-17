/**
 * Barrel — the public surface of the MCP tool layer, imported by `server/` and tests. Types and
 * helpers used only inside one module stay private to it. The concrete transport (stdio / HTTP)
 * belongs in `server/` — never here.
 */

export { buildMcpTools } from './tools';
export { shapeToolCallContent } from './dispatch';
export { listMcpResources, readMcpResource, CAD_RESOURCE_URIS } from './resources';
export { CONVENTIONS_GUIDE, CONVENTIONS_URI } from './conventions';
export { listMcpPrompts, getMcpPrompt } from './prompts';
export { SERVER_INSTRUCTIONS } from './instructions';

export type { CadExchangePort, DwgConverterPort, ProgramRun } from './exchangeTools';
export { buildExchangeToolDefinitions, applyExchangeToolCall, exportStepFile } from './exchangeTools';

export type { FeaToolsPort, FeaHost, FeaToolResult, FieldTableInput } from './feaTools';
export { buildFeaToolDefinitions, FEA_SOLVE_TIMEOUT_S } from './feaTools';
export { buildLibraryToolDefinitions, type MaterialLibraryStorePort, type LibraryRegistration } from './libraryTools';

export type { ToolSearchResult } from './discovery';
export {
  buildAllMcpTools,
  buildDiscoveryToolDefinitions,
  applyDiscoveryToolCall,
  searchTools,
  closestToolNames,
  suggestToolNames,
} from './discovery';

export type { ToolsetName } from './toolsets';
export { TOOLSET_NAMES, TOOLSETS, parseToolsets, isToolsetName, toolsetOf, isToolEnabled, isPromptEnabled } from './toolsets';

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
export { listMcpResources, readMcpResource, CAD_RESOURCE_URIS } from './resources';

export type {
  McpPromptMessage,
  McpPromptArgument,
  McpPromptDescriptor,
  McpPromptResult,
} from './prompts';
export { listMcpPrompts, getMcpPrompt } from './prompts';

export type { UiBridge } from './uiBridge';

export type { BridgeToolResult } from './bridgeTools';
export { buildBridgeToolDefinitions, applyBridgeToolCall } from './bridgeTools';

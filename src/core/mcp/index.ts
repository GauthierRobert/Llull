/**
 * @layer core/mcp
 * Barrel — re-exports the public surface of the MCP tool layer.
 *
 * Consumers (server/mcp transport, tests) import from '@core/mcp'.
 * The concrete transport (stdio / HTTP) belongs in `server/` — never here.
 */

export type { McpToolDefinition } from './tools';
export { buildMcpTools } from './tools';

export type { McpTextContent, McpToolCallResult } from './dispatch';
export { applyMcpToolCall } from './dispatch';

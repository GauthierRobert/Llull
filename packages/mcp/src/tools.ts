/**
 * @layer mcp
 * MCP tool definitions generated from the command registry (`toToolSchemas()` is the only source;
 * no schema is hand-written here). No MCP SDK dependency — transport wiring lives in `server/`.
 */

import type { ParamsSchema } from '@core/commands/types';
import { toToolSchemas, type ToolSchema } from '@core/commands/registry';

/** `inputSchema` is the command's `paramsSchema`; `annotations` is present only when the command has any. */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: ParamsSchema;
  annotations?: NonNullable<ToolSchema['annotations']>;
}

/**
 * @pure
 * @invariant buildMcpTools()[i].name === listCommands()[i].name for all i
 */
export function buildMcpTools(): McpToolDefinition[] {
  return toToolSchemas().map(({ name, description, input_schema, annotations }) => ({
    name,
    description,
    inputSchema: input_schema,
    ...(annotations ? { annotations } : {}),
  }));
}

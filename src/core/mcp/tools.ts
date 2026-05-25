/**
 * @layer core/mcp
 *
 * MCP tool definition builder — pure, framework-agnostic.
 *
 * Converts the command registry into MCP-shaped tool definitions.
 * The source of truth is always `toToolSchemas()` from the registry;
 * no tool schema is ever hand-written here.
 *
 * NOTE: This file defines minimal local types only — it does NOT depend
 * on any MCP SDK package (transport wiring is a G2 concern, not G1).
 *
 * @pure No side effects beyond reading the registry.
 */

import type { ParamsSchema } from '@core/commands/types';
import { toToolSchemas } from '@core/commands/registry';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single MCP tool definition.
 *
 * MCP uses `inputSchema` (camelCase) where Anthropic uses `input_schema`.
 * All other fields mirror `toToolSchemas()` 1:1.
 */
export interface McpToolDefinition {
  /** The snake_case tool/command name (matches `CommandDefinition.name`). */
  name: string;
  /** One-line imperative description shown to external agents. */
  description: string;
  /**
   * JSON Schema object describing the accepted parameters.
   * Same value as `CommandDefinition.paramsSchema`; field renamed per MCP spec.
   */
  inputSchema: ParamsSchema;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Generate one `McpToolDefinition` per registered command.
 *
 * @pure
 * @layer core/mcp
 * @invariant buildMcpTools().length === listCommands().length
 * @invariant buildMcpTools()[i].name === listCommands()[i].name for all i
 */
export function buildMcpTools(): McpToolDefinition[] {
  return toToolSchemas().map((schema) => ({
    name: schema.name,
    description: schema.description,
    inputSchema: schema.input_schema,
  }));
}

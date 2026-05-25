/**
 * @layer core/mcp
 *
 * Pure MCP content shaper and tool-call dispatcher.
 *
 * Two exports:
 *
 * `shapeToolCallContent` — the SINGLE implementation of MCP CallToolResult
 *   content shaping. Takes a pre-computed result (summary, affected, isError,
 *   data?) and builds the MCP content blocks. Pure: no `execute`, no document,
 *   no side effects. The transport (server/src/mcp.ts) calls this after running
 *   `commandBus.applyCommand`; `applyMcpToolCall` also delegates here.
 *
 * `applyMcpToolCall` — thin wrapper for callers that have a document and want
 *   to run `execute` + shape in one step (used by pure unit tests; NOT called
 *   by the production server which routes through the command bus instead).
 *
 * @pure over the document — neither function mutates the input doc.
 * No network, no DOM, no SDK imports. All side effects live in `server/`.
 */

import type { CadDocument } from '@core/model/types';
import { execute, getCommand } from '@core/commands/registry';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** A single content block in an MCP tool result (text variant). */
export interface McpTextContent {
  type: 'text';
  /** The command `summary` — factual feedback for the calling agent. */
  text: string;
}

/**
 * The shaped MCP CallToolResult, without the document.
 *
 * Returned by `shapeToolCallContent`; the transport can forward it verbatim
 * (it matches the MCP SDK's `CallToolResult` shape).
 *
 * - `content`         — always >= 1 text block (summary); extra blocks for
 *                       affected ids and json data when present.
 * - `isError`         — true ONLY for unknown tool names.
 * - `structuredContent` — present ONLY when the command returned record-type
 *                       `data` (query commands); omitted for mutations/no-ops.
 */
export interface McpShapedResult {
  content: McpTextContent[];
  isError: boolean;
  structuredContent?: Record<string, unknown>;
}

/**
 * The value returned by `applyMcpToolCall`.
 *
 * Extends `McpShapedResult` with the document + affected ids so pure unit
 * tests can assert the document state without a command bus.
 *
 * - `document` — the next document state (new object if mutated, same reference
 *                if the command was a no-op or unknown).
 * - `affected` — ids of entities created or changed (empty for queries/no-ops).
 * - `data`     — present ONLY when the command set `CommandResult.data`.
 */
export interface McpToolCallResult extends McpShapedResult {
  affected: string[];
  document: CadDocument;
  data?: unknown;
}

// ---------------------------------------------------------------------------
// Single shaping implementation
// ---------------------------------------------------------------------------

/**
 * Shape a pre-computed command result into an MCP `CallToolResult` payload.
 *
 * This is the ONE place where MCP content blocks are assembled. The transport
 * (`server/src/mcp.ts`) calls this after `commandBus.applyCommand`; the
 * `applyMcpToolCall` wrapper calls it after `execute`. There is no other copy.
 *
 * Content block rules:
 *   1. Always: `{ type:'text', text: summary }`.
 *   2. When affected is non-empty: `{ type:'text', text:'Affected entity ids: ...' }`.
 *   3. When data is defined: `{ type:'text', text:'```json\n...\n```' }`.
 *   4. When data is a non-null, non-array object: also set `structuredContent`.
 *
 * @pure — no execute, no document, no side effects.
 * @layer core/mcp
 *
 * @param result - The pre-computed fields from a CommandResult + isError flag.
 * @returns The shaped MCP payload (content blocks + optional structuredContent).
 */
export function shapeToolCallContent(result: {
  summary: string;
  affected: string[];
  isError: boolean;
  data?: unknown;
}): McpShapedResult {
  const content: McpTextContent[] = [{ type: 'text', text: result.summary }];

  if (result.affected.length > 0) {
    content.push({
      type: 'text',
      text: `Affected entity ids: ${result.affected.join(', ')}`,
    });
  }

  if (result.data !== undefined) {
    content.push({
      type: 'text',
      text: `\`\`\`json\n${JSON.stringify(result.data, null, 2)}\n\`\`\``,
    });
    const isRecord =
      typeof result.data === 'object' &&
      result.data !== null &&
      !Array.isArray(result.data);
    if (isRecord) {
      return {
        content,
        isError: result.isError,
        structuredContent: result.data as Record<string, unknown>,
      };
    }
  }

  return { content, isError: result.isError };
}

// ---------------------------------------------------------------------------
// Dispatcher (thin wrapper for pure unit tests)
// ---------------------------------------------------------------------------

/**
 * Apply an MCP tool call to a document.
 *
 * Calls `execute` once, then delegates content shaping to `shapeToolCallContent`.
 * Used by pure unit tests that operate directly on a document without a command
 * bus. The production server routes through `commandBus.applyCommand` instead
 * and calls `shapeToolCallContent` directly — ensuring execute() runs exactly once.
 *
 * @pure over doc — never mutates the input document.
 * @layer core/mcp
 * @affects depends on the underlying command
 * @failure unknown toolName -> isError true, affected:[], document === input doc
 */
export function applyMcpToolCall(
  doc: CadDocument,
  toolName: string,
  args: unknown,
): McpToolCallResult {
  // Ask the registry directly whether the name is a command — a fact about the
  // registry, not a parse of `execute`'s human-facing summary string (L5/C1).
  const isUnknown = getCommand(toolName) === undefined;
  const result = execute(doc, toolName, args);

  const shaped = shapeToolCallContent({
    summary: result.summary,
    affected: result.affected,
    isError: isUnknown,
    data: result.data,
  });

  const toolCallResult: McpToolCallResult = {
    ...shaped,
    affected: result.affected,
    document: result.document,
  };
  // Only surface `data` when the command produced it (exactOptionalPropertyTypes).
  if (result.data !== undefined) toolCallResult.data = result.data;
  return toolCallResult;
}

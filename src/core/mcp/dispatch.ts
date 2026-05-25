/**
 * @layer core/mcp
 *
 * Pure MCP tool-call dispatcher.
 *
 * `applyMcpToolCall` is the single function the G2 transport layer calls on
 * every `tools/call` request. It threads the document through `execute` and
 * returns an MCP-style result payload that the transport can forward verbatim.
 *
 * @pure over the document — the input doc is never mutated.
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
 * The value returned by `applyMcpToolCall`.
 *
 * Mirrors the MCP `CallToolResult` shape so the transport can forward it
 * directly without any further transformation.
 *
 * - `content`  — array of content blocks; always contains at least one text block
 *                carrying the command `summary`.
 * - `affected` — ids of entities created or changed (MCP extension field).
 * - `isError`  — true ONLY when the tool name is not a registered command; the
 *                document is returned unchanged. A registered command that
 *                gracefully no-ops on bad params (conventions C5) is NOT an error —
 *                its explanatory summary is normal feedback.
 * - `document` — the next document state (new object if a change was made,
 *                the SAME reference as the input if the command was a no-op).
 */
export interface McpToolCallResult {
  content: McpTextContent[];
  affected: string[];
  isError: boolean;
  document: CadDocument;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Apply an MCP tool call to a document.
 *
 * Routes `toolName` + `args` through `execute`, then shapes the `CommandResult`
 * into an MCP-style result payload.
 *
 * Unknown tool names are treated as errors: `isError` is set, the document is
 * returned unchanged, and the summary explains the failure.
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

  return {
    content: [{ type: 'text', text: result.summary }],
    affected: result.affected,
    isError: isUnknown,
    document: result.document,
  };
}

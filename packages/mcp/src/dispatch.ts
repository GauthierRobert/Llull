/**
 * @layer mcp
 * MCP result shaping. `shapeToolCallContent` is the single place CallToolResult content blocks are
 * assembled (the server calls it after `commandBus.applyCommand`); `applyMcpToolCall` is the
 * document-in/document-out form (`execute` + shape) used by unit tests, not by the server.
 * @pure no network, no DOM, no SDK imports.
 */

import type { CadDocument } from '@core/model/types';
import { execute, getCommand } from '@core/commands/registry';
import { isRecord } from '@lib/isRecord';

/** A single content block in an MCP tool result (text variant). */
export interface McpTextContent {
  type: 'text';
  /** The command `summary` — factual feedback for the calling agent. */
  text: string;
}

/** MCP CallToolResult minus the document. `structuredContent` only for record-typed `data`. */
export interface McpShapedResult {
  content: McpTextContent[];
  isError: boolean;
  structuredContent?: Record<string, unknown>;
}

/** `document` is the same reference as the input when the command was a no-op or unknown. */
export interface McpToolCallResult extends McpShapedResult {
  affected: string[];
  document: CadDocument;
  data?: unknown;
}

/** The `text` of a `{ format: 'code', text }` data record, else null. */
function codeText(data: unknown): string | null {
  return isRecord(data) && data.format === 'code' && typeof data.text === 'string'
    ? data.text
    : null;
}

/**
 * Content blocks: summary; `Affected entity ids: …` when non-empty; a json block when `data` is
 * defined (a `format:'code'` record's `text` moves to its own verbatim block).
 * @pure
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
    // Source code (export_code) is shown verbatim so agents read it as code, not as a JSON string.
    const code = codeText(result.data);
    const jsonData =
      code === null
        ? result.data
        : { ...(result.data as object), text: '(source code in the next block)' };
    content.push({
      type: 'text',
      text: `\`\`\`json\n${JSON.stringify(jsonData, null, 2)}\n\`\`\``,
    });
    if (code !== null) content.push({ type: 'text', text: code });
    if (isRecord(result.data)) {
      return {
        content,
        isError: result.isError,
        structuredContent: result.data,
      };
    }
  }

  return { content, isError: result.isError };
}

/**
 * @pure over doc
 * @failure unknown toolName -> isError true, affected:[], document === input doc
 */
export function applyMcpToolCall(
  doc: CadDocument,
  toolName: string,
  args: unknown,
): McpToolCallResult {
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
  if (result.data !== undefined) toolCallResult.data = result.data;
  return toolCallResult;
}

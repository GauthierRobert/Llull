/**
 * @layer mcp
 * MCP result shaping. `shapeToolCallContent` is the single place CallToolResult content blocks are
 * assembled (the server calls it after `commandBus.applyCommand`).
 * @pure no network, no DOM, no SDK imports.
 */

import { isRecord } from '@lib/isRecord';

interface McpTextContent {
  type: 'text';
  text: string;
}

/**
 * MCP CallToolResult minus the document. `structuredContent` only for record-typed `data`.
 * @invariant a type alias, not an interface: only an alias is assignable to the SDK's
 *            index-signatured CallToolResult (server/src/mcp/server.ts relies on it, no casts).
 */
export type McpShapedResult = {
  content: McpTextContent[];
  isError: boolean;
  structuredContent?: Record<string, unknown>;
};

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
  const { summary, affected, isError, data } = result;
  const content: McpTextContent[] = [{ type: 'text', text: summary }];
  if (affected.length > 0) {
    content.push({ type: 'text', text: `Affected entity ids: ${affected.join(', ')}` });
  }
  if (data === undefined) return { content, isError };

  // Source code (export_code) is shown verbatim so agents read it as code, not as a JSON string.
  const code = codeText(data);
  const jsonData =
    isRecord(data) && code !== null ? { ...data, text: '(source code in the next block)' } : data;
  content.push({ type: 'text', text: `\`\`\`json\n${JSON.stringify(jsonData, null, 2)}\n\`\`\`` });
  if (code !== null) content.push({ type: 'text', text: code });
  return isRecord(data) ? { content, isError, structuredContent: data } : { content, isError };
}

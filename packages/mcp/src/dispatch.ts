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
 * Size caps for the text an agent reads (`content`); `structuredContent` always carries the full
 * `data`. A 3000-entity model otherwise returns megabytes (build_project 3 MB, describe_scene
 * 1.5 MB, export_stl 11 MB) and floods the agent's context.
 */
export const MAX_AFFECTED_IDS_SHOWN = 200;
export const MAX_JSON_TEXT_CHARS = 30_000;
export const MAX_CODE_TEXT_CHARS = 150_000;

/** `text` cut to `max` characters with a note saying how much was dropped and where to look. */
function clip(text: string, max: number, hint: string): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated ${text.length - max} of ${text.length} characters; ${hint}]`;
}

/** Pretty JSON while it is small; compact (then clipped) once it would flood the context. */
function jsonText(value: unknown): string {
  const pretty = JSON.stringify(value, null, 2) ?? 'undefined';
  if (pretty.length <= MAX_JSON_TEXT_CHARS) return pretty;
  return clip(
    JSON.stringify(value) ?? 'undefined',
    MAX_JSON_TEXT_CHARS,
    'the full data is in structuredContent; narrow the request (filters, a smaller selection) or read the cad://scene resource',
  );
}

/**
 * Content blocks: summary; `Affected entity ids: …` when non-empty (first
 * `MAX_AFFECTED_IDS_SHOWN` ids, then a count); a json block when `data` is defined, clipped past
 * `MAX_JSON_TEXT_CHARS` (a `format:'code'` record's `text` moves to its own verbatim block,
 * clipped past `MAX_CODE_TEXT_CHARS`).
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
    const shown = affected.slice(0, MAX_AFFECTED_IDS_SHOWN).join(', ');
    const more = affected.length - MAX_AFFECTED_IDS_SHOWN;
    content.push({
      type: 'text',
      text:
        more > 0
          ? `Affected entity ids (first ${MAX_AFFECTED_IDS_SHOWN} of ${affected.length}; ${more} more not listed, use find_entities or describe_scene to enumerate): ${shown}`
          : `Affected entity ids: ${shown}`,
    });
  }
  if (data === undefined) return { content, isError };

  // Source code (export_code) is shown verbatim so agents read it as code, not as a JSON string.
  const code = codeText(data);
  const jsonData =
    isRecord(data) && code !== null ? { ...data, text: '(source code in the next block)' } : data;
  content.push({ type: 'text', text: `\`\`\`json\n${jsonText(jsonData)}\n\`\`\`` });
  if (code !== null) {
    content.push({
      type: 'text',
      text: clip(code, MAX_CODE_TEXT_CHARS, 'the full source is in structuredContent.text'),
    });
  }
  return isRecord(data) ? { content, isError, structuredContent: data } : { content, isError };
}

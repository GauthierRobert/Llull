/**
 * MCP result shaping. `shapeToolCallContent` is the single place CallToolResult content blocks are
 * assembled (the server calls it after `commandBus.applyCommand`).
 */

import type { CommandError } from '@core/commands/types';
import { isRecord } from '@lib/isRecord';

interface McpTextContent {
  type: 'text';
  text: string;
}

/**
 * MCP CallToolResult minus the document. `structuredContent` = the full `data` (non-records wrapped
 * as `{ data }`) + all (deduplicated) `affected` ids; absent when there is neither data, error nor ids.
 * @invariant a type alias, not an interface: only an alias is assignable to the SDK's
 *            index-signatured CallToolResult (server/src/mcp/server.ts relies on it, no casts).
 */
export type McpShapedResult = { content: McpTextContent[]; isError: boolean; structuredContent?: Record<string, unknown> };

/** The `text` of a `{ format: 'code', text }` data record, else null. */
function codeText(data: unknown): string | null {
  return isRecord(data) && data.format === 'code' && typeof data.text === 'string' ? data.text : null;
}

/**
 * The full machine-readable result: a record `data` as is, anything else as `{ data }`, plus every
 * affected id under `affected` (unless the record already has its own `affected` key).
 */
function structuredOf(data: unknown, affected: string[]): Record<string, unknown> {
  const record = isRecord(data) ? data : { data };
  return affected.length > 0 && !('affected' in record) ? { ...record, affected } : record;
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

const TEXT_SIGNIFICANT_DIGITS = 6;
const TEXT_NOISE_FLOOR = 1e-15;

/** Floats to ~6 significant figures and float noise (|x| < 1e-15) to 0, for the text an agent reads; integers untouched. */
function roundForText(value: unknown): unknown {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Number.isInteger(value)) return value;
    return Math.abs(value) < TEXT_NOISE_FLOOR ? 0 : Number(value.toPrecision(TEXT_SIGNIFICANT_DIGITS));
  }
  if (Array.isArray(value)) return value.map(roundForText);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, roundForText(entry)]));
  return value;
}

/** Compact, rounded JSON (full precision lives in structuredContent), clipped once it would flood the context. */
function jsonText(value: unknown): string {
  return clip(
    JSON.stringify(roundForText(value)) ?? 'undefined',
    MAX_JSON_TEXT_CHARS,
    'the full data is in structuredContent; narrow the request (filters, a smaller selection) or read the cad://scene resource',
  );
}

/**
 * Content blocks: summary; `Affected entity ids: …` when non-empty (first
 * `MAX_AFFECTED_IDS_SHOWN` ids, then a count); a json block when `data` is defined, clipped past
 * `MAX_JSON_TEXT_CHARS` (a `format:'code'` record's `text` moves to its own verbatim block,
 * clipped past `MAX_CODE_TEXT_CHARS`).
 */
export function shapeToolCallContent(result: {
  summary: string;
  affected: string[];
  isError: boolean;
  data?: unknown;
  error?: CommandError;
}): McpShapedResult {
  const { summary, isError, data, error } = result;
  const affected = [...new Set(result.affected)];
  const content: McpTextContent[] = [{ type: 'text', text: summary }];
  const errorPart = error === undefined ? {} : { error };
  if (error !== undefined) {
    const where = error.paths.length > 0 ? ` at ${error.paths.join(', ')}` : '';
    content.push({ type: 'text', text: `Error ${error.code}${where}: ${error.remediation}` });
  }
  if (affected.length > 0) {
    const shown = affected.slice(0, MAX_AFFECTED_IDS_SHOWN).join(', ');
    const more = affected.length - MAX_AFFECTED_IDS_SHOWN;
    content.push({
      type: 'text',
      text:
        more > 0
          ? `Affected entity ids (first ${MAX_AFFECTED_IDS_SHOWN} of ${affected.length}; ${more} more not listed: all ids are in structuredContent.affected, or use find_entities or describe_scene): ${shown}`
          : `Affected entity ids: ${shown}`,
    });
  }
  if (data === undefined) {
    // Always give clients the new ids as a field (no regex on the text).
    const structured = { ...errorPart, ...(affected.length > 0 ? { affected } : {}) };
    return Object.keys(structured).length > 0 ? { content, isError, structuredContent: structured } : { content, isError };
  }

  // Source code (export_code) is shown verbatim so agents read it as code, not as a JSON string.
  const code = codeText(data);
  const jsonData = isRecord(data) && code !== null ? { ...data, text: '(source code in the next block)' } : data;
  content.push({ type: 'text', text: `\`\`\`json\n${jsonText(jsonData)}\n\`\`\`` });
  if (code !== null) {
    content.push({ type: 'text', text: clip(code, MAX_CODE_TEXT_CHARS, 'the full source is in structuredContent.text') });
  }
  return { content, isError, structuredContent: { ...structuredOf(data, affected), ...errorPart } };
}

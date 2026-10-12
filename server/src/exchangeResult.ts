/**
 * @layer server
 * The exchange tools (export_step, import_step, import_dwg, import_code) are written against the
 * MCP layer and return MCP-shaped results. REST (`POST /exchange`) and the CLI want the command
 * bus shape `{ summary, affected, isError, data }`; this recovers it from `structuredContent`,
 * which carries the full data and every affected id.
 * @pure
 */

import type { McpShapedResult } from '@mcp/dispatch';
import { isRecord } from '@lib/isRecord';

export interface UnshapedResult {
  readonly summary: string;
  readonly affected: string[];
  readonly isError: boolean;
  readonly data?: unknown;
}

const AFFECTED_LINE = /^Affected entity ids: (.+)$/;

export function unshapeExchangeResult(shaped: McpShapedResult): UnshapedResult {
  const summary = shaped.content[0]?.text ?? '';
  const structured = shaped.structuredContent;
  const fromStructure =
    isRecord(structured) && Array.isArray(structured['affected'])
      ? structured['affected'].filter((id): id is string => typeof id === 'string')
      : null;
  const fromText = shaped.content
    .map((block) => AFFECTED_LINE.exec(block.text)?.[1])
    .find((ids) => ids !== undefined)
    ?.split(', ');
  const affected = fromStructure ?? fromText ?? [];
  let data: unknown;
  if (structured !== undefined) {
    const rest = Object.fromEntries(
      Object.entries(structured).filter(([key]) => key !== 'affected'),
    );
    data = 'data' in rest && Object.keys(rest).length === 1 ? rest['data'] : rest;
  }
  return {
    summary,
    affected,
    isError: shaped.isError,
    ...(data !== undefined && !(isRecord(data) && Object.keys(data).length === 0) ? { data } : {}),
  };
}

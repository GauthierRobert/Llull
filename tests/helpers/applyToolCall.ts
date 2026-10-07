import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { shapeToolCallContent, type McpShapedResult } from '@mcp/dispatch';

/** `execute` + MCP result shaping on a document, for tests (the server runs the same via the command bus). */
export function applyToolCall(
  doc: CadDocument,
  toolName: string,
  args: unknown,
): McpShapedResult & { affected: string[]; document: CadDocument; data?: unknown } {
  const result = execute(doc, toolName, args);
  return {
    ...shapeToolCallContent({
      summary: result.summary,
      affected: result.affected,
      isError: result.rejected === true,
      data: result.data,
    }),
    affected: result.affected,
    document: result.document,
    ...(result.data !== undefined ? { data: result.data } : {}),
  };
}

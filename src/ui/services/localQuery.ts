// Read-only commands on the store document (reports, exports) + browser download of their payload.

import { execute, getCommand } from '@core/commands/registry';
import { noop } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { useStore } from '@ui/store';
import { downloadText } from '@ui/download';
import { isCsvData, stringFields } from '@ui/resultData';

/** Runs a read-only command on the store document; a mutating command is refused (it must go through `dispatch`). */
export function runQuery(command: string, params: Record<string, unknown> = {}): CommandResult {
  const document = useStore.getState().document;
  const definition = getCommand(command);
  if (definition !== undefined && definition.annotations?.readOnly !== true)
    return noop(document, `${command} changes the document; run it through dispatch, not as a query.`);
  return execute(document, command, params);
}

/** Downloads `data[field]` as the reported name (civil `fileName`, building `filename`) or `fallbackName`; null fallback + no name = no download. @returns the summary */
export function downloadQuery(
  command: string,
  params: Record<string, unknown>,
  field: string,
  fallbackName: string | null,
  mimeType: string,
): string {
  const result = runQuery(command, params);
  const data = stringFields(result.data);
  const content = data?.[field];
  const fileName = data?.['fileName'] ?? data?.['filename'] ?? fallbackName;
  if (content !== undefined && fileName !== null) downloadText(content, fileName, mimeType);
  return result.summary;
}

/** @returns the summary and whether a file was downloaded (false: refused). */
export function downloadCsvQuery(
  command: string,
  params: Record<string, unknown>,
  fileName: string,
): { summary: string; downloaded: boolean } {
  const result = runQuery(command, params);
  const downloaded = isCsvData(result.data);
  if (isCsvData(result.data)) downloadText(result.data.csv, fileName, 'text/csv');
  return { summary: result.summary, downloaded };
}

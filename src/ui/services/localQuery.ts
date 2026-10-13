// Read-only commands on the store document (reports, exports) + browser download of their payload.

import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import { useStore } from '@ui/store';
import { downloadText } from '@ui/download';
import { isCsvData, stringFields } from '@ui/resultData';

export function runQuery(command: string, params: Record<string, unknown> = {}): CommandResult {
  return execute(useStore.getState().document, command, params);
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

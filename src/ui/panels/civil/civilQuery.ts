/**
 * @layer ui/panels/civil
 *
 * Read-only civil queries run locally on the current document (reports, exports) and the browser
 * download of their file payload. Never changes the document.
 */

import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import { useStore } from '@ui/store';
import { downloadText } from '@ui/download';
import { stringFields } from '@ui/resultData';

/** Runs a read-only command on the current store document. */
export function runQuery(command: string, params: Record<string, unknown> = {}): CommandResult {
  return execute(useStore.getState().document, command, params);
}

/**
 * Runs `command` and downloads `data[field]` as `data.fileName` (or `fallbackName`).
 * @returns the command summary (shown as status).
 */
export function downloadQuery(
  command: string,
  params: Record<string, unknown>,
  field: 'text' | 'csv',
  fallbackName: string,
  mimeType: string,
): string {
  const result = runQuery(command, params);
  const data = stringFields(result.data);
  const content = data?.[field];
  if (content !== undefined) downloadText(content, data?.['fileName'] ?? fallbackName, mimeType);
  return result.summary;
}

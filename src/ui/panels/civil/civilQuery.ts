/**
 * @layer ui/panels/civil
 *
 * Read-only civil queries run locally on the current document (reports, exports) and the browser
 * download of their file payload. Never changes the document.
 */

import { useMemo } from 'react';
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
 * Summary of the read-only civil `command` for one object (`key: id`), re-run when the civil model
 * or the document units change (the only inputs a civil report reads).
 */
export function useCivilReport(command: string, key: string, id: string): string {
  const civil = useStore((s) => s.document.civil);
  const units = useStore((s) => s.document.units);
  return useMemo(
    () => runQuery(command, { [key]: id }).summary,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [civil, units, command, key, id],
  );
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

/** Status-bar and measurement feedback rules shared by local and online dispatch. Presentation only. */

import { getCommand } from '@core/commands/registry';
import { isDegraded } from '@core/commands/provenance';
import type { ResultProvenance } from '@core/commands/types';
import type { DispatchOptions, LastMeasure } from './storeTypes';

/** Camera commands report their internals; the status bar shows a short label instead. */
const CAMERA_SUMMARIES: Readonly<Record<string, string>> = { fit_view: 'View fitted' };

/** Status text for a result; `undefined` = leave the status bar unchanged (`quiet` dispatches). */
export function statusSummaryFor(name: string, summary: string, options: DispatchOptions | undefined): string | undefined {
  if (options?.quiet === true) return undefined;
  return CAMERA_SUMMARIES[name] ?? summary;
}

/** Only read-only query commands that return data produce a measurement card. */
export function measureAfter(name: string, data: unknown, previous: LastMeasure | null, provenance?: ResultProvenance): LastMeasure | null {
  if (data === undefined || getCommand(name)?.annotations?.readOnly !== true) return previous;
  return { command: name, data, ...(isDegraded(provenance) ? { approximate: true as const } : {}) };
}

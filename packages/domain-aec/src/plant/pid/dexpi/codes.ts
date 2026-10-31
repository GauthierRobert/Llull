/** Stable `DEXPI_*` and `PID_*` codes of the P&ID plugin with their one-line fixes (plant 04 PID, TECHNICAL_SPEC §7). */

import { tableRejection } from '@core/commands/noop';

export const DEXPI_REMEDIATION: Readonly<Record<string, string>> = {
  DEXPI_PARSE_ERROR:
    'Fix or re-export the file: it must be well-formed UTF-8 XML without a DOCTYPE, at most 50 MB; the position is in paths ("line N, column M").',
  DEXPI_VERSION_UNSUPPORTED:
    'Export DEXPI 1.3 (Proteus 4.1.x, root PlantModel) from the source tool; 1.2, 1.4 and 2.0 arrive with later milestones.',
  DEXPI_DANGLING_REFERENCE: 'Check the source file: the name of the missing object is in the message; the end was imported as a free end.',
  DEXPI_UNMAPPED_CLASS: 'Nothing to fix if the class is intended: the item was imported as Custom with its class kept in passthrough.',
  DEXPI_GRAPHICS_DROPPED: 'Nothing to fix: the data is intact; the drawing is simplified (symbols come from the llull library).',
  DEXPI_ATTRIBUTE_UNIT: 'Check the unit in the source file; the value was kept as text flagged unverified.',
  PID_SHEET_DUPLICATE: 'Choose another sheet number (omit `sheet` to take the next free PID-nnn).',
  PID_SHEET_NOT_FOUND: 'List the sheets with pid_report kind=counts or import a P&ID with import_dexpi first.',
};

export const refusePid = tableRejection(DEXPI_REMEDIATION);

export type DexpiSeverity = 'warning' | 'info';

/** A finding of an import: stable code, where (`paths`), and its fix. */
export interface DexpiIssue {
  readonly code: string;
  readonly severity: DexpiSeverity;
  readonly message: string;
  readonly ids: readonly string[];
  readonly paths: readonly string[];
  readonly remediation: string;
}

export function dexpiIssue(
  code: string,
  severity: DexpiSeverity,
  message: string,
  ids: readonly string[] = [],
  paths: readonly string[] = [],
): DexpiIssue {
  return { code, severity, message, ids, paths, remediation: DEXPI_REMEDIATION[code] ?? 'see the command description' };
}

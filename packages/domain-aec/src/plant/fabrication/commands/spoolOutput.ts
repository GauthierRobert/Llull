import type { SpoolInfo, Violation } from '../spools';
import { violationsOf } from '../spools';
import type { SpoolLimits } from '../model';

/** The `data` row of one spool (shared by split_spools and spool_list). */
export function spoolRow(spool: SpoolInfo, lineId: string, limits: SpoolLimits | undefined): Record<string, unknown> {
  const violations: Violation[] = violationsOf(spool, limits);
  return {
    name: spool.name,
    lineId,
    componentIds: spool.componentIds,
    lengthMm: spool.lengthMm,
    boxMm: spool.boxMm,
    weightKg: spool.weightKg,
    weightComplete: spool.weightComplete,
    pieces: spool.pieces,
    violations: violations.map((violation) => ({ code: violation.code, message: violation.message })),
  };
}

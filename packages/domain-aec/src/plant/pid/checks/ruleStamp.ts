/** `check_pid` rule on the issue stamp of a sheet: PID_STAMP_STALE (§5.5, PID-FU-3 follow-up). */

import type { CheckContext } from './context';
import { makeFinding, type Finding } from './finding';
import { sheetContentSha256 } from './sheetContent';

/**
 * A sheet carrying an issue stamp whose content hash differs from the hash of what the sheet shows now was edited after it was signed.
 * @invariant a stamp without a content hash cannot be compared and is skipped; one finding per stale sheet, ids = [sheet id], item = sheet number; a freshly stamped sheet is never stale (the hash excludes status, revision and the stamp)
 */
export function stampStale(ctx: CheckContext, sheetId?: string): Finding[] {
  const out: Finding[] = [];
  for (const sheet of Object.values(ctx.pid.sheets)) {
    const stamped = sheet.issuedBy?.contentSha256;
    if (sheet.issuedBy === undefined || stamped === undefined || (sheetId !== undefined && sheet.id !== sheetId)) continue;
    const now = sheetContentSha256(ctx.pid, sheet);
    if (now === stamped) continue;
    out.push({
      ...makeFinding({
        pid: ctx.pid,
        code: 'PID_STAMP_STALE',
        ids: [sheet.id],
        item: sheet.number,
        message: `sheet ${sheet.number} was changed after ${sheet.issuedBy.signer} signed it for construction (${sheet.issuedBy.at}): its content hash is ${now.slice(0, 12)}, the stamp holds ${stamped.slice(0, 12)}`,
        values: { stampedSha256: stamped, currentSha256: now, signer: sheet.issuedBy.signer },
      }),
      sheet: sheet.number,
    });
  }
  return out;
}

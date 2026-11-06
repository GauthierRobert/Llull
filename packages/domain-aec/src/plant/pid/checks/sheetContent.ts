/** Content hash of a sheet: what `issue_pid_sheet` stamps and what `check_pid` compares the stamp with (PID_STAMP_STALE). */

import { jcsJson } from '@lib/jcs';
import { sha256Hex } from '@lib/sha256';
import type { PidModel, PidSheet } from '../model';

/** SHA-256 of what a sheet shows: its identity fields, every item drawn on it in item order, the project symbols of the classes it uses and the acceptances of findings on its items (status, revision and the issue stamp are not part of it). */
export function sheetContentSha256(pid: PidModel, sheet: PidSheet): string {
  const items = pid.itemOrder.flatMap((id) => {
    const item = pid.items[id];
    return item !== undefined && item.sheetId === sheet.id ? [item] : [];
  });
  const onSheet = new Set<string>([sheet.id, ...items.map((item) => item.id)]);
  const symbols = Object.fromEntries(
    [...new Set(items.map((item) => item.dexpiClass))].flatMap((cls) =>
      pid.symbols !== undefined && Object.hasOwn(pid.symbols, cls) ? [[cls, pid.symbols[cls]]] : [],
    ),
  );
  const acceptances = Object.fromEntries(
    Object.entries(pid.acceptances ?? {}).filter(([key]) =>
      key
        .slice(key.indexOf(':', 4) + 1)
        .split(',')
        .some((id) => onSheet.has(id)),
    ),
  );
  return sha256Hex(
    jcsJson({
      id: sheet.id,
      number: sheet.number,
      title: sheet.title,
      paper: sheet.paper,
      items,
      symbols,
      acceptances,
    }),
  );
}

/**
 * @layer ui/panels/civil
 *
 * Live civil report hook over the local read-only queries (`@ui/services/localQuery`).
 */

import { useMemo } from 'react';
import { useStore } from '@ui/store';
import { runQuery } from '@ui/services/localQuery';

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

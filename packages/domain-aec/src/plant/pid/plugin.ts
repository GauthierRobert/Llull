/**
 * P&ID plugin (plant 04 PID), toolset `pid`: M1 the skeleton. The slice `doc.plant.pid` (sheets, items, conventions; model in `model.ts`) with its
 * load validation. The commands arrive with their milestones (M2 DEXPI import and `pid_report`, M3 authoring); P&ID items have no derived entities.
 */

import type { CadPlugin, DocumentExtension } from '@core/plugins/plugin';
import { isRecord } from '@lib/isRecord';
import { pidCatalog } from './catalog';
import { getPid, withPid } from './state';
import { pidErrors } from './validate';

const pidDocument: DocumentExtension = {
  validate: (raw) => {
    const plant = raw['plant'];
    return isRecord(plant) ? pidErrors(plant['pid']) : [];
  },
  derivedEntityIds: () => new Set(),
  restore: (raw) => raw,
  carry: (prev, next) => {
    const before = prev.plant?.pid;
    if (before === undefined) return next;
    const pid = getPid(next);
    const sheets = Object.fromEntries(
      Object.entries(pid.sheets).map(([id, sheet]) => {
        const kept = before.sheets[id];
        return [
          id,
          kept === undefined || kept.number !== sheet.number
            ? sheet
            : {
                ...sheet,
                status: kept.status,
                revision: kept.revision,
                ...(kept.issuedBy === undefined ? {} : { issuedBy: kept.issuedBy }),
              },
        ];
      }),
    );
    return withPid(next, { ...pid, sheets, ...(before.acceptances === undefined ? {} : { acceptances: before.acceptances }) });
  },
};

export const pidPlugin: CadPlugin = { name: 'pid', toolset: 'pid', commands: pidCatalog, document: pidDocument };

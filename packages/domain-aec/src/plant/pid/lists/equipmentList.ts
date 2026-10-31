/** `pid_report kind=equipment_list` (top-level equipment) and `kind=nozzle_list` (every nozzle) (plant 04 PID §5.7). */

import type { PidItem, PidModel } from '../model';
import { itemsOf } from './counts';
import { attributeText, labelOf, lineNumberOf, segmentsByOwner, sheetNumber, sortedRows, type Entry, type ListResult } from './lookup';

export const EQUIPMENT_LIST_COLUMNS = ['tag', 'class', 'nozzles', 'designPressure', 'designTemperature', 'sheet'] as const;
export const NOZZLE_LIST_COLUMNS = ['equipmentTag', 'subTag', 'dn', 'connectedLine', 'access'] as const;

/** The top-level equipment a nozzle belongs to (its own equipment, or the root of the sub-equipment chain). */
function rootOf(pid: PidModel, id: string): string {
  let current = id;
  for (let depth = 0; depth < 64; depth++) {
    const item = pid.items[current];
    if (item?.kind !== 'equipment' || item.parentId === undefined) break;
    current = item.parentId;
  }
  return current;
}

/** Design values (own or of the first sub-equipment that has them): DEXPI `DesignPressure` / `UpperLimitDesignPressure` (and the temperature pair), as "<value> <unit>". */
export function equipmentList(pid: PidModel, sheetId?: string): ListResult {
  const nozzleCount = new Map<string, number>();
  for (const item of itemsOf(pid, sheetId))
    if (item.kind === 'nozzle') {
      const root = rootOf(pid, item.equipmentId);
      nozzleCount.set(root, (nozzleCount.get(root) ?? 0) + 1);
    }
  const subEquipment = new Map<string, PidItem[]>();
  for (const item of itemsOf(pid, sheetId))
    if (item.kind === 'equipment' && item.parentId !== undefined)
      subEquipment.set(item.parentId, [...(subEquipment.get(item.parentId) ?? []), item]);
  /** The equipment's own value, else the first sub-equipment (chamber) that carries one. */
  const design = (item: PidItem, names: readonly string[]): string =>
    [item, ...(subEquipment.get(item.id) ?? [])].map((candidate) => attributeText(candidate, names)).find((text) => text !== '') ?? '';
  const entries: Entry[] = [];
  for (const item of itemsOf(pid, sheetId)) {
    if (item.kind !== 'equipment' || item.parentId !== undefined) continue;
    entries.push({
      id: item.id,
      row: {
        tag: labelOf(item),
        class: item.passthrough?.['dexpi:ComponentClass'] ?? item.dexpiClass,
        nozzles: nozzleCount.get(item.id) ?? 0,
        designPressure: design(item, ['DesignPressure', 'UpperLimitDesignPressure']),
        designTemperature: design(item, ['DesignTemperature', 'UpperLimitDesignTemperature']),
        sheet: sheetNumber(pid, item),
      },
    });
  }
  return { columns: EQUIPMENT_LIST_COLUMNS, rows: sortedRows(entries, 'tag') };
}

export function nozzleList(pid: PidModel, sheetId?: string): ListResult {
  const owners = segmentsByOwner(pid);
  const entries: Entry[] = [];
  for (const item of itemsOf(pid, sheetId)) {
    if (item.kind !== 'nozzle') continue;
    const segment = owners.get(item.id);
    const equipmentTag = labelOf(pid.items[item.equipmentId], item.equipmentId);
    entries.push({
      id: item.id,
      row: {
        equipmentTag,
        subTag: item.subTag,
        dn: item.dn ?? '',
        connectedLine: segment === undefined ? '' : lineNumberOf(pid, segment.lineId),
        access: item.access === true,
      },
    });
  }
  return { columns: NOZZLE_LIST_COLUMNS, rows: sortedRows(entries, 'equipmentTag', 'subTag') };
}

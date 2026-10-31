/** `pid_report kind=counts`: the census keys and counting rules of `validation/data/dexpi_census.json` applied to the model (plant 04 PID §5.7). */

import type { PidItem, PidModel } from '../model';

export const COUNT_KEYS = [
  'equipmentTopLevel',
  'equipmentAll',
  'nozzles',
  'pipingNetworkSystems',
  'pipingNetworkSegments',
  'pipingComponents',
  'valves',
  'processInstrumentationFunctions',
  'instrumentationLoopFunctions',
  'actuatingSystems',
  'processSignalGeneratingFunctions',
  'informationFlows',
  'pipeOffPageConnectors',
  'pipeFlowArrows',
  'connections',
  'danglingConnections',
  'shapeCatalogueEntries',
] as const;

export type CountKey = (typeof COUNT_KEYS)[number];
export type Counts = Readonly<Record<CountKey, number>>;

/** The class the source file gave (an unmapped class is `Custom` with the source class in passthrough). */
export const sourceClass = (item: PidItem): string => item.passthrough?.['dexpi:ComponentClass'] ?? item.dexpiClass;

/** Items on `sheetId` (all sheets when absent). */
export const itemsOf = (pid: PidModel, sheetId?: string): PidItem[] =>
  pid.itemOrder.flatMap((id) => {
    const item = pid.items[id];
    return item !== undefined && (sheetId === undefined || item.sheetId === sheetId) ? [item] : [];
  });

/**
 * Counting rules: a DEXPI segment is one `dexpi:segment` per line (llull splits it at every component); a valve is a piping component whose source class
 * contains "Valve"; connections, dangling ones and shape catalogue entries are counters of the import (not items) and are summed over the imports of the sheet.
 */
export function censusCounts(pid: PidModel, sheetId?: string): Counts {
  const counts: Record<CountKey, number> = Object.fromEntries(COUNT_KEYS.map((key) => [key, 0])) as Record<CountKey, number>;
  const segments = new Set<string>();
  for (const item of itemsOf(pid, sheetId)) {
    switch (item.kind) {
      case 'equipment':
        counts.equipmentAll++;
        if (item.parentId === undefined) counts.equipmentTopLevel++;
        break;
      case 'nozzle':
        counts.nozzles++;
        break;
      case 'line':
        counts.pipingNetworkSystems++;
        break;
      case 'segment':
        segments.add(`${item.lineId}|${item.passthrough?.['dexpi:segment'] ?? item.id}`);
        break;
      case 'inline':
        counts.pipingComponents++;
        if (sourceClass(item).includes('Valve')) counts.valves++;
        break;
      case 'instrument':
        counts.processInstrumentationFunctions++;
        break;
      case 'loop':
        counts.instrumentationLoopFunctions++;
        break;
      case 'actuating':
        counts.actuatingSystems++;
        break;
      case 'signal':
        counts.informationFlows++;
        break;
      case 'opc':
        counts.pipeOffPageConnectors++;
        break;
      case 'annotation':
        if (item.dexpiClass === 'ProcessSignalGeneratingFunction') counts.processSignalGeneratingFunctions++;
        else if (item.dexpiClass === 'PipeFlowArrow') counts.pipeFlowArrows++;
        break;
    }
  }
  counts.pipingNetworkSegments = segments.size;
  for (const record of pid.imports ?? [])
    if (sheetId === undefined || record.sheetId === sheetId)
      for (const key of ['connections', 'danglingConnections', 'shapeCatalogueEntries'] as const) counts[key] += record.census?.[key] ?? 0;
  return counts;
}

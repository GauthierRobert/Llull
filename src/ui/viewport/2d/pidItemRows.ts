// Read-only rows of a P&ID item for the 2D inspector (tag, class, typed fields, attributes); pure.

import type { PidItem } from '@aec/index';

type PidValue = PidItem['attributes'][string];

export interface PidItemRow {
  readonly label: string;
  readonly value: string;
}

const formatValue = (value: PidValue): string => (value.kind === 'quantity' ? `${value.value} ${value.unit}` : value.value);

/** Typed fields worth showing per kind, then the attributes sorted by name. Unknown fields are skipped. */
export function pidItemRows(item: PidItem): PidItemRow[] {
  const rows: PidItemRow[] = [{ label: 'Class', value: item.dexpiClass }];
  const add = (label: string, value: string | number | boolean | undefined): void => {
    if (value !== undefined && value !== '') rows.push({ label, value: String(value) });
  };
  switch (item.kind) {
    case 'line':
      add('Line number', item.lineNumber);
      add('DN', item.dn);
      add('Piping class', item.pipingClass);
      add('Fluid', item.fluidCode);
      add('Segments', item.segmentIds.length);
      break;
    case 'segment':
      add('DN', item.dn);
      add('Piping class', item.pipingClass);
      add('Flow', item.flow);
      add('Line', item.lineId);
      break;
    case 'inline':
      add('DN', item.dn);
      add('Piping class', item.pipingClass);
      break;
    case 'nozzle':
      add('Nozzle', item.subTag);
      add('DN', item.dn);
      break;
    case 'instrument':
      add('Category', item.category);
      add('Functions', item.functions);
      add('Loop', item.loopNumber);
      add('Location', item.location);
      add('Display', item.display);
      break;
    case 'signal':
      add('Signal', item.signalKind);
      break;
    case 'actuating':
      add('Actuator', item.actuator);
      add('Fail action', item.failAction);
      break;
    case 'opc':
      add('Direction', item.direction);
      add('Target sheet', item.targetSheet);
      break;
    default:
      break;
  }
  for (const name of Object.keys(item.attributes).sort()) rows.push({ label: name, value: formatValue(item.attributes[name] as PidValue) });
  return rows;
}

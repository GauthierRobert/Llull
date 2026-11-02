/** Nozzle schedule of the equipment data sheet: one row per nozzle record with its port (position, direction in millimetres) and flange. */

import type { EquipmentElement } from '@aec/building/types';
import type { NozzleRecord, PlantEquipmentData } from '../plantData';
import { millimetres, toMillimetres, type Obj } from './millimetres';

export interface DatasheetWarning {
  readonly code: string;
  readonly message: string;
  readonly paths: string[];
}

type Ports = { readonly ok: true; readonly data: Obj } | { readonly ok: false; readonly section: Obj };

function nozzleRow(nozzle: NozzleRecord, port: Obj | undefined, mm: number): Obj {
  const position = port?.['position'];
  return {
    mark: nozzle.mark,
    portId: port?.['id'] ?? null,
    service: nozzle.service ?? null,
    dn: nozzle.dn,
    rating: nozzle.rating,
    facing: nozzle.facing,
    location: toMillimetres(nozzle.location, mm),
    orientationDeg: port?.['orientationDeg'] ?? null,
    projectionMm: millimetres(nozzle.projection, mm),
    neckOutsideDiameterMm: millimetres(nozzle.neckOutsideDiameter, mm),
    neckWallMm: millimetres(nozzle.neckWall, mm),
    flange: toMillimetres(nozzle.flange, mm),
    positionMm: Array.isArray(position) ? position.map((value: number) => millimetres(value, mm)) : null,
    direction: port?.['direction'] ?? null,
  };
}

/** The rows in nozzle order; a nozzle without a placeable port keeps its row (position and direction null) and raises a warning. */
export function nozzleSchedule(
  element: EquipmentElement,
  plant: PlantEquipmentData,
  answer: Ports,
  mm: number,
): { rows: Obj[]; warnings: DatasheetWarning[] } {
  const ports = new Map<string, Obj>(answer.ok ? Object.entries(answer.data['ports'] as Record<string, Obj>) : []);
  const warnings: DatasheetWarning[] = [];
  const rows = plant.nozzles.map((nozzle): Obj => {
    const port = ports.get(`${element.mark}:${nozzle.mark}`);
    if (port === undefined)
      warnings.push({
        code: 'EQP_PARAM_INVALID',
        message: `nozzle ${nozzle.mark} of ${element.mark} has no placeable port (its location does not fit the equipment): position and direction are null`,
        paths: [`nozzles.${nozzle.mark}`],
      });
    return nozzleRow(nozzle, port, mm);
  });
  if (!answer.ok)
    warnings.push({
      code: typeof answer.section['code'] === 'string' ? answer.section['code'] : 'EQP_PARAM_INVALID',
      message: `ports unavailable: ${String(answer.section['message'])}`,
      paths: ['nozzles'],
    });
  return { rows, warnings };
}

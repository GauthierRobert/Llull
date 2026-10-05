/**
 * Bolt-group sizing of the moment connections: smallest bolt diameter / row count that passes every
 * connection of a kind (EN 1993-1-8).
 * @layer domain-aec
 * @pure
 */

import type { BuildingModel, MomentConnectionElement } from '@core/model/building';
import type { CadDocument } from '@core/model/types';
import { fromMm, toMm, withElement } from '../model';
import { buildingConnectionSolids } from './evaluateConnections';
import { connectionCheck, type CheckRow } from './frameCheckSolve';

const BOLT_SIZES_MM = [20, 24, 27, 30];

export function sizeBoltGroups(
  doc: CadDocument,
  initial: BuildingModel,
  rows: ReadonlyArray<CheckRow>,
  targetUtilisation: number,
): { building: BuildingModel; changes: string[]; changed: string[]; limited: boolean } {
  let building = initial;
  const changes: string[] = [];
  const changed: string[] = [];
  let limited = false;
  for (const kind of ['eaves', 'apex'] as const) {
    const targets = rows.filter((row) => {
      const element = building.elements[row.elementId];
      return element?.category === 'connection' && element.kind === kind && row.forces;
    });
    if (targets.length === 0) continue;
    let chosen: { rows: number; diameter: number } | null = null;
    // Fallback when nothing passes: the feasible group with the lowest worst utilisation.
    let best: { rows: number; diameter: number; worst: number } | null = null;
    search: for (const diameter of BOLT_SIZES_MM) {
      for (let boltRows = kind === 'eaves' ? 3 : 2; boltRows <= 6; boltRows++) {
        let worst = 0;
        let feasible = true;
        for (const row of targets) {
          const original = building.elements[row.elementId] as MomentConnectionElement;
          const trial: MomentConnectionElement = {
            ...original,
            boltRows,
            boltDiameter: fromMm(doc, diameter),
          };
          if (!rowSpacingOk(doc, building, trial)) {
            feasible = false;
            break;
          }
          const trialBuilding = withElement(building, trial);
          for (const forces of row.forces ?? []) {
            const verdict = connectionCheck(doc, trialBuilding, trial, forces.moment, forces.shear);
            if (verdict === null) {
              feasible = false;
              break;
            }
            worst = Math.max(worst, verdict.utilisation);
          }
          if (!feasible) break;
        }
        if (!feasible) continue;
        if (best === null || worst < best.worst) best = { rows: boltRows, diameter, worst };
        if (worst <= targetUtilisation) {
          chosen = { rows: boltRows, diameter };
          break search;
        }
      }
    }
    if (!chosen && best) {
      limited = true;
      chosen = { rows: best.rows, diameter: best.diameter };
    }
    if (!chosen) continue;
    changes.push(`${kind} connections: ${chosen.rows * 2} × M${chosen.diameter}`);
    for (const row of targets) {
      const original = building.elements[row.elementId] as MomentConnectionElement;
      if (
        original.boltRows === chosen.rows &&
        original.boltDiameter === fromMm(doc, chosen.diameter)
      ) {
        continue;
      }
      building = withElement(building, {
        ...original,
        boltRows: chosen.rows,
        boltDiameter: fromMm(doc, chosen.diameter),
      });
      changed.push(original.id);
    }
  }
  return { building, changes, changed, limited };
}

/** Bolt rows at least 2.2 d0 apart (EN 1993-1-8 Tab. 3.3; d0 = d + 2 mm up to M24, + 3 mm above). */
function rowSpacingOk(
  doc: Pick<CadDocument, 'units'>,
  building: BuildingModel,
  connection: MomentConnectionElement,
): boolean {
  if (connection.boltRows < 2) return true;
  const solids = buildingConnectionSolids(doc, building, connection);
  if (!solids) return false;
  const diameter = toMm(doc, connection.boltDiameter);
  const hole = fromMm(doc, diameter + (diameter <= 24 ? 2 : 3));
  const ys = [
    ...new Set(
      solids
        .filter((solid) => solid.part.startsWith('bolt') && solid.part.endsWith('-l'))
        .map((solid) => {
          const values = solid.outline.map(([, y]) => y);
          return (Math.min(...values) + Math.max(...values)) / 2;
        }),
    ),
  ].sort((a, b) => a - b);
  return ys.every((y, index) => index === 0 || y - (ys[index - 1] as number) >= 2.2 * hole);
}

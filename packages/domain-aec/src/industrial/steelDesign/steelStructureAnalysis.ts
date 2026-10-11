/**
 * Whole-structure load path and member verification behind check_steel_members:
 * loads → beams → columns, notional horizontal forces → bracing and moment frames, one row per
 * steel member.
 * @layer domain-aec
 * @pure
 */

import type { CadDocument } from '@core/model/types';
import { applyAreaLoads, type EquipmentLoadReport, type FloorLoadReport } from './steelAreaLoads';
import { applyLineLoads, type LineRunReport } from './steelLineLoads';
import { checkBeam } from './steelBeamChecks';
import { createBeamLoads } from './steelBeamLoads';
import { checkBracing, type StoreyReport } from './steelBracingChecks';
import { checkColumn, columnSegments, type ColumnSegment } from './steelColumnChecks';
import { analyseFrames, type FrameReport } from './steelFrameAnalysis';
import { analyseFraming, type BeamResult } from './steelFraming';
import { collectSteelBars, modelUnits } from './steelMemberBars';
import { skippedRow, type MemberRow } from './steelMemberRows';

interface SteelCheckParams {
  /** kN/m² permanent on floor slabs. */
  readonly floorDeadLoad: number;
  /** kN/m² imposed on floor slabs outside equipment footprints. */
  readonly imposedLoad: number;
  /** kg/m³ of pipe contents. */
  readonly pipeContentDensity: number;
  /** kg/m of cable tray with cables. */
  readonly cableTrayWeight: number;
  /** Notional horizontal force factor φ (1/200). */
  readonly notionalFactor: number;
  /** Beam deflection limit as span / n. */
  readonly deflectionRatio: number;
  /** Moment-frame storey drift limit as h / n. */
  readonly swayRatio: number;
}

interface SteelStructureAnalysis {
  /** One row per steel member, in model order. */
  readonly rows: MemberRow[];
  readonly floors: FloorLoadReport[];
  readonly equipment: EquipmentLoadReport[];
  readonly lines: LineRunReport[];
  readonly storeys: StoreyReport[];
  /** Moment frames (rigid beam-to-column joints) analysed as 2D frames. */
  readonly frames: FrameReport[];
  readonly warnings: string[];
  /** Steel mass per member id, kg. */
  readonly massKg: ReadonlyMap<string, number>;
}

/** @failure document without a building / steel members -> rows [] */
export function analyseSteelStructure(
  doc: CadDocument,
  params: SteelCheckParams,
): SteelStructureAnalysis {
  const units = modelUnits(doc);
  const bars = collectSteelBars(doc);
  const columns = bars.filter((bar) => bar.kind === 'column');
  const braces = bars.filter((bar) => bar.kind === 'brace');
  const beams = bars.filter((bar) => bar.kind === 'beam').map(createBeamLoads);
  const area = applyAreaLoads(units, beams, params);
  const lines = applyLineLoads(units, beams, params, bars);
  const framing = analyseFraming(beams, columns);
  for (const [columnId, node] of lines.columnNodes) {
    framing.columnNodes.set(columnId, [...(framing.columnNodes.get(columnId) ?? []), node]);
  }
  const segments = new Map<string, ColumnSegment[]>(
    columns.map((column) => [
      column.id,
      columnSegments(column, framing.columnNodes.get(column.id) ?? []),
    ]),
  );
  const results: BeamResult[] = [...framing.results.values()];
  const frames = analyseFrames(results, columns, framing.columnNodes, params);
  const bracing = checkBracing(
    braces,
    results,
    [...segments.values()].flat(),
    params.notionalFactor,
    frames.coverage,
  );
  const rowById = new Map<string, MemberRow>(bracing.rows.map((row) => [row.id, row]));
  for (const column of columns) {
    rowById.set(column.id, checkColumn(column, segments.get(column.id) ?? []));
  }
  for (const result of results) {
    rowById.set(
      result.loads.bar.id,
      checkBeam(
        result.loads.bar,
        result,
        params.deflectionRatio,
        bracing.strutForces.get(result.loads.bar.id),
      ),
    );
  }
  for (const [id, row] of frames.rows) rowById.set(id, row);
  const rows = bars.map(
    (bar) =>
      rowById.get(bar.id) ??
      skippedRow(bar, bar.skipReason ?? 'member is not part of the analysis'),
  );
  const massKg = new Map(
    bars.map((bar) => [bar.id, ((bar.profile?.massPerMetre ?? 0) * bar.length) / 1000]),
  );
  return {
    rows,
    floors: area.floors,
    equipment: area.equipment,
    lines: lines.runs,
    storeys: bracing.storeys,
    frames: frames.reports,
    warnings: [
      ...area.warnings,
      ...lines.warnings,
      ...framing.warnings,
      ...frames.warnings,
      ...bracing.warnings,
    ],
    massKg,
  };
}

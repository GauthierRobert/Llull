/**
 * @layer domain-aec
 */

import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { getBuilding, isFiniteNumber, noChange } from '../model';
import { toCsv } from '../scheduleBuild';
import type { CraneModel, FrameLoads } from './frameModelTypes';
import { checkFrames } from './frameCheckFrames';
import type { CheckRow } from './frameCheckSolve';
import { round } from '../numeric';
import { failureSummary } from './checkReport';

/** Load parameters shared by check_portal_frames and design_portal_frames. */
export const FRAME_LOAD_SHAPE = {
  deadLoad: z
    .number()
    .optional()
    .describe('Roof dead load (build-up, purlins, services), kN/m². Default 0.5.'),
  snowLoad: z.number().optional().describe('Roof snow load, kN/m². Default 0.8.'),
  windPressure: z
    .number()
    .optional()
    .describe(
      'Peak velocity pressure qp, kN/m² (EN 1991-1-4; e.g. 0.6–1.0). Default 0 = wind not applied. ' +
        'Coefficients: walls cpe +0.8 / −0.5, roof −0.6 (monopitch roofs, EN 1991-1-4 Tab. 7.3a zone H: −0.6 with ' +
        'wind on the low eaves, −0.8 on the high eaves), each with internal pressure cpi +0.2 and −0.3.',
    ),
  craneCapacity: z
    .number()
    .optional()
    .describe(
      'Crane capacity in tonnes for every runway on the level. Default: read from the runways ' +
        '(add_crane_runway capacity); 0 = ignore cranes.',
    ),
  hoistingClass: z
    .enum(['HC1', 'HC2', 'HC3', 'HC4'])
    .optional()
    .describe(
      'EN 1991-3 hoisting class for the dynamic factor φ2 = φ2,min + β2 vh (HC1 1.05 + 0.17 vh, ' +
        'HC2 1.10 + 0.34 vh, HC3 1.15 + 0.51 vh, HC4 1.20 + 0.68 vh). Default HC2.',
    ),
  hoistingSpeed: z
    .number()
    .optional()
    .describe('Hoisting speed vh in m/s (>= 0) for φ2. Default 0.1.'),
  craneSelfWeight: z
    .number()
    .optional()
    .describe(
      'Crane self-weight Gc in kN (> 0, bridge + trolley; trolley = 0.2 Gc). Default 0.5 Q + 20 kN.',
    ),
  minHookApproach: z
    .number()
    .optional()
    .describe(
      'Minimum approach of the hook to a rail in m (>= 0): the trolley position that maximises the wheel load. Default 1.0.',
    ),
  wheelBase: z
    .number()
    .optional()
    .describe(
      'Wheel base a of a crane rail wheel group in mm (> 0), used for the transverse drive force HT = φ5 ξ M / a. Default 3000.',
    ),
  levelId: z.string().optional().describe('Level id. Default: the active level.'),
};

type FrameLoadParams = z.output<z.ZodObject<typeof FRAME_LOAD_SHAPE>>;

/** Validated loads + level, or the failure reason. */
export function resolveFrameLoads(
  doc: CadDocument,
  params: FrameLoadParams,
): { loads: FrameLoads; levelId: string } | { reason: string } {
  const { deadLoad = 0.5, snowLoad = 0.8, windPressure = 0, craneCapacity } = params;
  const nonNegative = (value: unknown): boolean => isFiniteNumber(value) && value >= 0;
  if (
    !nonNegative(deadLoad) ||
    !nonNegative(snowLoad) ||
    !nonNegative(windPressure) ||
    (craneCapacity !== undefined && !nonNegative(craneCapacity))
  ) {
    return { reason: 'deadLoad, snowLoad, windPressure and craneCapacity must be >= 0' };
  }
  const { hoistingClass, hoistingSpeed, craneSelfWeight, minHookApproach, wheelBase } = params;
  if (
    (hoistingSpeed !== undefined && !nonNegative(hoistingSpeed)) ||
    (minHookApproach !== undefined && !nonNegative(minHookApproach))
  ) {
    return { reason: 'hoistingSpeed and minHookApproach must be >= 0' };
  }
  const positive = (value: unknown): boolean => isFiniteNumber(value) && value > 0;
  if (
    (craneSelfWeight !== undefined && !positive(craneSelfWeight)) ||
    (wheelBase !== undefined && !positive(wheelBase))
  ) {
    return { reason: 'craneSelfWeight and wheelBase must be > 0' };
  }
  const building = getBuilding(doc);
  const levelId = params.levelId ?? building.activeLevelId ?? building.levelOrder[0];
  if (levelId === undefined || !building.levels[levelId]) {
    return { reason: `no level '${params.levelId ?? ''}'` };
  }
  const craneModel: CraneModel = {
    ...(hoistingClass !== undefined ? { hoistingClass } : {}),
    ...(hoistingSpeed !== undefined ? { hoistingSpeed } : {}),
    ...(craneSelfWeight !== undefined ? { craneSelfWeight } : {}),
    ...(minHookApproach !== undefined ? { minHookApproach } : {}),
    ...(wheelBase !== undefined ? { wheelBase } : {}),
  };
  return {
    loads: {
      deadLoad,
      snowLoad,
      windPressure,
      ...(craneCapacity !== undefined ? { craneCapacity } : {}),
      ...(Object.keys(craneModel).length > 0 ? { craneModel } : {}),
    },
    levelId,
  };
}

/** "G = 0.5 kN/m² + self-weight, S = 0.8, W = 0.7 (qp), cranes from runways". */
export function describeLoads(loads: FrameLoads): string {
  return (
    `G = ${loads.deadLoad} kN/m² + self-weight, S = ${loads.snowLoad} kN/m², ` +
    `${loads.windPressure > 0 ? `qp = ${loads.windPressure} kN/m²` : 'no wind (windPressure = 0)'}, ` +
    `${loads.craneCapacity === undefined ? 'cranes from runways' : loads.craneCapacity === 0 ? 'cranes ignored' : `cranes ${loads.craneCapacity} t`}`
  );
}

/**
 * @command check_portal_frames
 * @pure read-only
 * @affects none; data = { rows: CheckRow[], csv, maxUtilisation, failures, combinations, alphaCritical }
 * @failure negative loads / unknown level / no frame -> no data
 */
export const checkPortalFrames = defineCommand({
  name: 'check_portal_frames',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Structural check of the steel portal frames of a level. Each frame (rafters in a vertical ' +
    "plane + the columns under them; bases pinned, or fixed when the base plates have columnBase 'fixed') is solved as a 2D frame (direct stiffness, " +
    'section properties from the profile outline, no root radii) for every EN 1990 combination of ' +
    'dead G (deadLoad + self-weight), snow S, wind W (windPressure, both directions, incl. uplift) ' +
    'and crane C (from add_crane_runway capacity, EN 1991-3 load groups 1 and 5: wheel reactions by statics ' +
    'at the minimum hook approach with φ1 / φ2 (hoisting class) / φ4, transverse drive forces HT (φ5) and ' +
    'skewing forces HS at the brackets; combinations C / C5 with the crane at the left or right rail), with sway imperfections and Horne αcr per storey (all moments amplified ' +
    'by 1/(1−1/αcr) when αcr < 10). Checks: member cross-section (EN 1993-1-1 §6.2), flexural buckling with N–M ' +
    'interaction and lateral-torsional buckling (§6.3; columns full height, LTB between side rails, ' +
    'rafters between purlins, compression flanges assumed fly-braced at purlins / rails), frame sway stability ' +
    '(αcr ≥ 3), end-plate bolt groups (EN 1993-1-8, grade 8.8) and SLS deflections (rafters ' +
    'span/200 under snow, eaves h/150 under wind, rail level h/400 under crane). Returns the worst ' +
    'utilisation per element; values > 1 fail. Bracing, foundations and crane runway beams are ' +
    'checked by check_bracing, check_foundations and check_crane_runways. A preliminary design ' +
    'check, not a substitute for the engineer of record.',
  params: z.object(FRAME_LOAD_SHAPE),
  run: (doc, params): CommandResult => {
    const resolved = resolveFrameLoads(doc, params);
    if ('reason' in resolved)
      return noChange(doc, `check_portal_frames failed: ${resolved.reason}.`);
    const { loads, levelId } = resolved;
    const { rows, frames, skipped, combinations, minAlphaCritical } = checkFrames(
      doc,
      levelId,
      loads,
    );
    if (frames === 0) {
      return noChange(
        doc,
        `check_portal_frames failed: no analysable portal frame on the level${skipped.length > 0 ? ` (${skipped.join(', ')})` : ''}.`,
      );
    }
    const failures = rows.filter((row) => row.utilisation > 1);
    const worst = rows.reduce<CheckRow | null>(
      (best, row) => (best === null || row.utilisation > best.utilisation ? row : best),
      null,
    );
    const columns = [
      'Frame',
      'Mark',
      'Type',
      'N (kN)',
      'M (kNm)',
      'V (kN)',
      'Utilisation',
      'Status',
      'Combination',
      'Check',
    ];
    const csv = toCsv(
      columns,
      rows.map((row) => [
        row.frame,
        row.mark,
        row.kind,
        round(row.axial, 1),
        round(row.moment, 1),
        round(row.shear, 1),
        round(row.utilisation),
        row.utilisation > 1 ? 'FAIL' : 'OK',
        row.combination,
        row.check,
      ]),
    );
    return {
      document: doc,
      summary:
        `Checked ${frames} frame(s), ${rows.length} check(s) over ${combinations.length} ULS combination(s) + SLS (${describeLoads(loads)}): ` +
        `max utilisation ${round(worst?.utilisation ?? 0)} (${worst?.mark ?? '—'} ${worst?.kind ?? ''}, ${worst?.frame ?? '—'}, ${worst?.combination ?? '—'}); ` +
        `min αcr ${Number.isFinite(minAlphaCritical) ? round(minAlphaCritical, 1) : '—'}; ` +
        failureSummary(
          failures,
          (row) => `${row.mark} ${row.kind}`,
          'all OK (frames only: see check_bracing, check_foundations, check_crane_runways).',
        ) +
        `${skipped.length > 0 ? ` Not checked: ${skipped.join(', ')}.` : ''}`,
      affected: [],
      data: {
        rows,
        csv,
        maxUtilisation: worst?.utilisation ?? 0,
        failures: [...new Set(failures.map((row) => row.elementId))],
        combinations,
        alphaCritical: Number.isFinite(minAlphaCritical) ? minAlphaCritical : null,
      },
    };
  },
});

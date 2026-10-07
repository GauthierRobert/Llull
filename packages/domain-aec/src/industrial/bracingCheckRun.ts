/**
 * @layer domain-aec
 */

import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { existingLevelId, getBuilding } from '../model';
import { noop } from '@core/commands/noop';
import { isPositiveNumber, isNonNegativeNumber } from '@lib/isFiniteNumber';
import { DEFAULT_BUFFER_STIFFNESS, DEFAULT_TRAVEL_SPEED } from './runwayCheckModel';
import { round } from '../numeric';
import { checkTable, failureSummary } from './checkReport';
import { analyseBracing, locateMembers } from './bracingAnalysis';
import { existingLevelIdParam } from '../levelParams';

/**
 * @command check_bracing
 * @pure read-only
 * @affects none; data = { rows: BracingRow[], csv, maxUtilisation, failures, windForce, ... }
 * @invariant ULS wind = 1.5 · qp · 1.3 · gable area; tension-only diagonals; Npl,Rd = A·fy
 * @failure negative loads / unknown level / no bracing / no rafters -> no data
 */
export const checkBracing = defineCommand({
  name: 'check_bracing',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Preliminary wind-bracing check of the steel hall on a level (members with role brace, e.g. from ' +
    'add_portal_frame_building). Longitudinal wind on the gable: ULS force = 1.5 · qp · (0.8 + 0.5) · ' +
    'gable area (span × eaves + roof triangle, from the end-frame rafters/columns). Half goes to the ' +
    'roof level and, with the EN 1993-1-1 §5.3.3 equivalent stabilising force (1/200 of the roof ULS ' +
    'vertical load 1.35 deadLoad + 1.5 snowLoad), is carried by the roof X-bracing as a horizontal ' +
    'truss, shared equally by the braced end bays; the roof reactions go to the wall X-bracing. ' +
    'Diagonals are tension-only: one per X carries the panel shear / cos θ, checked against ' +
    'Npl,Rd = A·fy (γM0 = 1, net = gross for welded ends). The transverse component is carried in ' +
    'compression by the rafter (roof) or column (wall), checked for minor-axis buckling χ·Npl,Rd ' +
    'with Lcr = bay length. Gable posts: net pressure cpe + cpi = 0.8 + 0.2 = 1.0 on one wall, simply supported bending ' +
    'q·tributary·h²/8 vs Mpl and shear. The roof truss spans the full hall width on the two outer ' +
    'walls: panel shear V = w·(W/2 − d) (w = bay force / W, d = distance of the panel edge from the ' +
    'nearest wall), so wall-side panels carry about half the bay force. Struts: wall = column, Lcr = ' +
    'column height; roof = rafter, Lcr = purlin gap along the rafter; plus the eaves purlin carrying ' +
    'the truss reaction (bay force / 2) with Lcr = bay length (row flagged utilisation 99 if absent). ' +
    'On multi-span halls the internal column lines carry no wall bracing, so the roof truss still spans ' +
    'the full hall width and the reaction (bay force / 2) acts at the two OUTER wall lines only: the ' +
    'eaves-strut force equals that of a single-span hall of the same gable area (it grows with the gable, ' +
    'e.g. a monopitch gable is larger than a duopitch one), and a light eaves purlin such as the default ' +
    'C200x75x2.5 over a 6 m bay (about 36 kN) can fail at qp above about 0.7 kN/m²: fit a heavier eaves ' +
    'purlin (update_steel_member) rather than treating the force as an error.' +
    ' Crane longitudinal path (runway beams, role crane, on a long wall): per runway line the force at rail level is max(1.35 HL,i = ' +
    '1.35 φ5 K/nr of groups 1/5, HB,1/nr of group 7 with accidental γ = 1.0, HB,1 = 1.25 · 0.7 travelSpeed · √(mc SB), crane mass only) ' +
    'and is added to the shear of the wall X-bracing panels on that side (shared equally by the braced bays of that wall; ' +
    'assumes the existing wall X-bracing takes it, no separate crane bracing below the rail). Rows "crane longitudinal (group 1 / group 7)" ' +
    'report the crane-only part; data.crane gives the horizontal force (along y) at the foundations of the braced-bay columns. ' +
    'Rows are grouped (roof bracing, wall bracing per side, gable posts); utilisation > 1 ' +
    'fails. Not covered: frame action, uplift, self-weight, connections - a preliminary check.',
  params: z.object({
    windPressure: z
      .number()
      .optional()
      .describe(
        'Peak velocity pressure qp, kN/m² (EN 1991-1-4). Default 0.6. Frame gable coefficient 0.8 + 0.5; gable posts use net cpe + cpi = 0.8 + 0.2.',
      ),
    deadLoad: z
      .number()
      .optional()
      .describe('Roof dead load, kN/m², for the stabilising force only. Default 0.5.'),
    snowLoad: z
      .number()
      .optional()
      .describe('Roof snow load, kN/m², for the stabilising force only. Default 0.8.'),
    craneCapacity: z
      .number()
      .optional()
      .describe(
        'Crane capacity in tonnes (> 0) for the crane longitudinal force. Default: read from the runway beam notes (add_crane_runway); no runway and no value = no crane force.',
      ),
    craneSelfWeight: z
      .number()
      .optional()
      .describe('Crane self-weight Gc in kN (> 0). Default 0.5 Q + 20 kN.'),
    travelSpeed: z
      .number()
      .optional()
      .describe(
        'Crane long travel speed in m/s (> 0) for the buffer force (v1 = 0.7 × travelSpeed). Default 0.63 (about 38 m/min).',
      ),
    bufferStiffness: z
      .number()
      .optional()
      .describe('Buffer spring constant SB in kN/m (> 0). Default 1000.'),
    levelId: existingLevelIdParam,
  }),
  run: (doc: CadDocument, params): CommandResult => {
    const { windPressure = 0.6, deadLoad = 0.5, snowLoad = 0.8 } = params;
    if (
      !isNonNegativeNumber(windPressure) ||
      !isNonNegativeNumber(deadLoad) ||
      !isNonNegativeNumber(snowLoad)
    ) {
      return noop(doc, 'check_bracing failed: windPressure, deadLoad, snowLoad must be >= 0.');
    }
    const { travelSpeed = DEFAULT_TRAVEL_SPEED, bufferStiffness = DEFAULT_BUFFER_STIFFNESS } =
      params;
    for (const [name, value] of [
      ['craneCapacity', params.craneCapacity],
      ['craneSelfWeight', params.craneSelfWeight],
      ['travelSpeed', travelSpeed],
      ['bufferStiffness', bufferStiffness],
    ] as const) {
      if (value !== undefined && !isPositiveNumber(value)) {
        return noop(doc, `check_bracing failed: ${name} must be a number > 0.`);
      }
    }
    const levelId = existingLevelId(getBuilding(doc), params.levelId);
    if (levelId === undefined) {
      return noop(doc, `check_bracing failed: no level '${params.levelId ?? ''}'.`);
    }
    const analysis = analyseBracing(locateMembers(doc, levelId), levelId, {
      windPressure,
      deadLoad,
      snowLoad,
      craneCapacity: params.craneCapacity,
      craneSelfWeight: params.craneSelfWeight,
      travelSpeed,
      bufferStiffness,
    });
    if ('reason' in analysis) return noop(doc, analysis.reason);
    const {
      rows,
      gableArea,
      windUltimate,
      roofWind,
      roofForce,
      stability,
      bayForce,
      bayCount,
      craneForce,
      craneCapacity,
      craneSpan,
      craneSides,
      craneFoundation,
    } = analysis;
    const { csv, failures, worst } = checkTable(
      rows,
      [
        'Group',
        'Mark',
        'Type',
        'Force (kN)',
        'Resistance (kN)',
        'M (kNm)',
        'Utilisation',
        'Status',
        'Check',
      ],
      (row, status) => [
        row.group,
        row.mark,
        row.kind,
        round(row.force, 1),
        round(row.resistance, 1),
        round(row.moment, 1),
        round(row.utilisation),
        status,
        row.check,
      ],
    );
    return {
      document: doc,
      summary:
        `Bracing check (qp ${windPressure} kN/m², G ${deadLoad}, S ${snowLoad}): gable ${round(gableArea, 1)} m², ` +
        `ULS wind ${round(windUltimate, 1)} kN, roof level ${round(roofWind, 1)} kN + stability ${round(stability, 1)} kN ` +
        `over ${bayCount} braced bay(s) = ${round(bayForce, 1)} kN each; ${rows.length} check(s), ` +
        `max utilisation ${round(worst?.utilisation ?? 0)} (${worst?.mark ?? '—'} ${worst?.kind ?? ''}, ${worst?.group ?? '—'}); ` +
        failureSummary(
          failures,
          (row) => `${row.mark} ${row.kind}`,
          'all OK (preliminary, tension-only diagonals).',
        ),
      affected: [],
      data: {
        rows,
        csv,
        maxUtilisation: worst?.utilisation ?? 0,
        failures: [...new Set(failures.flatMap((row) => row.elementIds))],
        gableArea,
        windForce: windUltimate,
        roofForce,
        stabilityForce: stability,
        bracedBays: bayCount,
        crane:
          craneForce === null
            ? null
            : {
                ...craneForce,
                capacityTonnes: craneCapacity,
                spanMm: craneSpan,
                runwaySides: craneSides,
                foundationHorizontalY: craneFoundation,
              },
      },
    };
  },
});

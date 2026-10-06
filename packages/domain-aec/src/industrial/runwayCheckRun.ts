/**
 * @layer domain-aec
 */

import type { SteelMemberElement } from '@core/model/building';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { getBuilding, toMm } from '../model';
import { noop } from '@core/commands/noop';
import { isPositiveNumber, isNonNegativeNumber } from '@lib/isFiniteNumber';
import { craneCapacityOf, type CraneModel } from './frameModelTypes';
import {
  DEFAULT_BUFFER_STIFFNESS,
  DEFAULT_CRANE_SPAN,
  DEFAULT_TRAVEL_SPEED,
  type RunwayCheckRow,
} from './runwayCheckModel';
import { checkBeam } from './runwayBeamCheck';
import { round } from '../numeric';
import { checkTable, existingLevelId, failureSummary } from './checkReport';

/**
 * @command check_crane_runways
 * @pure read-only
 * @affects none; data = { rows: RunwayCheckRow[], csv, maxUtilisation, failures }
 * @failure bad params / unknown level / no crane beams -> no data
 */
export const runwayCheck = defineCommand({
  name: 'check_crane_runways',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Preliminary check of the crane runway beams (steel members with role crane, from ' +
    'add_crane_runway / add_portal_frame_building crane) of a level. Each segment between supports ' +
    'is a simply supported beam (conservative vs continuous) loaded by one 2-wheel crane group per ' +
    'rail: wheel load P = max rail reaction / 2 from the statics of the bridge with the trolley at ' +
    'the minimum hook approach (EN 1991-3 load group 1: φ1 = 1.1 on Gc, φ2 by hoisting class), lateral ' +
    'rail force = envelope of the transverse drive force HT (group 1, φ5 = 1.5) and the skewing force HS ' +
    '(group 5, §2.7.4, α = 0.015) split on the wheels, longitudinal stop force HL = φ5 K/nr as axial force, ULS factor 1.35, runway + rail self-weight (railSize). ' +
    'Checks: (1) strength - biaxial My/Mpl,y + Mz/Mpl,z with lateral bending carried by the top ' +
    'flange only (Wpl,z/2), and shear; (2) ltb - χLT from Mcr (C1 = 1.13, Lcr = span, I-sections ' +
    'only, 0.85 Mcr for the top-flange load application); (3) SLS EN 1993-6 §7.3 - vertical and ' +
    'lateral deflection <= L/600 under characteristic wheel loads (static P, two-wheel exact ' +
    'midspan formula); (4) fatigue EN 1993-1-9 - ΔσE2 = λ φfat Δσ at the bottom flange, λ = 0.315 / ' +
    '0.397 / 0.500 (normal stresses, EN 1991-3 Tab. 2.12) for class S2 / S3 / S4, φfat 1.05, detail category 71, γMf 1.15, γFf 1.0. ' +
    '(5) local - EN 1993-6 §5.7.1: leff = 3.25 (Irf/tw)^(1/3), Irf = 0.75 Ir(rail, wear) + If (rail not rigidly ' +
    'fixed, Tab. 5.1 case b), beff = foot + hr + tf <= b, σoz = 1.35 P / (leff tw) <= fy/γM0; local fatigue with λ x 1.26 ' +
    '(2 cycles per passage), φfat 1.05, category 160 (girder rolled) / 71 (welded-full, full-penetration) / 36 (welded-fillet) / γMf 1.15. ' +
    '(6) buffer forces, load group 7 (§2.11.1): HB,1 = φ7 v1 √(mc SB), φ7 = 1.25 (ξb ≤ 0.5), v1 = 0.7 travelSpeed, mc = crane mass (free hook), SB = bufferStiffness; ' +
    'shared by the 2 rails, accidental γ = 1.0 (Tab. A.1); rows: stop force vs top-flange weld transfer (b tf fy, stop welded to the top flange) and end-bay axial + bending at the beam centroid (eccentricity h/2 + rail height). ' +
    '(7) test load, group 8 (§2.10): Qtest = max(φ6 · 1.1, 1.25) Qh, φ6 = 0.5 (1 + φ2), γ = 1.1, bending row. ' +
    'Utilisation > 1 fails. Not covered: torsion, rail-wheel contact, continuity, ' +
    'connections - not a substitute for the engineer of record.',
  params: z.object({
    craneCapacity: z
      .number()
      .optional()
      .describe(
        'Crane capacity in tonnes (> 0) applied to every runway beam. Default: read from each ' +
          "runway beam's note (add_crane_runway capacity).",
      ),
    wheelBase: z
      .number()
      .optional()
      .describe('Distance between the two wheels of a rail wheel group, mm (> 0). Default 3000.'),
    hoistingClass: z
      .enum(['HC1', 'HC2', 'HC3', 'HC4'])
      .optional()
      .describe(
        'EN 1991-3 hoisting class: φ2 = φ2,min + β2 vh (HC1 1.05 + 0.17 vh, HC2 1.10 + 0.34 vh, HC3 1.15 + 0.51 vh, HC4 1.20 + 0.68 vh). Default HC2.',
      ),
    hoistingSpeed: z.number().optional().describe('Hoisting speed vh in m/s (>= 0). Default 0.1.'),
    craneSpan: z
      .number()
      .optional()
      .describe(
        'Bridge span between the two runway rails, mm (> 0). Default: x distance to the paired runway beam, else 20000.',
      ),
    craneSelfWeight: z
      .number()
      .optional()
      .describe(
        'Crane self-weight Gc in kN (> 0, bridge + trolley, trolley = 0.2 Gc). Default 0.5 Q + 20 kN.',
      ),
    minHookApproach: z
      .number()
      .optional()
      .describe(
        'Minimum hook approach to the rail in m (>= 0); positions the trolley for the maximum wheel load. Default 1.0.',
      ),
    travelSpeed: z
      .number()
      .optional()
      .describe(
        'Crane long travel speed in m/s (> 0) for the buffer force HB,1 (v1 = 0.7 × travelSpeed). Default 0.63 (about 38 m/min).',
      ),
    bufferStiffness: z
      .number()
      .optional()
      .describe(
        'Buffer spring constant SB in kN/m (> 0) for HB,1 = φ7 v1 √(mc SB). Default 1000 kN/m.',
      ),
    craneClass: z
      .enum(['S2', 'S3', 'S4'])
      .optional()
      .describe(
        'EN 1991-3 / EN 1993-6 fatigue duty class (S2 light, S3 medium, S4 heavy). Default S3.',
      ),
    railSize: z
      .enum(['A45', 'A55', 'A65', 'A75', 'A100', 'flat50x30'])
      .optional()
      .describe(
        'Crane rail (DIN 536 Form A, approximate section data, or flat bar 50x30). Its mass joins the runway self-weight and its inertia (75 % of Ir for wear) spreads the wheel load in the local web check. Default A55.',
      ),
    girder: z
      .enum(['rolled', 'welded-full', 'welded-fillet'])
      .optional()
      .describe(
        'Runway girder type for local web fatigue (EN 1993-1-9 Tab. 8.10): rolled section = detail category 160; welded-full = welded plate girder with full-penetration web-to-flange welds = 71; welded-fillet = fillet or partial-penetration welds = 36. Default rolled.',
      ),
    levelId: z.string().optional().describe('Level id. Default: the active level.'),
  }),
  run: (doc, params): CommandResult => {
    const {
      craneCapacity,
      wheelBase = 3000,
      hoistingClass = 'HC2',
      hoistingSpeed = 0.1,
      craneSpan,
      craneSelfWeight,
      minHookApproach = 1,
      travelSpeed = DEFAULT_TRAVEL_SPEED,
      bufferStiffness = DEFAULT_BUFFER_STIFFNESS,
      craneClass = 'S3',
      railSize = 'A55',
      girder = 'rolled',
    } = params;
    if (craneCapacity !== undefined && !isPositiveNumber(craneCapacity)) {
      return noop(doc, 'check_crane_runways failed: craneCapacity must be a number > 0 (t).');
    }
    if (!isPositiveNumber(wheelBase)) {
      return noop(doc, 'check_crane_runways failed: wheelBase must be a number > 0 (mm).');
    }
    if (!isNonNegativeNumber(hoistingSpeed)) {
      return noop(doc, 'check_crane_runways failed: hoistingSpeed must be a number >= 0 (m/s).');
    }
    if (!isNonNegativeNumber(minHookApproach)) {
      return noop(doc, 'check_crane_runways failed: minHookApproach must be a number >= 0 (m).');
    }
    for (const [name, value] of [
      ['craneSpan', craneSpan],
      ['craneSelfWeight', craneSelfWeight],
      ['travelSpeed', travelSpeed],
      ['bufferStiffness', bufferStiffness],
    ] as const) {
      if (value !== undefined && !isPositiveNumber(value)) {
        return noop(doc, `check_crane_runways failed: ${name} must be a number > 0.`);
      }
    }
    const building = getBuilding(doc);
    const levelId = existingLevelId(building, params.levelId);
    if (levelId === undefined) {
      return noop(doc, `check_crane_runways failed: no level '${params.levelId ?? ''}'.`);
    }
    const mm = (value: number): number => toMm(doc, value);
    const rows: RunwayCheckRow[] = [];
    const runways = Object.values(building.elements).filter(
      (element): element is SteelMemberElement =>
        element.category === 'member' && element.role === 'crane' && element.levelId === levelId,
    );
    /** Bridge span: x distance to the nearest runway beam facing this one (overlapping y range). */
    const pairedSpan = (beam: SteelMemberElement): number => {
      const [yLow, yHigh] = [
        Math.min(beam.start[1], beam.end[1]),
        Math.max(beam.start[1], beam.end[1]),
      ];
      const distances = runways
        .filter(
          (other) =>
            other !== beam &&
            Math.min(other.start[1], other.end[1]) < yHigh &&
            Math.max(other.start[1], other.end[1]) > yLow &&
            Math.abs(mm(other.start[0] - beam.start[0])) > 1000,
        )
        .map((other) => Math.abs(mm(other.start[0] - beam.start[0])));
      return distances.length > 0 ? Math.min(...distances) : DEFAULT_CRANE_SPAN;
    };
    const capacities = new Set<number>();
    let beams = 0;
    for (const element of Object.values(building.elements)) {
      if (element.category !== 'member' || element.role !== 'crane') continue;
      if (element.levelId !== levelId) continue;
      const capacity = craneCapacity ?? craneCapacityOf(element);
      if (capacity === null) continue;
      const span = Math.hypot(
        mm(element.end[0] - element.start[0]),
        mm(element.end[1] - element.start[1]),
        mm(element.end[2] - element.start[2]),
      );
      const model: CraneModel = {
        hoistingClass,
        hoistingSpeed,
        minHookApproach,
        wheelBase,
        ...(craneSelfWeight !== undefined ? { craneSelfWeight } : {}),
      };
      const beamRows = checkBeam(
        element,
        span,
        capacity,
        craneSpan ?? pairedSpan(element),
        model,
        craneClass,
        railSize,
        girder,
        { travelSpeed, stiffness: bufferStiffness },
      );
      if (beamRows.length === 0) continue;
      beams += 1;
      capacities.add(capacity);
      rows.push(...beamRows);
    }
    const { csv, failures, worst } = checkTable(
      rows,
      [
        'Beam',
        'Mark',
        'Profile',
        'Span (mm)',
        'Kind',
        'Check',
        'Value',
        'Limit',
        'Unit',
        'Utilisation',
        'Status',
      ],
      (row, status) => [
        row.elementId,
        row.mark,
        row.profile,
        row.span,
        row.kind,
        row.check,
        row.value,
        row.limit,
        row.unit,
        row.utilisation,
        status,
      ],
    );
    if (beams === 0 || !worst) {
      return noop(
        doc,
        `check_crane_runways failed: no crane runway beam with a known capacity on level '${levelId}' (add_crane_runway first, or pass craneCapacity).`,
      );
    }
    return {
      document: doc,
      summary:
        `Checked ${beams} crane runway beam(s), ${rows.length} check(s) (${[...capacities].join('/')} t, class ${craneClass}, wheelBase ${wheelBase} mm): ` +
        `max utilisation ${round(worst.utilisation)} (${worst.mark} ${worst.kind}: ${worst.check}); ` +
        failureSummary(
          failures,
          (row) => `${row.mark} ${row.kind}`,
          'all OK (preliminary, simply supported spans).',
        ),
      affected: [],
      data: {
        rows,
        csv,
        maxUtilisation: worst.utilisation,
        failures: [...new Set(failures.map((row) => row.elementId))],
      },
    };
  },
});

/**
 * Crane runway beam verification (preliminary): bending + shear under moving wheel loads, lateral
 * bending, lateral-torsional buckling, SLS deflections (EN 1993-6 §7.3) and fatigue (EN 1993-1-9).
 * @layer core/commands/building/industrial
 */

import type { SteelMemberElement } from '../../../model/building';
import type { CommandDefinition, CommandResult } from '../../types';
import { fromMm, getBuilding, isFiniteNumber, noChange } from '../model';
import { findProfile, sectionProperties } from '../steel/profiles';
import { toCsv } from '../quantities';
import {
  craneActions,
  craneCapacityOf,
  HOISTING_CLASSES,
  type CraneModel,
  type HoistingClass,
} from './frameModel';
import {
  E_STEEL,
  lateralTorsionalReduction,
  sectionResistance,
  yieldStrength,
} from './steelDesign';

export type CraneClass = 'S2' | 'S3' | 'S4';

export type GirderType = 'rolled' | 'welded-full' | 'welded-fillet';

export type RailSize = 'A45' | 'A55' | 'A65' | 'A75' | 'A100' | 'flat50x30';

/** Approximate crane-rail data (DIN 536 Form A; flat bar 50x30): height mm, foot width mm, kg/m, Ir mm⁴. */
export const RAILS: Readonly<
  Record<RailSize, { height: number; foot: number; mass: number; inertia: number }>
> = {
  A45: { height: 55, foot: 125, mass: 22.1, inertia: 90e4 },
  A55: { height: 65, foot: 150, mass: 31.8, inertia: 178e4 },
  A65: { height: 75, foot: 175, mass: 43.1, inertia: 319e4 },
  A75: { height: 85, foot: 200, mass: 56.2, inertia: 531e4 },
  A100: { height: 95, foot: 200, mass: 74.3, inertia: 856e4 },
  flat50x30: { height: 30, foot: 50, mass: 11.8, inertia: 11.25e4 },
};

export interface RunwayCheckParams {
  railSize?: RailSize;
  girder?: GirderType;
  craneCapacity?: number;
  wheelBase?: number;
  craneClass?: CraneClass;
  hoistingClass?: HoistingClass;
  hoistingSpeed?: number;
  craneSpan?: number;
  craneSelfWeight?: number;
  minHookApproach?: number;
  levelId?: string;
}

export interface RunwayCheckRow {
  readonly elementId: string;
  readonly mark: string;
  readonly profile: string;
  /** Segment length, mm. */
  readonly span: number;
  readonly kind: 'strength' | 'ltb' | 'deflection' | 'fatigue' | 'local';
  readonly check: string;
  readonly value: number;
  readonly limit: number;
  readonly unit: string;
  readonly utilisation: number;
}

const GAMMA_ULS = 1.35;
/** Bridge span (mm) when no paired runway beam is found and craneSpan is not given. */
const DEFAULT_CRANE_SPAN = 20000;
const DEFLECTION_RATIO = 600;
const FATIGUE_PHI = 1.05;
const FATIGUE_CATEGORY = 71; // N/mm²
const GAMMA_MF = 1.15;
const GAMMA_M0 = 1;
/** EN 1993-1-9 Tab. 8.10: rolled 160; welded full-penetration tee-butt 71; fillet / partial penetration 36. */
const LOCAL_CATEGORIES: Readonly<Record<GirderType, number>> = {
  rolled: 160,
  'welded-full': 71,
  'welded-fillet': 36,
};
const LOCAL_LAMBDA_FACTOR = 1.26; // 2^(1/3): two stress cycles per wheel passage (EN 1993-6 §9.4.2)
const RAIL_WEAR_INERTIA_FACTOR = 0.75; // simplified Ir reduction for 25 % head wear (EN 1993-6 §5.6.2(2))
/** Damage-equivalent factors λ for normal stresses (EN 1991-3 Tab. 2.12). */
const CLASSES: Readonly<Record<CraneClass, number>> = { S2: 0.315, S3: 0.397, S4: 0.5 };

/** Maximum moment (N·mm) of two wheel loads P at spacing a on a simply supported span L. */
export function wheelMoment(load: number, spacing: number, span: number): number {
  return spacing < 0.586 * span
    ? (load * (span - spacing / 2) ** 2) / (2 * span)
    : (load * span) / 4;
}

/** Maximum support shear (N) of two wheel loads P at spacing a on span L (one wheel at support). */
export function wheelShear(load: number, spacing: number, span: number): number {
  return load * Math.max(1, 2 - spacing / span);
}

/** Midspan deflection (mm) of two wheel loads P placed symmetrically about midspan (exact). */
function wheelDeflection(load: number, spacing: number, span: number, inertia: number): number {
  const wheels = spacing < span ? 2 : 1;
  const x = wheels === 2 ? (span - spacing) / 2 : span / 2;
  return (wheels * load * x * (3 * span ** 2 - 4 * x ** 2)) / (48 * E_STEEL * inertia);
}

function round(value: number, digits = 2): number {
  return Math.round(value * 10 ** digits) / 10 ** digits;
}

function checkBeam(
  beam: SteelMemberElement,
  span: number,
  capacity: number,
  craneSpan: number,
  model: CraneModel,
  craneClass: CraneClass,
  railSize: RailSize,
  girder: GirderType,
): RunwayCheckRow[] {
  const profile = findProfile(beam.profile);
  if (!profile || !(span > 0)) return [];
  const fy = yieldStrength(beam.material);
  const section = sectionProperties(profile);
  const resistance = sectionResistance(profile, fy);
  const wheelBase = model.wheelBase ?? 3000;
  const actions = craneActions(capacity, craneSpan, model);
  const wheel = actions.group1.max / 2;
  // Lateral rail force: envelope of the transverse drive forces HT (group 1) and skewing HS (group 5).
  const lateralWheel =
    Math.max(
      actions.group1.transverseMax,
      actions.group1.transverseMin,
      actions.group5.skewMax,
      actions.group5.skewMin,
    ) / 2;
  const longitudinal = GAMMA_ULS * actions.group1.longitudinal;
  const isI = profile.shape === 'I';
  const row = (
    kind: RunwayCheckRow['kind'],
    check: string,
    value: number,
    limit: number,
    unit: string,
  ): RunwayCheckRow => ({
    elementId: beam.id,
    mark: beam.mark,
    profile: profile.name,
    span: round(span, 0),
    kind,
    check,
    value: round(value),
    limit: round(limit),
    unit,
    utilisation: round(value / limit, 3),
  });

  const rail = RAILS[railSize];
  const distributed = (((profile.massPerMetre + rail.mass) * 9.81) / 1000) * GAMMA_ULS;
  const momentY = GAMMA_ULS * wheelMoment(wheel, wheelBase, span) + (distributed * span ** 2) / 8;
  const shear = GAMMA_ULS * wheelShear(wheel, wheelBase, span) + (distributed * span) / 2;
  const momentZ = GAMMA_ULS * wheelMoment(lateralWheel, wheelBase, span);
  const flangeResistanceZ = isI
    ? (profile.tf * profile.b ** 2 * fy) / 4
    : (section.minorInertia / (profile.b / 2) / 2) * fy;

  // C1 = 1.13 (point loads), 0.85 for the destabilising top-flange load.
  const chi = lateralTorsionalReduction(profile, fy, span, 0.85 * 1.13);

  const characteristic = actions.staticMax / 2;
  const verticalDeflection = wheelDeflection(characteristic, wheelBase, span, section.inertia);
  const lateralDeflection = wheelDeflection(
    lateralWheel,
    wheelBase,
    span,
    section.minorInertia / 2,
  );
  const stressRange =
    wheelMoment(characteristic, wheelBase, span) / (section.inertia / (profile.h / 2));
  const equivalentRange = CLASSES[craneClass] * FATIGUE_PHI * stressRange;

  // EN 1993-6 §5.7.1, rail not rigidly fixed (Tab. 5.1 case b): Irf = Ir,worn + If,eff, separate inertias.
  const effectiveWidth = Math.min(profile.b, rail.foot + rail.height + profile.tf);
  const flangeInertia = (effectiveWidth * profile.tf ** 3) / 12;
  const railFlangeInertia = RAIL_WEAR_INERTIA_FACTOR * rail.inertia + flangeInertia;
  const loadedLength = 3.25 * (railFlangeInertia / profile.tw) ** (1 / 3);
  const localStress = (GAMMA_ULS * wheel) / (loadedLength * profile.tw);
  const localRange = (characteristic * FATIGUE_PHI) / (loadedLength * profile.tw);
  const localLambda = CLASSES[craneClass] * LOCAL_LAMBDA_FACTOR;
  const localCategory = LOCAL_CATEGORIES[girder];

  return [
    row(
      'strength',
      'bending My/Mpl,y + Mz/Mpl,z(top flange)',
      momentY / resistance.moment + momentZ / flangeResistanceZ,
      1,
      '-',
    ),
    row('strength', 'shear V/Vpl', shear, resistance.shear, 'N'),
    row(
      'strength',
      `longitudinal stop force φ5 K/nr (axial N/Npl, HL ${round(actions.group1.longitudinal / 1000, 1)} kN, φ2 ${round(actions.phi2, 3)})`,
      longitudinal,
      resistance.axial,
      'N',
    ),
    row(
      'ltb',
      isI ? 'My/(χLT Mpl,y) + Mz/Mpl,z(top flange)' : 'not susceptible (non-I section)',
      momentY / (chi * resistance.moment) + momentZ / flangeResistanceZ,
      1,
      '-',
    ),
    row(
      'deflection',
      'vertical δz (crane, L/600)',
      verticalDeflection,
      span / DEFLECTION_RATIO,
      'mm',
    ),
    row('deflection', 'lateral δy (L/600)', lateralDeflection, span / DEFLECTION_RATIO, 'mm'),
    row(
      'fatigue',
      `γFf·ΔσE2 (λ=${CLASSES[craneClass]}, ${craneClass}) vs Δσc ${FATIGUE_CATEGORY}/γMf`,
      equivalentRange,
      FATIGUE_CATEGORY / GAMMA_MF,
      'N/mm²',
    ),
    row(
      'local',
      `local web stress σoz (EN 1993-6 §5.7.1) leff ${round(loadedLength, 0)} mm, rail ${railSize}`,
      localStress,
      fy / GAMMA_M0,
      'N/mm²',
    ),
    row(
      'local',
      `local web fatigue (cat ${localCategory}) λ=${round(localLambda, 3)}`,
      localLambda * localRange,
      localCategory / GAMMA_MF,
      'N/mm²',
    ),
  ];
}

/**
 * @command check_crane_runways
 * @pure read-only
 * @affects none; data = { rows: RunwayCheckRow[], csv, maxUtilisation, failures }
 * @failure bad params / unknown level / no crane beams -> no data
 */
export const runwayCheck: CommandDefinition<RunwayCheckParams> = {
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
    'Utilisation > 1 fails. Not covered: torsion, rail-wheel contact, continuity, ' +
    'connections - not a substitute for the engineer of record.',
  paramsSchema: {
    type: 'object',
    properties: {
      craneCapacity: {
        type: 'number',
        description:
          'Crane capacity in tonnes (> 0) applied to every runway beam. Default: read from each ' +
          "runway beam's note (add_crane_runway capacity).",
      },
      wheelBase: {
        type: 'number',
        description:
          'Distance between the two wheels of a rail wheel group, mm (> 0). Default 3000.',
      },
      hoistingClass: {
        type: 'string',
        enum: ['HC1', 'HC2', 'HC3', 'HC4'],
        description:
          'EN 1991-3 hoisting class: φ2 = φ2,min + β2 vh (HC1 1.05 + 0.17 vh, HC2 1.10 + 0.34 vh, HC3 1.15 + 0.51 vh, HC4 1.20 + 0.68 vh). Default HC2.',
      },
      hoistingSpeed: {
        type: 'number',
        description: 'Hoisting speed vh in m/s (>= 0). Default 0.1.',
      },
      craneSpan: {
        type: 'number',
        description:
          'Bridge span between the two runway rails, mm (> 0). Default: x distance to the paired runway beam, else 20000.',
      },
      craneSelfWeight: {
        type: 'number',
        description:
          'Crane self-weight Gc in kN (> 0, bridge + trolley, trolley = 0.2 Gc). Default 0.5 Q + 20 kN.',
      },
      minHookApproach: {
        type: 'number',
        description:
          'Minimum hook approach to the rail in m (>= 0); positions the trolley for the maximum wheel load. Default 1.0.',
      },
      craneClass: {
        type: 'string',
        enum: ['S2', 'S3', 'S4'],
        description:
          'EN 1991-3 / EN 1993-6 fatigue duty class (S2 light, S3 medium, S4 heavy). Default S3.',
      },
      railSize: {
        type: 'string',
        enum: ['A45', 'A55', 'A65', 'A75', 'A100', 'flat50x30'],
        description:
          'Crane rail (DIN 536 Form A, approximate section data, or flat bar 50x30). Its mass joins the runway self-weight and its inertia (75 % of Ir for wear) spreads the wheel load in the local web check. Default A55.',
      },
      girder: {
        type: 'string',
        enum: ['rolled', 'welded-full', 'welded-fillet'],
        description:
          'Runway girder type for local web fatigue (EN 1993-1-9 Tab. 8.10): rolled section = detail category 160; welded-full = welded plate girder with full-penetration web-to-flange welds = 71; welded-fillet = fillet or partial-penetration welds = 36. Default rolled.',
      },
      levelId: { type: 'string', description: 'Level id. Default: the active level.' },
    },
    required: [],
  },
  run: (doc, params): CommandResult => {
    const {
      craneCapacity,
      wheelBase = 3000,
      hoistingClass = 'HC2',
      hoistingSpeed = 0.1,
      craneSpan,
      craneSelfWeight,
      minHookApproach = 1,
      craneClass = 'S3',
      railSize = 'A55',
      girder = 'rolled',
    } = params;
    if (craneCapacity !== undefined && !(isFiniteNumber(craneCapacity) && craneCapacity > 0)) {
      return noChange(doc, 'check_crane_runways failed: craneCapacity must be a number > 0 (t).');
    }
    if (!(isFiniteNumber(wheelBase) && wheelBase > 0)) {
      return noChange(doc, 'check_crane_runways failed: wheelBase must be a number > 0 (mm).');
    }
    if (!(hoistingClass in HOISTING_CLASSES)) {
      return noChange(
        doc,
        "check_crane_runways failed: hoistingClass must be 'HC1', 'HC2', 'HC3' or 'HC4'.",
      );
    }
    if (!(isFiniteNumber(hoistingSpeed) && hoistingSpeed >= 0)) {
      return noChange(
        doc,
        'check_crane_runways failed: hoistingSpeed must be a number >= 0 (m/s).',
      );
    }
    if (!(isFiniteNumber(minHookApproach) && minHookApproach >= 0)) {
      return noChange(
        doc,
        'check_crane_runways failed: minHookApproach must be a number >= 0 (m).',
      );
    }
    for (const [name, value] of [
      ['craneSpan', craneSpan],
      ['craneSelfWeight', craneSelfWeight],
    ] as const) {
      if (value !== undefined && !(isFiniteNumber(value) && value > 0)) {
        return noChange(doc, `check_crane_runways failed: ${name} must be a number > 0.`);
      }
    }
    if (!(craneClass in CLASSES)) {
      return noChange(doc, "check_crane_runways failed: craneClass must be 'S2', 'S3' or 'S4'.");
    }
    if (!(railSize in RAILS)) {
      return noChange(
        doc,
        "check_crane_runways failed: railSize must be 'A45', 'A55', 'A65', 'A75', 'A100' or 'flat50x30'.",
      );
    }
    if (!(girder in LOCAL_CATEGORIES)) {
      return noChange(
        doc,
        "check_crane_runways failed: girder must be 'rolled', 'welded-full' or 'welded-fillet'.",
      );
    }
    const building = getBuilding(doc);
    const levelId = params.levelId ?? building.activeLevelId ?? building.levelOrder[0];
    if (levelId === undefined || !building.levels[levelId]) {
      return noChange(doc, `check_crane_runways failed: no level '${params.levelId ?? ''}'.`);
    }
    const mm = (value: number): number => value / fromMm(doc, 1);
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
      );
      if (beamRows.length === 0) continue;
      beams += 1;
      capacities.add(capacity);
      rows.push(...beamRows);
    }
    if (beams === 0) {
      return noChange(
        doc,
        `check_crane_runways failed: no crane runway beam with a known capacity on level '${levelId}' (add_crane_runway first, or pass craneCapacity).`,
      );
    }
    const failures = rows.filter((row) => row.utilisation > 1);
    const worst = rows.reduce((best, row) => (row.utilisation > best.utilisation ? row : best));
    const csv = toCsv(
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
      rows.map((row) => [
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
        row.utilisation > 1 ? 'FAIL' : 'OK',
      ]),
    );
    return {
      document: doc,
      summary:
        `Checked ${beams} crane runway beam(s), ${rows.length} check(s) (${[...capacities].join('/')} t, class ${craneClass}, wheelBase ${wheelBase} mm): ` +
        `max utilisation ${round(worst.utilisation)} (${worst.mark} ${worst.kind}: ${worst.check}); ` +
        (failures.length === 0
          ? 'all OK (preliminary, simply supported spans).'
          : `${failures.length} failure(s): ${failures
              .slice(0, 8)
              .map((row) => `${row.mark} ${row.kind} ${round(row.utilisation)}`)
              .join(', ')}${failures.length > 8 ? ', …' : ''}.`),
      affected: [],
      data: {
        rows,
        csv,
        maxUtilisation: worst.utilisation,
        failures: [...new Set(failures.map((row) => row.elementId))],
      },
    };
  },
};

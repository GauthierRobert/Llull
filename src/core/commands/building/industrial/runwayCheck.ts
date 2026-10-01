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
import { craneActions, craneCapacityOf } from './frameModel';
import {
  E_STEEL,
  lateralTorsionalReduction,
  sectionResistance,
  yieldStrength,
} from './steelDesign';

export type CraneClass = 'S2' | 'S3' | 'S4';

export type RailSize = 'A45' | 'A55' | 'A65' | 'A75' | 'A100' | 'flat50x30';

/** Approximate crane-rail data (DIN 536 Form A; flat bar 50x30): height mm, head width mm, kg/m, Ir mm⁴. */
export const RAILS: Readonly<
  Record<RailSize, { height: number; head: number; mass: number; inertia: number }>
> = {
  A45: { height: 55, head: 45, mass: 22.1, inertia: 90e4 },
  A55: { height: 65, head: 55, mass: 31.8, inertia: 178e4 },
  A65: { height: 75, head: 65, mass: 43.1, inertia: 319e4 },
  A75: { height: 85, head: 75, mass: 56.2, inertia: 531e4 },
  A100: { height: 95, head: 100, mass: 74.3, inertia: 856e4 },
  flat50x30: { height: 30, head: 50, mass: 11.8, inertia: 11.25e4 },
};

export interface RunwayCheckParams {
  railSize?: RailSize;
  welded?: boolean;
  craneCapacity?: number;
  wheelBase?: number;
  craneClass?: CraneClass;
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
const DYNAMIC_FACTOR = 1.15; // φ2 already inside craneActions
const DEFLECTION_RATIO = 600;
const FATIGUE_PHI = 1.05;
const FATIGUE_CATEGORY = 71; // N/mm²
const GAMMA_MF = 1.15;
const GAMMA_M0 = 1;
const LOCAL_CATEGORY_ROLLED = 160; // EN 1993-1-9 Tab. 8.10 detail 1 (rolled)
const LOCAL_CATEGORY_WELDED = 71;
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
  wheelBase: number,
  craneClass: CraneClass,
  railSize: RailSize,
  welded: boolean,
): RunwayCheckRow[] {
  const profile = findProfile(beam.profile);
  if (!profile || !(span > 0)) return [];
  const fy = yieldStrength(beam.material);
  const section = sectionProperties(profile);
  const resistance = sectionResistance(profile, fy);
  const actions = craneActions(capacity);
  const wheel = actions.max / 2;
  const lateralWheel = actions.lateral / 2;
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

  const characteristic = wheel / DYNAMIC_FACTOR;
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

  // EN 1993-6 §5.7.1, rail not welded (Tab. 5.1 case a): Irf = Ir,worn + If, separate inertias.
  const effectiveWidth = Math.min(profile.b, rail.head + rail.height + profile.tf);
  const flangeInertia = (effectiveWidth * profile.tf ** 3) / 12;
  const railFlangeInertia = RAIL_WEAR_INERTIA_FACTOR * rail.inertia + flangeInertia;
  const loadedLength = 3.25 * (railFlangeInertia / profile.tw) ** (1 / 3);
  const localStress = (GAMMA_ULS * wheel) / (loadedLength * profile.tw);
  const localRange = (characteristic * FATIGUE_PHI) / (loadedLength * profile.tw);
  const localLambda = CLASSES[craneClass] * LOCAL_LAMBDA_FACTOR;
  const localCategory = welded ? LOCAL_CATEGORY_WELDED : LOCAL_CATEGORY_ROLLED;

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
    'rail: wheel load P = max rail reaction / 2 (EN 1991-3 dynamic factors included), lateral ' +
    'surge H per rail split on the wheels, ULS factor 1.35, runway + rail self-weight (railSize). ' +
    'Checks: (1) strength - biaxial My/Mpl,y + Mz/Mpl,z with lateral bending carried by the top ' +
    'flange only (Wpl,z/2), and shear; (2) ltb - χLT from Mcr (C1 = 1.13, Lcr = span, I-sections ' +
    'only, 0.85 Mcr for the top-flange load application); (3) SLS EN 1993-6 §7.3 - vertical and ' +
    'lateral deflection <= L/600 under characteristic wheel loads (P / 1.15, two-wheel exact ' +
    'midspan formula); (4) fatigue EN 1993-1-9 - ΔσE2 = λ φfat Δσ at the bottom flange, λ = 0.315 / ' +
    '0.397 / 0.500 (normal stresses, EN 1991-3 Tab. 2.12) for class S2 / S3 / S4, φfat 1.05, detail category 71, γMf 1.15, γFf 1.0. ' +
    '(5) local - EN 1993-6 §5.7.1: leff = 3.25 (Irf/tw)^(1/3), Irf = 0.75 Ir(rail, wear) + If (rail not ' +
    'welded), beff = head + hr + tf <= b, σoz = 1.35 P / (leff tw) <= fy/γM0; local fatigue with λ x 1.26 ' +
    '(2 cycles per passage), φfat 1.05, category 160 (rolled) or 71 (welded: true) / γMf 1.15. ' +
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
      welded: {
        type: 'boolean',
        description:
          'true if the runway is a welded plate girder: local web fatigue uses detail category 71 instead of 160 (rolled section). Default false.',
      },
      levelId: { type: 'string', description: 'Level id. Default: the active level.' },
    },
    required: [],
  },
  run: (doc, params): CommandResult => {
    const {
      craneCapacity,
      wheelBase = 3000,
      craneClass = 'S3',
      railSize = 'A55',
      welded = false,
    } = params;
    if (craneCapacity !== undefined && !(isFiniteNumber(craneCapacity) && craneCapacity > 0)) {
      return noChange(doc, 'check_crane_runways failed: craneCapacity must be a number > 0 (t).');
    }
    if (!(isFiniteNumber(wheelBase) && wheelBase > 0)) {
      return noChange(doc, 'check_crane_runways failed: wheelBase must be a number > 0 (mm).');
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
    const building = getBuilding(doc);
    const levelId = params.levelId ?? building.activeLevelId ?? building.levelOrder[0];
    if (levelId === undefined || !building.levels[levelId]) {
      return noChange(doc, `check_crane_runways failed: no level '${params.levelId ?? ''}'.`);
    }
    const mm = (value: number): number => value / fromMm(doc, 1);
    const rows: RunwayCheckRow[] = [];
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
      const beamRows = checkBeam(element, span, capacity, wheelBase, craneClass, railSize, welded);
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

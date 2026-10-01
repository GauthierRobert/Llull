/**
 * Secondary steel check of a steel hall: roof purlins and side rails between the portal frames under
 * dead + snow gravity, EN 1991-1-4 wind uplift (roof zones F / G / H-I, wall zones A / B / C / D),
 * bending, shear and deflection. Members are simply supported over one bay (conservative).
 * @layer core/commands/building/industrial
 */

import type { SteelMemberElement } from '../../../model/building';
import type { CadDocument } from '../../../model/types';
import type { CommandDefinition, CommandResult } from '../../types';
import { fromMm, getBuilding, isFiniteNumber, noChange } from '../model';
import { toCsv } from '../quantities';
import { findProfile, sectionProperties, type SteelProfile } from '../steel/profiles';
import { DOWNWIND_ROOF_FACTOR, valleyLines } from './frameModel';
import {
  E_STEEL,
  lateralTorsionalReduction,
  sectionResistance,
  yieldStrength,
} from './steelDesign';

const GAMMA_G = 1.35;
const GAMMA_Q = 1.5;
/** Internal pressure coefficient: +0.2 maximises uplift / suction, -0.3 maximises wall pressure. */
const CPI_SUCTION = 0.2;
const CPI_PRESSURE = 0.3;
/** cpe,10 of the roof zones (duopitch, pitch about 5-15 deg; H and I share the value). */
const CPE_ROOF = { F: -1.7, G: -1.2, 'H/I': -0.6 } as const;
/** cpe,10 of the roof zones for wind along the ridge (θ = 90°, EN 1991-1-4 Tab. 7.4b, pitch 5-15 deg). */
const CPE_ROOF_ALONG = { F: -1.6, G: -1.3, H: -0.7, I: -0.6 } as const;
/** cpe,10 of the monopitch roof zones, pitch 5-15 deg (EN 1991-1-4 Tab. 7.3a): θ = 0° wind on the low eaves. */
const CPE_MONOPITCH_LOW = { F: -1.7, G: -1.2, H: -0.6 } as const;
/** Monopitch, θ = 180° (wind on the high eaves). */
const CPE_MONOPITCH_HIGH = { F: -2.3, G: -1.3, H: -0.8 } as const;
/** Monopitch, θ = 90° (wind along the slope's eaves). */
const CPE_MONOPITCH_ALONG = { F: -1.6, G: -1.8, H: -0.6, I: -0.5 } as const;
/** cpe,10 of the wall zones. */
const CPE_WALL = { A: -1.2, B: -0.8, C: -0.5, D: 0.8 } as const;
const PURLIN_DEFLECTION_RATIO = 200;
const RAIL_DEFLECTION_RATIO = 150;
/** Fallback tributary width when a purlin row has no neighbour, mm. */
const DEFAULT_TRIBUTARY = 1800;
const TOLERANCE = 1;
const GRAVITY = 9.81;

type RoofZone = keyof typeof CPE_ROOF;
type AlongZone = keyof typeof CPE_ROOF_ALONG;
type WallZone = keyof typeof CPE_WALL;

export interface PurlinRow {
  readonly elementId: string;
  readonly mark: string;
  readonly kind: 'purlin' | 'rail';
  /** Governing wind zone: F / G / H/I (roof) or A / B / C / D (wall). */
  readonly zone: string;
  /** Member span between frames, m. */
  readonly span: number;
  /** Governing check with its parameters. */
  readonly check: string;
  /** Design effect in `unit` (kNm, kN or mm). */
  readonly value: number;
  /** Resistance or limit in `unit`. */
  readonly limit: number;
  readonly unit: 'kNm' | 'kN' | 'mm';
  readonly utilisation: number;
  readonly combination: string;
  /** Purlins only: utilisation of the wind-uplift bending check alone (the zone-dependent one). */
  readonly upliftUtilisation?: number;
}

export interface ZoneSummary {
  readonly surface: 'roof' | 'wall';
  readonly zone: string;
  readonly cpe: number;
  readonly members: number;
  readonly maxUtilisation: number;
}

interface CheckPurlinsParams {
  windPressure?: number;
  snowLoad?: number;
  roofDeadLoad?: number;
  levelId?: string;
}

type Point = readonly [number, number, number];

interface Located {
  readonly member: SteelMemberElement;
  readonly profile: SteelProfile;
  readonly start: Point;
  readonly end: Point;
  /** Span, mm. */
  readonly length: number;
  readonly yMin: number;
  readonly yMax: number;
}

interface Verdict {
  readonly check: string;
  readonly value: number;
  readonly limit: number;
  readonly unit: 'kNm' | 'kN' | 'mm';
  readonly utilisation: number;
  readonly combination: string;
}

const round = (value: number, digits = 2): number =>
  Math.round(value * 10 ** digits) / 10 ** digits;

/** EN 1993-1-5 §4.4 plate reduction ρ for slenderness λp with the 0.055 (3 + ψ) term. */
function plateReduction(slenderness: number, psiTerm: number): number {
  return slenderness <= 0.673 ? 1 : Math.min(1, (slenderness - psiTerm) / slenderness ** 2);
}

interface Segment {
  readonly area: number;
  /** Distance of the segment centre above mid-depth, mm. */
  readonly y: number;
  /** Own second moment about its centre, mm⁴ (vertical segments only). */
  readonly inertia: number;
}

function sectionModulus(segments: readonly Segment[], top: number): number {
  const area = segments.reduce((sum, segment) => sum + segment.area, 0);
  const axis = segments.reduce((sum, segment) => sum + segment.area * segment.y, 0) / area;
  const inertia = segments.reduce(
    (sum, segment) => sum + segment.inertia + segment.area * (segment.y - axis) ** 2,
    0,
  );
  return inertia / (top - axis);
}

/**
 * Effective / gross section modulus of a cold-formed C in strong-axis bending (thin-walled model,
 * compression flange on top; symmetric so gravity and uplift share the ratio).
 * Flange: internal element, kσ = 4, bp = b - t (centreline flat width), ρ·bp split at the flange ends, extra 0.9 when λp > 0.673.
 * Web: ψ = -1, kσ = 23.9, compression zone h/2, ρ·hc split 0.4 / 0.6 (EN 1993-1-5 Tab. 4.1).
 * Lips fully effective (no distortional buckling χd); neutral axis shift not iterated.
 * @returns ratio <= 1 and the flange / web reduction factors
 */
export function effectiveModulusRatio(
  profile: SteelProfile,
  fy: number,
): { ratio: number; flangeRho: number; webRho: number } {
  const t = profile.tw;
  const epsilon = Math.sqrt(235 / fy);
  const web = profile.h - t;
  const flange = profile.b - t;
  const lip = Math.max(0, profile.lip - t / 2);
  const flangeSlenderness = flange / t / (28.4 * epsilon * Math.sqrt(4));
  const webSlenderness = web / t / (28.4 * epsilon * Math.sqrt(23.9));
  const flangeRho = plateReduction(flangeSlenderness, 0.22) * (flangeSlenderness > 0.673 ? 0.9 : 1);
  const webRho = plateReduction(webSlenderness, 0.11);
  const half = web / 2;
  const vertical = (length: number, y: number): Segment => ({
    area: t * length,
    y,
    inertia: (t * length ** 3) / 12,
  });
  const horizontal = (length: number, y: number): Segment => ({ area: t * length, y, inertia: 0 });
  const bottom = (): Segment[] => [horizontal(flange, -half), vertical(lip, -half + lip / 2)];
  const gross: Segment[] = [
    ...bottom(),
    horizontal(flange, half),
    vertical(lip, half - lip / 2),
    vertical(web, 0),
  ];
  const effectiveZone = (webRho * web) / 2;
  const upperPart = 0.4 * effectiveZone;
  const lowerPart = 0.6 * effectiveZone;
  const effective: Segment[] = [
    ...bottom(),
    horizontal(flangeRho * flange, half),
    vertical(lip, half - lip / 2),
    vertical(web / 2, -half / 2),
    vertical(upperPart, half - upperPart / 2),
    vertical(lowerPart, lowerPart / 2),
  ];
  const top = half + t / 2;
  return {
    ratio: Math.min(1, sectionModulus(effective, top) / sectionModulus(gross, top)),
    flangeRho,
    webRho,
  };
}

/** Design bending resistance, N·mm: Wpl fy for I, Weff fy for cold-formed C, Wel fy otherwise. */
function bendingResistance(profile: SteelProfile, fy: number): number {
  if (profile.shape === 'I') return sectionResistance(profile, fy).moment;
  const elastic = sectionProperties(profile).elasticModulus * fy;
  return profile.shape === 'C' ? elastic * effectiveModulusRatio(profile, fy).ratio : elastic;
}

/** χLT of the free flange: I sections by EN 1993-1-1 §6.3.2.3, cold-formed C by the simplified §10.1 value. */
function freeFlangeReduction(profile: SteelProfile, fy: number, span: number): number {
  return profile.shape === 'I'
    ? lateralTorsionalReduction(profile, fy, span / 2)
    : span > 6000
      ? 0.6
      : 0.75;
}

/** Governing (highest utilisation) of a list of verdicts. */
function governing(verdicts: readonly Verdict[]): Verdict {
  return verdicts.reduce((best, verdict) =>
    verdict.utilisation > best.utilisation ? verdict : best,
  );
}

/** Simply supported member under uniform line loads (kN/m, perpendicular to the strong axis). */
function beamVerdicts(
  profile: SteelProfile,
  fy: number,
  span: number,
  loads: {
    ultimate: number;
    ultimateLabel: string;
    serviceability: number;
    serviceabilityLabel: string;
    deflectionRatio: number;
    reduction: number;
    bendingLabel: string;
  },
): Verdict[] {
  const metres = span / 1000;
  const moment = (Math.max(0, loads.ultimate) * metres * metres) / 8;
  const shear = (Math.max(0, loads.ultimate) * metres) / 2;
  const momentResistance = (loads.reduction * bendingResistance(profile, fy)) / 1e6;
  const shearResistance = sectionResistance(profile, fy).shear / 1000;
  const inertia = sectionProperties(profile).inertia;
  const deflection =
    (5 * Math.max(0, loads.serviceability) * span ** 4) / (384 * E_STEEL * inertia);
  const limit = span / loads.deflectionRatio;
  return [
    {
      check: `${loads.bendingLabel} (χ ${loads.reduction.toFixed(2)})`,
      value: moment,
      limit: momentResistance,
      unit: 'kNm',
      utilisation: moment / momentResistance,
      combination: loads.ultimateLabel,
    },
    {
      check: 'shear V/Vpl,Rd',
      value: shear,
      limit: shearResistance,
      unit: 'kN',
      utilisation: shear / shearResistance,
      combination: loads.ultimateLabel,
    },
    {
      check: `deflection ≤ span/${loads.deflectionRatio}`,
      value: deflection,
      limit,
      unit: 'mm',
      utilisation: deflection / limit,
      combination: loads.serviceabilityLabel,
    },
  ];
}

/**
 * @command check_purlins
 * @pure read-only
 * @affects none; data = { rows: PurlinRow[], csv, maxUtilisation, failures, zones, ... }
 * @invariant simply supported over one bay; ULS gravity 1.35G + 1.5S; uplift 1.5 W - 1.0 G
 * @failure negative loads / unknown level / no purlins -> no data
 */
export const checkPurlins: CommandDefinition<CheckPurlinsParams> = {
  name: 'check_purlins',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Preliminary check of the roof purlins (role purlin) and side rails (role rail) of the steel hall ' +
    'on a level, e.g. from add_portal_frame_building. Each member is simply supported over its bay ' +
    '(conservative: lapped / continuous purlins are not modelled). Tributary width = half the ' +
    'distance along the slope to each neighbouring purlin (rails: half the vertical distance, ' +
    'ground to eaves at the ends). Roof, per purlin: (1) gravity 1.35 (roofDeadLoad + self-weight) + ' +
    '1.5 snow on plan, components normal to the slope (× cos pitch), bending with the top flange ' +
    'restrained by the sheeting (χLT = 1); (2) wind uplift 1.5 qp (|cpe| + cpi 0.2) - 1.0 dead, with ' +
    'EN 1991-1-4 duopitch roof zones (pitch about 5-15°): e = min(b, 2h) with b the crosswind dimension ' +
    'and h the ridge height; worst of wind across the ridge (θ = 0°: F -1.7 / G -1.2 / H and I -0.6; F/G ' +
    'within e/10 of the eaves, F also within e/4 of a gable) and along the ridge (θ = 90°, Tab. 7.4b: F ' +
    '-1.6 / G -1.3 / H -0.7 / I -0.6; F and G within e/10 of a gable, F within e/4 of the eaves, H up to ' +
    'e/2); multi-span halls (valleys between roofs, EN 1991-1-4 Fig. 7.10 simplified): spans between ' +
    'two valleys are downwind of the windward span for either wind direction and use zone H/I with ' +
    'cpe × 0.6 for θ = 0°; monopitch halls (no ridge) use EN 1991-1-4 Tab. 7.3a instead: θ = 0° (wind on the low ' +
    'eaves) F -1.7 / G -1.2 / H -0.6, θ = 180° (wind on the high eaves) F -2.3 / G -1.3 / H -0.8 with the zones ' +
    'measured from the low / high eaves, θ = 90° F -1.6 / G -1.8 / H -0.6 / I -0.5; the worst zone touching the member applies to its whole length. The ' +
    'bottom flange is in compression: χLT from §6.3.2.3 for I sections with Lcr = span/2, simplified ' +
    'EN 1993-1-3 §10.1 value for cold-formed C sections (0.6 for spans > 6 m, else 0.75), assuming one ' +
    'row of anti-sag bars at mid-span; (3) shear; (4) deflection under characteristic dead + snow ≤ ' +
    'span/200. Rails: horizontal wind on the strong axis, zones A -1.2 (within e/5 of a gable) / B ' +
    '-0.8 (within e) / C -0.5, with cpi +0.2 (inner flange free and in compression: χLT as for purlin uplift), ' +
    'and pressure D +0.8 with cpi -0.3 (restrained, χLT = 1); bending, shear, ' +
    'deflection under characteristic wind ≤ span/150. Cold-formed C sections use an effective section ' +
    'modulus (EN 1993-1-3 §5.5 / 1993-1-5 §4.4, simplified: flange kσ 4 with 0.9 when λp > 0.673, web ψ -1, lips fully effective, no distortional buckling); weak-axis, torsion and cladding self-weight on rails are not ' +
    'checked. Returns one row per member with its governing check; values > 1 fail. Preliminary - ' +
    'not a substitute for the engineer of record.',
  paramsSchema: {
    type: 'object',
    properties: {
      windPressure: {
        type: 'number',
        description:
          'Peak velocity pressure qp, kN/m² (EN 1991-1-4, e.g. 0.6-1.0), >= 0. Default 0.6. 0 = no wind.',
      },
      snowLoad: {
        type: 'number',
        description: 'Roof snow load on plan, kN/m², >= 0. Default 0.8.',
      },
      roofDeadLoad: {
        type: 'number',
        description:
          'Roof build-up dead load carried by the purlins (sheeting, insulation, services) per m² of roof, kN/m², >= 0. Purlin self-weight is added automatically. Default 0.3.',
      },
      levelId: { type: 'string', description: 'Level id. Default: the active level.' },
    },
    required: [],
  },
  run: (doc: CadDocument, params): CommandResult => {
    const { windPressure = 0.6, snowLoad = 0.8, roofDeadLoad = 0.3 } = params;
    const nonNegative = (value: unknown): boolean => isFiniteNumber(value) && value >= 0;
    if (!nonNegative(windPressure) || !nonNegative(snowLoad) || !nonNegative(roofDeadLoad)) {
      return noChange(
        doc,
        'check_purlins failed: windPressure, snowLoad and roofDeadLoad must be >= 0.',
      );
    }
    const building = getBuilding(doc);
    const levelId = params.levelId ?? building.activeLevelId ?? building.levelOrder[0];
    if (levelId === undefined || !building.levels[levelId]) {
      return noChange(doc, `check_purlins failed: no level '${params.levelId ?? ''}'.`);
    }
    const unit = fromMm(doc, 1);
    const toMm = (point: readonly number[]): Point => [
      (point[0] ?? 0) / unit,
      (point[1] ?? 0) / unit,
      (point[2] ?? 0) / unit,
    ];
    const members: Located[] = [];
    const skipped: string[] = [];
    for (const id of building.elementOrder) {
      const element = building.elements[id];
      if (element?.category !== 'member' || element.levelId !== levelId) continue;
      const profile = findProfile(element.profile);
      const [start, end] = [toMm(element.start), toMm(element.end)];
      const length = Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]);
      if (!profile || length < TOLERANCE) {
        if (element.role === 'purlin' || element.role === 'rail') skipped.push(element.mark);
        continue;
      }
      members.push({
        member: element,
        profile,
        start,
        end,
        length,
        yMin: Math.min(start[1], end[1]),
        yMax: Math.max(start[1], end[1]),
      });
    }
    const purlins = members.filter(({ member }) => member.role === 'purlin');
    const rails = members.filter(({ member }) => member.role === 'rail');
    if (purlins.length === 0) {
      return noChange(doc, `check_purlins: no purlins (role purlin) on level '${levelId}'.`);
    }

    // Hall envelope: plan extents of every member, ridge height, eaves level.
    const everyPoint = members.flatMap(({ start, end }) => [start, end]);
    const [x0, x1] = [
      Math.min(...everyPoint.map((point) => point[0])),
      Math.max(...everyPoint.map((point) => point[0])),
    ];
    const [y0, yEnd] = [
      Math.min(...everyPoint.map((point) => point[1])),
      Math.max(...everyPoint.map((point) => point[1])),
    ];
    const height = Math.max(...everyPoint.map((point) => point[2]));
    const rafterZs = members
      .filter(({ member }) => member.role === 'rafter')
      .flatMap(({ start, end }) => [start[2], end[2]]);
    const eaves = rafterZs.length > 0 ? Math.min(...rafterZs) : null;
    const valleys = valleyLines(
      members
        .filter(({ member }) => member.role === 'rafter')
        .map(({ start, end }) => ({ start, end })),
    );
    // Monopitch hall: no two rafters meet at their high ends (no ridge).
    const rafterHighEnds = members
      .filter(({ member }) => member.role === 'rafter')
      .map(({ start, end }) => (start[2] >= end[2] ? start : end));
    const monopitch =
      rafterHighEnds.length > 0 &&
      rafterHighEnds.every(
        (point, index) =>
          !rafterHighEnds.some(
            (other, otherIndex) =>
              otherIndex !== index &&
              Math.hypot(point[0] - other[0], point[1] - other[1], point[2] - other[2]) <= 10,
          ),
      );
    const width = x1 - x0;
    const depth = yEnd - y0;
    const eAcross = Math.min(depth, 2 * height);
    const eAlong = Math.min(width, 2 * height);

    // Purlin rows: one slope of one bay, ordered along x, split where the slope reverses.
    const rows: PurlinRow[] = [];
    const zoneStats = new Map<string, ZoneSummary>();
    const record = (
      surface: 'roof' | 'wall',
      zone: string,
      cpe: number,
      utilisation: number,
    ): void => {
      const key = `${surface}|${zone}|${cpe}`;
      const current = zoneStats.get(key);
      zoneStats.set(key, {
        surface,
        zone,
        cpe,
        members: (current?.members ?? 0) + 1,
        maxUtilisation: Math.max(current?.maxUtilisation ?? 0, utilisation),
      });
    };
    const groups = new Map<string, Located[]>();
    for (const purlin of purlins) {
      const roll = purlin.member.roll;
      const key = `${round(purlin.yMin, 0)}|${round(purlin.yMax, 0)}|${Math.sign(round(roll, 4))}`;
      groups.set(key, [...(groups.get(key) ?? []), purlin]);
    }
    for (const group of groups.values()) {
      const sorted = [...group].sort((a, b) => a.start[0] - b.start[0]);
      const sign = Math.sign(round(sorted[0]?.member.roll ?? 0, 4));
      const slopes: Located[][] = [];
      for (const purlin of sorted) {
        const slope = slopes[slopes.length - 1];
        const previous = slope?.[slope.length - 1];
        const reversed =
          previous !== undefined &&
          ((sign > 0 && purlin.start[2] < previous.start[2] - TOLERANCE) ||
            (sign < 0 && purlin.start[2] > previous.start[2] + TOLERANCE));
        if (!slope || reversed) slopes.push([purlin]);
        else slope.push(purlin);
      }
      for (const slope of slopes) {
        const eavesEnd = slope.reduce((low, purlin) =>
          purlin.start[2] < low.start[2] ? purlin : low,
        );
        const highEnd = slope.reduce((top, purlin) =>
          purlin.start[2] > top.start[2] ? purlin : top,
        );
        const gaps = slope.slice(1).map((purlin, index) => {
          const before = slope[index] as Located;
          return Math.hypot(purlin.start[0] - before.start[0], purlin.start[2] - before.start[2]);
        });
        slope.forEach((purlin, index) => {
          const neighbours = [gaps[index - 1], gaps[index]].filter(
            (gap): gap is number => gap !== undefined && gap > TOLERANCE,
          );
          const tributary =
            neighbours.length === 0
              ? DEFAULT_TRIBUTARY
              : neighbours.reduce((sum, gap) => sum + gap, 0) / 2;
          const pitch = Math.abs(purlin.member.roll);
          const cosine = Math.cos(pitch);
          const fy = yieldStrength(purlin.member.material);
          const trib = tributary / 1000;
          const selfWeight = (purlin.profile.massPerMetre * GRAVITY) / 1000;
          // Vertical dead per metre of purlin, snow on plan (× cos pitch); normal comp. × cos pitch.
          const dead = (roofDeadLoad * trib + selfWeight) * cosine;
          const snow = snowLoad * trib * cosine * cosine;

          // Wind zone: worst of wind across the ridge (θ = 0°) and along it (θ = 90°).
          const horizontalEaves = Math.abs(purlin.start[0] - eavesEnd.start[0]);
          const nearGable = (distance: number): boolean =>
            purlin.yMin - y0 < distance - TOLERANCE || yEnd - purlin.yMax < distance - TOLERANCE;
          // Multi-span (EN 1991-1-4 Fig. 7.10, simplified): a span between two valleys is downwind
          // of the windward span for either wind direction: zone H/I with the 0.6 reduction.
          const spanIndex = valleys.filter((valley) => valley < purlin.start[0]).length;
          const downwindSpan = spanIndex > 0 && spanIndex < valleys.length;
          const acrossZone: RoofZone = downwindSpan
            ? 'H/I'
            : horizontalEaves <= eAcross / 10 + TOLERANCE
              ? nearGable(eAcross / 4)
                ? 'F'
                : 'G'
              : 'H/I';
          const alongZone: AlongZone = nearGable(eAlong / 10)
            ? horizontalEaves <= eAlong / 4 + TOLERANCE
              ? 'F'
              : 'G'
            : nearGable(eAlong / 2)
              ? 'H'
              : 'I';
          const acrossCpe = CPE_ROOF[acrossZone] * (downwindSpan ? DOWNWIND_ROOF_FACTOR : 1);
          let [zone, cpe, direction]: [string, number, string] =
            acrossCpe <= CPE_ROOF_ALONG[alongZone]
              ? [acrossZone, acrossCpe, '']
              : [alongZone, CPE_ROOF_ALONG[alongZone], ''];
          if (monopitch) {
            const monopitchZone = (distance: number): 'F' | 'G' | 'H' =>
              distance <= eAcross / 10 + TOLERANCE ? (nearGable(eAcross / 4) ? 'F' : 'G') : 'H';
            const lowZone = monopitchZone(horizontalEaves);
            const highZone = monopitchZone(Math.abs(purlin.start[0] - highEnd.start[0]));
            const options = [
              {
                zone: lowZone,
                cpe: CPE_MONOPITCH_LOW[lowZone],
                direction: ' (θ = 0°, wind on the low eaves)',
              },
              {
                zone: highZone,
                cpe: CPE_MONOPITCH_HIGH[highZone],
                direction: ' (θ = 180°, wind on the high eaves)',
              },
              {
                zone: alongZone,
                cpe: CPE_MONOPITCH_ALONG[alongZone],
                direction: ' (θ = 90°, wind along the eaves)',
              },
            ];
            const governingOption = options.reduce((worstCase, option) =>
              option.cpe < worstCase.cpe ? option : worstCase,
            );
            [zone, cpe, direction] = [
              governingOption.zone,
              governingOption.cpe,
              governingOption.direction,
            ];
          }

          const wind = windPressure * (Math.abs(cpe) + CPI_SUCTION) * trib;
          const gravityVerdicts = beamVerdicts(purlin.profile, fy, purlin.length, {
            ultimate: GAMMA_G * dead + GAMMA_Q * snow,
            ultimateLabel: '1.35G+1.5S',
            serviceability: dead + snow,
            serviceabilityLabel: 'SLS G+S',
            deflectionRatio: PURLIN_DEFLECTION_RATIO,
            reduction: 1,
            bendingLabel: 'gravity bending (top flange restrained)',
          });
          const uplift = beamVerdicts(purlin.profile, fy, purlin.length, {
            ultimate: GAMMA_Q * wind - dead,
            ultimateLabel: '1.5W-1.0G',
            serviceability: 0,
            serviceabilityLabel: 'SLS',
            deflectionRatio: PURLIN_DEFLECTION_RATIO,
            reduction: freeFlangeReduction(purlin.profile, fy, purlin.length),
            bendingLabel: `uplift bending zone ${zone} cpe ${cpe}${direction} (free flange, Lcr span/2)`,
          });
          const worst = governing([...gravityVerdicts, ...uplift.slice(0, 2)]);
          rows.push({
            elementId: purlin.member.id,
            mark: purlin.member.mark,
            kind: 'purlin',
            zone,
            span: purlin.length / 1000,
            check: `${worst.check} ${purlin.member.profile}, tributary ${tributary.toFixed(0)} mm, pitch ${((pitch * 180) / Math.PI).toFixed(1)}°`,
            value: worst.value,
            limit: worst.limit,
            unit: worst.unit,
            utilisation: worst.utilisation,
            combination: worst.combination,
            upliftUtilisation: (uplift[0] as Verdict).utilisation,
          });
          record('roof', zone, cpe, worst.utilisation);
        });
      }
    }

    // Rails: rows of equal height on each side wall.
    const railGroups = new Map<string, number[]>();
    const sideOf = (rail: Located): string => (rail.start[0] <= (x0 + x1) / 2 ? 'west' : 'east');
    for (const rail of rails) {
      const key = sideOf(rail);
      const levels = railGroups.get(key) ?? [];
      if (!levels.some((z) => Math.abs(z - rail.start[2]) < TOLERANCE)) levels.push(rail.start[2]);
      railGroups.set(
        key,
        levels.sort((a, b) => a - b),
      );
    }
    for (const rail of rails) {
      const levels = railGroups.get(sideOf(rail)) ?? [];
      const index = levels.findIndex((z) => Math.abs(z - rail.start[2]) < TOLERANCE);
      const z = rail.start[2];
      const lower = levels[index - 1] ?? 0;
      const upper = levels[index + 1] ?? Math.max(eaves ?? z + (z - lower), z);
      const trib = (upper - lower) / 2 / 1000;
      const fy = yieldStrength(rail.member.material);
      const gableDistance = Math.max(0, Math.min(rail.yMin - y0, yEnd - rail.yMax));
      const suctionZone: WallZone =
        gableDistance < eAlong / 5 - TOLERANCE
          ? 'A'
          : gableDistance < eAlong - TOLERANCE
            ? 'B'
            : 'C';
      const suction = Math.abs(CPE_WALL[suctionZone]) + CPI_SUCTION;
      const pressure = CPE_WALL.D + CPI_PRESSURE;
      // Suction: inner flange free and in compression (χLT as purlin uplift); pressure: sheeting-restrained.
      const cases = [
        {
          zone: suctionZone,
          net: suction,
          reduction: freeFlangeReduction(rail.profile, fy, rail.length),
        },
        { zone: 'D' as WallZone, net: pressure, reduction: 1 },
      ].map((windCase) => ({
        zone: windCase.zone,
        net: windCase.net,
        verdicts: beamVerdicts(rail.profile, fy, rail.length, {
          ultimate: GAMMA_Q * windPressure * windCase.net * trib,
          ultimateLabel: '1.5W',
          serviceability: windPressure * windCase.net * trib,
          serviceabilityLabel: 'SLS W',
          deflectionRatio: RAIL_DEFLECTION_RATIO,
          reduction: windCase.reduction,
          bendingLabel: `wind bending zone ${windCase.zone} cp,net ${windCase.net.toFixed(1)}${windCase.zone === 'D' ? '' : ' (free flange)'}`,
        }),
      }));
      const governingCase = cases.reduce((best, windCase) =>
        governing(windCase.verdicts).utilisation > governing(best.verdicts).utilisation
          ? windCase
          : best,
      );
      const zone = governingCase.zone;
      const worst = governing(governingCase.verdicts);
      rows.push({
        elementId: rail.member.id,
        mark: rail.member.mark,
        kind: 'rail',
        zone,
        span: rail.length / 1000,
        check: `${worst.check} ${rail.member.profile}, tributary ${(trib * 1000).toFixed(0)} mm`,
        value: worst.value,
        limit: worst.limit,
        unit: worst.unit,
        utilisation: worst.utilisation,
        combination: worst.combination,
      });
      record('wall', zone, CPE_WALL[zone], worst.utilisation);
    }

    const worst = rows.reduce<PurlinRow | null>(
      (best, row) => (best === null || row.utilisation > best.utilisation ? row : best),
      null,
    );
    const failures = rows.filter((row) => row.utilisation > 1);
    const zones = [...zoneStats.values()].sort((a, b) =>
      `${a.surface}${a.zone}` < `${b.surface}${b.zone}` ? -1 : 1,
    );
    const csv = toCsv(
      [
        'Mark',
        'Type',
        'Zone',
        'Span (m)',
        'Check',
        'Value',
        'Limit',
        'Unit',
        'Utilisation',
        'Status',
        'Combination',
      ],
      rows.map((row) => [
        row.mark,
        row.kind,
        row.zone,
        round(row.span),
        row.check,
        round(row.value),
        round(row.limit),
        row.unit,
        round(row.utilisation),
        row.utilisation > 1 ? 'FAIL' : 'OK',
        row.combination,
      ]),
    );
    const purlinRows = rows.filter((row) => row.kind === 'purlin');
    const maxOf = (list: readonly PurlinRow[]): number =>
      round(Math.max(0, ...list.map((row) => row.utilisation)));
    return {
      document: doc,
      summary:
        `Purlin check (qp ${windPressure} kN/m², S ${snowLoad}, roof G ${roofDeadLoad}): ` +
        `${purlinRows.length} purlin(s), ${rows.length - purlinRows.length} rail(s), simply supported per bay; ` +
        `max utilisation purlins ${maxOf(purlinRows)}, rails ${maxOf(rows.filter((row) => row.kind === 'rail'))} ` +
        `(governing ${worst?.mark ?? '—'} ${worst?.kind ?? ''} zone ${worst?.zone ?? '—'}: ${worst?.check ?? '—'}); ` +
        `e = ${round(eAcross / 1000, 1)} m across / ${round(eAlong / 1000, 1)} m along the ridge; ` +
        (failures.length === 0
          ? 'all OK (preliminary).'
          : `${failures.length} failure(s): ${failures
              .slice(0, 8)
              .map((row) => `${row.mark} ${row.kind} ${round(row.utilisation)}`)
              .join(', ')}${failures.length > 8 ? ', …' : ''}.`) +
        (skipped.length > 0 ? ` Not checked: ${skipped.join(', ')}.` : ''),
      affected: [],
      data: {
        rows,
        csv,
        maxUtilisation: worst?.utilisation ?? 0,
        failures: failures.map((row) => row.elementId),
        zones,
        roofType: monopitch ? 'monopitch' : 'duopitch',
        edgeDistanceAcrossRidge: eAcross,
        edgeDistanceAlongRidge: eAlong,
      },
    };
  },
};

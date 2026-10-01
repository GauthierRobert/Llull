/**
 * Wind bracing check of a steel hall: longitudinal wind on the gables → roof X-bracing → wall
 * X-bracing (tension-only diagonals), compression struts and gable wind posts.
 * @layer core/commands/building/industrial
 */

import type { SteelMemberElement } from '../../../model/building';
import type { CadDocument } from '../../../model/types';
import type { CommandDefinition, CommandResult } from '../../types';
import { fromMm, getBuilding, isFiniteNumber, noChange } from '../model';
import { toCsv } from '../quantities';
import { findProfile, sectionProperties, type SteelProfile } from '../steel/profiles';
import { bucklingReduction, E_STEEL, sectionResistance, yieldStrength } from './steelDesign';

/** EN 1990 partial factor for variable (wind) actions. */
const GAMMA_Q = 1.5;
/** EN 1990 6.10 permanent action factor for the equivalent stabilising force. */
const GAMMA_G = 1.35;
/** EN 1991-1-4 whole gable (frame): windward pressure 0.8 + leeward suction 0.5. */
const CP_GABLE = 0.8 + 0.5;
/** Gable post on one wall: net pressure cpe + cpi = 0.8 + 0.2 (EN 1991-1-4). */
const CP_POST = 0.8 + 0.2;
/** EN 1993-1-1 §5.3.3 bracing equivalent force ratio (simplified 1/200). */
const STABILITY_RATIO = 1 / 200;
/** Utilisation reported when a required member is missing (always a failure). */
const NO_MEMBER_UTILISATION = 99;
/** Eaves purlin sits within this of the wall line in x (lift of the purlin off the rafter), mm. */
const EAVES_X_TOLERANCE = 200;
/** Eaves purlin sits within this of the eaves level in z, mm. */
const EAVES_Z_TOLERANCE = 400;
/** Position tolerance, mm. */
const TOLERANCE = 1;

export interface BracingRow {
  readonly group: string;
  readonly elementId: string;
  /** Every element the row covers (both diagonals of an X). */
  readonly elementIds: readonly string[];
  readonly mark: string;
  readonly kind: 'diagonal' | 'strut' | 'gable-post';
  /** kN: diagonal tension, strut compression, post end reaction. */
  readonly force: number;
  /** kN: Npl,Rd, χ·Npl,Rd or Vpl,Rd. */
  readonly resistance: number;
  /** kNm: gable posts only (else 0). */
  readonly moment: number;
  /** kNm: gable posts only (else 0). */
  readonly momentResistance: number;
  readonly utilisation: number;
  readonly check: string;
}

interface CheckBracingParams {
  windPressure?: number;
  deadLoad?: number;
  snowLoad?: number;
  levelId?: string;
}

type Point = readonly [number, number, number];

interface Located {
  readonly member: SteelMemberElement;
  readonly profile: SteelProfile;
  readonly start: Point;
  readonly end: Point;
}

const round = (value: number, digits = 2): number =>
  Math.round(value * 10 ** digits) / 10 ** digits;
const near = (a: number, b: number): boolean => Math.abs(a - b) <= TOLERANCE;

/** Flexural buckling imperfection factor about the minor axis (EN 1993-1-1 Tab. 6.1/6.2). */
function minorImperfection(profile: SteelProfile): number {
  if (profile.shape === 'I') return profile.h / profile.b > 1.2 ? 0.34 : 0.49;
  if (profile.shape === 'C') return 0.34;
  return profile.shape === 'SHS' || profile.shape === 'RHS' || profile.shape === 'CHS'
    ? 0.21
    : 0.49;
}

/** Design buckling resistance χ·A·fy (N) about the minor axis for a buckling length (mm). */
function bucklingResistance(profile: SteelProfile, fy: number, length: number): number {
  const section = sectionProperties(profile);
  const npl = section.area * fy;
  const critical = (Math.PI ** 2 * E_STEEL * section.minorInertia) / length ** 2;
  return bucklingReduction(Math.sqrt(npl / critical), minorImperfection(profile)) * npl;
}

interface Panel {
  readonly group: string;
  readonly roof: boolean;
  readonly bay: string;
  readonly braces: Located[];
}

/**
 * @command check_bracing
 * @pure read-only
 * @affects none; data = { rows: BracingRow[], csv, maxUtilisation, failures, windForce, ... }
 * @invariant ULS wind = 1.5 · qp · 1.3 · gable area; tension-only diagonals; Npl,Rd = A·fy
 * @failure negative loads / unknown level / no bracing / no rafters -> no data
 */
export const checkBracing: CommandDefinition<CheckBracingParams> = {
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
    'the truss reaction (bay force / 2) with Lcr = bay length (row flagged utilisation 99 if absent).' +
    ' Rows are grouped (roof bracing, wall bracing per side, gable posts); utilisation > 1 ' +
    'fails. Not covered: frame action, uplift, self-weight, connections - a preliminary check.',
  paramsSchema: {
    type: 'object',
    properties: {
      windPressure: {
        type: 'number',
        description:
          'Peak velocity pressure qp, kN/m² (EN 1991-1-4). Default 0.6. Frame gable coefficient 0.8 + 0.5; gable posts use net cpe + cpi = 0.8 + 0.2.',
      },
      deadLoad: {
        type: 'number',
        description: 'Roof dead load, kN/m², for the stabilising force only. Default 0.5.',
      },
      snowLoad: {
        type: 'number',
        description: 'Roof snow load, kN/m², for the stabilising force only. Default 0.8.',
      },
      levelId: { type: 'string', description: 'Level id. Default: the active level.' },
    },
    required: [],
  },
  run: (doc: CadDocument, params): CommandResult => {
    const { windPressure = 0.6, deadLoad = 0.5, snowLoad = 0.8 } = params;
    const nonNegative = (value: unknown): boolean => isFiniteNumber(value) && value >= 0;
    if (!nonNegative(windPressure) || !nonNegative(deadLoad) || !nonNegative(snowLoad)) {
      return noChange(doc, 'check_bracing failed: windPressure, deadLoad, snowLoad must be >= 0.');
    }
    const building = getBuilding(doc);
    const levelId = params.levelId ?? building.activeLevelId ?? building.levelOrder[0];
    if (levelId === undefined || !building.levels[levelId]) {
      return noChange(doc, `check_bracing failed: no level '${params.levelId ?? ''}'.`);
    }
    const unit = fromMm(doc, 1);
    const members: Located[] = [];
    for (const id of building.elementOrder) {
      const element = building.elements[id];
      if (element?.category !== 'member' || element.levelId !== levelId) continue;
      const profile = findProfile(element.profile);
      if (!profile) continue;
      const toMm = (point: readonly number[]): Point => [
        (point[0] ?? 0) / unit,
        (point[1] ?? 0) / unit,
        (point[2] ?? 0) / unit,
      ];
      members.push({
        member: element,
        profile,
        start: toMm(element.start),
        end: toMm(element.end),
      });
    }
    const braces = members.filter(({ member }) => member.role === 'brace');
    const rafters = members.filter(({ member }) => member.role === 'rafter');
    if (braces.length === 0) {
      return noChange(doc, `check_bracing: no bracing (role brace) on level '${levelId}'.`);
    }
    if (rafters.length === 0) {
      return noChange(doc, `check_bracing failed: no rafters on level '${levelId}' (no gable).`);
    }

    // Hall envelope from the end frame (rafter plane y0) and the frame columns.
    const rafterEnds = rafters.flatMap(({ start, end }) => [start, end]);
    const ys = rafterEnds.map((point) => point[1]);
    const y0 = Math.min(...ys);
    const yEnd = Math.max(...ys);
    const xs = rafterEnds.map((point) => point[0]);
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    const centre = (x0 + x1) / 2;
    const gableAreaMm2 = rafters
      .filter(({ start, end }) => near(start[1], y0) && near(end[1], y0))
      .reduce(
        (sum, { start, end }) => sum + Math.abs(end[0] - start[0]) * ((start[2] + end[2]) / 2),
        0,
      );
    const gableArea = gableAreaMm2 / 1e6;
    const planArea = ((x1 - x0) * (yEnd - y0)) / 1e6;
    const windUltimate = GAMMA_Q * windPressure * CP_GABLE * gableArea;
    const roofWind = windUltimate / 2;
    const stability = (GAMMA_G * deadLoad + GAMMA_Q * snowLoad) * planArea * STABILITY_RATIO;
    const roofForce = roofWind + stability;

    // Braced panels: roof (diagonal plan x-extent > 0) and walls (vertical plane), per bay.
    const panels = new Map<string, Panel>();
    for (const located of braces) {
      const { start, end } = located;
      const roof = !near(start[0], end[0]);
      const bay = `${round(Math.min(start[1], end[1]), 0)}-${round(Math.max(start[1], end[1]), 0)}`;
      const xLow = round(Math.min(start[0], end[0]), 0);
      const xHigh = round(Math.max(start[0], end[0]), 0);
      const side = start[0] <= centre ? 'west' : 'east';
      const key = roof ? `roof|${bay}|${xLow}|${xHigh}` : `wall|${bay}|${xLow}`;
      const panel = panels.get(key) ?? {
        group: roof ? 'roof bracing' : `wall bracing ${side}`,
        roof,
        bay,
        braces: [],
      };
      panel.braces.push(located);
      panels.set(key, panel);
    }
    const bays = new Set([...panels.values()].map((panel) => panel.bay));
    const bayWallPanels = (bay: string): number =>
      [...panels.values()].filter((panel) => panel.bay === bay && !panel.roof).length;
    const bayForce = roofForce / bays.size;

    // Roof strut = rafter braced laterally by purlins: largest purlin gap along the slope.
    const purlins = members.filter(({ member }) => member.role === 'purlin');
    const purlinGapAlong = (rafter: Located, bayStart: number, bayEnd: number): number => {
      const [from, to] = [
        Math.min(rafter.start[0], rafter.end[0]),
        Math.max(rafter.start[0], rafter.end[0]),
      ];
      const slope = Math.hypot(rafter.end[0] - rafter.start[0], rafter.end[2] - rafter.start[2]);
      const cosine = Math.abs(rafter.end[0] - rafter.start[0]) / slope;
      const positions = purlins
        .filter(
          ({ start: s, end: e }) =>
            near(Math.min(s[1], e[1]), bayStart) &&
            near(Math.max(s[1], e[1]), bayEnd) &&
            s[0] >= from - EAVES_X_TOLERANCE &&
            s[0] <= to + EAVES_X_TOLERANCE,
        )
        .map(({ start: s }) => s[0])
        .sort((a, b) => a - b);
      const gaps = positions.slice(1).map((position, index) => position - (positions[index] ?? 0));
      return gaps.length === 0 ? slope : Math.max(...gaps) / cosine;
    };

    const rows: BracingRow[] = [];
    const sorted = [...panels.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [, panel] of sorted) {
      const diagonal = panel.braces.reduce((best, candidate) =>
        Math.hypot(...candidate.start.map((v, i) => v - (candidate.end[i] ?? 0))) >
        Math.hypot(...best.start.map((v, i) => v - (best.end[i] ?? 0)))
          ? candidate
          : best,
      );
      const { start, end, profile, member } = diagonal;
      const [dx, dy, dz] = [
        Math.abs(end[0] - start[0]),
        Math.abs(end[1] - start[1]),
        Math.abs(end[2] - start[2]),
      ];
      if (dy < TOLERANCE) continue;
      const length = Math.hypot(dx, dy, dz);
      const xLow = Math.min(start[0], end[0]);
      const xHigh = Math.max(start[0], end[0]);
      const hallWidth = x1 - x0;
      const shear = panel.roof
        ? (bayForce * (hallWidth / 2 - Math.max(0, Math.min(xLow - x0, x1 - xHigh)))) / hallWidth
        : bayForce / bayWallPanels(panel.bay);
      const tension = (shear * length) / dy;
      const fy = yieldStrength(member.material);
      const npl = sectionResistance(profile, fy).axial / 1000;
      const ids = panel.braces.map(({ member: brace }) => brace.id);
      rows.push({
        group: panel.group,
        elementId: member.id,
        elementIds: ids,
        mark: member.mark,
        kind: 'diagonal',
        force: tension,
        resistance: npl,
        moment: 0,
        momentResistance: 0,
        utilisation: tension / npl,
        check: `tension-only ${member.profile}: V ${shear.toFixed(1)} kN / cos θ ${(dy / length).toFixed(2)} = ${tension.toFixed(1)} kN ≤ Npl,Rd ${npl.toFixed(1)} kN (bay ${panel.bay} mm)`,
      });
      // Compression strut: rafter (roof) / column (wall) at either end of the bay.
      const [bayStart, bayEnd] = [Math.min(start[1], end[1]), Math.max(start[1], end[1])];
      const strut = panel.roof
        ? rafters.find(
            ({ start: s, end: e }) =>
              (near(s[1], bayStart) || near(s[1], bayEnd)) &&
              near(s[1], e[1]) &&
              near(Math.min(s[0], e[0]), xLow) &&
              near(Math.max(s[0], e[0]), xHigh),
          )
        : members.find(
            ({ member: candidate, start: s }) =>
              candidate.role === 'column' &&
              near(s[0], start[0]) &&
              (near(s[1], bayStart) || near(s[1], bayEnd)),
          );
      if (strut) {
        const compression = panel.roof ? (shear * dx) / dy : (shear * dz) / dy;
        const strutFy = yieldStrength(strut.member.material);
        const purlinGap = purlinGapAlong(strut, bayStart, bayEnd);
        const strutLength = panel.roof ? purlinGap : dz;
        const strutResistance = bucklingResistance(strut.profile, strutFy, strutLength) / 1000;
        rows.push({
          group: panel.group,
          elementId: strut.member.id,
          elementIds: [strut.member.id],
          mark: strut.member.mark,
          kind: 'strut',
          force: compression,
          resistance: strutResistance,
          moment: 0,
          momentResistance: 0,
          utilisation: compression / strutResistance,
          check: `${panel.roof ? 'rafter' : 'column'} ${strut.member.profile} compression ${compression.toFixed(1)} kN ≤ χ·Npl,Rd ${strutResistance.toFixed(1)} kN (minor axis, Lcr ${strutLength.toFixed(0)} mm${panel.roof ? ', purlin gap' : ', column height'})`,
        });
      }

      // Eaves purlin at the wall end of the roof truss: carries the truss reaction in compression.
      const atWall = panel.roof && (near(xLow, x0) || near(xHigh, x1));
      if (atWall) {
        const wallX = near(xLow, x0) ? x0 : x1;
        const eavesStrut = members.find(
          ({ member: candidate, start: s, end: e }) =>
            candidate.role === 'purlin' &&
            Math.abs(s[0] - wallX) < EAVES_X_TOLERANCE &&
            near(Math.min(s[1], e[1]), bayStart) &&
            near(Math.max(s[1], e[1]), bayEnd) &&
            Math.abs(s[2] - Math.min(...rafterEnds.map((point) => point[2]))) < EAVES_Z_TOLERANCE,
        );
        const reaction = bayForce / 2;
        const fyEaves = eavesStrut ? yieldStrength(eavesStrut.member.material) : 0;
        const eavesResistance = eavesStrut
          ? bucklingResistance(eavesStrut.profile, fyEaves, dy) / 1000
          : 0;
        rows.push({
          group: panel.group,
          elementId: eavesStrut?.member.id ?? member.id,
          elementIds: [eavesStrut?.member.id ?? member.id],
          mark: eavesStrut?.member.mark ?? member.mark,
          kind: 'strut',
          force: reaction,
          resistance: eavesResistance,
          moment: 0,
          momentResistance: 0,
          utilisation: eavesStrut ? reaction / eavesResistance : NO_MEMBER_UTILISATION,
          check: eavesStrut
            ? `eaves strut ${eavesStrut.member.profile} compression ${reaction.toFixed(1)} kN (truss reaction) ≤ χ·Npl,Rd ${eavesResistance.toFixed(1)} kN (minor axis, Lcr ${dy.toFixed(0)} mm bay)`
            : `no eaves strut found at x ${round(wallX, 0)} mm in bay ${panel.bay} mm: truss reaction ${reaction.toFixed(1)} kN has no compression member`,
        });
      }
    }

    // Gable wind posts: columns in a gable plane that do not meet a rafter end (frame columns do).
    const meetsRafter = ({ start, end }: Located): boolean =>
      rafterEnds.some(
        (point) => near(point[0], end[0]) && near(point[1], end[1]) && near(point[2], end[2]),
      ) ||
      rafterEnds.some(
        (point) => near(point[0], start[0]) && near(point[1], start[1]) && near(point[2], start[2]),
      );
    const columns = members.filter(({ member }) => member.role === 'column');
    for (const planeY of [y0, yEnd]) {
      const inPlane = columns
        .filter(({ start }) => near(start[1], planeY))
        .sort((a, b) => a.start[0] - b.start[0]);
      inPlane.forEach((post, index) => {
        if (meetsRafter(post)) return;
        const left = inPlane[index - 1]?.start[0] ?? post.start[0];
        const right = inPlane[index + 1]?.start[0] ?? post.start[0];
        const tributary = (right - left) / 2 / 1000;
        const height = Math.abs(post.end[2] - post.start[2]) / 1000;
        const load = GAMMA_Q * windPressure * CP_POST * tributary;
        const fy = yieldStrength(post.member.material);
        const resistance = sectionResistance(post.profile, fy);
        const moment = (load * height * height) / 8;
        const reaction = (load * height) / 2;
        const momentResistance = resistance.moment / 1e6;
        const shearResistance = resistance.shear / 1000;
        rows.push({
          group: 'gable posts',
          elementId: post.member.id,
          elementIds: [post.member.id],
          mark: post.member.mark,
          kind: 'gable-post',
          force: reaction,
          resistance: shearResistance,
          moment,
          momentResistance,
          utilisation: Math.max(moment / momentResistance, reaction / shearResistance),
          check: `${post.member.profile} (y ${round(planeY, 0)} mm): q ${load.toFixed(2)} kN/m, h ${height.toFixed(2)} m, M ${moment.toFixed(1)} ≤ Mpl,Rd ${momentResistance.toFixed(1)} kNm, V ${reaction.toFixed(1)} ≤ Vpl,Rd ${shearResistance.toFixed(1)} kN`,
        });
      });
    }

    const worst = rows.reduce<BracingRow | null>(
      (best, row) => (best === null || row.utilisation > best.utilisation ? row : best),
      null,
    );
    const failures = rows.filter((row) => row.utilisation > 1);
    const csv = toCsv(
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
      rows.map((row) => [
        row.group,
        row.mark,
        row.kind,
        round(row.force, 1),
        round(row.resistance, 1),
        round(row.moment, 1),
        round(row.utilisation),
        row.utilisation > 1 ? 'FAIL' : 'OK',
        row.check,
      ]),
    );
    return {
      document: doc,
      summary:
        `Bracing check (qp ${windPressure} kN/m², G ${deadLoad}, S ${snowLoad}): gable ${round(gableArea, 1)} m², ` +
        `ULS wind ${round(windUltimate, 1)} kN, roof level ${round(roofWind, 1)} kN + stability ${round(stability, 1)} kN ` +
        `over ${bays.size} braced bay(s) = ${round(bayForce, 1)} kN each; ${rows.length} check(s), ` +
        `max utilisation ${round(worst?.utilisation ?? 0)} (${worst?.mark ?? '—'} ${worst?.kind ?? ''}, ${worst?.group ?? '—'}); ` +
        (failures.length === 0
          ? 'all OK (preliminary, tension-only diagonals).'
          : `${failures.length} failure(s): ${failures
              .slice(0, 8)
              .map((row) => `${row.mark} ${row.kind} ${round(row.utilisation)}`)
              .join(', ')}${failures.length > 8 ? ', …' : ''}.`),
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
        bracedBays: bays.size,
      },
    };
  },
};

/**
 * Wind-bracing load path and member checks for a steel hall level (EN 1991-1-4, EN 1993-1-1).
 * @layer domain-aec
 * @pure
 */

import type { CadDocument } from '@core/model/types';
import { fromMm, getBuilding } from '../model';
import { findProfile } from '../steel/profiles';
import { round } from '../numeric';
import { sectionResistance, yieldStrength } from './steelDesign';
import { craneCapacityOf } from './frameModelTypes';
import {
  type BracingRow,
  CP_GABLE,
  CP_POST,
  DEFAULT_CRANE_SPAN,
  EAVES_X_TOLERANCE,
  EAVES_Z_TOLERANCE,
  GAMMA_G,
  GAMMA_Q,
  type Located,
  NO_MEMBER_UTILISATION,
  type Panel,
  type Point,
  STABILITY_RATIO,
  TOLERANCE,
  bucklingResistance,
  craneWallForce,
  near,
} from './bracingModel';

export interface BracingInputs {
  readonly windPressure: number;
  readonly deadLoad: number;
  readonly snowLoad: number;
  readonly craneCapacity: number | undefined;
  readonly craneSelfWeight: number | undefined;
  readonly travelSpeed: number;
  readonly bufferStiffness: number;
}

/** Steel members of `levelId` with endpoints in mm. */
export function locateMembers(doc: CadDocument, levelId: string): Located[] {
  const building = getBuilding(doc);
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
  return members;
}

/** Gable wind posts: columns in a gable plane that do not meet a rafter end (frame columns do). */
function gablePostRows(
  members: ReadonlyArray<Located>,
  rafterEnds: ReadonlyArray<Point>,
  y0: number,
  yEnd: number,
  windPressure: number,
): BracingRow[] {
  const rows: BracingRow[] = [];
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
  return rows;
}

export interface BracingAnalysis {
  readonly rows: BracingRow[];
  readonly gableArea: number;
  readonly windUltimate: number;
  readonly roofWind: number;
  readonly roofForce: number;
  readonly stability: number;
  readonly bayForce: number;
  readonly bayCount: number;
  readonly craneForce: ReturnType<typeof craneWallForce> | null;
  readonly craneCapacity: number | null;
  readonly craneSpan: number;
  readonly craneSides: string[];
  readonly craneFoundation: { side: string; braced: number; total: number; perColumn: number }[];
}

/** @failure no brace / no rafter on the level -> `{ reason }` */
export function analyseBracing(
  members: ReadonlyArray<Located>,
  levelId: string,
  inputs: BracingInputs,
): BracingAnalysis | { reason: string } {
  const { windPressure, deadLoad, snowLoad, travelSpeed, bufferStiffness } = inputs;
  const braces = members.filter(({ member }) => member.role === 'brace');
  const rafters = members.filter(({ member }) => member.role === 'rafter');
  if (braces.length === 0)
    return { reason: `check_bracing: no bracing (role brace) on level '${levelId}'.` };
  if (rafters.length === 0) {
    return { reason: `check_bracing failed: no rafters on level '${levelId}' (no gable).` };
  }
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

  // Crane longitudinal path: one runway line per carrying wall, force at rail level.
  const runways = members.filter(({ member }) => member.role === 'crane');
  const craneCapacity =
    inputs.craneCapacity ??
    runways.map(({ member }) => craneCapacityOf(member)).find((value) => value !== null) ??
    null;
  const runwayXs = runways.map(({ start }) => start[0]);
  const craneSpan =
    runwayXs.length > 0 && Math.max(...runwayXs) - Math.min(...runwayXs) > 1000
      ? Math.max(...runwayXs) - Math.min(...runwayXs)
      : DEFAULT_CRANE_SPAN;
  const craneForce =
    craneCapacity !== null && runways.length > 0
      ? craneWallForce(
          craneCapacity,
          craneSpan,
          inputs.craneSelfWeight,
          travelSpeed,
          bufferStiffness,
        )
      : null;
  const craneSides = new Set(runways.map(({ start }) => (start[0] <= centre ? 'west' : 'east')));
  const wallPanelsOnSide = (side: string): number =>
    [...panels.values()].filter((panel) => panel.group === `wall bracing ${side}`).length;
  const craneShareOf = (panel: Panel): number => {
    const side = panel.group.endsWith('west') ? 'west' : 'east';
    return craneForce !== null && !panel.roof && craneSides.has(side)
      ? craneForce.design / wallPanelsOnSide(side)
      : 0;
  };
  const craneFoundation: { side: string; braced: number; total: number; perColumn: number }[] = [];

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
    const craneShare = craneShareOf(panel);
    const shear = panel.roof
      ? (bayForce * (hallWidth / 2 - Math.max(0, Math.min(xLow - x0, x1 - xHigh)))) / hallWidth
      : bayForce / bayWallPanels(panel.bay) + craneShare;
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
    if (craneForce !== null && craneShare > 0) {
      const craneTension = (craneShare * length) / dy;
      const side = panel.group.endsWith('west') ? 'west' : 'east';
      rows.push({
        group: panel.group,
        elementId: member.id,
        elementIds: ids,
        mark: member.mark,
        kind: 'diagonal',
        force: craneTension,
        resistance: npl,
        moment: 0,
        momentResistance: 0,
        utilisation: craneTension / npl,
        check: `crane longitudinal (group 1 / group 7): ${craneForce.governing} governs, 1.35 HL ${craneForce.driveGroup1.toFixed(1)} kN vs HB (γ 1.0) ${craneForce.bufferGroup7.toFixed(1)} kN per runway, share ${craneShare.toFixed(1)} kN on bay ${panel.bay} mm, tension ${craneTension.toFixed(1)} kN ≤ Npl,Rd ${npl.toFixed(1)} kN (included in the wall bracing row above)`,
      });
      craneFoundation.push({
        side,
        braced: wallPanelsOnSide(side),
        total: craneShare,
        perColumn: craneShare / 2,
      });
    }
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
      // Eaves level of this wall (monopitch: the low and the high eaves differ).
      const eavesZ = Math.min(
        ...rafterEnds.filter((point) => near(point[0], wallX)).map((point) => point[2]),
      );
      const eavesStrut = members.find(
        ({ member: candidate, start: s, end: e }) =>
          candidate.role === 'purlin' &&
          Math.abs(s[0] - wallX) < EAVES_X_TOLERANCE &&
          near(Math.min(s[1], e[1]), bayStart) &&
          near(Math.max(s[1], e[1]), bayEnd) &&
          Math.abs(s[2] - eavesZ) < EAVES_Z_TOLERANCE,
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
          ? `eaves strut ${eavesStrut.member.profile} compression ${reaction.toFixed(1)} kN (truss reaction at the outer wall line, independent of the number of spans) ≤ χ·Npl,Rd ${eavesResistance.toFixed(1)} kN (minor axis, Lcr ${dy.toFixed(0)} mm bay)`
          : `no eaves strut found at x ${round(wallX, 0)} mm in bay ${panel.bay} mm: truss reaction ${reaction.toFixed(1)} kN has no compression member`,
      });
    }
  }

  rows.push(...gablePostRows(members, rafterEnds, y0, yEnd, windPressure));
  return {
    rows,
    gableArea,
    windUltimate,
    roofWind,
    roofForce,
    stability,
    bayForce,
    bayCount: bays.size,
    craneForce,
    craneCapacity,
    craneSpan,
    craneSides: [...craneSides],
    craneFoundation,
  };
}

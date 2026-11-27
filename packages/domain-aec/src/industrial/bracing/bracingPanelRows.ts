/** Braced panels of a steel hall level: grouping per bay, crane longitudinal path and the check rows of each panel. */

import { distance3 } from '@lib/vec3';
import { round } from '../../shared/numeric';
import { sectionResistance } from '../steelDesign/steelDesign';
import { isSteelRefusal, memberStrength } from '../steelDesign/steelGrades';
import { craneCapacityOf } from '../frames/frameModelTypes';
import { DEFAULT_CRANE_SPAN } from '../runway/runwayCheckModel';
import { refusedFields } from '../common/utilisation';
import {
  type BracingRow,
  EAVES_X_TOLERANCE,
  EAVES_Z_TOLERANCE,
  type Located,
  NO_MEMBER_UTILISATION,
  type Panel,
  type Point,
  TOLERANCE,
  bucklingResistance,
  craneWallForce,
  near,
  refusedRow,
} from './bracingModel';
import { maxOf, minOf } from '@lib/arrayExtrema';
import { verdictSign } from '../steelDesign/verdictSign';

export interface BracingInputs {
  readonly windPressure: number;
  readonly deadLoad: number;
  readonly snowLoad: number;
  readonly craneCapacity: number | undefined;
  readonly craneSelfWeight: number | undefined;
  readonly travelSpeed: number;
  readonly bufferStiffness: number;
}

export interface CraneFoundationRow {
  side: string;
  braced: number;
  total: number;
  perColumn: number;
}

export interface CranePath {
  readonly craneCapacity: number | null;
  readonly craneSpan: number;
  readonly craneForce: ReturnType<typeof craneWallForce> | null;
  readonly craneSides: Set<string>;
}

export interface PanelContext extends CranePath {
  readonly members: ReadonlyArray<Located>;
  readonly rafters: ReadonlyArray<Located>;
  readonly rafterEnds: ReadonlyArray<Point>;
  readonly panels: Map<string, Panel>;
  readonly purlins: ReadonlyArray<Located>;
  readonly x0: number;
  readonly x1: number;
  readonly bayForce: number;
}

const axisLength = ({ start, end }: Located): number => distance3(end, start);

/** Braced panels: roof (diagonal plan x-extent > 0) and walls (vertical plane), per bay. */
export function groupPanels(braces: ReadonlyArray<Located>, centre: number): Map<string, Panel> {
  const panels = new Map<string, Panel>();
  for (const located of braces) {
    const { start, end } = located;
    const roof = !near(start[0], end[0]);
    const bay = `${round(Math.min(start[1], end[1]), 0)}-${round(Math.max(start[1], end[1]), 0)}`;
    const xLow = round(Math.min(start[0], end[0]), 0);
    const xHigh = round(Math.max(start[0], end[0]), 0);
    const side = start[0] <= centre ? 'west' : 'east';
    const key = roof ? `roof|${bay}|${xLow}|${xHigh}` : `wall|${bay}|${xLow}`;
    const panel = panels.get(key) ?? { group: roof ? 'roof bracing' : `wall bracing ${side}`, roof, bay, braces: [] };
    panel.braces.push(located);
    panels.set(key, panel);
  }
  return panels;
}

/** Crane longitudinal path: one runway line per carrying wall, force at rail level. */
export function craneLongitudinalPath(members: ReadonlyArray<Located>, centre: number, inputs: BracingInputs): CranePath {
  const { travelSpeed, bufferStiffness } = inputs;
  const runways = members.filter(({ member }) => member.role === 'crane');
  const craneCapacity =
    inputs.craneCapacity ?? runways.map(({ member }) => craneCapacityOf(member)).find((value) => value !== null) ?? null;
  const runwayXs = runways.map(({ start }) => start[0]);
  const craneSpan =
    runwayXs.length > 0 && maxOf(runwayXs) - minOf(runwayXs) > 1000 ? maxOf(runwayXs) - minOf(runwayXs) : DEFAULT_CRANE_SPAN;
  const craneForce =
    craneCapacity !== null && runways.length > 0
      ? craneWallForce(craneCapacity, craneSpan, inputs.craneSelfWeight, travelSpeed, bufferStiffness)
      : null;
  const craneSides = new Set(runways.map(({ start }) => (start[0] <= centre ? 'west' : 'east')));
  return { craneCapacity, craneSpan, craneForce, craneSides };
}

const bayWallPanels = (context: PanelContext, bay: string): number =>
  [...context.panels.values()].filter((panel) => panel.bay === bay && !panel.roof).length;

const wallPanelsOnSide = (context: PanelContext, side: string): number =>
  [...context.panels.values()].filter((panel) => panel.group === `wall bracing ${side}`).length;

const craneShareOf = (context: PanelContext, panel: Panel): number => {
  const side = panel.group.endsWith('west') ? 'west' : 'east';
  return context.craneForce !== null && !panel.roof && context.craneSides.has(side)
    ? context.craneForce.design / wallPanelsOnSide(context, side)
    : 0;
};

/** Roof strut = rafter braced laterally by purlins: largest purlin gap along the slope. */
function purlinGapAlong(context: PanelContext, rafter: Located, bayStart: number, bayEnd: number): number {
  const [from, to] = [Math.min(rafter.start[0], rafter.end[0]), Math.max(rafter.start[0], rafter.end[0])];
  const slope = Math.hypot(rafter.end[0] - rafter.start[0], rafter.end[2] - rafter.start[2]);
  const cosine = Math.abs(rafter.end[0] - rafter.start[0]) / slope;
  const positions = context.purlins
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
  return gaps.length === 0 ? slope : maxOf(gaps) / cosine;
}

interface DiagonalGeometry {
  readonly panel: Panel;
  readonly diagonal: Located;
  readonly dx: number;
  readonly dy: number;
  readonly dz: number;
  readonly xLow: number;
  readonly xHigh: number;
  readonly shear: number;
}

/** Compression strut: rafter (roof) / column (wall) at either end of the bay. */
function strutRow(context: PanelContext, geometry: DiagonalGeometry): BracingRow | undefined {
  const { panel, diagonal, dx, dy, dz, xLow, xHigh, shear } = geometry;
  const { start, end } = diagonal;
  const [bayStart, bayEnd] = [Math.min(start[1], end[1]), Math.max(start[1], end[1])];
  const strut = panel.roof
    ? context.rafters.find(
        ({ start: s, end: e }) =>
          (near(s[1], bayStart) || near(s[1], bayEnd)) &&
          near(s[1], e[1]) &&
          near(Math.min(s[0], e[0]), xLow) &&
          near(Math.max(s[0], e[0]), xHigh),
      )
    : context.members.find(
        ({ member: candidate, start: s }) =>
          candidate.role === 'column' && near(s[0], start[0]) && (near(s[1], bayStart) || near(s[1], bayEnd)),
      );
  const strutStrength = strut ? memberStrength(strut.member.material, strut.profile) : undefined;
  if (strut && strutStrength && isSteelRefusal(strutStrength)) return refusedRow(panel.group, strut.member, 'strut', strutStrength);
  if (strut && strutStrength && !isSteelRefusal(strutStrength)) {
    const compression = panel.roof ? (shear * dx) / dy : (shear * dz) / dy;
    const strutFy = strutStrength.fy;
    const purlinGap = purlinGapAlong(context, strut, bayStart, bayEnd);
    const strutLength = panel.roof ? purlinGap : dz;
    const strutResistance = bucklingResistance(strut.profile, strutFy, strutLength) / 1000;
    return {
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
    };
  }
  return undefined;
}

/** Eaves purlin at the wall end of the roof truss: carries the truss reaction in compression. */
function eavesRow(context: PanelContext, geometry: DiagonalGeometry): BracingRow | undefined {
  const { panel, diagonal, dy, xLow, xHigh } = geometry;
  const { start, end, member } = diagonal;
  const { x0, x1, bayForce } = context;
  const atWall = panel.roof && (near(xLow, x0) || near(xHigh, x1));
  if (!atWall) return undefined;
  const [bayStart, bayEnd] = [Math.min(start[1], end[1]), Math.max(start[1], end[1])];
  const wallX = near(xLow, x0) ? x0 : x1;
  // Eaves level of this wall (monopitch: the low and the high eaves differ).
  const eavesZ = minOf(context.rafterEnds.filter((point) => near(point[0], wallX)).map((point) => point[2]));
  const eavesStrut = context.members.find(
    ({ member: candidate, start: s, end: e }) =>
      candidate.role === 'purlin' &&
      Math.abs(s[0] - wallX) < EAVES_X_TOLERANCE &&
      near(Math.min(s[1], e[1]), bayStart) &&
      near(Math.max(s[1], e[1]), bayEnd) &&
      Math.abs(s[2] - eavesZ) < EAVES_Z_TOLERANCE,
  );
  const reaction = bayForce / 2;
  const eavesStrength = eavesStrut ? memberStrength(eavesStrut.member.material, eavesStrut.profile) : undefined;
  const eavesRefusal = eavesStrength && isSteelRefusal(eavesStrength) ? eavesStrength : undefined;
  const fyEaves = eavesStrength && !isSteelRefusal(eavesStrength) ? eavesStrength.fy : 0;
  const eavesResistance = eavesStrut && !eavesRefusal ? bucklingResistance(eavesStrut.profile, fyEaves, dy) / 1000 : 0;
  return {
    group: panel.group,
    elementId: eavesStrut?.member.id ?? member.id,
    elementIds: [eavesStrut?.member.id ?? member.id],
    mark: eavesStrut?.member.mark ?? member.mark,
    kind: 'strut',
    force: reaction,
    resistance: eavesResistance,
    moment: 0,
    momentResistance: 0,
    ...(eavesRefusal ? refusedFields(eavesRefusal) : { utilisation: eavesStrut ? reaction / eavesResistance : NO_MEMBER_UTILISATION }),
    check: eavesRefusal
      ? `eaves strut ${eavesStrut?.member.profile ?? ''} not checked — ${eavesRefusal.message}`
      : eavesStrut
        ? `eaves strut ${eavesStrut.member.profile} compression ${reaction.toFixed(1)} kN (truss reaction at the outer wall line, independent of the number of spans) ≤ χ·Npl,Rd ${eavesResistance.toFixed(1)} kN (minor axis, Lcr ${dy.toFixed(0)} mm bay)`
        : `no eaves strut found at x ${round(wallX, 0)} mm in bay ${panel.bay} mm: truss reaction ${reaction.toFixed(1)} kN has no compression member`,
  };
}

/** The check rows of one braced panel (diagonal, crane share, strut, eaves purlin), appended to `rows` in that order. */
export function panelRows(context: PanelContext, panel: Panel, rows: BracingRow[], craneFoundation: CraneFoundationRow[]): void {
  const diagonal = panel.braces.reduce((best, candidate) => (axisLength(candidate) > axisLength(best) ? candidate : best));
  const { start, end, profile, member } = diagonal;
  const [dx, dy, dz] = [Math.abs(end[0] - start[0]), Math.abs(end[1] - start[1]), Math.abs(end[2] - start[2])];
  if (dy < TOLERANCE) return;
  const { x0, x1, bayForce, craneForce } = context;
  const length = axisLength(diagonal);
  const xLow = Math.min(start[0], end[0]);
  const xHigh = Math.max(start[0], end[0]);
  const hallWidth = x1 - x0;
  const craneShare = craneShareOf(context, panel);
  const shear = panel.roof
    ? (bayForce * (hallWidth / 2 - Math.max(0, Math.min(xLow - x0, x1 - xHigh)))) / hallWidth
    : bayForce / bayWallPanels(context, panel.bay) + craneShare;
  const tension = (shear * length) / dy;
  const strength = memberStrength(member.material, profile);
  if (isSteelRefusal(strength)) {
    rows.push(refusedRow(panel.group, member, 'diagonal', strength));
    return;
  }
  const fy = strength.fy;
  const npl = sectionResistance(profile, fy).axial / 1000;
  const ids = panel.braces.map(({ member: brace }) => brace.id);
  const diagonalRow = (force: number, check: string): BracingRow => ({
    group: panel.group,
    elementId: member.id,
    elementIds: ids,
    mark: member.mark,
    kind: 'diagonal',
    force,
    resistance: npl,
    moment: 0,
    momentResistance: 0,
    utilisation: force / npl,
    check,
  });
  rows.push(
    diagonalRow(
      tension,
      `tension-only ${member.profile}: V ${shear.toFixed(1)} kN / cos θ ${(dy / length).toFixed(2)} = ${tension.toFixed(1)} kN ${verdictSign(tension, npl)} Npl,Rd ${npl.toFixed(1)} kN (bay ${panel.bay} mm)`,
    ),
  );
  if (craneForce !== null && craneShare > 0) {
    const craneTension = (craneShare * length) / dy;
    const side = panel.group.endsWith('west') ? 'west' : 'east';
    rows.push(
      diagonalRow(
        craneTension,
        `crane longitudinal (group 1 / group 7): ${craneForce.governing} governs, 1.35 HL ${craneForce.driveGroup1.toFixed(1)} kN vs HB (γ 1.0) ${craneForce.bufferGroup7.toFixed(1)} kN per runway, share ${craneShare.toFixed(1)} kN on bay ${panel.bay} mm, tension ${craneTension.toFixed(1)} kN ≤ Npl,Rd ${npl.toFixed(1)} kN (included in the wall bracing row above)`,
      ),
    );
    craneFoundation.push({ side, braced: wallPanelsOnSide(context, side), total: craneShare, perColumn: craneShare / 2 });
  }
  const geometry: DiagonalGeometry = { panel, diagonal, dx, dy, dz, xLow, xHigh, shear };
  const strut = strutRow(context, geometry);
  if (strut) rows.push(strut);
  const eaves = eavesRow(context, geometry);
  if (eaves) rows.push(eaves);
}

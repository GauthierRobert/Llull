/** Wind-bracing load path and member checks for a steel hall level (EN 1991-1-4, EN 1993-1-1). */

import type { CadDocument } from '@core/model/types';
import { levelMembersInMm } from '../common/memberSupport';
import { round } from '../../shared/numeric';
import { sectionResistance } from '../steelDesign/steelDesign';
import { isSteelRefusal, memberStrength } from '../steelDesign/steelGrades';
import { GAMMA_G, GAMMA_Q } from '../../shared/loadFactors';
import {
  type BracingRow,
  CP_GABLE,
  CP_POST,
  type Located,
  type Point,
  STABILITY_RATIO,
  type craneWallForce,
  near,
  refusedRow,
} from './bracingModel';
import {
  type BracingInputs,
  type CraneFoundationRow,
  type PanelContext,
  craneLongitudinalPath,
  groupPanels,
  panelRows,
} from './bracingPanelRows';
import { maxOf, minOf } from '@lib/arrayExtrema';
import { appendAll } from '@lib/appendAll';
import { verdictSign } from '../steelDesign/verdictSign';

/** Steel members of `levelId` with endpoints in mm. */
export function locateMembers(doc: CadDocument, levelId: string): Located[] {
  return levelMembersInMm(doc, levelId).flatMap(({ profile, ...located }) => (profile ? [{ ...located, profile }] : []));
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
  const sameSpot = (a: Point, b: Point): boolean => a.every((value, axis) => near(value, b[axis] ?? 0));
  const meetsRafter = ({ start, end }: Located): boolean => rafterEnds.some((point) => sameSpot(point, start) || sameSpot(point, end));
  const columns = members.filter(({ member }) => member.role === 'column');
  for (const planeY of [y0, yEnd]) {
    const inPlane = columns.filter(({ start }) => near(start[1], planeY)).sort((a, b) => a.start[0] - b.start[0]);
    inPlane.forEach((post, index) => {
      if (meetsRafter(post)) return;
      const left = inPlane[index - 1]?.start[0] ?? post.start[0];
      const right = inPlane[index + 1]?.start[0] ?? post.start[0];
      const tributary = (right - left) / 2 / 1000;
      const height = Math.abs(post.end[2] - post.start[2]) / 1000;
      const load = GAMMA_Q * windPressure * CP_POST * tributary;
      const strength = memberStrength(post.member.material, post.profile);
      if (isSteelRefusal(strength)) {
        rows.push(refusedRow('gable posts', post.member, 'gable-post', strength));
        return;
      }
      const fy = strength.fy;
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
        check: `${post.member.profile} (y ${round(planeY, 0)} mm): q ${load.toFixed(2)} kN/m, h ${height.toFixed(2)} m, M ${moment.toFixed(1)} ${verdictSign(moment, momentResistance)} Mpl,Rd ${momentResistance.toFixed(1)} kNm, V ${reaction.toFixed(1)} ≤ Vpl,Rd ${shearResistance.toFixed(1)} kN`,
      });
    });
  }
  return rows;
}

interface BracingAnalysis {
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
  readonly craneFoundation: CraneFoundationRow[];
}

/** @failure no brace / no rafter on the level -> `{ reason }` */
export function analyseBracing(
  members: ReadonlyArray<Located>,
  levelId: string,
  inputs: BracingInputs,
): BracingAnalysis | { reason: string } {
  const { windPressure, deadLoad, snowLoad } = inputs;
  const braces = members.filter(({ member }) => member.role === 'brace');
  const rafters = members.filter(({ member }) => member.role === 'rafter');
  if (braces.length === 0) return { reason: `check_bracing: no bracing (role brace) on level '${levelId}'.` };
  if (rafters.length === 0) return { reason: `check_bracing failed: no rafters on level '${levelId}' (no gable).` };
  const rafterEnds = rafters.flatMap(({ start, end }) => [start, end]);
  const ys = rafterEnds.map((point) => point[1]);
  const y0 = minOf(ys);
  const yEnd = maxOf(ys);
  const xs = rafterEnds.map((point) => point[0]);
  const x0 = minOf(xs);
  const x1 = maxOf(xs);
  const centre = (x0 + x1) / 2;
  const gableAreaMm2 = rafters
    .filter(({ start, end }) => near(start[1], y0) && near(end[1], y0))
    .reduce((sum, { start, end }) => sum + Math.abs(end[0] - start[0]) * ((start[2] + end[2]) / 2), 0);
  const gableArea = gableAreaMm2 / 1e6;
  const planArea = ((x1 - x0) * (yEnd - y0)) / 1e6;
  const windUltimate = GAMMA_Q * windPressure * CP_GABLE * gableArea;
  const roofWind = windUltimate / 2;
  const stability = (GAMMA_G * deadLoad + GAMMA_Q * snowLoad) * planArea * STABILITY_RATIO;
  const roofForce = roofWind + stability;

  const panels = groupPanels(braces, centre);
  const bays = new Set([...panels.values()].map((panel) => panel.bay));
  const bayForce = roofForce / bays.size;
  const cranePath = craneLongitudinalPath(members, centre, inputs);
  const { craneForce, craneCapacity, craneSpan, craneSides } = cranePath;
  const craneFoundation: CraneFoundationRow[] = [];
  const context: PanelContext = {
    ...cranePath,
    members,
    rafters,
    rafterEnds,
    panels,
    purlins: members.filter(({ member }) => member.role === 'purlin'),
    x0,
    x1,
    bayForce,
  };
  const rows: BracingRow[] = [];
  const sorted = [...panels.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [, panel] of sorted) panelRows(context, panel, rows, craneFoundation);

  appendAll(rows, gablePostRows(members, rafterEnds, y0, yEnd, windPressure));
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

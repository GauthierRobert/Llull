/**
 * Tees, olets and stub-ins of a built layout (07 PST M5a): a node where three straight elements meet, two of them collinear (the header, one or two
 * pipes) and the third a branch at about 90 degrees. The code SIF (App. D) acts at the element ends of that node; stiffness is the plain pipe (k = 1).
 * @failure a node with more than three elements, a bend or a rigid body at a junction, no collinear pair, a branch not within 15 degrees of
 *   perpendicular -> PST_BRANCH_UNSUPPORTED
 */

import type { Vec3 } from '@core/model/vectors';
import { computeSif, isSifRefusal, type SifComponent } from '../code/sif';
import type { RuleSet } from '../code/ruleSets';
import type { ElementEndSif, FeElement, Junction, LayoutFailure } from './layoutTypes';

export interface JunctionFitting {
  readonly fitting: Extract<SifComponent, 'welding_tee' | 'unreinforced_tee' | 'reinforced_tee' | 'weldolet'>;
  readonly padMm?: number | undefined;
}

const COLLINEAR = Math.cos((5 * Math.PI) / 180);

const unit = (a: Vec3, b: Vec3): Vec3 => {
  const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const l = Math.hypot(...d);
  return [d[0] / l, d[1] / l, d[2] / l];
};
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

const refuse = (message: string, ids: readonly string[]): LayoutFailure => ({
  ok: false,
  code: 'PST_BRANCH_UNSUPPORTED',
  message,
  ids,
  paths: [],
});

/** The elements with the tee SIF at their junction end, and the junctions. */
export function applyJunctions(
  nodes: readonly Vec3[],
  elements: readonly FeElement[],
  set: RuleSet,
  fittingOf: (branchPipeId: string) => JunctionFitting,
): { elements: FeElement[]; junctions: Junction[] } | LayoutFailure {
  const incident = new Map<number, number[]>();
  elements.forEach((element, index) => {
    for (const node of [element.a, element.b]) incident.set(node, [...(incident.get(node) ?? []), index]);
  });
  const ends = new Map<number, ElementEndSif[]>();
  const junctions: Junction[] = [];
  for (const [node, list] of [...incident].sort((a, b) => a[0] - b[0])) {
    if (list.length < 3) continue;
    const here = nodes[node] as Vec3;
    const named = `node N${node + 1}`;
    const members = list.map((index) => elements[index] as FeElement);
    const ids = [...new Set(members.map((member) => member.pipeId))];
    if (list.length > 3) return refuse(`${named}: ${list.length} pipe pieces meet here; only tees (three) are modelled`, ids);
    if (members.some((member) => member.kind === 'bend' || member.component?.rigid === true))
      return refuse(
        `${named}: a branch on a bend or on a rigid component (valve, flange) cannot be modelled; move it onto straight pipe`,
        ids,
      );
    const away = members.map((member) => unit(here, nodes[member.a === node ? member.b : member.a] as Vec3));
    let header: [number, number] | null = null;
    for (const [i, j] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const)
      if (dot(away[i] as Vec3, away[j] as Vec3) < -COLLINEAR) header = [i, j];
    if (header === null)
      return refuse(`${named}: no two of the three pipe pieces are collinear (a Y junction or an elbow with a stub)`, ids);
    const branch = [0, 1, 2].find((i) => !header?.includes(i)) as number;
    const axis = away[header[0]] as Vec3;
    const sine = Math.hypot(...cross(axis, away[branch] as Vec3));
    if (sine < Math.cos((15 * Math.PI) / 180))
      return refuse(
        `${named}: the branch is more than 15 degrees from perpendicular to the header (only 90 degree tees are modelled)`,
        ids,
      );
    const headerElement = members[header[0]] as FeElement;
    const branchElement = members[branch] as FeElement;
    const choice = fittingOf(branchElement.pipeId);
    const sif = computeSif(set, { component: choice.fitting, odMm: headerElement.odMm, wallMm: headerElement.wallMm, padMm: choice.padMm });
    if (isSifRefusal(sif)) return refuse(`${named}: ${sif.reason}`, ids);
    const normal = cross(axis, away[branch] as Vec3);
    const size = Math.hypot(...normal);
    const planeNormal: Vec3 = [normal[0] / size, normal[1] / size, normal[2] / size];
    members.forEach((_, i) => {
      const own: ElementEndSif = {
        node,
        ii: sif.ii,
        io: sif.io,
        normal: planeNormal,
        source: choice.fitting,
        ...(i === branch ? { headerWallMm: headerElement.wallMm } : {}),
      };
      ends.set(list[i] as number, [...(ends.get(list[i] as number) ?? []), own]);
    });
    junctions.push({
      node,
      headerPipeId: headerElement.pipeId,
      branchPipeId: branchElement.pipeId,
      fitting: choice.fitting,
      h: sif.h,
      ii: sif.ii,
      io: sif.io,
    });
  }
  return {
    elements: elements.map((element, index) => (ends.has(index) ? { ...element, endSifs: ends.get(index) as ElementEndSif[] } : element)),
    junctions,
  };
}

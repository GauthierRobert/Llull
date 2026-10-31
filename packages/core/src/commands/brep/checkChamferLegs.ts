/**
 * Leg readback of check_blends for the variable and asymmetric chamfers (BLD M5, TECHNICAL_SPEC §13.24): at stations along each chamfered edge of the source, the distance from the edge to the contact line of the chamfer
 * face on each of the two faces, measured in the plane perpendicular to the edge (the leg as the chamfer is defined), against the law the recipe gave (size -> sizeEnd on the first face, size2 -> size2End on the other).
 * @invariant a leg is compared at the stations of the source edge (equal arc length), at most 21; a chamfer face the kernel did not name `chamfer(<edge name>)`, or whose contact lines cannot be read, is a row with a reason, never a pass
 * @failure a leg off its law by more than LEG_TOLERANCE of the law -> BLD_CHECK_CHAMFER_LEGS (fail)
 */

import { chamferNodes } from '../../geometry/blend/blendInfo';
import type { GeometryKernel } from '../../geometry/kernel';
import type { Entity, Vec3 } from '../../model/types';
import { roundSignificant } from '../../lib/significant';
import { REMEDIATION, type Finding } from './checkBlendFindings';

/** Relative deviation of a measured leg from its law above which the chamfer is off the law (the loft of a curved edge interpolates the arc to 1e-7 of its radius; named default, §13.24). */
export const LEG_TOLERANCE = 1e-3;
const MAX_STATIONS = 21;
const CONTACT_SAMPLES = 200;

export interface ChamferRow {
  readonly entityId: string;
  readonly edge: number;
  readonly name: string | null;
  /** The chamfer face of the result, null when the kernel did not give one. */
  readonly face: number | null;
  readonly requested: { readonly first: readonly [number, number]; readonly second: readonly [number, number] };
  /** The legs at the stations: `s` the fraction of the arc length from the start of the edge. */
  readonly legs: ReadonlyArray<{
    readonly s: number;
    readonly first: number;
    readonly second: number;
    readonly expectedFirst: number;
    readonly expectedSecond: number;
  }>;
  readonly maxDeviation: number | null;
  readonly note?: string;
}

const sig = (value: number): number => roundSignificant(value, 10);
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

/** The distance from `point` to the nearest place where the polyline `line` crosses the plane through `point` with normal `tangent` (a contact line of a curved edge meets that plane more than once); null when it does not. */
function crossing(line: readonly Vec3[], point: Vec3, tangent: Vec3): number | null {
  const offsets = line.map((p) => dot(sub(p, point), tangent));
  const scale = Math.max(...line.map((p) => norm(sub(p, point))), 1e-12);
  let nearest: number | null = null;
  const consider = (distance: number): void => {
    if (nearest === null || distance < nearest) nearest = distance;
  };
  for (let k = 0; k < line.length; k++) {
    const here = offsets[k] as number;
    if (Math.abs(here) <= 1e-9 * scale) consider(norm(sub(line[k] as Vec3, point)));
    const next = offsets[k + 1];
    if (next !== undefined && here * next < 0) {
      const t = here / (here - next);
      const a = line[k] as Vec3;
      const b = line[k + 1] as Vec3;
      consider(norm(sub([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])], point)));
    }
  }
  return nearest;
}

/** The leg rows of every variable or asymmetric chamfer node of `entity`'s recipe, and a finding for each leg off its law. */
export function readChamferLegs(kernel: GeometryKernel, entity: Entity, unit: string): { rows: ChamferRow[]; findings: Finding[] } {
  const rows: ChamferRow[] = [];
  const findings: Finding[] = [];
  const query = kernel.faceQuery;
  const recipe = entity.kind === 'mesh' ? entity.brep : undefined;
  if (query === undefined || recipe === undefined) return { rows, findings };
  for (const node of chamferNodes(recipe)) {
    const source = kernel.evaluate(node.source);
    const built = kernel.evaluate(node);
    const before = source === null ? null : kernel.topology(source);
    const after = built === null ? null : kernel.topology(built);
    const sourceGraph = source === null ? null : query.faceGraph(source);
    const resultGraph = built === null ? null : query.faceGraph(built);
    node.edges.forEach((edge, at) => {
      const name = before?.edges[edge]?.name ?? null;
      const first: readonly [number, number] = [node.size, node.sizeEnd ?? node.size];
      const second: readonly [number, number] =
        node.faces === undefined ? first : [node.size2 ?? node.size, node.size2End ?? node.size2 ?? node.size];
      const row = (extra: Partial<ChamferRow>): ChamferRow => ({
        entityId: entity.id,
        edge,
        name,
        face: null,
        requested: { first, second },
        legs: [],
        maxDeviation: null,
        ...extra,
      });
      if (
        source === null ||
        built === null ||
        before === null ||
        after === null ||
        sourceGraph === null ||
        resultGraph === null ||
        name === null
      ) {
        rows.push(row({ note: 'the kernel could not rebuild the chamfer to read its legs' }));
        return;
      }
      const chamfer = after.faces.find((face) => face.name === `chamfer(${name})`);
      if (chamfer === undefined) {
        rows.push(row({ note: `the result has no face named chamfer(${name}): the legs are not measured` }));
        return;
      }
      // the two faces of the source edge, by name, and which of them carries the first leg
      const sides = (sourceGraph.edgeFaces[edge] ?? []).map((face) => before.faces[face]?.name);
      const firstFace = node.faces === undefined ? undefined : before.faces[node.faces[at] as number]?.name;
      const names = [...new Set(sides)].filter((value): value is string => value !== undefined);
      if (names.length !== 2) {
        rows.push(row({ face: chamfer.index, note: 'the edge does not join two named faces, the legs are not measured' }));
        return;
      }
      const contacts = (resultGraph.faces[chamfer.index]?.loops ?? []).flat().flatMap((contact) => {
        const other = (resultGraph.edgeFaces[contact] ?? []).find((face) => face !== chamfer.index);
        const otherName = other === undefined ? undefined : after.faces[other]?.name;
        return otherName !== undefined && names.includes(otherName) ? [{ contact, side: otherName }] : [];
      });
      const lineOf = (side: string): Vec3[] | null => {
        const found = contacts.find((entry) => entry.side === side);
        return found === undefined
          ? null
          : (query.edgeSamples(built, found.contact, CONTACT_SAMPLES)?.map((sample) => sample.point) ?? null);
      };
      const [lineFirst, lineSecond] = [
        lineOf(firstFace ?? (names[0] as string)),
        lineOf(firstFace === undefined ? (names[1] as string) : (names.find((value) => value !== firstFace) as string)),
      ];
      const stations = query.edgeSamples(source, edge, Math.min(MAX_STATIONS, 21));
      if (lineFirst === null || lineSecond === null || stations === null) {
        rows.push(row({ face: chamfer.index, note: 'the contact lines of the chamfer face could not be read, the legs are not measured' }));
        return;
      }
      const legs: ChamferRow['legs'][number][] = [];
      let worst = 0;
      const length = stations[stations.length - 1]?.s || 1;
      for (const station of stations) {
        const along = station.s / length;
        const legOne = crossing(lineFirst, station.point, station.tangent);
        const legTwo = crossing(lineSecond, station.point, station.tangent);
        const expectedFirst = first[0] + (first[1] - first[0]) * along;
        const expectedSecond = second[0] + (second[1] - second[0]) * along;
        if (legOne === null || legTwo === null) continue;
        legs.push({
          s: sig(along),
          first: sig(legOne),
          second: sig(legTwo),
          expectedFirst: sig(expectedFirst),
          expectedSecond: sig(expectedSecond),
        });
        worst = Math.max(worst, Math.abs(legOne - expectedFirst) / expectedFirst, Math.abs(legTwo - expectedSecond) / expectedSecond);
      }
      if (legs.length === 0) {
        rows.push(
          row({ face: chamfer.index, note: 'the contact lines do not cross the planes of the edge stations, the legs are not measured' }),
        );
        return;
      }
      rows.push(row({ face: chamfer.index, legs, maxDeviation: sig(worst) }));
      if (worst > LEG_TOLERANCE)
        findings.push({
          code: 'BLD_CHECK_CHAMFER_LEGS',
          severity: 'fail',
          entityId: entity.id,
          face: chamfer.index,
          edge,
          value: sig(worst),
          limit: LEG_TOLERANCE,
          unit,
          remediation: REMEDIATION.BLD_CHECK_CHAMFER_LEGS,
          message: `a leg of the chamfer of edge ${edge} is off its law by ${sig(worst)} (relative), more than ${LEG_TOLERANCE}`,
        });
    });
  }
  return { rows, findings };
}

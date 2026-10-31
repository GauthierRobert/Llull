/**
 * Leg readback of check_blends for the variable and asymmetric chamfers (BLD M5, TECHNICAL_SPEC §13.24): at stations along each chamfered edge of the source, the chord from the edge to the contact line of the chamfer
 * face on each of the two faces, in the plane perpendicular to the edge (the leg as the chamfer is defined), against the law the recipe gave: size -> sizeEnd on the first face and size2 -> size2End on the other, or for a
 * distance-angle chamfer the second leg d sin(a) / sin(phi + a) of its dihedral phi at each station (a right angle gives d tan(a)).
 * @invariant a leg is compared at the stations of the source edge (equal arc length), at most 21; the contact lines are crossed with the plane of the station on a quadratic through three samples (an error of order h^3, not the chord
 *   sag of order h^2 of a polyline); a leg whose law is not known (no face query for the dihedral), a chamfer face the kernel did not name `chamfer(<edge name>)`, contact lines that cannot be read, or a station the lines do not
 *   cross, is reported (a row with a reason, `skipped`), counted as unverified by check_blends, never a pass
 * @failure a leg off its law by more than LEG_TOLERANCE of the law -> BLD_CHECK_CHAMFER_LEGS (fail)
 */

import { chamferNodes } from '../../geometry/blend/blendInfo';
import type { GeometryKernel } from '../../geometry/kernel';
import type { Entity, Vec3 } from '../../model/types';
import { roundSignificant } from '../../lib/significant';
import { REMEDIATION, type Finding } from './checkBlendFindings';

/** Relative deviation of a measured leg from its law above which the chamfer is off the law (named default, §13.24). */
export const LEG_TOLERANCE = 1e-3;
const MAX_STATIONS = 21;
const CONTACT_SAMPLES = 200;
/** More stations than this fraction without a reading make the row unverified. */
const MAX_SKIPPED_FRACTION = 0.25;

export interface ChamferRow {
  readonly entityId: string;
  readonly edge: number;
  readonly name: string | null;
  /** The chamfer face of the result, null when the kernel did not give one. */
  readonly face: number | null;
  readonly requested: {
    readonly first: readonly [number, number];
    readonly second: readonly [number, number] | { readonly angleDeg: number };
  };
  /** The legs at the stations: `s` the fraction of the arc length from the start of the edge; an expected leg is null where its law is not known. */
  readonly legs: ReadonlyArray<{
    readonly s: number;
    readonly first: number;
    readonly second: number;
    readonly expectedFirst: number;
    readonly expectedSecond: number | null;
  }>;
  /** Stations at which a contact line did not cross the plane of the edge. */
  readonly skipped: number;
  readonly maxDeviation: number | null;
  /** Why the row is not a verification (absent when the legs were compared). */
  readonly note?: string;
}

const sig = (value: number): number => roundSignificant(value, 10);
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

/** A root of the quadratic through (0, f0), (1, f1), (2, f2) inside [low, high] (the function changes sign there), by bisection. */
function quadraticRoot(f0: number, f1: number, f2: number, low: number, high: number): number {
  const value = (t: number): number => f0 + (t * (-3 * f0 + 4 * f1 - f2)) / 2 + (t * t * (f0 - 2 * f1 + f2)) / 2;
  let [a, b] = [low, high];
  const sign = Math.sign(value(a));
  for (let step = 0; step < 60; step++) {
    const middle = (a + b) / 2;
    if (Math.sign(value(middle)) === sign) a = middle;
    else b = middle;
  }
  return (a + b) / 2;
}

/**
 * The distance from `point` to the nearest place where one of the polylines `lines` crosses the plane through `point` with normal `tangent` (a contact line of a curved edge meets that plane more than once); null when none does.
 * The crossing is found on the quadratic through three consecutive samples, so a polyline of 200 samples of a circle is read to order h^3.
 */
function crossing(lines: readonly (readonly Vec3[])[], point: Vec3, tangent: Vec3): number | null {
  let nearest: number | null = null;
  const consider = (distance: number): void => {
    if (nearest === null || distance < nearest) nearest = distance;
  };
  for (const line of lines) {
    const offsets = line.map((p) => dot(sub(p, point), tangent));
    const scale = Math.max(...line.map((p) => norm(sub(p, point))), 1e-12);
    const lastOffset = offsets[line.length - 1];
    if (lastOffset !== undefined && Math.abs(lastOffset) <= 1e-12 * scale) consider(norm(sub(line[line.length - 1] as Vec3, point)));
    for (let k = 0; k + 1 < line.length; k++) {
      const here = offsets[k] as number;
      const next = offsets[k + 1] as number;
      if (Math.abs(here) <= 1e-12 * scale) {
        consider(norm(sub(line[k] as Vec3, point)));
        continue;
      }
      if (here * next >= 0) continue;
      // nodes (k, k + 1, k + 2) when there is a k + 2, else (k - 1, k, k + 1)
      const shift = k + 2 < line.length ? 0 : -1;
      const [i0, i1, i2] = [k + shift, k + shift + 1, k + shift + 2];
      if (i0 < 0) {
        consider(norm(sub(line[k] as Vec3, point)));
        continue;
      }
      const f = [offsets[i0], offsets[i1], offsets[i2]] as [number, number, number];
      const p = [line[i0], line[i1], line[i2]] as [Vec3, Vec3, Vec3];
      const t = quadraticRoot(f[0], f[1], f[2], shift === 0 ? 0 : 1, shift === 0 ? 1 : 2);
      const weights = [((t - 1) * (t - 2)) / 2, -t * (t - 2), (t * (t - 1)) / 2];
      const [w0, w1, w2] = weights as [number, number, number];
      const at = (axis: 0 | 1 | 2): number => p[0][axis] * w0 + p[1][axis] * w1 + p[2][axis] * w2;
      const crossed: Vec3 = [at(0), at(1), at(2)];
      consider(norm(sub(crossed, point)));
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
      const angle = node.angleDeg;
      const second: readonly [number, number] =
        node.faces === undefined ? first : [node.size2 ?? node.size, node.size2End ?? node.size2 ?? node.size];
      const row = (extra: Partial<ChamferRow>): ChamferRow => ({
        entityId: entity.id,
        edge,
        name,
        face: null,
        requested: { first, second: angle === undefined ? second : { angleDeg: angle } },
        legs: [],
        skipped: 0,
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
      const sourceFaces = [...new Set(sourceGraph.edgeFaces[edge] ?? [])];
      const names = sourceFaces.map((face) => before.faces[face]?.name).filter((value): value is string => value !== undefined);
      const firstIndex = node.faces === undefined ? undefined : (node.faces[at] as number);
      const firstFace = firstIndex === undefined ? undefined : before.faces[firstIndex]?.name;
      if (names.length !== 2 || new Set(names).size !== 2) {
        rows.push(row({ face: chamfer.index, note: 'the edge does not join two named faces, the legs are not measured' }));
        return;
      }
      const otherFace = names.find((value) => value !== firstFace) as string;
      const contacts = (resultGraph.faces[chamfer.index]?.loops ?? []).flat().flatMap((contact) => {
        const other = (resultGraph.edgeFaces[contact] ?? []).find((face) => face !== chamfer.index);
        const otherName = other === undefined ? undefined : after.faces[other]?.name;
        return otherName !== undefined && names.includes(otherName) ? [{ contact, side: otherName }] : [];
      });
      const sideLines = (side: string): Vec3[][] =>
        contacts
          .filter((entry) => entry.side === side)
          .flatMap((entry) => {
            const points = query.edgeSamples(built, entry.contact, CONTACT_SAMPLES)?.map((sample) => sample.point);
            return points === undefined ? [] : [points];
          });
      const firstSide = firstFace ?? (names[0] as string);
      const linesFirst = sideLines(firstSide);
      const linesSecond = sideLines(firstFace === undefined ? (names[1] as string) : otherName(names, firstFace));
      const stations = query.edgeSamples(source, edge, MAX_STATIONS);
      if (linesFirst.length === 0 || linesSecond.length === 0 || stations === null) {
        rows.push(row({ face: chamfer.index, note: 'the contact lines of the chamfer face could not be read, the legs are not measured' }));
        return;
      }
      const secondFaceIndex = sourceFaces.find((face) => before.faces[face]?.name === otherFace);
      const legs: ChamferRow['legs'][number][] = [];
      let worst = 0;
      let skipped = 0;
      const length = stations[stations.length - 1]?.s || 1;
      for (const station of stations) {
        const along = station.s / length;
        const legOne = crossing(linesFirst, station.point, station.tangent);
        const legTwo = crossing(linesSecond, station.point, station.tangent);
        const expectedFirst = first[0] + (first[1] - first[0]) * along;
        let expectedSecond: number | null = second[0] + (second[1] - second[0]) * along;
        if (angle !== undefined) {
          // distance-angle: the second leg follows from the dihedral at the station (the angle is measured on the first face)
          const normals =
            firstIndex === undefined || secondFaceIndex === undefined
              ? null
              : [firstIndex, secondFaceIndex].map((face) => query.projectOnFace(source, face, [station.point])?.[0]?.normal ?? null);
          const [n0, n1] = normals ?? [null, null];
          if (n0 === null || n0 === undefined || n1 === null || n1 === undefined) expectedSecond = null;
          else {
            const phi = Math.PI - Math.acos(Math.max(-1, Math.min(1, dot(n0, n1))));
            const a = (angle * Math.PI) / 180;
            expectedSecond = (expectedFirst * Math.sin(a)) / Math.sin(phi + a);
          }
        }
        if (legOne === null || legTwo === null) {
          skipped += 1;
          continue;
        }
        legs.push({
          s: sig(along),
          first: sig(legOne),
          second: sig(legTwo),
          expectedFirst: sig(expectedFirst),
          expectedSecond: expectedSecond === null ? null : sig(expectedSecond),
        });
        worst = Math.max(worst, Math.abs(legOne - expectedFirst) / expectedFirst);
        if (expectedSecond !== null) worst = Math.max(worst, Math.abs(legTwo - expectedSecond) / expectedSecond);
      }
      if (legs.length === 0 || skipped > MAX_SKIPPED_FRACTION * stations.length) {
        rows.push(
          row({
            face: chamfer.index,
            legs,
            skipped,
            note: `the contact lines cross the plane of the edge at ${legs.length} of ${stations.length} stations, the legs are not verified`,
          }),
        );
        return;
      }
      if (legs.some((entry) => entry.expectedSecond === null)) {
        rows.push(
          row({
            face: chamfer.index,
            legs,
            skipped,
            maxDeviation: sig(worst),
            note: 'the second leg of a distance-angle chamfer needs the faces of the edge to be queried: only the first leg is compared',
          }),
        );
        return;
      }
      rows.push(row({ face: chamfer.index, legs, skipped, maxDeviation: sig(worst) }));
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

const otherName = (names: readonly string[], first: string): string => names.find((value) => value !== first) as string;

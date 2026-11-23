/**
 * One fitted face per run and group of section edges: the cubic Bézier edges of a station ring, each already fitted across the stations of a run,
 * are joined along u into a few B-spline faces (the General Fuse of two sweeps pairs far fewer faces than with one face per edge).
 * @invariant the merged face equals its edge faces exactly: at u = (k + s) / m it is edge k at s (a C1 junction keeps a double knot, anything else a triple one)
 * @invariant a whole section never becomes one face: a face closed on itself is not sewn to its own seam by the kernel (`kernelSheets.ts`), so a ring is cut into FACE_GROUPS faces
 */

import { appendAll } from '../../lib/appendAll';
import type { Vec3 } from '../../model/vectors';
import type { NurbsSurfaceData } from '../../lib/nurbs/surfaceTypes';

/** Faces a section ring is merged into (per run chunk); every face shares its two boundary pole paths bit for bit with its neighbours. */
export const FACE_GROUPS = 2;
/** Fewest edges worth merging (a ring of fewer keeps one face per edge). */
const MIN_EDGES = 4;
const CUBIC = 3;

type Row = ReadonlyArray<Vec3>;

/** True when the junction between consecutive Bézier edges is C1 everywhere along v: p3 - p2 = p1' - p0' for every column. */
function isC1(previous: NurbsSurfaceData, next: NurbsSurfaceData, scale: number): boolean {
  const [p2, p3] = [previous.poles[2] as Row, previous.poles[3] as Row];
  const [p0, p1] = [next.poles[0] as Row, next.poles[1] as Row];
  return p3.every((point, j) =>
    [0, 1, 2].every((axis) => {
      const left = (point[axis] as number) - ((p2[j] as Vec3)[axis] as number);
      const right = ((p1[j] as Vec3)[axis] as number) - ((p0[j] as Vec3)[axis] as number);
      return Math.abs(left - right) <= 1e-9 * scale;
    }),
  );
}

/** One face from consecutive cubic edge faces (same v structure). */
function join(edges: readonly NurbsSurfaceData[], scale: number): NurbsSurfaceData {
  const first = edges[0] as NurbsSurfaceData;
  const rows: Row[] = [...(first.poles as Row[])];
  const multiplicities = [CUBIC + 1];
  edges.slice(1).forEach((edge, k) => {
    const c1 = isC1(edges[k] as NurbsSurfaceData, edge, scale);
    if (c1) rows.pop(); // the junction pole is the midpoint of its neighbours: a double knot has no pole there
    appendAll(rows, edge.poles.slice(1) as Row[]);
    multiplicities.push(c1 ? CUBIC - 1 : CUBIC);
  });
  multiplicities.push(CUBIC + 1);
  return {
    degreeU: CUBIC,
    degreeV: first.degreeV,
    poles: rows,
    knotsU: multiplicities.map((_, k) => k / (multiplicities.length - 1)),
    multiplicitiesU: multiplicities,
    knotsV: first.knotsV,
    multiplicitiesV: first.multiplicitiesV,
  };
}

/** True when `faces` are the edge faces of a station ring this module can join: at least MIN_EDGES single-span, non-rational cubics. */
function joinable(faces: readonly NurbsSurfaceData[]): boolean {
  return (
    faces.length >= MIN_EDGES &&
    faces.every(
      (face) => face.degreeU === CUBIC && face.weights === undefined && face.knotsU.length === 2 && face.poles.length === CUBIC + 1,
    )
  );
}

/**
 * `faces` (one per consecutive section edge, one run chunk) joined into FACE_GROUPS faces of near-equal edge counts; unchanged when they cannot be
 * joined (rational or lower-degree edges, a short ring).
 * @pure
 */
export function mergeEdgeFaces(faces: readonly NurbsSurfaceData[], scale: number): NurbsSurfaceData[] {
  if (!joinable(faces)) return [...faces];
  const size = Math.ceil(faces.length / FACE_GROUPS);
  const groups: NurbsSurfaceData[] = [];
  for (let from = 0; from < faces.length; from += size) groups.push(join(faces.slice(from, from + size), scale));
  return groups;
}

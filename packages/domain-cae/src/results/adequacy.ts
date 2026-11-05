/**
 * Mesh adequacy (05 §5.5, VC-FEA-09; 10 result-integrity TR-INT-07): are there enough tetrahedron layers through the wall of every solid part for the
 * element order to resolve bending? Measured on the actual mesh: rays are cast from sampled boundary faces along the inward normal through the
 * tetrahedra; the element layers are the hit distance over the local element size. A thin wall of a large part (a tube, an L-bracket) reads thin; the bounding box never enters.
 */

import type { FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { FeMeshAdequacy } from '@core/model/meshAdequacy';
import type { Vec3 } from '@core/model/vectors';

type Verdict = FeMeshAdequacy['verdict'];
type PartEntry = FeMeshAdequacy['parts'][number];

/**
 * Element layers required through the wall of a linear tetrahedron (C3D4), on the scale of hex-equivalent layers (hit distance over the local
 * element size). Target value of TR-INT-07 (10-result-integrity), pending the measured convergence study of VNV-M3 / VC-INT-12.
 */
export const LINEAR_LAYERS_REQUIRED = 4;
/** Element layers required through the wall of a quadratic tetrahedron (C3D10). Target value of TR-INT-07, pending the VNV-M3 convergence study. */
export const QUADRATIC_LAYERS_REQUIRED = 2;
/** Boundary faces measured per part and order: all of them up to this many, else this many chosen by a deterministic hash of the face nodes. */
const SAMPLE_FACES = 400;
/** Fraction of the samples allowed to read thinner (the 5th percentile governs, so a thin wall is not averaged away). */
const PERCENTILE = 0.05;
/**
 * Mean edge length of a Kuhn-split cell (6 tets: edges 1, 1, 1, sqrt 2, sqrt 2, sqrt 3 of the cell side) over the cell side: the local element size
 * h of a ray is the mean edge length of the tets it crosses divided by this, so a structured mesh of cubic cells of side s reads h = s and one
 * layer of hex-equivalent cells reads 1 layer. A mesher's near-regular tets (layer height 0.82 of the edge) read about the same.
 */
const MEAN_EDGE_OVER_CELL = (3 + 2 * Math.SQRT2 + Math.sqrt(3)) / 6;
/** Relative slack on the budget comparison, so a structured mesh exactly at the budget (4.0000000001 or 3.9999999999 layers) is not decided by rounding. */
const BUDGET_TOLERANCE = 1e-6;
/** A thinnest spot under this fraction of the budget makes a result that meets it `marginal` (a thin region smaller than 5 % of the surface). */
const MARGINAL_FRACTION = 0.75;
/** A direction counts as leaving a tetrahedron face only when its cosine with the outward normal exceeds this. */
const EXIT_COSINE = 1e-9;
type Corner = 0 | 1 | 2 | 3;
const CORNERS: readonly Corner[] = [0, 1, 2, 3];
/** Faces of a tetrahedron by the corner each one is opposite to. */
const FACE_OF: Readonly<Record<Corner, readonly [Corner, Corner, Corner]>> = { 0: [1, 2, 3], 1: [0, 2, 3], 2: [0, 1, 3], 3: [0, 1, 2] };
/** The six edges of a tetrahedron as corner pairs. */
const EDGES: readonly (readonly [Corner, Corner])[] = [
  [0, 1],
  [0, 2],
  [0, 3],
  [1, 2],
  [1, 3],
  [2, 3],
];

const WORST: Readonly<Record<Verdict, number>> = { adequate: 0, marginal: 1, inadequate: 2 };

/**
 * Verdict of a measured layer count: `inadequate` when the 5th percentile is below the budget; `marginal` when it meets the budget but the
 * thinnest sampled spot is under 75 % of it (a thin region smaller than 5 % of the surface); `adequate` otherwise.
 */
function verdictOf(typical: number, thinnest: number, required: number): Verdict {
  if (typical < required * (1 - BUDGET_TOLERANCE)) return 'inadequate';
  return thinnest < required * MARGINAL_FRACTION ? 'marginal' : 'adequate';
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

type Corners = readonly [Vec3, Vec3, Vec3, Vec3];
interface Tet {
  readonly ids: readonly [number, number, number, number];
  readonly corners: Corners;
}

/** Sorted node ids of the face of `tet` opposite `corner`. */
const faceIds = (tet: Tet, corner: Corner): [number, number, number] => {
  const [a, b, c] = FACE_OF[corner];
  return [tet.ids[a], tet.ids[b], tet.ids[c]].sort((x, y) => x - y) as [number, number, number];
};

/** Unit outward normal of the face of `tet` opposite corner `opposite` and one of its vertices; null for a zero-area face. */
function outwardFace(tet: Tet, opposite: Corner): { readonly normal: Vec3; readonly vertex: Vec3 } | null {
  const [a, b, c] = FACE_OF[opposite];
  const [pa, pb, pc] = [tet.corners[a], tet.corners[b], tet.corners[c]];
  const raw = cross(sub(pb, pa), sub(pc, pa));
  const length = Math.hypot(raw[0], raw[1], raw[2]);
  if (!(length > 0) || !Number.isFinite(length)) return null;
  const sign = dot(raw, sub(tet.corners[opposite], pa)) > 0 ? -1 : 1;
  return { normal: [(sign * raw[0]) / length, (sign * raw[1]) / length, (sign * raw[2]) / length], vertex: pa };
}

/** `neighbours[4 * tet + corner]` is the tetrahedron across the face opposite `corner`, -1 on the boundary. */
function adjacency(tets: readonly Tet[]): Int32Array {
  const neighbours = new Int32Array(tets.length * 4).fill(-1);
  const seen = new Map<string, number>();
  tets.forEach((tet, index) => {
    for (const corner of CORNERS) {
      const key = faceIds(tet, corner).join(',');
      const other = seen.get(key);
      if (other === undefined) seen.set(key, index * 4 + corner);
      else if (neighbours[other] === -1) {
        neighbours[other] = index;
        neighbours[index * 4 + corner] = Math.floor(other / 4);
      }
    }
  });
  return neighbours;
}

/** Deterministic pseudo-random order of a boundary face (hash of its sorted node ids): samples spread over the part without aliasing the mesh pattern. */
function faceHash(tet: Tet, corner: Corner): number {
  const [a, b, c] = faceIds(tet, corner);
  return (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791)) >>> 0;
}

/** Mean of the 6 corner-to-corner edge lengths of `tet`. */
function meanEdge(tet: Tet): number {
  let total = 0;
  for (const [from, to] of EDGES) {
    const [a, b] = [tet.corners[from], tet.corners[to]];
    total += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  }
  return total / 6;
}

interface Ray {
  /** Element layers: hit distance over the local element size. */
  readonly layers: number;
  readonly tets: number;
}

/**
 * The ray from the centroid of a boundary face along the inward normal until it leaves the part: its hit distance t over the local element size
 * h (mean edge length of the crossed tets over MEAN_EDGE_OVER_CELL); null for a degenerate face or a ray that crosses nothing measurable. A ray
 * stops where it makes no progress (a degenerate tet, or overlapping tets whose faces point at each other), so it always terminates.
 */
function layersThrough(tets: readonly Tet[], neighbours: Int32Array, start: number, corner: Corner): Ray | null {
  const first = tets[start] as Tet;
  const face = outwardFace(first, corner);
  if (face === null) return null;
  const [a, b, c] = FACE_OF[corner].map((vertex) => first.corners[vertex]) as [Vec3, Vec3, Vec3];
  const origin: Vec3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
  const direction: Vec3 = [-face.normal[0], -face.normal[1], -face.normal[2]];
  let current = start;
  let crossed = 0;
  let edges = 0;
  let travelled = 0;
  for (;;) {
    const tet = tets[current] as Tet;
    let exitCorner: Corner | null = null;
    let exitAt = Infinity;
    for (const opposite of CORNERS) {
      const candidate = outwardFace(tet, opposite);
      if (candidate === null) continue;
      const cosine = dot(direction, candidate.normal);
      if (cosine <= EXIT_COSINE) continue;
      const at = dot(sub(candidate.vertex, origin), candidate.normal) / cosine;
      if (at < exitAt) {
        exitAt = at;
        exitCorner = opposite;
      }
    }
    if (exitCorner === null || !(exitAt > travelled)) break;
    crossed += 1;
    edges += meanEdge(tet);
    travelled = exitAt;
    const next = neighbours[current * 4 + exitCorner] as number;
    if (next < 0) break;
    current = next;
  }
  const size = edges / crossed / MEAN_EDGE_OVER_CELL;
  return crossed > 0 && size > 0 ? { layers: travelled / size, tets: crossed } : null;
}

/** The measured entry of one part and order, or null when no boundary face could be cast. */
function measure(entityId: string, order: PartEntry['order'], tets: readonly Tet[]): PartEntry | null {
  const neighbours = adjacency(tets);
  const boundary: { readonly tet: number; readonly corner: Corner; readonly hash: number }[] = [];
  tets.forEach((tet, index) => {
    for (const corner of CORNERS)
      if (neighbours[index * 4 + corner] === -1) boundary.push({ tet: index, corner, hash: faceHash(tet, corner) });
  });
  const chosen =
    boundary.length <= SAMPLE_FACES ? boundary : [...boundary].sort((left, right) => left.hash - right.hash).slice(0, SAMPLE_FACES);
  const rays = chosen
    .map((face) => layersThrough(tets, neighbours, face.tet, face.corner))
    .filter((ray): ray is Ray => ray !== null)
    .sort((left, right) => left.layers - right.layers || left.tets - right.tets);
  const governing = rays[Math.max(0, Math.ceil(PERCENTILE * rays.length) - 1)];
  const thinnest = rays[0];
  if (governing === undefined || thinnest === undefined) return null;
  const elementsThrough = governing.layers;
  const required = order === 'linear' ? LINEAR_LAYERS_REQUIRED : QUADRATIC_LAYERS_REQUIRED;
  const minimumLayers = thinnest.layers;
  return {
    entityId,
    order,
    elementsThrough,
    minimumLayers,
    tetsCrossed: governing.tets,
    required,
    samples: rays.length,
    verdict: verdictOf(elementsThrough, minimumLayers, required),
  };
}

/**
 * Through-thickness adequacy of every solid part of the mesh, per element order.
 * @invariant deterministic (no randomness; samples chosen by a hash of the face nodes; ties keep the element order); cost O(E) to index the
 *   elements plus O(S x L) for S <= 400 sampled boundary faces per part and order and L the layers a ray crosses; `elementsThrough` is the 5th
 *   percentile of the element layers (hit distance over the mean tet edge of the crossed tets, calibrated to hex-equivalent cells; a thin wall governs); the verdict is the worst over parts; parts without tetrahedra, or with tetrahedra
 *   referencing a missing node left out of the count, are listed in `unmeasuredParts` and never counted as inadequate
 */
export function meshAdequacy(mesh: FeMeshArtifact): FeMeshAdequacy {
  const coordinates = new Map<number, Vec3>(mesh.nodes.map((node) => [node[0], [node[1], node[2], node[3]]]));
  const groups = new Map<string, { entityId: string; order: PartEntry['order']; tets: Tet[] }>();
  const entities = new Set<string>();
  for (const block of mesh.blocks) {
    entities.add(block.entityId);
    if (block.type !== 'C3D4' && block.type !== 'C3D10') continue;
    const order: PartEntry['order'] = block.type === 'C3D4' ? 'linear' : 'quadratic';
    const key = `${block.entityId}|${order}`;
    const group = groups.get(key) ?? { entityId: block.entityId, order, tets: [] };
    for (const element of block.elements) {
      const ids = element.slice(1, 5);
      const corners = ids.map((id) => coordinates.get(id));
      if (ids.length < 4 || corners.some((corner) => corner === undefined)) continue;
      group.tets.push({ ids: ids as unknown as Tet['ids'], corners: corners as unknown as Corners });
    }
    groups.set(key, group);
  }
  const parts = [...groups.values()]
    .sort((left, right) => (`${left.entityId}|${left.order}` < `${right.entityId}|${right.order}` ? -1 : 1))
    .flatMap((group) => measure(group.entityId, group.order, group.tets) ?? []);
  const measured = new Set(parts.map((part) => part.entityId));
  const verdict = parts.reduce<Verdict>((worst, part) => (WORST[part.verdict] > WORST[worst] ? part.verdict : worst), 'adequate');
  return { verdict, parts, unmeasuredParts: [...entities].filter((entityId) => !measured.has(entityId)).sort() };
}

/** The adequacy recorded on the results artifact when the solve ran, else measured on `mesh` (imported results carry none). */
export const adequacyOf = (results: FeResultsArtifact, mesh: FeMeshArtifact): FeMeshAdequacy => results.adequacy ?? meshAdequacy(mesh);

/** One account per part that is not adequate, e.g. `part 'bx-1': 2 element layer(s) through the wall ... (C3D4 needs 4)`; empty when adequate. */
export function inadequacyReasons(adequacy: FeMeshAdequacy): string[] {
  return adequacy.parts
    .filter((part) => part.verdict !== 'adequate')
    .map(
      (part) =>
        `part '${part.entityId}': ${Number(part.elementsThrough.toFixed(2))} element layer(s) through the wall (5th percentile of ${part.samples} sampled boundary faces, thinnest spot ${Number(part.minimumLayers.toFixed(2))}; ${part.order === 'linear' ? 'C3D4' : 'C3D10'} needs ${part.required})`,
    );
}

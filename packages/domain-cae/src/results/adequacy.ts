/**
 * Mesh adequacy (05 §5.5, VC-FEA-09; 10 result-integrity TR-INT-07): are there enough tetrahedron layers through the wall of every solid part for the
 * element order to resolve bending? Measured on the actual mesh: rays are cast from sampled boundary faces along the inward normal through the
 * tetrahedra, and the layers crossed are counted. A thin wall of a large part (a tube, an L-bracket) reads thin; the bounding box never enters.
 */

import type { FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { FeMeshAdequacy } from '@core/model/meshAdequacy';
import type { Vec3 } from '@core/model/vectors';

type Verdict = FeMeshAdequacy['verdict'];
type PartEntry = FeMeshAdequacy['parts'][number];

/**
 * Layers required through the wall of a linear tetrahedron (C3D4). Target value of TR-INT-07 (10-result-integrity), pending the measured
 * convergence of VNV-M3 / VC-INT-12.
 */
export const LINEAR_LAYERS_REQUIRED = 4;
/** Layers required through the wall of a quadratic tetrahedron (C3D10). Target value of TR-INT-07, pending VNV-M3. */
export const QUADRATIC_LAYERS_REQUIRED = 2;
/** Boundary faces measured per part and order: all of them up to this many, else this many chosen by a deterministic hash of the face nodes. */
const SAMPLE_FACES = 400;
/** Fraction of the samples allowed to read thinner (the 5th percentile governs, so a thin wall is not averaged away). */
const PERCENTILE = 0.05;
/** A direction counts as leaving a tetrahedron face only when its cosine with the outward normal exceeds this. */
const EXIT_COSINE = 1e-9;
/** Faces of a tetrahedron by the corner each one is opposite to. */
const FACE_OF = [
  [1, 2, 3],
  [0, 2, 3],
  [0, 1, 3],
  [0, 1, 2],
] as const;

const WORST: Readonly<Record<Verdict, number>> = { adequate: 0, marginal: 1, inadequate: 2 };

/**
 * Verdict of a measured layer count: `inadequate` when the 5th percentile is below the budget; `marginal` when it meets the budget but the
 * thinnest sampled spot does not (a thin region smaller than 5 % of the surface); `adequate` otherwise.
 */
function verdictOf(typical: number, thinnest: number, required: number): Verdict {
  if (typical < required) return 'inadequate';
  return thinnest < required ? 'marginal' : 'adequate';
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
const faceIds = (tet: Tet, corner: number): [number, number, number] => {
  const [a, b, c] = (FACE_OF[corner] ?? FACE_OF[0]).map((vertex) => tet.ids[vertex]).sort((x, y) => x - y);
  return [a ?? 0, b ?? 0, c ?? 0];
};

/** Unit outward normal of the face of `tet` opposite corner `opposite` and one of its vertices; null for a zero-area face. */
function outwardFace(tet: Tet, opposite: number): { readonly normal: Vec3; readonly vertex: Vec3 } | null {
  const [a, b, c] = FACE_OF[opposite] ?? FACE_OF[0];
  const [pa, pb, pc] = [tet.corners[a], tet.corners[b], tet.corners[c]];
  const raw = cross(sub(pb, pa), sub(pc, pa));
  const length = Math.hypot(raw[0], raw[1], raw[2]);
  if (!(length > 0) || !Number.isFinite(length)) return null;
  const sign = dot(raw, sub(tet.corners[opposite] ?? pa, pa)) > 0 ? -1 : 1;
  return { normal: [(sign * raw[0]) / length, (sign * raw[1]) / length, (sign * raw[2]) / length], vertex: pa };
}

/** `neighbours[4 * tet + corner]` is the tetrahedron across the face opposite `corner`, -1 on the boundary. */
function adjacency(tets: readonly Tet[]): Int32Array {
  const neighbours = new Int32Array(tets.length * 4).fill(-1);
  const seen = new Map<string, number>();
  tets.forEach((tet, index) => {
    for (let corner = 0; corner < 4; corner += 1) {
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
function faceHash(tet: Tet, corner: number): number {
  const [a, b, c] = faceIds(tet, corner);
  return (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791)) >>> 0;
}

/** Layers crossed by the ray from the centroid of a boundary face along the inward normal until it leaves the part; null for a degenerate face. */
function layersThrough(tets: readonly Tet[], neighbours: Int32Array, start: number, corner: number): number | null {
  const first = tets[start];
  const face = first === undefined ? null : outwardFace(first, corner);
  if (first === undefined || face === null) return null;
  const points = (FACE_OF[corner] ?? FACE_OF[0]).map((vertex) => first.corners[vertex]);
  const origin: Vec3 = [
    points.reduce((sum, point) => sum + (point?.[0] ?? 0), 0) / 3,
    points.reduce((sum, point) => sum + (point?.[1] ?? 0), 0) / 3,
    points.reduce((sum, point) => sum + (point?.[2] ?? 0), 0) / 3,
  ];
  const direction: Vec3 = [-face.normal[0], -face.normal[1], -face.normal[2]];
  let current = start;
  let layers = 1;
  while (layers <= tets.length) {
    const tet = tets[current];
    let exitCorner = -1;
    let exitAt = Infinity;
    for (let opposite = 0; opposite < 4 && tet !== undefined; opposite += 1) {
      const candidate = outwardFace(tet, opposite);
      const cosine = candidate === null ? 0 : dot(direction, candidate.normal);
      if (candidate === null || cosine <= EXIT_COSINE) continue;
      const at = dot(sub(candidate.vertex, origin), candidate.normal) / cosine;
      if (at < exitAt) {
        exitAt = at;
        exitCorner = opposite;
      }
    }
    const next = exitCorner < 0 ? -1 : (neighbours[current * 4 + exitCorner] ?? -1);
    if (next < 0) return layers;
    current = next;
    layers += 1;
  }
  return layers;
}

/** The measured entry of one part and order, or null when no boundary face could be cast. */
function measure(entityId: string, order: PartEntry['order'], tets: readonly Tet[]): PartEntry | null {
  const neighbours = adjacency(tets);
  const boundary: { readonly tet: number; readonly corner: number; readonly hash: number }[] = [];
  tets.forEach((tet, index) => {
    for (let corner = 0; corner < 4; corner += 1)
      if (neighbours[index * 4 + corner] === -1) boundary.push({ tet: index, corner, hash: faceHash(tet, corner) });
  });
  const chosen =
    boundary.length <= SAMPLE_FACES
      ? boundary
      : [...boundary]
          .sort((left, right) => left.hash - right.hash || left.tet - right.tet || left.corner - right.corner)
          .slice(0, SAMPLE_FACES);
  const layers = chosen
    .map((face) => layersThrough(tets, neighbours, face.tet, face.corner))
    .filter((count): count is number => count !== null)
    .sort((left, right) => left - right);
  if (layers.length === 0) return null;
  const elementsThrough = layers[Math.max(0, Math.ceil(PERCENTILE * layers.length) - 1)] ?? 0;
  const required = order === 'linear' ? LINEAR_LAYERS_REQUIRED : QUADRATIC_LAYERS_REQUIRED;
  const minimumLayers = layers[0] ?? 0;
  return {
    entityId,
    order,
    elementsThrough,
    minimumLayers,
    required,
    samples: layers.length,
    verdict: verdictOf(elementsThrough, minimumLayers, required),
  };
}

/**
 * Through-thickness adequacy of every solid part of the mesh, per element order.
 * @invariant deterministic (no randomness; samples chosen by a hash of the face nodes; ties broken by element order); cost O(E) to index the
 *   elements plus O(S x L) for S <= 400 sampled boundary faces per part and order and L the layers a ray crosses; `elementsThrough` is the 5th
 *   percentile of the layers crossed (a thin wall governs); the verdict is the worst over parts; parts without tetrahedra, or with tetrahedra
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
    .sort((left, right) =>
      left.entityId === right.entityId ? left.order.localeCompare(right.order) : left.entityId < right.entityId ? -1 : 1,
    )
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
        `part '${part.entityId}': ${part.elementsThrough} element layer(s) through the wall (5th percentile of ${part.samples} sampled boundary faces, thinnest spot ${part.minimumLayers}; ${part.order === 'linear' ? 'C3D4' : 'C3D10'} needs ${part.required})`,
    );
}

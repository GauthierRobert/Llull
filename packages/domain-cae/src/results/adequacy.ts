/**
 * Mesh adequacy (05 §5.5, VC-FEA-09; 10 result-integrity TR-INT-07): are there enough tetrahedron layers through the wall of every solid part for the
 * element order to resolve bending? Measured on the actual mesh: rays are cast from sampled boundary faces along the inward normal through the
 * tetrahedra; the element layers are the hit distance over the local element size. A thin wall of a large part (a tube, an L-bracket) reads thin; the bounding box never enters.
 */

import type { FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { FeMeshAdequacy } from '@core/model/meshAdequacy';
import { CORNERS, buildAdjacency, castRay, faceGeometry, faceHash, type Corner, type Ray } from './adequacyRay';

type Verdict = FeMeshAdequacy['parts'][number]['verdict'];
type PartEntry = FeMeshAdequacy['parts'][number];

/**
 * Element layers required through the wall of a linear tetrahedron (C3D4), on the scale of hex-equivalent layers (hit distance over the local
 * element size). Target value of TR-INT-07 (10-result-integrity), pending the measured convergence study of VNV-M3 / VC-INT-12.
 */
export const LINEAR_LAYERS_REQUIRED = 4;
/** Element layers required through the wall of a quadratic tetrahedron (C3D10). Target value of TR-INT-07, pending the VNV-M3 convergence study. */
export const QUADRATIC_LAYERS_REQUIRED = 2;
/** A part with at most this many boundary faces is measured on every face. */
const ALL_FACES = 2000;
/** Above it: boundary faces are bucketed by position (a GRID^3 grid over the boundary) and area class, and this many (smallest hash) are taken per bucket. */
const PER_BUCKET = 3;
const GRID = 8;
const AREA_CLASSES = 6;
/** Fraction of the surface area allowed to read thinner (the 5th percentile governs, so a thin wall is not averaged away). */
const PERCENTILE = 0.05;
/** Relative slack on the budget comparison, so a structured mesh exactly at the budget (4.0000000001 or 3.9999999999 layers) is not decided by rounding. */
const BUDGET_TOLERANCE = 1e-6;
/** A thinnest sampled spot under this fraction of the budget makes the part inadequate whatever the percentile says (a thin rib on a fine mesh is not averaged away). */
const FLOOR_FRACTION = 0.5;
/** A thinnest spot between FLOOR_FRACTION and this fraction of the budget makes a result that meets it `marginal` (a warning, not a gate). */
const MARGINAL_FRACTION = 0.75;
/** Verified mesh hashes remembered at once (a hash hit saves re-measuring a mesh reloaded from the artifact store). */
const HASH_CACHE = 8;

const WORST: Readonly<Record<FeMeshAdequacy['verdict'], number>> = { adequate: 0, marginal: 1, inadequate: 2, unmeasured: 3 };

/**
 * Verdict of a measured layer count: `inadequate` when the 5th percentile is below the budget or the thinnest sampled spot is under half of it;
 * `marginal` when the thinnest spot is under 75 % of it; `adequate` otherwise.
 */
function verdictOf(typical: number, thinnest: number, required: number): Verdict {
  if (typical < required * (1 - BUDGET_TOLERANCE) || thinnest < required * FLOOR_FRACTION) return 'inadequate';
  return thinnest < required * MARGINAL_FRACTION ? 'marginal' : 'adequate';
}

interface BoundaryFace {
  readonly tet: number;
  readonly corner: Corner;
  readonly hash: number;
  readonly area: number;
  readonly bucket: number;
}

/** The faces to cast from, each with the surface area it stands for: every face of a small boundary, else the `PER_BUCKET` smallest-hash faces of each (position, area class) bucket. */
function sampleFaces(faces: BoundaryFace[]): { readonly face: BoundaryFace; readonly weight: number }[] {
  if (faces.length <= ALL_FACES) return faces.map((face) => ({ face, weight: face.area }));
  const buckets = new Map<number, BoundaryFace[]>();
  for (const face of faces) {
    const members = buckets.get(face.bucket);
    if (members === undefined) buckets.set(face.bucket, [face]);
    else members.push(face);
  }
  return [...buckets.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([, members]) => {
      const chosen = members.sort((left, right) => left.hash - right.hash).slice(0, PER_BUCKET);
      const weight = members.reduce((sum, face) => sum + face.area, 0) / chosen.length;
      return chosen.map((face) => ({ face, weight }));
    });
}

/** The boundary faces of the tetrahedra with their position / area bucket. */
function boundaryFaces(xyz: Float64Array, nodes: Int32Array, neighbours: Int32Array): BoundaryFace[] {
  const raw: { tet: number; corner: Corner; area: number; centroid: readonly number[] }[] = [];
  for (let tet = 0; tet < nodes.length / 4; tet += 1)
    for (const corner of CORNERS)
      if (neighbours[tet * 4 + corner] === -1) raw.push({ tet, corner, ...faceGeometry(xyz, nodes, tet, corner) });
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  let smallest = Infinity;
  for (const face of raw) {
    face.centroid.forEach((value, axis) => {
      lo[axis] = Math.min(lo[axis] as number, value);
      hi[axis] = Math.max(hi[axis] as number, value);
    });
    if (face.area > 0) smallest = Math.min(smallest, face.area);
  }
  const cell = (value: number, axis: number): number => {
    const extent = (hi[axis] as number) - (lo[axis] as number);
    return extent > 0 ? Math.min(GRID - 1, Math.floor((GRID * (value - (lo[axis] as number))) / extent)) : 0;
  };
  return raw.map((face) => {
    const [cx, cy, cz] = face.centroid.map(cell) as [number, number, number];
    const areaClass = face.area > 0 ? Math.min(AREA_CLASSES - 1, Math.floor(Math.log2(face.area / smallest))) : 0;
    return {
      tet: face.tet,
      corner: face.corner,
      area: face.area,
      hash: faceHash(nodes, face.tet, face.corner),
      bucket: ((cx * GRID + cy) * GRID + cz) * AREA_CLASSES + areaClass,
    };
  });
}

/** The measured entry of one part and order, or null when no boundary face could be cast. */
function measure(entityId: string, order: PartEntry['order'], xyz: Float64Array, nodes: Int32Array): PartEntry | null {
  const neighbours = buildAdjacency(nodes);
  const rays = sampleFaces(boundaryFaces(xyz, nodes, neighbours))
    .flatMap(({ face, weight }) => {
      const ray = castRay(xyz, nodes, neighbours, face.tet, face.corner);
      return ray === null ? [] : [{ ray, weight }];
    })
    .sort((left, right) => left.ray.layers - right.ray.layers || left.ray.tets - right.ray.tets);
  const thinnest = rays[0]?.ray;
  if (thinnest === undefined) return null;
  const target = PERCENTILE * rays.reduce((sum, entry) => sum + entry.weight, 0) * (1 - 1e-12);
  let cumulative = 0;
  let governing: Ray = thinnest;
  for (const entry of rays) {
    governing = entry.ray;
    cumulative += entry.weight;
    if (cumulative >= target) break;
  }
  const required = order === 'linear' ? LINEAR_LAYERS_REQUIRED : QUADRATIC_LAYERS_REQUIRED;
  return {
    entityId,
    order,
    elementsThrough: governing.layers,
    minimumLayers: thinnest.layers,
    tetsCrossed: governing.tets,
    required,
    samples: rays.length,
    verdict: verdictOf(governing.layers, thinnest.layers, required),
  };
}

function measureMesh(mesh: FeMeshArtifact): FeMeshAdequacy {
  const index = new Map<number, number>();
  const xyz = new Float64Array(mesh.nodes.length * 3);
  mesh.nodes.forEach((node, at) => {
    index.set(node[0], at);
    xyz.set([node[1], node[2], node[3]], at * 3);
  });
  const groups = new Map<string, { entityId: string; order: PartEntry['order']; nodes: number[] }>();
  const entities = new Set<string>();
  for (const block of mesh.blocks) {
    entities.add(block.entityId);
    if (block.type !== 'C3D4' && block.type !== 'C3D10') continue;
    const order: PartEntry['order'] = block.type === 'C3D4' ? 'linear' : 'quadratic';
    const key = `${block.entityId}|${order}`;
    const group = groups.get(key) ?? { entityId: block.entityId, order, nodes: [] };
    for (const element of block.elements) {
      const corners = [1, 2, 3, 4].map((at) => index.get(element[at] as number));
      if (element.length < 5 || corners.some((corner) => corner === undefined)) continue;
      for (const corner of corners) group.nodes.push(corner as number);
    }
    groups.set(key, group);
  }
  const parts = [...groups.values()]
    .sort((left, right) => (`${left.entityId}|${left.order}` < `${right.entityId}|${right.order}` ? -1 : 1))
    .flatMap((group) => measure(group.entityId, group.order, xyz, Int32Array.from(group.nodes)) ?? []);
  const measured = new Set(parts.map((part) => part.entityId));
  const verdict = parts.reduce<FeMeshAdequacy['verdict']>(
    (worst, part) => (WORST[part.verdict] > WORST[worst] ? part.verdict : worst),
    'adequate',
  );
  return { verdict, parts, unmeasuredParts: [...entities].filter((entityId) => !measured.has(entityId)).sort() };
}

const byObject = new WeakMap<FeMeshArtifact, FeMeshAdequacy>();
const byHash = new Map<string, FeMeshAdequacy>();

/**
 * Through-thickness adequacy of every solid part of the mesh, per element order.
 * @invariant deterministic (no randomness; samples chosen by a hash of the face nodes; ties keep the element order); memoized by the mesh object;
 *   cost O(E) to index the elements and the face adjacency (typed arrays, no per-face strings) plus O(S x L) for S sampled boundary faces and L the
 *   layers a ray crosses (all faces of a boundary up to 2,000 faces, else 3 per position x area bucket); `elementsThrough` is the area-weighted 5th
 *   percentile of the element layers (hit distance over h = (6 x mean volume of the crossed tets)^(1/3): a Kuhn cell of side s reads s; a thin wall
 *   governs, and the thinnest dimension of a slender section governs by design); a part is `inadequate` below the budget at the 5th percentile or when
 *   the thinnest sampled spot is under half of it, `marginal` under 75 % of it; the verdict is the worst over parts; parts without tetrahedra, or with
 *   tetrahedra referencing a missing node left out of the count, are listed in `unmeasuredParts` and never counted as inadequate
 */
export function meshAdequacy(mesh: FeMeshArtifact): FeMeshAdequacy {
  const known = byObject.get(mesh);
  if (known !== undefined) return known;
  const measured = measureMesh(mesh);
  byObject.set(mesh, measured);
  return measured;
}

/** True when results on this adequacy must not be assessed without `acceptInadequateMesh` (inadequate, or not measurable). */
export const blocksAssessment = (adequacy: FeMeshAdequacy): boolean =>
  adequacy.verdict === 'inadequate' || adequacy.verdict === 'unmeasured';

/**
 * The adequacy that gates the results assessed on `mesh`: ALWAYS measured on the mesh, never read from `results.adequacy` (that record is display
 * only: a forged or stale verdict gates nothing). No mesh artifact (imported results) is `unmeasured`, which gates like `inadequate`.
 * @invariant memoized by the mesh object, and by the verified mesh hash `results.meshHash` (with the node and element counts) over the last 8 meshes
 */
export function adequacyOf(results: FeResultsArtifact, mesh: FeMeshArtifact | null): FeMeshAdequacy {
  if (mesh === null) return { verdict: 'unmeasured', parts: [], unmeasuredParts: [] };
  const known = byObject.get(mesh);
  if (known !== undefined) return known;
  const elements = mesh.blocks.reduce((sum, block) => sum + block.elements.length, 0);
  const key = results.meshHash === '' ? '' : `${results.meshHash}|${mesh.nodes.length}|${elements}`;
  const cached = key === '' ? undefined : byHash.get(key);
  if (cached !== undefined) {
    byObject.set(mesh, cached);
    return cached;
  }
  const measured = meshAdequacy(mesh);
  if (key !== '') {
    byHash.set(key, measured);
    if (byHash.size > HASH_CACHE) byHash.delete(byHash.keys().next().value as string);
  }
  return measured;
}

/** One account per part that is not adequate, e.g. `part 'bx-1': 2 element layer(s) through the wall ... (C3D4 needs 4)`; empty when adequate. */
export function inadequacyReasons(adequacy: FeMeshAdequacy): string[] {
  if (adequacy.verdict === 'unmeasured')
    return ['the mesh artifact is not available, so the element layers through the walls could not be measured'];
  return adequacy.parts
    .filter((part) => part.verdict !== 'adequate')
    .map(
      (part) =>
        `part '${part.entityId}': ${Number(part.elementsThrough.toFixed(2))} element layer(s) through the wall (5th percentile of ${part.samples} sampled boundary faces, thinnest spot ${Number(part.minimumLayers.toFixed(2))}; ${part.order === 'linear' ? 'C3D4' : 'C3D10'} needs ${part.required})`,
    );
}

/**
 * Beam lattice of an implicit body for export_3mf (05 IMP 6.1, FR-IMP-51): the strut or graph lattice behind the body as nodes and frusta in world coordinates, with
 * the region mesh as the clipping mesh. A body whose field is anything else (TPMS, booleans...) has no beam form and stays a mesh.
 * @invariant the clipping mesh of a region is meshed by dual contouring on at most 32 cells along the longest side (sharp box edges stay exact; the clip needs no body-resolution detail)
 * @invariant the beams are the periodic images of the cell's beams whose axes enter the region (an end strictly inside, or a sample on or inside it along the beam); a beam that only touches the region at an end is not exported; consumers trim the others with the clipping mesh (clipping mode inside)
 */

import type { ExecutionContext } from '@core/commands/types';
import { resolveFieldEngine } from '@core/geometry/field/engine';
import type { FieldEngine } from '@core/geometry/field/engineTypes';
import type { BeamLatticeAnswer, LatticeBeam } from '@core/model/beamLattice';
import type { CadDocument, MeshData, Vec3 } from '@core/model/types';
import { applyEulerXYZ } from '@lib/eulerRotation';
import { compileField, compileScalarField } from './compile';
import { graphGeometry } from './graph';
import { type GraphNode, type StrutsNode, type VoronoiNode, bodyOf, fieldOf, type Law } from './model';
import { voronoiGeometry } from './voronoi';
import { bodyGrid } from './realise';
import { strutGeometry } from './struts';

const MAX_BEAMS = 200_000;
/** The clipping mesh is cut from the region at most this many cells along its longest side (a body voxel of 0.05 over 20 mm would be 400 and write megabytes of coplanar triangles). */
const CLIP_CELLS = 32;
const SAMPLES_PER_BEAM = 9;

const key = (p: Vec3): string => p.map((c) => Math.round(c * 1e7)).join(',');

/** Box (12 triangles, outward) as a clipping mesh. */
function boxMesh(min: Vec3, max: Vec3): MeshData {
  const positions: number[] = [];
  for (const z of [min[2], max[2]]) for (const y of [min[1], max[1]]) for (const x of [min[0], max[0]]) positions.push(x, y, z);
  const indices = [0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5];
  return { positions, indices };
}

interface Graph {
  readonly nodes: Vec3[];
  readonly beams: Array<{ a: number; b: number; ra: number; rb: number }>;
}

function strutBeams(node: StrutsNode, box: { min: Vec3; max: Vec3 }): Graph | string {
  const { set } = strutGeometry(node.cell, node.cellSize, 1, undefined);
  const corners = [box.min[0], box.max[0]].flatMap((x) =>
    [box.min[1], box.max[1]].flatMap((y) => [box.min[2], box.max[2]].map((z): Vec3 => [x, y, z])),
  );
  const local = corners.map((p) => {
    const d: Vec3 = [p[0] - node.origin[0], p[1] - node.origin[1], p[2] - node.origin[2]];
    return inverseRotate(d, node.rotation);
  });
  const range = [0, 1, 2].map((axis) => {
    const values = local.map((p) => p[axis] as number);
    const cell = node.cellSize[axis] as number;
    return [Math.floor(Math.min(...values) / cell) - 1, Math.ceil(Math.max(...values) / cell) + 1] as const;
  });
  const cells = range.reduce((product, [lo, hi]) => product * (hi - lo + 1), 1);
  if (cells * set.beams.length > MAX_BEAMS)
    return `${cells * set.beams.length} beams exceed the beam-lattice limit of ${MAX_BEAMS}: it stays a mesh`;
  const nodes: Vec3[] = [];
  const index = new Map<string, number>();
  const at = (p: Vec3): number => {
    const k = key(p);
    const known = index.get(k);
    if (known !== undefined) return known;
    nodes.push(p);
    index.set(k, nodes.length - 1);
    return nodes.length - 1;
  };
  const seen = new Set<string>();
  const beams: Graph['beams'] = [];
  const world = (p: Vec3): Vec3 => {
    const r = applyEulerXYZ(p, [0, 0, 0], node.rotation);
    return [r[0] + node.origin[0], r[1] + node.origin[1], r[2] + node.origin[2]];
  };
  const [rx, ry, rz] = range as [readonly [number, number], readonly [number, number], readonly [number, number]];
  for (let i = rx[0]; i <= rx[1]; i += 1)
    for (let j = ry[0]; j <= ry[1]; j += 1)
      for (let k = rz[0]; k <= rz[1]; k += 1) {
        const shift: Vec3 = [i * node.cellSize[0], j * node.cellSize[1], k * node.cellSize[2]];
        for (const beam of set.beams) {
          const [a, b] = [set.nodes[beam.a] as Vec3, set.nodes[beam.b] as Vec3];
          const [pa, pb] = [
            world([a[0] + shift[0], a[1] + shift[1], a[2] + shift[2]]),
            world([b[0] + shift[0], b[1] + shift[1], b[2] + shift[2]]),
          ];
          const [ka, kb] = [key(pa), key(pb)];
          const pair = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
          if (ka === kb || seen.has(pair)) continue;
          seen.add(pair);
          beams.push({ a: at(pa), b: at(pb), ra: 0, rb: 0 });
        }
      }
  return { nodes, beams };
}

/** Rotation by the inverse of the Euler XYZ rotation `euler` (about the origin). */
function inverseRotate(p: Vec3, euler: Vec3): Vec3 {
  const columns = [
    applyEulerXYZ([1, 0, 0], [0, 0, 0], euler),
    applyEulerXYZ([0, 1, 0], [0, 0, 0], euler),
    applyEulerXYZ([0, 0, 1], [0, 0, 0], euler),
  ];
  return columns.map((c) => c[0] * p[0] + c[1] * p[1] + c[2] * p[2]) as unknown as Vec3;
}

function lawValues(engine: FieldEngine, doc: CadDocument, law: Law, points: readonly Vec3[]): number[] | string {
  if (typeof law === 'number') return points.map(() => law);
  const compiled = compileScalarField(doc, law);
  if (!compiled.ok) return compiled.message;
  const answer = engine.evaluate(compiled.program, Float64Array.from(points.flat()), false);
  if (answer.failure !== undefined) return answer.failure.message;
  return Array.from(answer.values, (v) => Math.max(0, v));
}

/** How the region cuts a periodic strut lattice: beams with one end strictly inside and the other strictly outside (dangling, trimmed by the region), wholly inside (ends on the boundary count as inside), and the rest. */
export function latticeCut(
  doc: CadDocument,
  node: StrutsNode,
  engine: FieldEngine,
): { readonly dangling: number; readonly inside: number; readonly outside: number } | string {
  if (node.region === undefined) return 'the lattice has no region';
  const region = compileField(doc, node.region);
  if (!region.ok) return region.message;
  if (region.program.bounds === null) return 'the region has no finite support';
  const built = strutBeams(node, region.program.bounds);
  if (typeof built === 'string') return built;
  const evaluated = engine.evaluate(region.program, Float64Array.from(built.nodes.flat()), false);
  if (evaluated.failure !== undefined) return evaluated.failure.message;
  const values = evaluated.values;
  const eps = 1e-9 * Math.max(1, ...node.cellSize);
  let dangling = 0;
  let inside = 0;
  let outside = 0;
  for (const beam of built.beams) {
    const [va, vb] = [values[beam.a] as number, values[beam.b] as number];
    if (va <= eps && vb <= eps) inside += 1;
    else if ((va < -eps && vb > eps) || (vb < -eps && va > eps)) dangling += 1;
    else outside += 1;
  }
  return { dangling, inside, outside };
}

/** Provider for the plugin hook `beamLattice`. */
export function beamLatticeOf(doc: CadDocument, entityId: string, ctx: ExecutionContext | undefined): BeamLatticeAnswer {
  const body = bodyOf(doc, entityId);
  if (body === undefined) return null;
  const root = fieldOf(doc, body.field);
  if (root === undefined || (root.op !== 'struts' && root.op !== 'graph' && root.op !== 'voronoi'))
    return `field ${body.field} is ${root === undefined ? 'missing' : `a ${root.op} node`}, not a strut or graph lattice`;
  const engine = resolveFieldEngine(ctx?.fieldEngine);
  const regionId = root.region;
  const region = regionId === undefined ? null : compileField(doc, regionId);
  if (region !== null && !region.ok) return region.message;
  const clipBox = region !== null && region.ok && region.program.bounds !== null ? region.program.bounds : body.bounds;
  let graph: Graph;
  let defaultRadius: number;
  let caps: LatticeBeam['cap1'] = 'sphere';
  let nodeRadius: number | null = null;
  if (root.op === 'struts') {
    const built = strutBeams(root, clipBox);
    if (typeof built === 'string') return built;
    graph = built;
    const radii = lawValues(engine, doc, root.radius, graph.nodes);
    if (typeof radii === 'string') return radii;
    graph.beams.forEach((beam) => {
      beam.ra = radii[beam.a] as number;
      beam.rb = radii[beam.b] as number;
    });
    defaultRadius = radii.reduce((largest, radius) => Math.max(largest, radius), 0);
    nodeRadius = typeof root.radius === 'number' && root.nodeRadius !== undefined && root.nodeRadius > root.radius ? root.nodeRadius : null;
  } else {
    const built = root.op === 'voronoi' ? voronoiGeometry(root as VoronoiNode) : graphGeometry(doc, root as GraphNode);
    if (!built.ok) return built.message;
    graph = {
      nodes: built.graph.set.nodes.map((n): Vec3 => [n[0], n[1], n[2]]),
      beams: built.graph.set.beams.map((beam) => ({ a: beam.a, b: beam.b, ra: beam.ra, rb: beam.rb })),
    };
    defaultRadius = built.graph.radiusMax;
    caps = root.cap;
  }
  const samples: Vec3[] = [];
  for (const beam of graph.beams) {
    const [a, b] = [graph.nodes[beam.a] as Vec3, graph.nodes[beam.b] as Vec3];
    for (let s = 0; s < SAMPLES_PER_BEAM; s += 1) {
      const t = s / (SAMPLES_PER_BEAM - 1);
      samples.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
  }
  const eps = 1e-9 + 1e-6 * body.voxel;
  const regionAnswer = region !== null && region.ok ? engine.evaluate(region.program, Float64Array.from(samples.flat()), false) : null;
  if (regionAnswer?.failure !== undefined) return regionAnswer.failure.message;
  const values =
    regionAnswer !== null
      ? regionAnswer.values
      : Float64Array.from(samples, (p) =>
          Math.max(
            ...[0, 1, 2].map((axis) =>
              Math.max((clipBox.min[axis] as number) - (p[axis] as number), (p[axis] as number) - (clipBox.max[axis] as number)),
            ),
          ),
        );
  const kept = graph.beams.filter((_, index) => {
    for (let s = 0; s < SAMPLES_PER_BEAM; s += 1) {
      const value = values[index * SAMPLES_PER_BEAM + s] as number;
      const end = s === 0 || s === SAMPLES_PER_BEAM - 1;
      if (value < -eps || (!end && value <= eps)) return true;
    }
    return false;
  });
  if (kept.length === 0) return 'no beam reaches the region';
  const used = [...new Set(kept.flatMap((beam) => [beam.a, beam.b]))].sort((x, y) => x - y);
  const renumber = new Map(used.map((old, index) => [old, index]));
  let clip: MeshData | null;
  if (region !== null && region.ok) {
    const longest = Math.max(...[0, 1, 2].map((axis) => (clipBox.max[axis] as number) - (clipBox.min[axis] as number)));
    const meshed = engine.mesh(region.program, bodyGrid(clipBox, Math.max(body.voxel, longest / CLIP_CELLS)), {
      mesher: 'dual_contouring',
      maxTriangles: engine.limits.maxTriangles,
    });
    if (!meshed.ok) return `the clipping region cannot be meshed (${meshed.message})`;
    clip = meshed.mesh;
  } else clip = boxMesh(clipBox.min, clipBox.max);
  return {
    nodes: used.map((old) => graph.nodes[old] as Vec3),
    beams: kept.map((beam) => ({
      a: renumber.get(beam.a) as number,
      b: renumber.get(beam.b) as number,
      r1: beam.ra,
      r2: beam.rb,
      cap1: caps,
      cap2: caps,
    })),
    radius: defaultRadius,
    nodeRadius,
    clip,
    representation: null,
    dropped: graph.beams.length - kept.length,
  };
}

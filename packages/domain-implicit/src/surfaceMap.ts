/**
 * Surface-UV cell map (05 IMP 5.6, 14.13): the cells of a lattice follow the (u, v) of a `nurbs_surface` sheet and the signed distance along its normal. The sheet is
 * tessellated, every node of a grid around it takes the (u, v) interpolated at its closest point on the triangles and the signed distance to that point, and the
 * three grids travel in the program as `sample_field` operands (trilinear, bit-identical on both engines): no new tape op.
 * @invariant a cell coordinate is u * cellsU, v * cellsV (u, v normalised to [0, 1] over the patch) and distance / depth: whole cells are integer coordinates, the lattice is
 *   continuous across them, and a mapped field is NOT a distance (quality approximate)
 * @invariant the grids hold finite values everywhere; a node farther than `depth * (layers + 1)` from the sheet takes the constants of that distance (it lies outside the layers)
 * @failure no such entity -> IMP_ENTITY_NOT_FOUND; not a nurbs_surface -> IMP_PARAM_RANGE; a degenerate patch (zero-area triangles or a collapsed (u, v) parameterisation) -> IMP_MAP_SINGULAR;
 *   a grid above MAX_NODES -> IMP_MAP_TOO_LARGE
 */

import { placedSurface, tessellateSheet } from '@core/geometry/nurbsSurface';
import type { GridSamples } from '@core/geometry/field/sampled';
import type { CadDocument, Vec3 } from '@core/model/types';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import type { SurfaceUvMap } from './model';

/** Nodes of one grid at most (three grids and their sources travel in the program and its job folder). */
const MAX_NODES = 600_000;
/** Grid spacing as a fraction of the cell depth. */
const NODES_PER_DEPTH = 4;
const DEGENERATE = 1e-12;

interface SurfaceMapData {
  readonly u: GridSamples;
  readonly v: GridSamples;
  readonly w: GridSamples;
  /** Phase per document length of the three cell coordinates (2 pi / mean cell size), the constants of the gradient normalisation. */
  readonly scales: readonly [number, number, number];
  /** Ratio of the longest to the shortest cell edge over the sheet (1 = undistorted cells). */
  readonly stretch: { readonly min: number; readonly max: number };
}

export type SurfaceMapResult =
  | { readonly ok: true; readonly data: SurfaceMapData }
  | {
      readonly ok: false;
      readonly code: 'IMP_ENTITY_NOT_FOUND' | 'IMP_PARAM_RANGE' | 'IMP_MAP_SINGULAR' | 'IMP_MAP_TOO_LARGE';
      readonly message: string;
      readonly ids: readonly string[];
    };

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Closest point of triangle (a, b, c) to p as barycentric weights of (b, c) (Ericson, Real-Time Collision Detection 5.1.5). */
function closestWeights(p: Vec3, a: Vec3, b: Vec3, c: Vec3): [number, number] {
  const [ab, ac, ap] = [sub(b, a), sub(c, a), sub(p, a)];
  const [d1, d2] = [dot(ab, ap), dot(ac, ap)];
  if (d1 <= 0 && d2 <= 0) return [0, 0];
  const bp = sub(p, b);
  const [d3, d4] = [dot(ab, bp), dot(ac, bp)];
  if (d3 >= 0 && d4 <= d3) return [1, 0];
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return [d1 / (d1 - d3), 0];
  const cp = sub(p, c);
  const [d5, d6] = [dot(ab, cp), dot(ac, cp)];
  if (d6 >= 0 && d5 <= d6) return [0, 1];
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return [0, d2 / (d2 - d6)];
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return [1 - w, w];
  }
  const denominator = 1 / (va + vb + vc);
  return [vb * denominator, vc * denominator];
}

const cache = new WeakMap<object, Map<string, SurfaceMapResult>>();

/** The grids of `map` on the sheet of `doc` (memoised per sheet entity and parameters: an edit of the sheet is a new entity object). */
export function surfaceMapOf(doc: CadDocument, map: SurfaceUvMap): SurfaceMapResult {
  const entity = Object.hasOwn(doc.entities, map.sheetId) ? doc.entities[map.sheetId] : undefined;
  if (entity === undefined)
    return { ok: false, code: 'IMP_ENTITY_NOT_FOUND', message: `no sheet '${map.sheetId}' for the surface_uv map`, ids: [map.sheetId] };
  if (entity.kind !== 'nurbs_surface')
    return {
      ok: false,
      code: 'IMP_PARAM_RANGE',
      message: `'${map.sheetId}' is a ${entity.kind}, a surface_uv map needs a nurbs_surface sheet`,
      ids: [map.sheetId],
    };
  const key = `${map.cellsU}|${map.cellsV}|${map.depth}|${map.layers}`;
  const known = cache.get(entity)?.get(key);
  if (known !== undefined) return known;
  const built = build(entity, map);
  const perEntity = cache.get(entity) ?? new Map<string, SurfaceMapResult>();
  perEntity.set(key, built);
  cache.set(entity, perEntity);
  return built;
}

function build(entity: Extract<CadDocument['entities'][string], { kind: 'nurbs_surface' }>, map: SurfaceUvMap): SurfaceMapResult {
  const singular = (message: string): SurfaceMapResult => ({ ok: false, code: 'IMP_MAP_SINGULAR', message, ids: [map.sheetId] });
  const mesh = tessellateSheet(placedSurface(entity), entity.trims, 8);
  const point = (i: number): Vec3 => [
    mesh.positions[3 * i] as number,
    mesh.positions[3 * i + 1] as number,
    mesh.positions[3 * i + 2] as number,
  ];
  const uvOf = (i: number): [number, number] => [mesh.uvs[2 * i] as number, mesh.uvs[2 * i + 1] as number];
  const range = [0, 1].map((axis) => {
    let [lo, hi] = [Infinity, -Infinity];
    for (let i = 0; i < mesh.uvs.length / 2; i += 1) {
      const value = uvOf(i)[axis] as number;
      lo = Math.min(lo, value);
      hi = Math.max(hi, value);
    }
    return { lo, hi };
  }) as [{ lo: number; hi: number }, { lo: number; hi: number }];
  if (!(range[0].hi > range[0].lo && range[1].hi > range[1].lo)) return singular(`the sheet '${map.sheetId}' has no extent in (u, v)`);
  const scaled = (i: number): [number, number] => [
    (((uvOf(i)[0] as number) - range[0].lo) / (range[0].hi - range[0].lo)) * map.cellsU,
    (((uvOf(i)[1] as number) - range[1].lo) / (range[1].hi - range[1].lo)) * map.cellsV,
  ];
  interface Triangle {
    readonly a: Vec3;
    readonly b: Vec3;
    readonly c: Vec3;
    readonly normal: Vec3;
    readonly uv: readonly [[number, number], [number, number], [number, number]];
  }
  const triangles: Triangle[] = [];
  const cellEdges: number[] = [];
  let degenerate = 0;
  const meanSum: [number, number] = [0, 0];
  let counted = 0;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const [ia, ib, ic] = [mesh.indices[t] as number, mesh.indices[t + 1] as number, mesh.indices[t + 2] as number];
    const [a, b, c] = [point(ia), point(ib), point(ic)];
    const raw = cross(sub(b, a), sub(c, a));
    const area2 = Math.hypot(...raw);
    const edge2 = Math.max(dot(sub(b, a), sub(b, a)), dot(sub(c, a), sub(c, a)), 1e-300);
    const [ua, ub, uc] = [scaled(ia), scaled(ib), scaled(ic)];
    const det = (ub[0] - ua[0]) * (uc[1] - ua[1]) - (uc[0] - ua[0]) * (ub[1] - ua[1]);
    if (!(area2 > DEGENERATE * edge2) || !(Math.abs(det) > 1e-18)) {
      degenerate += 1;
      continue;
    }
    triangles.push({ a, b, c, normal: [raw[0] / area2, raw[1] / area2, raw[2] / area2], uv: [ua, ub, uc] });
    // physical length of one cell along u and along v on this triangle
    const [e1, e2] = [sub(b, a), sub(c, a)];
    const [du1, dv1, du2, dv2] = [ub[0] - ua[0], ub[1] - ua[1], uc[0] - ua[0], uc[1] - ua[1]];
    const pu: Vec3 = [(e1[0] * dv2 - e2[0] * dv1) / det, (e1[1] * dv2 - e2[1] * dv1) / det, (e1[2] * dv2 - e2[2] * dv1) / det];
    const pv: Vec3 = [(e2[0] * du1 - e1[0] * du2) / det, (e2[1] * du1 - e1[1] * du2) / det, (e2[2] * du1 - e1[2] * du2) / det];
    const sizes = [Math.hypot(...pu), Math.hypot(...pv), map.depth];
    cellEdges.push(Math.max(...sizes) / Math.max(Math.min(...sizes), 1e-300));
    meanSum[0] += sizes[0] as number;
    meanSum[1] += sizes[1] as number;
    counted += 1;
  }
  if (triangles.length === 0 || degenerate > triangles.length)
    return singular(
      `the sheet '${map.sheetId}' is degenerate: ${degenerate} of ${degenerate + triangles.length} triangles have no area or no (u, v) extent`,
    );
  const meanU = meanSum[0] / counted;
  const meanV = meanSum[1] / counted;
  if (!(meanU > 0 && meanV > 0 && Number.isFinite(meanU + meanV))) return singular(`the sheet '${map.sheetId}' collapses in (u, v)`);

  const reach = map.depth * (map.layers + 1);
  const h = map.depth / NODES_PER_DEPTH;
  const low = [Infinity, Infinity, Infinity] as [number, number, number];
  const high = [-Infinity, -Infinity, -Infinity] as [number, number, number];
  for (let i = 0; i < mesh.positions.length / 3; i += 1)
    for (let axis = 0; axis < 3; axis += 1) {
      low[axis] = Math.min(low[axis] as number, point(i)[axis] as number);
      high[axis] = Math.max(high[axis] as number, point(i)[axis] as number);
    }
  const origin: Vec3 = [low[0] - reach, low[1] - reach, low[2] - reach];
  const nodes: [number, number, number] = [
    Math.ceil((high[0] + reach - origin[0]) / h) + 1,
    Math.ceil((high[1] + reach - origin[1]) / h) + 1,
    Math.ceil((high[2] + reach - origin[2]) / h) + 1,
  ];
  const total = nodes[0] * nodes[1] * nodes[2];
  if (!(total <= MAX_NODES))
    return {
      ok: false,
      code: 'IMP_MAP_TOO_LARGE',
      message: `the map grid of sheet '${map.sheetId}' needs ${total} nodes (spacing ${h}), the limit is ${MAX_NODES}: raise depth or use a smaller sheet`,
      ids: [map.sheetId],
    };
  const [uGrid, vGrid, wGrid] = [
    new Array<number>(total).fill(0),
    new Array<number>(total).fill(0),
    new Array<number>(total).fill(map.layers + 1),
  ];
  const best = new Array<number>(total).fill(Infinity);
  const at = (i: number, j: number, k: number): number => i + nodes[0] * (j + nodes[1] * k);
  for (const tri of triangles) {
    const lo = [0, 1, 2].map((axis) => Math.min(tri.a[axis] as number, tri.b[axis] as number, tri.c[axis] as number) - reach);
    const hi = [0, 1, 2].map((axis) => Math.max(tri.a[axis] as number, tri.b[axis] as number, tri.c[axis] as number) + reach);
    const first = lo.map((value, axis) => Math.max(0, Math.floor((value - (origin[axis] as number)) / h)));
    const last = hi.map((value, axis) => Math.min((nodes[axis] as number) - 1, Math.ceil((value - (origin[axis] as number)) / h)));
    for (let k = first[2] as number; k <= (last[2] as number); k += 1)
      for (let j = first[1] as number; j <= (last[1] as number); j += 1)
        for (let i = first[0] as number; i <= (last[0] as number); i += 1) {
          const p: Vec3 = [origin[0] + i * h, origin[1] + j * h, origin[2] + k * h];
          const [wb, wc] = closestWeights(p, tri.a, tri.b, tri.c);
          const wa = 1 - wb - wc;
          const q: Vec3 = [
            wa * tri.a[0] + wb * tri.b[0] + wc * tri.c[0],
            wa * tri.a[1] + wb * tri.b[1] + wc * tri.c[1],
            wa * tri.a[2] + wb * tri.b[2] + wc * tri.c[2],
          ];
          const offset = sub(p, q);
          const distance = Math.hypot(...offset);
          const id = at(i, j, k);
          if (!(distance < (best[id] as number)) || distance > reach) continue;
          best[id] = distance;
          const side = dot(offset, tri.normal);
          uGrid[id] = wa * tri.uv[0][0] + wb * tri.uv[1][0] + wc * tri.uv[2][0];
          vGrid[id] = wa * tri.uv[0][1] + wb * tri.uv[1][1] + wc * tri.uv[2][1];
          wGrid[id] = (side < 0 ? -distance : distance) / map.depth;
        }
  }
  const source = `surface_uv:${sha256Hex(canonicalJson({ surface: entity.surface, trims: entity.trims ?? null, position: entity.position, rotation: entity.rotation }))}:${mapKey(map)}`;
  const grid = (values: number[], tag: string): GridSamples => ({
    kind: 'grid',
    nodes,
    origin: [origin[0] - h / 2, origin[1] - h / 2, origin[2] - h / 2],
    voxel: h,
    values,
    source: `${source}:${tag}`,
  });
  const stretchMin = Math.min(...cellEdges);
  const stretchMax = Math.max(...cellEdges);
  return {
    ok: true,
    data: {
      u: grid(uGrid, 'u'),
      v: grid(vGrid, 'v'),
      w: grid(wGrid, 'w'),
      scales: [(2 * Math.PI) / meanU, (2 * Math.PI) / meanV, (2 * Math.PI) / map.depth],
      stretch: { min: stretchMin, max: stretchMax },
    },
  };
}

const mapKey = (map: SurfaceUvMap): string => `${map.cellsU}:${map.cellsV}:${map.depth}:${map.layers}`;

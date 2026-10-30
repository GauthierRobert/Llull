/**
 * Surface-UV cell map (05 IMP 5.6, 14.13): the cells of a lattice follow the (u, v) of a `nurbs_surface` sheet and the normal distance to it. The sheet is tessellated,
 * every node of a grid around it takes the (u, v) interpolated at its closest point on the triangles, the normal component of the offset to that point and the lateral
 * (in-plane) distance beyond the sheet edge (negative over the footprint), and the grids travel in the program as `sample_field` operands (trilinear, bit-identical on both engines): no new tape op.
 * @invariant a cell coordinate is u * cellsU, v * cellsV (u, v normalised to [0, 1] over the patch) and normal distance / depth: whole cells are integer coordinates, and a
 *   mapped field is NOT a distance (quality approximate); the lattice lives where 0 <= w <= layers and the lateral distance is negative (the footprint of the sheet)
 * @invariant a closed direction of the sheet (first pole row equal to the last) must hold whole cells (IMP_MAP_SEAM) and is carried as (cos, sin) of its phase, so the trilinear
 *   grids stay continuous across the seam; an open direction carries the linear coordinate
 * @invariant the grids hold finite values everywhere; a node farther than `depth * (layers + 1)` from the sheet holds w = layers + 1 and the lateral distance `reach` (outside the support)
 * @failure no such entity -> IMP_ENTITY_NOT_FOUND; not a nurbs_surface -> IMP_PARAM_RANGE; a degenerate patch (zero-area triangles or a collapsed (u, v) parameterisation) -> IMP_MAP_SINGULAR;
 *   fractional cells over a closed direction -> IMP_MAP_SEAM; a grid above MAX_NODES or more than MAX_WORK closest-point tests -> IMP_MAP_TOO_LARGE
 */

import { placedSurface, tessellateSheet } from '@core/geometry/nurbsSurface';
import type { GridSamples } from '@core/geometry/field/sampled';
import type { CadDocument, Vec3 } from '@core/model/types';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import type { SurfaceUvMap } from './model';

/** Nodes of one grid at most (the grids and their sources travel in the program and its job folder). */
const MAX_NODES = 600_000;
/** Closest-point tests of the build at most (about 0.3 microseconds each: some 6 seconds). */
const MAX_WORK = 20_000_000;
/** Grid spacing as a fraction of the cell depth. */
const NODES_PER_DEPTH = 4;
const DEGENERATE = 1e-12;
/** Version of the construction (grid placement, closest point rule, periodic carriage): part of the identity in the content hash. */
const VERSION = 'surface_uv/v2';

/** A cell coordinate as the program carries it: linear (open direction) or as (cos, sin) of 2 pi times the coordinate (closed direction). */
export type PhaseGrids =
  | { readonly kind: 'linear'; readonly grid: GridSamples }
  | { readonly kind: 'periodic'; readonly cos: GridSamples; readonly sin: GridSamples };

interface SurfaceMapData {
  readonly u: PhaseGrids;
  readonly v: PhaseGrids;
  /** Normal distance in cells of depth (positive on the side the normal points to). */
  readonly w: GridSamples;
  /** Signed lateral distance in document units: -spacing / 2 over the footprint of the sheet, the distance within its plane beyond its edge. */
  readonly lateral: GridSamples;
  /** Phase per document length of the three cell coordinates (2 pi / mean cell size), the constants of the gradient normalisation. */
  readonly scales: readonly [number, number, number];
  /** Ratio of the longest to the shortest cell edge over the sheet (1 = undistorted cells). */
  readonly stretch: { readonly min: number; readonly max: number };
  /** Largest ratio of a local cell edge to the mean one, or its inverse, over the sheet. */
  readonly variation: number;
  /** Box of the support: the sheet grown by `layers * depth`. */
  readonly bounds: { readonly min: Vec3; readonly max: Vec3 };
}

export type SurfaceMapResult =
  | { readonly ok: true; readonly data: SurfaceMapData }
  | {
      readonly ok: false;
      readonly code: 'IMP_ENTITY_NOT_FOUND' | 'IMP_PARAM_RANGE' | 'IMP_MAP_SINGULAR' | 'IMP_MAP_TOO_LARGE' | 'IMP_MAP_SEAM';
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

const mapKey = (map: SurfaceUvMap): string => `${map.cellsU}:${map.cellsV}:${map.depth}:${map.layers}`;

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
  const key = mapKey(map);
  const known = cache.get(entity)?.get(key);
  if (known !== undefined) return known;
  const built = build(entity, map);
  const perEntity = cache.get(entity) ?? new Map<string, SurfaceMapResult>();
  perEntity.set(key, built);
  cache.set(entity, perEntity);
  return built;
}

/** Whether the first and last pole rows (u) or the first and last pole of every row (v) coincide: the patch closes on itself in that direction. */
function closedDirections(poles: ReadonlyArray<ReadonlyArray<Vec3>>, tolerance: number): [boolean, boolean] {
  const near = (a: Vec3, b: Vec3): boolean => Math.hypot(...sub(a, b)) <= tolerance;
  const first = poles[0] ?? [];
  const last = poles[poles.length - 1] ?? [];
  const closedU = poles.length > 2 && first.every((p, j) => near(p, last[j] as Vec3));
  const closedV = poles.every((row) => row.length > 2 && near(row[0] as Vec3, row[row.length - 1] as Vec3));
  return [closedU, closedV];
}

function build(entity: Extract<CadDocument['entities'][string], { kind: 'nurbs_surface' }>, map: SurfaceUvMap): SurfaceMapResult {
  const singular = (message: string): SurfaceMapResult => ({ ok: false, code: 'IMP_MAP_SINGULAR', message, ids: [map.sheetId] });
  const placed = placedSurface(entity);
  const mesh = tessellateSheet(placed, entity.trims, 8);
  const point = (i: number): Vec3 => [
    mesh.positions[3 * i] as number,
    mesh.positions[3 * i + 1] as number,
    mesh.positions[3 * i + 2] as number,
  ];
  const uvOf = (i: number): [number, number] => [mesh.uvs[2 * i] as number, mesh.uvs[2 * i + 1] as number];
  const low = [Infinity, Infinity, Infinity] as [number, number, number];
  const high = [-Infinity, -Infinity, -Infinity] as [number, number, number];
  for (let i = 0; i < mesh.positions.length / 3; i += 1)
    for (let axis = 0; axis < 3; axis += 1) {
      low[axis] = Math.min(low[axis] as number, point(i)[axis] as number);
      high[axis] = Math.max(high[axis] as number, point(i)[axis] as number);
    }
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
  const diagonal = Math.hypot(high[0] - low[0], high[1] - low[1], high[2] - low[2]);
  const closed =
    entity.trims !== undefined && entity.trims.length > 0 ? [false, false] : closedDirections(placed.poles as Vec3[][], 1e-9 * diagonal);
  for (const [axis, cells] of [
    ['u', map.cellsU],
    ['v', map.cellsV],
  ] as const)
    if (closed[axis === 'u' ? 0 : 1] === true && !Number.isInteger(cells))
      return {
        ok: false,
        code: 'IMP_MAP_SEAM',
        message: `the sheet '${map.sheetId}' closes on itself in ${axis}: cells${axis.toUpperCase()} must be a whole number (got ${cells}), a fraction jumps at the seam`,
        ids: [map.sheetId],
      };
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
  const sizes: Array<[number, number]> = [];
  let degenerate = 0;
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
    const [e1, e2] = [sub(b, a), sub(c, a)];
    const [du1, dv1, du2, dv2] = [ub[0] - ua[0], ub[1] - ua[1], uc[0] - ua[0], uc[1] - ua[1]];
    const pu: Vec3 = [(e1[0] * dv2 - e2[0] * dv1) / det, (e1[1] * dv2 - e2[1] * dv1) / det, (e1[2] * dv2 - e2[2] * dv1) / det];
    const pv: Vec3 = [(e2[0] * du1 - e1[0] * du2) / det, (e2[1] * du1 - e1[1] * du2) / det, (e2[2] * du1 - e1[2] * du2) / det];
    sizes.push([Math.hypot(...pu), Math.hypot(...pv)]);
  }
  if (triangles.length === 0 || degenerate > triangles.length)
    return singular(
      `the sheet '${map.sheetId}' is degenerate: ${degenerate} of ${degenerate + triangles.length} triangles have no area or no (u, v) extent`,
    );
  const meanU = sizes.reduce((sum, s) => sum + s[0], 0) / sizes.length;
  const meanV = sizes.reduce((sum, s) => sum + s[1], 0) / sizes.length;
  if (!(meanU > 0 && meanV > 0 && Number.isFinite(meanU + meanV))) return singular(`the sheet '${map.sheetId}' collapses in (u, v)`);
  const aspects = sizes.map(([lu, lv]) => Math.max(lu, lv, map.depth) / Math.max(Math.min(lu, lv, map.depth), 1e-300));
  const variation = Math.max(
    ...sizes.flatMap(([lu, lv]) => [lu / meanU, meanU / Math.max(lu, 1e-300), lv / meanV, meanV / Math.max(lv, 1e-300)]),
  );

  const reach = map.depth * (map.layers + 1);
  const h = map.depth / NODES_PER_DEPTH;
  const origin: Vec3 = [low[0] - reach, low[1] - reach, low[2] - reach];
  const nodes: [number, number, number] = [
    Math.ceil((high[0] + reach - origin[0]) / h) + 1,
    Math.ceil((high[1] + reach - origin[1]) / h) + 1,
    Math.ceil((high[2] + reach - origin[2]) / h) + 1,
  ];
  const total = nodes[0] * nodes[1] * nodes[2];
  const tooLarge = (what: string): SurfaceMapResult => ({
    ok: false,
    code: 'IMP_MAP_TOO_LARGE',
    message: `the map of sheet '${map.sheetId}' needs ${what}: raise depth (the grid spacing is depth / ${NODES_PER_DEPTH}) or use a smaller sheet`,
    ids: [map.sheetId],
  });
  if (!(total <= MAX_NODES)) return tooLarge(`${total} grid nodes (limit ${MAX_NODES})`);
  const ranges = triangles.map((tri) => {
    const lo = [0, 1, 2].map((axis) => Math.min(tri.a[axis] as number, tri.b[axis] as number, tri.c[axis] as number) - reach);
    const hi = [0, 1, 2].map((axis) => Math.max(tri.a[axis] as number, tri.b[axis] as number, tri.c[axis] as number) + reach);
    return {
      first: lo.map((value, axis) => Math.max(0, Math.floor((value - (origin[axis] as number)) / h))),
      last: hi.map((value, axis) => Math.min((nodes[axis] as number) - 1, Math.ceil((value - (origin[axis] as number)) / h))),
    };
  });
  const work = ranges.reduce(
    (sum, r) => sum + [0, 1, 2].reduce((product, axis) => product * ((r.last[axis] as number) - (r.first[axis] as number) + 1), 1),
    0,
  );
  if (!(work <= MAX_WORK)) return tooLarge(`${work} closest-point tests (limit ${MAX_WORK})`);

  const [uGrid, vGrid] = [new Array<number>(total).fill(0), new Array<number>(total).fill(0)];
  const wGrid = new Array<number>(total).fill(map.layers + 1);
  const lateral = new Array<number>(total).fill(reach);
  const best = new Array<number>(total).fill(Infinity);
  const at = (i: number, j: number, k: number): number => i + nodes[0] * (j + nodes[1] * k);
  triangles.forEach((tri, index) => {
    const { first, last } = ranges[index] as (typeof ranges)[number];
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
          const normalPart = dot(offset, tri.normal);
          uGrid[id] = wa * tri.uv[0][0] + wb * tri.uv[1][0] + wc * tri.uv[2][0];
          vGrid[id] = wa * tri.uv[0][1] + wb * tri.uv[1][1] + wc * tri.uv[2][1];
          wGrid[id] = normalPart / map.depth;
          const tangential = Math.sqrt(Math.max(distance * distance - normalPart * normalPart, 0));
          lateral[id] = tangential > 1e-9 * reach ? tangential : -h / 2;
        }
  });
  const source = `${VERSION}:${sha256Hex(canonicalJson({ surface: entity.surface, trims: entity.trims ?? null, position: entity.position, rotation: entity.rotation }))}:${mapKey(map)}`;
  const grid = (values: number[], tag: string): GridSamples => ({
    kind: 'grid',
    nodes,
    origin: [origin[0] - h / 2, origin[1] - h / 2, origin[2] - h / 2],
    voxel: h,
    values,
    source: `${source}:${tag}`,
  });
  const phase = (values: number[], closedDirection: boolean, tag: string): PhaseGrids =>
    closedDirection
      ? {
          kind: 'periodic',
          cos: grid(
            values.map((x) => Math.cos(2 * Math.PI * x)),
            `${tag}cos`,
          ),
          sin: grid(
            values.map((x) => Math.sin(2 * Math.PI * x)),
            `${tag}sin`,
          ),
        }
      : { kind: 'linear', grid: grid(values, tag) };
  const grow = map.layers * map.depth;
  return {
    ok: true,
    data: {
      u: phase(uGrid, closed[0] === true, 'u'),
      v: phase(vGrid, closed[1] === true, 'v'),
      w: grid(wGrid, 'w'),
      lateral: grid(lateral, 'lateral'),
      scales: [(2 * Math.PI) / meanU, (2 * Math.PI) / meanV, (2 * Math.PI) / map.depth],
      stretch: { min: Math.min(...aspects), max: Math.max(...aspects) },
      variation,
      bounds: { min: [low[0] - grow, low[1] - grow, low[2] - grow], max: [high[0] + grow, high[1] + grow, high[2] + grow] },
    },
  };
}

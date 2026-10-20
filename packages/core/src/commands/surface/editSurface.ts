/** sew_surfaces (join patches along a shared edge) and thicken_surface (closed mesh solid from a sheet). */

import type { Entity, Vec3 } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { changed } from '../noop';
import { newEntity } from '../entity/newEntity';
import { replaceEntities, withEntity } from '../entity/entityOps';
import { nextId } from '../../lib/id';
import { distance3 } from '../../lib/vec3';
import { expandKnots } from '../../lib/nurbs/knotVector';
import { surfaceDomain } from '../../lib/nurbs/surface';
import { surfaceSample } from '../../lib/nurbs/surfaceCurvature';
import { commonBasis, reverseSurface, transposeSurface } from '../../lib/nurbs/surfaceEdit';
import type { NurbsSurfaceData } from '../../lib/nurbs/surfaceTypes';
import { gridParameters, placedSurface, surfacePoleExtent } from '../../geometry/nurbsSurface';
import { refuseSrf } from './shared';
import { sewIntoSolid } from './sewShell';
import { isRefusal, sig, surfaceEntityOf } from './surfaceShared';

type Side = 'u0' | 'u1' | 'v0' | 'v1';

/** `surface` oriented so that `side` becomes its last (`last` true: u1) or first (u0) pole row. */
function withSideAt(surface: NurbsSurfaceData, side: Side, last: boolean): NurbsSurfaceData {
  const swapped = side.startsWith('v') ? transposeSurface(surface) : surface;
  const atEnd = side.endsWith('1');
  return atEnd === last ? swapped : reverseSurface(swapped, 'u');
}

const SIDES: ReadonlyArray<Side> = ['u0', 'u1', 'v0', 'v1'];

/** Joins `a` (side sa becomes its last row) and `b` (side sb its first row) into one patch when the edge poles agree within `tolerance`. */
function mergeAlong(a: NurbsSurfaceData, b: NurbsSurfaceData, tolerance: number): { surface: NurbsSurfaceData; gap: number } | null {
  for (const candidate of [b, reverseSurface(b, 'v')]) {
    const common = commonBasis([a, candidate]);
    if (typeof common === 'string') continue;
    const [left, right] = common as [NurbsSurfaceData, NurbsSurfaceData];
    const lastRow = left.poles[left.poles.length - 1] as ReadonlyArray<Vec3>;
    const firstRow = right.poles[0] as ReadonlyArray<Vec3>;
    if (lastRow.length !== firstRow.length || left.degreeU !== right.degreeU) continue;
    const gap = Math.max(...lastRow.map((pole, j) => distance3(pole, firstRow[j] as Vec3)));
    if (gap > tolerance) continue;
    const p = left.degreeU;
    const fullA = expandKnots(left.knotsU, left.multiplicitiesU);
    const fullB = expandKnots(right.knotsU, right.multiplicitiesU).map((knot) => knot + 1);
    const full = [...fullA.slice(0, fullA.length - p - 1), ...new Array<number>(p).fill(1), ...fullB.slice(p + 1)];
    const knotsU = [...new Set(full)];
    const rational = left.weights !== undefined;
    return {
      gap,
      surface: {
        ...left,
        poles: [...left.poles, ...right.poles.slice(1)],
        ...(rational ? { weights: [...(left.weights as number[][]), ...(right.weights as number[][]).slice(1)] } : {}),
        knotsU,
        multiplicitiesU: knotsU.map((knot) => full.filter((value) => value === knot).length),
      },
    };
  }
  return null;
}

/**
 * @affects two sheets, makeSolid false: removes 2 nurbs_surface, creates 1 nurbs_surface (C0 crease); makeSolid true or 3+ sheets: removes the sheets, creates 1 closed mesh solid
 * @invariant the merged patch coincides with both inputs, only whole shared edges are joined; the solid is closed (0 free edges) and oriented outward
 * @failure unknown id / not a surface -> SRF_ENTITY_NOT_FOUND / SRF_NOT_SURFACE; no shared edge within tolerance -> SRF_SEW_NOT_MERGEABLE; free edges remaining -> SRF_SEW_FREE_EDGES; an edge shared by 3 sheets -> SRF_SEW_NONMANIFOLD
 */
export const sewSurfaces = defineCommand({
  name: 'sew_surfaces',
  description:
    'Sew nurbs_surface sheets together. (1) Exactly two sheets that share one whole boundary edge and `makeSolid` false (default): they become ' +
    'a single multi-span nurbs_surface; the edges must coincide within `tolerance` (document units), the sides, their orientation and the knot ' +
    'vectors are matched automatically, the joint is a C0 crease (check_continuity on the pair first if tangency matters). (2) `makeSolid` true, ' +
    'or three and more sheets: the sheets are meshed with identical boundary samples along shared edges and welded within `tolerance`; when the ' +
    'result has no free edge it becomes ONE closed, outward-oriented triangle-mesh solid (volume and mass_properties work; there is no exact B-rep, ' +
    'which needs the native kernel) and the summary / data give the volume. A single closed sheet (a sphere, a tube) can be sewn on its own ' +
    '(`ids` of 1 with makeSolid true) to close its seam. If free edges remain nothing changes and the refusal says how many and where: raise ' +
    '`tolerance`, or fill / blend the gap first. The inputs are removed and the result has position [0, 0, 0].',
  params: z.object({
    ids: z.array(z.string()).describe('2 or more nurbs_surface ids (1 only with makeSolid true).'),
    tolerance: z
      .number()
      .describe('Largest distance (document units) between matching edge poles / welded vertices. Default 1e-6 x the size of the surfaces.')
      .optional(),
    makeSolid: z
      .boolean()
      .describe('Sew into a closed mesh solid (default false for exactly two sheets; implied for three or more).')
      .optional(),
    resolution: z
      .number()
      .describe('Solid only: mesh resolution, integer 8..96 (grid lines per sheet direction and boundary samples across the longest extent). Curved sheets lose volume as it drops (a sphere is 1.6 % low at 24, 0.4 % at 48). Default 24.')
      .optional(),
  }),
  run: (doc, { ids, tolerance, makeSolid, resolution = 24 }): CommandResult => {
    if (new Set(ids).size !== ids.length || ids.length === 0 || ids.length > 64 || (ids.length === 1 && makeSolid !== true))
      return refuseSrf(doc, 'sew_surfaces', 'SRF_PARAM_INVALID', 'give 2..64 different surface ids (1 only with makeSolid true)', ids, [
        'params.ids',
      ]);
    if (!(Number.isInteger(resolution) && resolution >= 8 && resolution <= 96))
      return refuseSrf(doc, 'sew_surfaces', 'SRF_PARAM_INVALID', `resolution must be an integer in 8..96 (got ${resolution})`, ids, [
        'params.resolution',
      ]);
    if (ids.length > 2 || makeSolid === true) return sewIntoSolid(doc, ids, tolerance, resolution);
    const [first, second] = [
      surfaceEntityOf(doc, 'sew_surfaces', ids[0] as string),
      surfaceEntityOf(doc, 'sew_surfaces', ids[1] as string),
    ];
    if (isRefusal(first)) return first;
    if (isRefusal(second)) return second;
    if ((first.trims?.length ?? 0) > 0 || (second.trims?.length ?? 0) > 0)
      return refuseSrf(doc, 'sew_surfaces', 'SRF_TRIM_UNSUPPORTED', 'sheets trimmed by curves cannot be sewn', ids, ['params.ids']);
    const [a, b] = [placedSurface(first), placedSurface(second)];
    const size = Math.max(
      ...[surfacePoleExtent(a), surfacePoleExtent(b)].flatMap(({ min, max }) => [max[0] - min[0], max[1] - min[1], max[2] - min[2]]),
      1e-9,
    );
    const tol = tolerance ?? 1e-6 * size;
    if (!(tol > 0)) return refuseSrf(doc, 'sew_surfaces', 'SRF_PARAM_INVALID', 'tolerance must be > 0', ids, ['params.tolerance']);
    for (const sideA of SIDES)
      for (const sideB of SIDES) {
        const merged = mergeAlong(withSideAt(a, sideA, true), withSideAt(b, sideB, false), tol);
        if (merged === null) continue;
        const sewn = newEntity('nurbs_surface', nextId('surf'), { surface: merged.surface }, [0, 0, 0], first.color, {
          layerId: first.layerId,
        });
        return changed(
          replaceEntities(doc, [...ids], sewn),
          `sew_surfaces: joined "${ids[0]}" side ${sideA} to "${ids[1]}" side ${sideB} into "${sewn.id}" (edge gap ${sig(merged.gap)} ${doc.units}, C0 crease; ${merged.surface.poles.length} x ${merged.surface.poles[0]?.length ?? 0} poles).`,
          [sewn.id],
        );
      }
    return refuseSrf(
      doc,
      'sew_surfaces',
      'SRF_SEW_NOT_MERGEABLE',
      `no whole edge of "${ids[0]}" matches an edge of "${ids[1]}" within ${tol}`,
      ids,
      ['params.ids'],
    );
  },
});

/**
 * @affects creates 1 mesh entity (closed triangle mesh, no exact recipe); the sheet is kept
 * @invariant top and bottom faces are offset along the sheet normal, side walls close the boundary; outward-facing triangles
 * @failure unknown id / not a surface -> SRF_ENTITY_NOT_FOUND / SRF_NOT_SURFACE; thickness <= 0 -> SRF_PARAM_INVALID; offset reaching a centre of curvature -> SRF_THICKEN_SELF_INTERSECT; no usable normal -> SRF_THICKEN_FAILED
 */
export const thickenSurface = defineCommand({
  name: 'thicken_surface',
  description:
    'Make a solid from a nurbs_surface sheet by giving it thickness along its normal (S_u x S_v). `side` "normal" (default) offsets towards the ' +
    'normal, "reverse" against it, "both" half the thickness each way. The result is a closed triangle mesh solid (a tessellation with ' +
    '`quality` quads per knot span: volume and mass work, booleans work on the mesh, but it has no exact B-rep). Refused when the offset ' +
    'reaches a centre of curvature (thickness above the local radius). The sheet is kept; thicken then boolean / mass_properties.',
  params: z.object({
    id: z.string().describe('Id of a nurbs_surface entity.'),
    thickness: z.number().describe('Total thickness, document units, > 0.'),
    side: z.enum(['normal', 'reverse', 'both']).describe('Which side of the sheet gets the material. Default "normal".').optional(),
    quality: z.number().describe('Quads per knot span and direction of the tessellation, integer 2..24. Default 8.').optional(),
  }),
  run: (doc, { id, thickness, side = 'normal', quality = 8 }): CommandResult => {
    const entity = surfaceEntityOf(doc, 'thicken_surface', id);
    if (isRefusal(entity)) return entity;
    if (entity.trims !== undefined && entity.trims.length > 0)
      return refuseSrf(
        doc,
        'thicken_surface',
        'SRF_TRIM_UNSUPPORTED',
        'a sheet trimmed by curves cannot be thickened (it would use the whole underlying patch)',
        [id],
        ['params.id'],
      );
    const invalid = (message: string, path: string): CommandResult =>
      refuseSrf(doc, 'thicken_surface', 'SRF_PARAM_INVALID', message, [id], [`params.${path}`]);
    if (!(thickness > 0) || !Number.isFinite(thickness))
      return invalid(`thickness must be a finite number > 0 (got ${thickness})`, 'thickness');
    if (!(Number.isInteger(quality) && quality >= 2 && quality <= 24))
      return invalid(`quality must be an integer in 2..24 (got ${quality})`, 'quality');
    const surface = placedSurface(entity);
    const { us, vs } = gridParameters(surface, quality);
    const [out, back] = side === 'normal' ? [thickness, 0] : side === 'reverse' ? [0, thickness] : [thickness / 2, thickness / 2];
    const samples = us.flatMap((u) => vs.map((v) => surfaceSample(surface, u, v)));
    if (samples.every((s) => s.degenerate))
      return refuseSrf(doc, 'thicken_surface', 'SRF_THICKEN_FAILED', 'the sheet has no usable normal', [id], ['id']);
    // a degenerate sample (a pole) borrows the normal of the nearest usable one along the same row
    const normals: Vec3[] = samples.map((s, index) => {
      if (!s.degenerate) return s.normal;
      const row = Math.floor(index / vs.length) * vs.length;
      for (let step = 1; step < vs.length; step++)
        for (const j of [index - row + step, index - row - step]) {
          const near = samples[row + j];
          if (j >= 0 && j < vs.length && near !== undefined && !near.degenerate) return near.normal;
        }
      return (samples.find((candidate) => !candidate.degenerate) as { normal: Vec3 }).normal;
    });
    const reach = (factorSide: number, sign: 1 | -1): number | null => {
      let tightest: number | null = null;
      samples.forEach((s) => {
        if (s.degenerate || factorSide === 0) return;
        for (const k of [s.k1, s.k2]) {
          const shrink = 1 - sign * factorSide * k;
          if (shrink <= 1e-3) tightest = Math.min(tightest ?? Infinity, 1 / Math.abs(k));
        }
      });
      return tightest;
    };
    const blocked = reach(out, 1) ?? reach(back, -1);
    if (blocked !== null)
      return refuseSrf(
        doc,
        'thicken_surface',
        'SRF_THICKEN_SELF_INTERSECT',
        `the offset reaches a centre of curvature: radius of curvature ${sig(blocked)} ${doc.units} <= offset`,
        [id],
        ['params.thickness'],
      );
    const [countU, countV] = [us.length, vs.length];
    const positions: number[] = [];
    for (const [sign, distance] of [
      [1, out],
      [-1, back],
    ] as const)
      samples.forEach((s, index) => {
        const n = normals[index] as Vec3;
        positions.push(s.point[0] + sign * distance * n[0], s.point[1] + sign * distance * n[1], s.point[2] + sign * distance * n[2]);
      });
    const bottom = countU * countV;
    const indices: number[] = [];
    const at = (i: number, j: number): number => i * countV + j;
    // Seams (a sheet closed in u or v) and collapsed edges (poles) share their vertices and get no wall: otherwise the mesh has coincident fins.
    const eps = 1e-9 * Math.max(1, ...samples.map((s) => distance3(s.point, (samples[0] as { point: Vec3 }).point)));
    const coincide = (a: number, b: number): boolean =>
      distance3((samples[a] as { point: Vec3 }).point, (samples[b] as { point: Vec3 }).point) <= eps;
    const rowsU = Array.from({ length: countU }, (_, i) => i);
    const colsV = Array.from({ length: countV }, (_, j) => j);
    const closedU = colsV.every((j) => coincide(at(0, j), at(countU - 1, j)));
    const closedV = rowsU.every((i) => coincide(at(i, 0), at(i, countV - 1)));
    const alias = Array.from({ length: bottom }, (_, k) => k);
    if (closedU) for (const j of colsV) alias[at(countU - 1, j)] = at(0, j);
    if (closedV) for (const i of rowsU) alias[at(i, countV - 1)] = at(i, 0);
    const edges: number[][] = [
      colsV.map((j) => at(0, j)),
      colsV.map((j) => at(countU - 1, j)),
      rowsU.map((i) => at(i, 0)),
      rowsU.map((i) => at(i, countV - 1)),
    ];
    for (const edge of edges)
      if (edge.every((k) => coincide(k, edge[0] as number))) for (const k of edge) alias[k] = alias[edge[0] as number] as number;
    const canon = (k: number): number => {
      let current = k;
      while (alias[current] !== current) current = alias[current] as number;
      return current;
    };
    const push = (...triangle: number[]): void => {
      const corners = triangle.map((k) => (k >= bottom ? bottom + canon(k - bottom) : canon(k)));
      if (new Set(corners).size === 3) indices.push(...corners);
    };
    for (let i = 0; i + 1 < countU; i++)
      for (let j = 0; j + 1 < countV; j++) {
        const [p, q, r, s] = [at(i, j), at(i, j + 1), at(i + 1, j), at(i + 1, j + 1)];
        push(p, r, q);
        push(q, r, s);
        push(bottom + p, bottom + q, bottom + r);
        push(bottom + q, bottom + s, bottom + r);
      }
    const loop: Array<readonly [number, number]> = [];
    for (let j = 0; j < countV; j++) loop.push([0, j]);
    for (let i = 1; i < countU; i++) loop.push([i, countV - 1]);
    for (let j = countV - 2; j >= 0; j--) loop.push([countU - 1, j]);
    for (let i = countU - 2; i >= 1; i--) loop.push([i, 0]);
    loop.forEach(([i, j], k) => {
      const [ni, nj] = loop[(k + 1) % loop.length] as readonly [number, number];
      const onSeam = (closedU && i === ni && (i === 0 || i === countU - 1)) || (closedV && j === nj && (j === 0 || j === countV - 1));
      if (onSeam) return;
      const [top, next] = [at(i, j), at(ni, nj)];
      push(top, bottom + next, bottom + top);
      push(top, next, bottom + next);
    });
    const solid: Entity = newEntity('mesh', nextId('mesh'), { mesh: { positions, indices } }, [0, 0, 0], entity.color, {
      layerId: entity.layerId,
    });
    const [[u0, u1], [v0, v1]] = surfaceDomain(surface);
    return changed(
      withEntity(doc, solid),
      `thicken_surface: made closed mesh solid "${solid.id}" ${sig(thickness)} ${doc.units} thick (${side}) from "${id}" (u [${sig(u0)}, ${sig(u1)}], v [${sig(v0)}, ${sig(v1)}], ${indices.length / 3} triangles, tessellated, not an exact B-rep).`,
      [solid.id],
    );
  },
});

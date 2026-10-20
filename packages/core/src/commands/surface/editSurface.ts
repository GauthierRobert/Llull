/** trim_surface (parameter rectangle), sew_surfaces (join patches along a shared edge) and thicken_surface (closed mesh solid from a sheet). */

import type { Entity, NurbsSurfaceEntity, Vec3 } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { changed } from '../noop';
import { newEntity } from '../entity/newEntity';
import { replaceEntity, replaceEntities, withEntity } from '../entity/entityOps';
import { nextId } from '../../lib/id';
import { distance3 } from '../../lib/vec3';
import { expandKnots } from '../../lib/nurbs/knotVector';
import { surfaceDomain } from '../../lib/nurbs/surface';
import { surfaceSample } from '../../lib/nurbs/surfaceCurvature';
import { commonBasis, extractSubSurface, reverseSurface, transposeSurface } from '../../lib/nurbs/surfaceEdit';
import type { NurbsSurfaceData } from '../../lib/nurbs/surfaceTypes';
import { gridParameters, placedSurface, surfacePoleExtent } from '../../geometry/nurbsSurface';
import { refuseSrf } from './shared';
import { isRefusal, sig, surfaceEntityOf } from './surfaceShared';

/**
 * @affects replaces the surface of 1 nurbs_surface entity by the part inside the parameter rectangle (same id)
 * @invariant exact: the trimmed patch coincides with the original over the rectangle and its domain is that rectangle
 * @failure unknown id / not a surface -> SRF_ENTITY_NOT_FOUND / SRF_NOT_SURFACE; an empty or out-of-domain interval -> SRF_TRIM_RANGE
 */
export const trimSurface = defineCommand({
  name: 'trim_surface',
  description:
    'Cut a nurbs_surface down to a rectangle of its parameter domain: keep u in [u0, u1] and v in [v0, v1] (see inspect_nurbs `domain`). ' +
    'Exact (knots are inserted at the cuts and the outer poles dropped); the sheet keeps its id and its parameter values inside the ' +
    'rectangle. Only iso-parametric trims are available: trimming by a curve, a plane or a projected loop needs trimmed faces from the exact kernel.',
  params: z.object({
    id: z.string().describe('Id of a nurbs_surface entity.'),
    u: z.array(z.number()).describe('[from, to] along u, inside the surface domain, from < to.'),
    v: z.array(z.number()).describe('[from, to] along v, inside the surface domain, from < to.'),
  }),
  run: (doc, { id, u, v }): CommandResult => {
    const entity = surfaceEntityOf(doc, 'trim_surface', id);
    if (isRefusal(entity)) return entity;
    if (u.length !== 2 || v.length !== 2)
      return refuseSrf(doc, 'trim_surface', 'SRF_TRIM_RANGE', 'u and v each need [from, to]', [id], ['params.u']);
    const result = extractSubSurface(entity.surface, [u[0] as number, u[1] as number], [v[0] as number, v[1] as number]);
    if (typeof result === 'string') return refuseSrf(doc, 'trim_surface', 'SRF_TRIM_RANGE', result, [id], ['params.u']);
    const next: NurbsSurfaceEntity = { ...entity, surface: result };
    return changed(
      replaceEntity(doc, next),
      `trim_surface: trimmed "${id}" to u [${u[0]}, ${u[1]}], v [${v[0]}, ${v[1]}] (${result.poles.length} x ${result.poles[0]?.length ?? 0} poles).`,
      [id],
    );
  },
});

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
 * @affects removes 2 nurbs_surface entities, creates 1 nurbs_surface (world coordinates) whose joint is a C0 crease
 * @invariant the merged patch coincides with both inputs; only whole shared edges are joined
 * @failure unknown id / not a surface -> SRF_ENTITY_NOT_FOUND / SRF_NOT_SURFACE; no shared edge within tolerance -> SRF_SEW_NOT_MERGEABLE
 */
export const sewSurfaces = defineCommand({
  name: 'sew_surfaces',
  description:
    'Sew two nurbs_surface sheets that share one whole boundary edge into a single multi-span nurbs_surface: the edges must coincide within ' +
    '`tolerance` (document units); the sides, their orientation and the knot vectors are matched automatically (degrees and knots are made ' +
    'compatible without changing either shape). The joint becomes a C0 crease (a repeated knot), so check_continuity on the original ' +
    'pair first if tangency matters. The two inputs are removed and the result has position [0, 0, 0] (world poles). Sewing into a closed ' +
    'shell or a solid, free-edge reports, and more than two patches need the exact kernel: sew pairs one after the other.',
  params: z.object({
    ids: z.array(z.string()).describe('Exactly 2 nurbs_surface ids.'),
    tolerance: z
      .number()
      .describe('Largest distance (document units) between matching edge poles. Default 1e-6 x the size of the surfaces.')
      .optional(),
  }),
  run: (doc, { ids, tolerance }): CommandResult => {
    if (ids.length !== 2 || ids[0] === ids[1])
      return refuseSrf(doc, 'sew_surfaces', 'SRF_PARAM_INVALID', 'give exactly 2 different surface ids', ids, ['params.ids']);
    const [first, second] = [
      surfaceEntityOf(doc, 'sew_surfaces', ids[0] as string),
      surfaceEntityOf(doc, 'sew_surfaces', ids[1] as string),
    ];
    if (isRefusal(first)) return first;
    if (isRefusal(second)) return second;
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
    for (let i = 0; i + 1 < countU; i++)
      for (let j = 0; j + 1 < countV; j++) {
        const [p, q, r, s] = [at(i, j), at(i, j + 1), at(i + 1, j), at(i + 1, j + 1)];
        indices.push(p, r, q, q, r, s);
        indices.push(bottom + p, bottom + q, bottom + r, bottom + q, bottom + s, bottom + r);
      }
    const boundary: number[] = [];
    for (let j = 0; j < countV; j++) boundary.push(at(0, j));
    for (let i = 1; i < countU; i++) boundary.push(at(i, countV - 1));
    for (let j = countV - 2; j >= 0; j--) boundary.push(at(countU - 1, j));
    for (let i = countU - 2; i >= 1; i--) boundary.push(at(i, 0));
    boundary.forEach((top, k) => {
      const next = boundary[(k + 1) % boundary.length] as number;
      indices.push(top, bottom + next, bottom + top, top, next, bottom + next);
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

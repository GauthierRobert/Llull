/** trim_surface: cut a sheet down to a parameter rectangle (exact), or by projected trimming curves (trim loops in the parameter plane). */

import type { NurbsSurfaceEntity } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, vec3, z } from '../schema';
import { changed } from '../noop';
import { replaceEntity } from '../entity/entityOps';
import { extractSubSurface } from '../../lib/nurbs/surfaceEdit';
import { buildTrimLoops } from '../../lib/nurbs/trimLoops';
import { domainLoop, trimmedArea } from '../../lib/nurbs/trimRegion';
import { surfaceDomain } from '../../lib/nurbs/surface';
import { placedSurface, surfacePoleExtent } from '../../geometry/nurbsSurface';
import { chainCurves, sizeOfCurves, worldCurves } from './curveInputs';
import { refuseSrf } from './shared';
import { isRefusal, sig, surfaceEntityOf } from './surfaceShared';

/**
 * @affects replaces the surface (rectangle) or the trim loops (curves) of 1 nurbs_surface entity (same id)
 * @invariant rectangle: exact, the trimmed patch coincides with the original and its domain is the rectangle; curves: the sheet keeps its patch and a
 *   list of (u, v) trim loops (render, area, STEP skipped); the reported area is the exact trimmed surface area
 * @failure unknown id / not a surface -> SRF_ENTITY_NOT_FOUND / SRF_NOT_SURFACE; neither or both of (u, v) and curveIds -> SRF_PARAM_INVALID;
 *   bad interval -> SRF_TRIM_RANGE; curve misses / leaves / crosses itself / cannot be kept / not supported on a trimmed sheet -> SRF_TRIM_MISS /
 *   SRF_TRIM_LOOP_INVALID / SRF_TRIM_AMBIGUOUS / SRF_TRIM_UNSUPPORTED
 */
export const trimSurface = defineCommand({
  name: 'trim_surface',
  description:
    'Cut a nurbs_surface sheet, in one of two ways. (1) Rectangle: `u` [from, to] and `v` [from, to] inside the surface domain (see inspect_nurbs ' +
    '`domain`): exact, the sheet keeps its id and its parameter values. (2) Curves: `curveIds` (nurbs_curve ids, chained end to end) are projected onto ' +
    'the sheet - to the closest point, or along `projectAlong` when given - and trim it. A CLOSED curve keeps its inside (`keep` "inside", default) or its ' +
    'outside (a hole); an OPEN curve must run from the sheet boundary across to the boundary (extend it past the edges) and needs `keepPoint`, a point ' +
    'near the side to keep. The sheet keeps its patch and stores the trim loops, so it renders and measures as the trimmed region: the result reports the ' +
    'exact trimmed `area` (also measure_area on the sheet id). A trimmed sheet accepts further trims only as holes inside the kept region; sewing, ' +
    'thickening and the analysis queries (curvature, draft, deviation) still use the whole underlying patch. Reference: a 10 x 10 plane trimmed by ' +
    'a circle of radius 3 keeping the inside has area 28.274334.',
  params: z.object({
    id: z.string().describe('Id of a nurbs_surface entity.'),
    u: z.array(z.number()).describe('Rectangle mode: [from, to] along u, inside the surface domain, from < to. Give with `v`.').optional(),
    v: z.array(z.number()).describe('Rectangle mode: [from, to] along v, inside the surface domain, from < to. Give with `u`.').optional(),
    curveIds: z
      .array(z.string())
      .describe('Curve mode: 1..12 nurbs_curve ids forming one chain (end to end), closed or open. Give instead of `u` and `v`.')
      .optional(),
    projectAlong: vec3(
      'Curve mode: direction [x, y, z] (any non-zero length) along which the curves are carried onto the sheet. Omit for the closest-point projection.',
    ).optional(),
    keep: z
      .enum(['inside', 'outside'])
      .describe('Curve mode, closed curve: keep the region "inside" the curve (default) or "outside" it (the curve becomes a hole).')
      .optional(),
    keepPoint: vec3(
      'Curve mode: a point [x, y, z] on the side to keep (projected onto the sheet). Required for an open curve; overrides `keep` for a closed one.',
    ).optional(),
    tolerance: z
      .number()
      .describe(
        'Curve mode: largest gap (document units, > 0) between chained curve ends, and the ray-hit tolerance. Default 1e-6 x the size.',
      )
      .optional(),
  }),
  run: (doc, params): CommandResult => {
    const { id, u, v, curveIds, projectAlong, keepPoint } = params;
    const entity = surfaceEntityOf(doc, 'trim_surface', id);
    if (isRefusal(entity)) return entity;
    const rectangle = u !== undefined || v !== undefined;
    if (rectangle === (curveIds !== undefined))
      return refuseSrf(
        doc,
        'trim_surface',
        'SRF_PARAM_INVALID',
        'give either u and v (rectangle), or curveIds (curves)',
        [id],
        ['params.u'],
      );
    if (rectangle) {
      if (u === undefined || v === undefined || u.length !== 2 || v.length !== 2)
        return refuseSrf(doc, 'trim_surface', 'SRF_TRIM_RANGE', 'u and v each need [from, to]', [id], ['params.u']);
      if (entity.trims !== undefined && entity.trims.length > 0)
        return refuseSrf(
          doc,
          'trim_surface',
          'SRF_TRIM_UNSUPPORTED',
          'a sheet trimmed by curves cannot be cut to a rectangle',
          [id],
          ['params.u'],
        );
      const result = extractSubSurface(entity.surface, [u[0] as number, u[1] as number], [v[0] as number, v[1] as number]);
      if (typeof result === 'string') return refuseSrf(doc, 'trim_surface', 'SRF_TRIM_RANGE', result, [id], ['params.u']);
      const next: NurbsSurfaceEntity = { ...entity, surface: result };
      return changed(
        replaceEntity(doc, next),
        `trim_surface: trimmed "${id}" to u [${u[0]}, ${u[1]}], v [${v[0]}, ${v[1]}] (${result.poles.length} x ${result.poles[0]?.length ?? 0} poles).`,
        [id],
      );
    }
    const ids = curveIds as string[];
    if (ids.length === 0 || ids.length > 12)
      return refuseSrf(doc, 'trim_surface', 'SRF_PARAM_INVALID', 'curveIds needs 1..12 curves', [id], ['params.curveIds']);
    if (projectAlong !== undefined && !(Math.hypot(...projectAlong) > 0))
      return refuseSrf(
        doc,
        'trim_surface',
        'SRF_PARAM_INVALID',
        'projectAlong must be a non-zero direction',
        [id],
        ['params.projectAlong'],
      );
    const curves = worldCurves(doc, 'trim_surface', ids, 'curveIds');
    if (isRefusal(curves)) return curves;
    const surface = placedSurface(entity);
    const { min, max } = surfacePoleExtent(surface);
    const size = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], sizeOfCurves(curves), 1e-9);
    const tolerance = params.tolerance ?? 1e-6 * size;
    if (!(tolerance > 0)) return refuseSrf(doc, 'trim_surface', 'SRF_PARAM_INVALID', 'tolerance must be > 0', [id], ['params.tolerance']);
    const open = chainCurves(curves, tolerance, false);
    if (open === null)
      return refuseSrf(doc, 'trim_surface', 'SRF_TRIM_LOOP_INVALID', `the curves do not chain end to end within ${tolerance}`, ids, [
        'params.curveIds',
      ]);
    const closed = chainCurves(curves, tolerance, true);
    const built = buildTrimLoops({
      surface,
      chain: (closed ?? open).curves,
      closed: closed !== null,
      direction: projectAlong ?? null,
      keep: params.keep ?? 'inside',
      keepPoint: keepPoint ?? null,
      existing: entity.trims,
      hitTolerance: Math.max(tolerance, 1e-9 * size),
    });
    if ('code' in built) return refuseSrf(doc, 'trim_surface', built.code, built.message, [id, ...ids], ['params.curveIds']);
    const next: NurbsSurfaceEntity = { ...entity, trims: built.loops };
    const area = trimmedArea(entity.surface, built.loops);
    const whole = trimmedArea(entity.surface, [domainLoop(entity.surface)]);
    const [[u0, u1], [v0, v1]] = surfaceDomain(entity.surface);
    const data = {
      id,
      area: sig(area),
      areaUnit: `${doc.units}^2`,
      untrimmedArea: sig(whole),
      keptFraction: sig(area / whole),
      loops: built.loops.length,
      vertices: built.vertices,
      projection: projectAlong === undefined ? 'closest point' : 'along direction',
      maxCurveToSheetGap: sig(built.maxGap),
      domain: { u: [u0, u1], v: [v0, v1] },
      unit: doc.units,
      unverified: false,
      provenance: {
        method:
          'curve projected into the (u, v) plane; area by Green theorem with Gauss quadrature of |Su x Sv|, Richardson-extrapolated over the loop sampling',
        reference: 'Piegl & Tiller, The NURBS Book, §6.1 projection; Green theorem',
        inputs: { id, curveIds: ids },
      },
    };
    return {
      ...changed(
        replaceEntity(doc, next),
        `trim_surface: trimmed "${id}" by ${ids.length} curve(s) (${built.note}); trimmed area ${data.area} ${doc.units}^2 of ${data.untrimmedArea} (${(data.keptFraction * 100).toFixed(2)} %).`,
        [id],
      ),
      data,
    };
  },
});

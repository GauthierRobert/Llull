/**
 * Deformation of curves and sheets (01 DEF §5.8): a `nurbs_curve` or `nurbs_surface` keeps its kind and gets new data. An affine map moves the poles
 * exactly; any other map samples the deformed geometry and refits it within `output.tolerance` (core refit, no kernel).
 * @invariant the entity keeps its id (it is edited in place) unless `keepSource`, which adds the deformed copy under a new id
 */

import type { CadDocument, Entity, NurbsCurveEntity, NurbsSurfaceEntity } from '../../model/types';
import { JACOBIAN_FLOOR, jacobianRange } from '../../geometry/deform/bounds';
import { resolveFrame } from '../../geometry/deform/frame';
import { type DeformNode, affineWorld, warpOf } from '../../geometry/deform/laws';
import { mapPoles, mapSurfacePoles, refitCurve, refitSurface } from '../../geometry/deform/curveWarp';
import { worldCurve, worldSurface } from '../../geometry/deform/worldNurbs';
import { nextId } from '../../lib/id';
import { evaluateCurve, curveDomain } from '../../lib/nurbs/evaluate';
import { evaluateSurface, surfaceDomain } from '../../lib/nurbs/surface';
import { newEntity } from '../entity/newEntity';
import { replaceEntity, withEntities } from '../entity/entityOps';
import { changed } from '../noop';
import type { CommandResult } from '../types';
import { defRejection } from './codes';
import type { DeformRequest } from './request';
import { NEXT_STEP } from './schema';
import { type DeformTarget, defaultTolerance, isRefusal } from './target';

type Sheet = NurbsCurveEntity | NurbsSurfaceEntity;

/** Samples per direction of the point cloud that stands for a curve or sheet when the plan looks for its bounds. */
const BOUND_SAMPLES = 33;

/** A target whose "mesh" is a cloud of points on the curve or sheet (bounds and frame defaults read it; there are no triangles). */
function targetOf(entity: Sheet): DeformTarget {
  const cloud: number[] = [];
  if (entity.kind === 'nurbs_curve') {
    const curve = worldCurve(entity);
    const [first, last] = curveDomain(curve);
    for (let i = 0; i < BOUND_SAMPLES; i++) cloud.push(...evaluateCurve(curve, first + ((last - first) * i) / (BOUND_SAMPLES - 1)));
  } else {
    const surface = worldSurface(entity);
    const [[u0, u1], [v0, v1]] = surfaceDomain(surface);
    for (let i = 0; i < BOUND_SAMPLES; i++)
      for (let j = 0; j < BOUND_SAMPLES; j++)
        cloud.push(...evaluateSurface(surface, u0 + ((u1 - u0) * i) / (BOUND_SAMPLES - 1), v0 + ((v1 - v0) * j) / (BOUND_SAMPLES - 1)));
  }
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < cloud.length; i += 3)
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a] as number, cloud[i + a] as number);
      max[a] = Math.max(max[a] as number, cloud[i + a] as number);
    }
  return {
    entity,
    kernel: null,
    source: { op: 'brep', blob: '0'.repeat(64), format: 'occt-brep-v1' },
    mesh: { positions: cloud, indices: [] },
    faceted: false,
    min,
    max,
    diagonal: Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]),
  };
}

/**
 * Deform one nurbs_curve / nurbs_surface entity of the document.
 * @failure a trimmed sheet under a non-affine map (its trim loops live in the original parameters) -> DEF_TARGET_UNSUPPORTED; no fit within the tolerance -> DEF_APPROX_TOLERANCE
 */
export function deformSheet(doc: CadDocument, request: DeformRequest, entity: Sheet): CommandResult {
  const { command, verb, output, keepSource = false } = request;
  const id = entity.id;
  const reject = (code: string, message: string, paths: readonly string[]): CommandResult =>
    defRejection(doc, command, code, message, [id], paths);
  const target = targetOf(entity);
  const plan = request.plan(target);
  if (isRefusal(plan)) return reject(plan.code, plan.message, plan.paths);
  const tolerance = output?.tolerance ?? defaultTolerance(target.diagonal);
  if (!(tolerance > 0) || !Number.isFinite(tolerance))
    return reject('DEF_TOLERANCE_INVALID', `tolerance ${tolerance} must be finite and > 0`, ['params.output.tolerance']);
  if (output?.preserveAnalytic === true)
    return reject('DEF_EXACT_UNAVAILABLE', 'a curve or sheet has no analytic faces to recognise', ['params.output.preserveAnalytic']);
  if (output?.mode === 'exact' && plan.law.kind !== 'affine')
    return reject(
      'DEF_EXACT_UNAVAILABLE',
      'a curve or sheet is exact only under an affine map; other laws refit it within the tolerance (mode "auto")',
      ['params.output.mode'],
    );
  const node: DeformNode = {
    op: 'deform',
    source: target.source,
    law: plan.law,
    frame: plan.frame,
    ...(plan.region === undefined ? {} : { region: plan.region }),
    output: { mode: output?.mode ?? 'auto', tolerance, preserveAnalytic: false },
  };
  const range = jacobianRange(node, plan.extent);
  if (plan.law.kind !== 'affine' && range.min <= JACOBIAN_FLOOR)
    return reject(
      'DEF_FOLDOVER',
      `the map folds the space the ${entity.kind === 'nurbs_curve' ? 'curve' : 'sheet'} lies in (min det J ${range.min.toPrecision(6)})`,
      [],
    );
  const warp = warpOf(node);
  const local = resolveFrame(plan.frame);
  if (warp === null || local === null)
    return reject('DEF_FRAME_DEGENERATE', 'the frame axis is zero or the reference is parallel to it', ['params.frame']);
  const affine = affineWorld(node);
  const map = warp.point;
  let created: Entity;
  let method: string;
  let error: number;
  const newId = keepSource ? nextId(entity.kind === 'nurbs_curve' ? 'curve' : 'surface') : id;
  const style = { layerId: entity.layerId, ...(entity.name === undefined ? {} : { name: entity.name }) };
  if (entity.kind === 'nurbs_curve') {
    const world = worldCurve(entity);
    const result = affine !== null ? { data: mapPoles(world, map), maxError: 0 } : refitCurve(world, map, tolerance);
    if (result === null)
      return reject(
        'DEF_APPROX_TOLERANCE',
        `no curve within ${tolerance} ${doc.units} of the deformed one below 400 poles: raise output.tolerance`,
        ['params.output.tolerance'],
      );
    created = newEntity('nurbs_curve', newId, { curve: result.data }, [0, 0, 0], entity.color, style);
    method = affine !== null ? 'exact (poles mapped)' : 'refit';
    error = result.maxError;
  } else {
    if (affine === null && entity.trims !== undefined && entity.trims.length > 0)
      return reject(
        'DEF_TARGET_UNSUPPORTED',
        `sheet '${id}' is trimmed: its trim loops live in the original parameters, which a refit changes; untrim it, or use an affine map`,
        ['params.id'],
      );
    const world = worldSurface(entity);
    const result = affine !== null ? { data: mapSurfacePoles(world, map), maxError: 0 } : refitSurface(world, map, tolerance);
    if (result === null)
      return reject(
        'DEF_APPROX_TOLERANCE',
        `no sheet within ${tolerance} ${doc.units} of the deformed one up to a 65 x 65 grid: raise output.tolerance`,
        ['params.output.tolerance'],
      );
    created = newEntity(
      'nurbs_surface',
      newId,
      { surface: result.data, ...(entity.trims === undefined ? {} : { trims: entity.trims }) },
      [0, 0, 0],
      entity.color,
      style,
    );
    method = affine !== null ? 'exact (poles mapped)' : 'refit';
    error = result.maxError;
  }
  const document = keepSource ? withEntities(doc, [created]) : replaceEntity(doc, created);
  const summary =
    `${command}: ${verb} '${id}' (kind '${entity.kind}') → ${keepSource ? `new ${entity.kind} '${newId}'` : 'the same entity, new data'} (${method}, fit error ${error.toPrecision(3)} ${doc.units}, tolerance ${tolerance.toPrecision(3)} ${doc.units}). ` +
    `Frame origin [${plan.frame.origin.join(', ')}] axis [${plan.frame.axis.join(', ')}]${plan.defaulted.length > 0 ? ` (defaulted: ${plan.defaulted.join(', ')})` : ''}. ${NEXT_STEP}`;
  const result = changed(document, summary, [newId]);
  return {
    ...result,
    data: {
      id: newId,
      path: 'curve-refit',
      kind: entity.kind,
      method,
      law: plan.law,
      tolerance: { value: tolerance, unit: doc.units, defaulted: output?.tolerance === undefined },
      fitError: error,
      jacobian: { min: range.min, max: range.max },
      unit: doc.units,
    },
  };
}

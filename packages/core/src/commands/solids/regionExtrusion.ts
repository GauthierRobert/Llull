/**
 * extrude_profile of a `region` entity: a region without holes is a plain exact extrusion (any kernel or none); holes and islands are
 * prisms subtracted from / united with the outer prisms in one kernel recipe (needs a kernel; the result is a mesh solid with its exact B-rep).
 */

import type { CadDocument, Entity, RegionEntity, ShapeRecipe, Vec2, Vec3 } from '../../model/types';
import type { CurveSegment } from '../../model/curve';
import type { CommandResult, ExecutionContext } from '../types';
import { regionFaces } from '../../geometry/region';
import { nextId } from '../../lib/id';
import { currentContext } from '../context';
import { commitEntity } from '../entity/commitEntity';
import { newEntity } from '../entity/newEntity';
import { evaluateRecipe, kernelResultEntity } from '../kernelShape';
import { codedRejection, noop } from '../noop';
import { exactCurves, extrusionResult } from './extrusionResult';
import { resolveRotation } from './shared';
import { unionOf } from './textExtrusion';

export interface RegionExtrusionRequest {
  readonly region: RegionEntity;
  readonly depth: number;
  readonly position: Vec3 | undefined;
  readonly rotation: unknown;
  readonly axis: unknown;
  readonly color: string;
}

/**
 * @failure depth <= 0 -> no-op; holes / islands without a kernel -> REGION_NEEDS_KERNEL; kernel refuses the prisms -> REGION_KERNEL_BUILD_FAILED
 */
export function extrudeRegion(doc: CadDocument, ctx: ExecutionContext | undefined, request: RegionExtrusionRequest): CommandResult {
  const { region, depth } = request;
  if (!(depth > 0)) return noop(doc, `extrude_profile: depth must be a finite number > 0 (got ${String(depth)}); no-op.`);
  const faces = regionFaces(region.loops);
  const chainOf = (loop: ReadonlyArray<Vec2>): CurveSegment<Vec2>[] => [...(region.curves?.[region.loops.indexOf(loop)] ?? [])];
  const position = request.position ?? region.position;
  const rotation = request.rotation ?? (request.axis === undefined ? region.rotation : undefined);
  const [only] = faces;
  if (faces.length === 1 && only !== undefined && only.holes.length === 0)
    return extrusionResult(doc, {
      profile: only.outer as Vec2[],
      depth,
      position,
      rotation,
      axis: request.axis,
      color: request.color,
      curves: chainOf(only.outer),
      describe: (id) =>
        `extrude_profile: created extrusion "${id}" from region "${region.id}" (${only.outer.length}-point profile, depth=${depth})`,
    });
  const kernel = (ctx ?? currentContext()).kernel;
  if (kernel === null)
    return codedRejection(
      doc,
      'extrude_profile',
      'REGION_NEEDS_KERNEL',
      `region "${region.id}" has ${region.loops.length - 1} inner loop(s) (holes / islands); extruding them subtracts prisms with a geometry kernel`,
      'Run with a geometry kernel (the desktop app, or llull --app), or extrude a region without holes.',
      [region.id],
    );
  const resolved = resolveRotation(request.axis, rotation);
  if (resolved.error !== undefined) return noop(doc, `extrude_profile: ${resolved.error}; no-op.`);
  const meshId = nextId('mesh');
  const prism = (loop: ReadonlyArray<Vec2>, part: string, height: number): ShapeRecipe => {
    const geometry = { profile: loop as Vec2[], depth: height, ...exactCurves(chainOf(loop)) };
    return { op: 'solid', entity: newEntity('extrusion', `${meshId}.${part}`, geometry, [0, 0, 0], request.color) as Entity };
  };
  /** A hole tool overshoots the prism on both faces, so the subtraction never leaves coincident faces. */
  const tool = (loop: ReadonlyArray<Vec2>, part: string): ShapeRecipe => ({
    op: 'place',
    source: prism(loop, part, 2 * depth),
    position: [0, 0, -depth / 2],
    rotation: [0, 0, 0],
  });
  const parts = faces.map(
    ({ outer, holes }, index): ShapeRecipe =>
      holes.reduce<ShapeRecipe>(
        (solid, hole, k) => ({ op: 'boolean', boolean: 'subtract', a: solid, b: tool(hole, `f${index}h${k}`) }),
        prism(outer, `f${index}`, depth),
      ),
  );
  const result = evaluateRecipe(kernel, { op: 'place', source: unionOf(parts), position, rotation: resolved.rotation });
  if (typeof result === 'string')
    return codedRejection(
      doc,
      'extrude_profile',
      'REGION_KERNEL_BUILD_FAILED',
      `the kernel could not build the prisms of region "${region.id}" (${result})`,
      'Check the region with measure_area; simplify the boundary or extrude the outer loop and subtract the holes with the boolean command (op subtract).',
      [region.id],
    );
  const entity = { ...kernelResultEntity(meshId, result, region), color: request.color };
  return {
    ...commitEntity(doc, entity, ''),
    summary: `extrude_profile: created mesh "${meshId}" from region "${region.id}" — ${faces.length} face(s), ${region.loops.length - faces.length} hole loop(s) subtracted, depth=${depth}; region kept.`,
  };
}

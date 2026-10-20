/** Thin-wall form of extrude_profile: an offset band (open path) or a ring (closed outline, a kernel subtract of two prisms). */

import type { CadDocument, Entity, ShapeRecipe, Vec2, Vec3 } from '../../model/types';
import type { CommandResult } from '../types';
import type { ExecutionContext } from '../types';
import { z } from '../schema';
import { noop } from '../noop';
import { currentContext } from '../context';
import { kernelUnavailable } from '../kernelRefusal';
import { commitKernelResult, evaluateRecipe, operandRecipe } from '../brep/kernelShape';
import { newEntity } from '../entity/newEntity';
import { applyEulerXYZ } from '../../lib/eulerRotation';
import { compactNumber } from '../../lib/compactNumber';
import { THIN_SIDES, thinRegion } from '../../geometry/thinProfile';
import { MAX_PROFILE_POINTS } from '../limits';
import { extrusionResult } from './extrusionResult';
import { resolveRotation } from './shared';
import { sketchLoop } from './sketchCurves';

export const thinSchema = z
  .object({
    thickness: z.number().describe('Wall thickness in document units (> 0), measured in the profile plane.'),
    side: z
      .enum(THIN_SIDES)
      .describe(
        '"centre": the wall is centred on the profile (thickness/2 each side); "inside": the wall grows toward the inside of a closed ' +
          'profile (left of the travel direction of an open path); "outside": it grows outward (right of the travel direction of an open path).',
      ),
  })
  .describe(
    'Thin-wall extrusion: instead of a solid prism, extrude only a wall of the given thickness along the profile. A closed profile gives a ' +
      'ring (outer minus inner outline, needs a geometry kernel), an open profile (open polyline id, or an inline profile with openPath true) ' +
      'gives an offset band (mitred corners). Volume = wall area x depth. Curved sketches are used through their display polygon.',
  );

interface ThinRequest {
  readonly profile: ReadonlyArray<Vec2> | undefined;
  readonly openPath: boolean | undefined;
  readonly id: string | undefined;
  readonly ids: readonly string[] | undefined;
  readonly depth: number;
  readonly position: Vec3 | undefined;
  readonly rotation: unknown;
  readonly axis: unknown;
  readonly color: string;
  readonly thin: z.infer<typeof thinSchema>;
}

interface ThinSource {
  readonly points: ReadonlyArray<Vec2>;
  readonly closed: boolean;
  readonly origin: Vec3;
  /** Rotation of the drawn source (its work plane); [0, 0, 0] for an inline profile. */
  readonly rotation: Vec3;
  readonly label: string;
}

function thinSource(doc: CadDocument, request: ThinRequest): ThinSource | string {
  const { profile, openPath, id, ids } = request;
  if ([profile, id, ids].filter((source) => source !== undefined).length !== 1) return 'give exactly one of profile, id or ids';
  if (profile !== undefined) {
    const finite = profile.every((point) => point.length === 2 && point.every(Number.isFinite));
    if (!finite) return 'profile points must be finite [x, y] pairs';
    if (profile.length > MAX_PROFILE_POINTS)
      return `profile has ${profile.length} points, exceeding MAX_PROFILE_POINTS (${MAX_PROFILE_POINTS})`;
    return {
      points: profile,
      closed: openPath !== true,
      origin: request.position ?? [0, 0, 0],
      rotation: [0, 0, 0],
      label: `${profile.length}-point ${openPath === true ? 'open' : 'closed'} profile`,
    };
  }
  const sourceIds = ids ?? (id === undefined ? [] : [id]);
  const single: Entity | undefined = sourceIds.length === 1 ? doc.entities[sourceIds[0] as string] : undefined;
  if (single?.kind === 'polyline' && !single.closed)
    return {
      points: single.points,
      closed: false,
      origin: request.position ?? single.position,
      rotation: single.rotation,
      label: `open polyline "${single.id}"`,
    };
  const loop = sketchLoop(doc, sourceIds);
  if (typeof loop === 'string') return loop;
  return {
    points: loop.profile,
    closed: true,
    origin: request.position ?? loop.origin,
    rotation: loop.rotation,
    label: `[${sourceIds.join(', ')}]`,
  };
}

const OVERSHOOT = 0.5;

function prism(id: string, profile: ReadonlyArray<Vec2>, depth: number, position: Vec3, rotation: Vec3, color: string): Entity {
  return newEntity('extrusion', id, { profile, depth }, position, color, { rotation });
}

/**
 * Thin extrusion of the requested source.
 * @failure bad source, depth <= 0, thickness too large for the outline, closed ring without a kernel / kernel refusal -> unchanged doc
 */
export function thinExtrude(doc: CadDocument, request: ThinRequest, ctx: ExecutionContext | undefined): CommandResult {
  const fail = (why: string): CommandResult => noop(doc, `extrude_profile: thin ${why}; no-op.`);
  if (!(request.depth > 0) || !Number.isFinite(request.depth))
    return fail(`depth must be a finite number > 0 (got ${String(request.depth)})`);
  const source = thinSource(doc, request);
  if (typeof source === 'string') return fail(source);
  const { thickness, side } = request.thin;
  const rotation = request.rotation ?? (request.axis === undefined ? source.rotation : undefined);
  const region = thinRegion(source.points, source.closed, thickness, side);
  if (typeof region === 'string') return fail(region);
  const note = `${side} wall ${compactNumber(thickness)} of ${source.label}, depth=${request.depth}, wall area ${compactNumber(region.area)}`;
  if (region.kind === 'band')
    return extrusionResult(doc, {
      profile: region.polygon,
      depth: request.depth,
      position: source.origin,
      rotation,
      axis: request.axis,
      color: request.color,
      describe: (id) => `extrude_profile: created thin extrusion "${id}" (${note})`,
    });
  const resolved = resolveRotation(request.axis, rotation);
  if (resolved.error !== undefined) return fail(resolved.error);
  const kernel = (ctx ?? currentContext()).kernel;
  if (!kernel) return noop(doc, kernelUnavailable('extrude_profile (thin closed profile)'));
  const lift = applyEulerXYZ([0, 0, -OVERSHOOT], [0, 0, 0], resolved.rotation);
  const below: Vec3 = [source.origin[0] + lift[0], source.origin[1] + lift[1], source.origin[2] + lift[2]];
  const outer = prism('thin-outer', region.outer, request.depth, source.origin, resolved.rotation, request.color);
  const inner = prism('thin-inner', region.inner, request.depth + 2 * OVERSHOOT, below, resolved.rotation, request.color);
  const recipe: ShapeRecipe = { op: 'boolean', boolean: 'subtract', a: operandRecipe(kernel, outer), b: operandRecipe(kernel, inner) };
  const result = evaluateRecipe(kernel, recipe);
  if (result === 'refused' || result === 'empty') return fail(`ring could not be built by the kernel (${result})`);
  return commitKernelResult(
    doc,
    kernel,
    result,
    [outer],
    (id, triangles) => `extrude_profile: created thin ring mesh "${id}" (${note}; ${triangles} triangles)`,
  );
}

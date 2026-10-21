/**
 * Sketch planes (SC-S3): a named plane (a world plane, or a planar face of a solid followed by its persistent name) moved along its normal,
 * and the placement of 2D entities on it. Both are feature steps, so an upstream edit that moves the face moves the plane and every sketch
 * placed on it; a face that is gone fails the step (REF_LOST) instead of leaving the sketch silently behind.
 */

import type { CadDocument, Entity, Vec2, Vec3 } from '../../model/types';
import { is2D } from '../../model/types';
import type { PlaneFrame, SketchPlane, SketchPlaneBase } from '../../model/sketchPlanes';
import type { CommandResult, ExecutionContext } from '../types';
import { defineCommand, vec2, vec3, z } from '../schema';
import { currentContext } from '../context';
import { changed, noop } from '../noop';
import { nextId } from '../../lib/id';
import { add3, cross3, dot3, normalize3, scale3, sub3 } from '../../lib/vec3';
import { eulerFromAxes } from '../../lib/eulerRotation';
import { kernelUnavailable } from '../kernelRefusal';
import { operandRecipe } from '../../geometry/operandRecipe';
import { validateSolidTarget } from '../brep/modifyTarget';
import { pickFaces } from '../brep/faceReferences';

const WORLD_FRAMES: Readonly<Record<'xy' | 'xz' | 'yz', PlaneFrame>> = {
  xy: { origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] },
  xz: { origin: [0, 0, 0], normal: [0, -1, 0], xDir: [1, 0, 0] },
  yz: { origin: [0, 0, 0], normal: [1, 0, 0], xDir: [0, 1, 0] },
};

/** `frame` moved `offset` along its normal and turned `spin` radians about it. @pure */
export function offsetFrame(frame: PlaneFrame, offset: number, spin: number): PlaneFrame {
  const yDir = cross3(frame.normal, frame.xDir);
  const xDir = normalize3(add3(scale3(frame.xDir, Math.cos(spin)), scale3(yDir, Math.sin(spin))));
  return { origin: add3(frame.origin, scale3(frame.normal, offset)), normal: frame.normal, xDir };
}

/** Plane-local [x, y] of a world point. @pure */
export function toPlane(frame: PlaneFrame, point: Vec3): Vec2 {
  const relative = sub3(point, frame.origin);
  return [dot3(relative, frame.xDir), dot3(relative, cross3(frame.normal, frame.xDir))];
}

/** World point of plane-local [x, y]. @pure */
export function fromPlane(frame: PlaneFrame, [x, y]: Vec2): Vec3 {
  return add3(frame.origin, add3(scale3(frame.xDir, x), scale3(cross3(frame.normal, frame.xDir), y)));
}

/** Entity placement (position, XYZ Euler rotation) whose local plane is `frame`. @pure */
export function placementOf(frame: PlaneFrame): { readonly position: Vec3; readonly rotation: Vec3 } {
  return { position: frame.origin, rotation: eulerFromAxes(frame.xDir, cross3(frame.normal, frame.xDir), frame.normal) };
}

/** Deterministic in-plane x axis for a face normal: world X projected on the plane, or world Y when X is (nearly) normal to it. */
function xDirFor(normal: Vec3): Vec3 {
  const reference: Vec3 = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return normalize3(sub3(reference, scale3(normal, dot3(reference, normal))));
}

type FacePick = {
  readonly id: string;
  readonly faceIndex?: number | undefined;
  readonly faceNear?: Vec3 | undefined;
  readonly faceName?: string | undefined;
};

function faceFrame(
  doc: CadDocument,
  ctx: ExecutionContext | undefined,
  face: FacePick,
): { readonly frame: PlaneFrame; readonly name: string | null } | { readonly problem: string; readonly code?: string } {
  const validation = validateSolidTarget(doc, 'create_sketch_plane', face.id);
  if ('summary' in validation) return { problem: validation.summary };
  const kernel = (ctx ?? currentContext()).kernel;
  if (!kernel) return { problem: kernelUnavailable('create_sketch_plane') };
  const shape = kernel.evaluate(operandRecipe(kernel, validation.entity));
  if (shape === null) return { problem: `kernel could not build '${face.id}'` };
  const topology = kernel.topology(shape);
  const pick = pickFaces(kernel, shape, topology, {
    indices: face.faceIndex === undefined ? [] : [face.faceIndex],
    near: face.faceNear === undefined ? [] : [face.faceNear],
    names: face.faceName === undefined ? undefined : [face.faceName],
  });
  if ('problem' in pick) return { problem: pick.problem, ...(pick.error === undefined ? {} : { code: pick.error.code }) };
  const [index] = pick.faces;
  const detail = index === undefined ? undefined : kernel.faceQuery?.faceDetails(shape, { samples: 0 })?.[index];
  if (detail === undefined) return { problem: 'a sketch on a face needs the exact face geometry of the native kernel' };
  if (detail.surface !== 'plane' || detail.normal === undefined) return { problem: `face ${index} is ${detail.surface}, not planar` };
  const normal = normalize3(detail.normal);
  return { frame: { origin: detail.centroid, normal, xDir: xDirFor(normal) }, name: face.faceName ?? pick.record?.[0] ?? null };
}

/**
 * @affects adds 1 sketch plane (doc.sketchPlanes); no entity
 * @failure both or neither of plane / face, face not planar or not found (REF_LOST when its recorded name is gone), no kernel for a face -> no-op
 */
export const createSketchPlane = defineCommand({
  name: 'create_sketch_plane',
  description:
    'Create a named sketch plane: a world plane (plane: "xy" | "xz" | "yz") or a planar FACE of a solid (face: { id, faceIndex | faceNear | faceName }), ' +
    'moved offset along its normal and turned spin degrees about it. Place 2D entities on it with place_on_sketch_plane, project solid edges into ' +
    'it with project_edges_to_sketch. A face plane follows the face (by its persistent name) when the model regenerates. Returns data { id, frame }.',
  params: z.object({
    name: z.string().describe('Display name. Default "Plane N".').optional(),
    plane: z.enum(['xy', 'xz', 'yz']).describe('World base plane (xz faces -Y, yz faces +X). Give plane OR face.').optional(),
    face: z
      .object({
        id: z.string().describe('Id of the 3D solid that carries the face.'),
        faceIndex: z.number().int().nonnegative().describe('0-based face index (inspect_faces).').optional(),
        faceNear: vec3('A point [x, y, z] on the face.').optional(),
        faceName: z.string().min(1).describe('Persistent face name (recorded automatically).').optional(),
      })
      .describe('A planar face of a solid as the base plane. Needs the native kernel. Give plane OR face.')
      .optional(),
    faceNames: z
      .array(z.string().min(1))
      .describe(
        'Persistent name of the face (recorded automatically from the first pick; wins over face.faceIndex / faceNear on regeneration).',
      )
      .optional(),
    offset: z.number().describe('Distance along the plane normal, document units. Default 0.').optional(),
    spin: z.number().describe('Rotation of the plane x axis about the normal, degrees. Default 0.').optional(),
  }),
  run: (doc, { name, plane, face, faceNames, offset = 0, spin = 0 }, ctx): CommandResult => {
    if ((plane === undefined) === (face === undefined)) return noop(doc, 'create_sketch_plane: give plane OR face; document unchanged.');
    let base: SketchPlaneBase;
    let frame: PlaneFrame;
    let faceName: string | null = null;
    if (plane !== undefined) {
      base = { kind: 'world', plane };
      frame = WORLD_FRAMES[plane];
    } else {
      const recorded = faceNames?.[0];
      const resolved = faceFrame(doc, ctx, recorded === undefined ? (face as FacePick) : { ...(face as FacePick), faceName: recorded });
      if ('problem' in resolved) {
        const refused = noop(doc, `create_sketch_plane: ${resolved.problem}; document unchanged.`);
        return resolved.code === undefined
          ? refused
          : { ...refused, error: { code: resolved.code, ids: [], paths: ['face.faceName'], remediation: 'Re-pick the face.' } };
      }
      faceName = resolved.name;
      base = { kind: 'face', entityId: (face as FacePick).id, ...(faceName === null ? {} : { faceName }) };
      frame = resolved.frame;
    }
    const id = nextId('plane');
    const count = Object.keys(doc.sketchPlanes ?? {}).length + 1;
    const entry: SketchPlane = {
      id,
      name: name ?? `Plane ${count}`,
      base,
      offset,
      spin: (spin * Math.PI) / 180,
      frame: offsetFrame(frame, offset, (spin * Math.PI) / 180),
    };
    const result = changed(
      { ...doc, sketchPlanes: { ...(doc.sketchPlanes ?? {}), [id]: entry } },
      `create_sketch_plane: '${entry.name}' (${id}) at [${entry.frame.origin.join(', ')}], normal [${entry.frame.normal.join(', ')}].`,
      [id],
    );
    const withData = { ...result, data: { id, frame: entry.frame } };
    const fresh = face !== undefined && face.faceName === undefined && faceNames === undefined && faceName !== null;
    return fresh ? { ...withData, recordExtras: { faceNames: [faceName] } } : withData;
  },
});

const placeable = (entity: Entity | undefined): entity is Entity => entity !== undefined && is2D(entity);

/**
 * @affects moves the given 2D entities onto the sketch plane (position + rotation); geometry unchanged
 * @failure unknown plane, an id that is not a 2D entity -> no-op
 */
export const placeOnSketchPlane = defineCommand({
  name: 'place_on_sketch_plane',
  description:
    "Put 2D entities (sketches drawn in local coordinates) on a sketch plane: each entity's local plane becomes the sketch plane, its local " +
    'origin at the plane origin plus at (plane-local [x, y]). Extrude / revolve them afterwards as usual. Regeneration re-places them, so a ' +
    'sketch on a face plane follows the face.',
  params: z.object({
    ids: z.array(z.string()).min(1).describe('Ids of the 2D entities to place.'),
    plane: z.string().describe('Sketch plane id (create_sketch_plane).'),
    at: vec2("Plane-local [x, y] of the entities' local origin. Default [0, 0].").optional(),
  }),
  run: (doc, { ids, plane, at = [0, 0] }): CommandResult => {
    const target = doc.sketchPlanes?.[plane];
    if (target === undefined) return noop(doc, `place_on_sketch_plane: no sketch plane '${plane}'; document unchanged.`);
    const bad = ids.filter((id) => !placeable(doc.entities[id]));
    if (bad.length > 0) return noop(doc, `place_on_sketch_plane: ${bad.join(', ')} not 2D entities; document unchanged.`);
    const { frame } = target;
    const origin = add3(frame.origin, add3(scale3(frame.xDir, at[0] ?? 0), scale3(cross3(frame.normal, frame.xDir), at[1] ?? 0)));
    const { rotation } = placementOf(frame);
    const entities = { ...doc.entities };
    for (const id of ids) {
      const entity = entities[id];
      if (entity !== undefined) entities[id] = { ...entity, position: origin, rotation };
    }
    return changed(
      { ...doc, entities },
      `place_on_sketch_plane: placed ${ids.length} entit${ids.length === 1 ? 'y' : 'ies'} on '${target.name}'.`,
      [...ids],
    );
  },
});

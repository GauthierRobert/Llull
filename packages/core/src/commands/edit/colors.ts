/** Display colour of entities (set_entity_color) and of single faces of a mesh solid or parametric primitive (set_face_color). */

import type { Entity, FaceColor, Vec3 } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, vec3, z } from '../schema';
import { changed, noop } from '../noop';
import { isHexColor } from '../../lib/isHexColor';
import { inverseEulerXYZ } from '../../lib/eulerRotation';
import { sub3 } from '../../lib/vec3';
import { meshDiagonal } from '../../geometry/meshExtent';
import { acceptsFaceColors, faceColorMesh, mergeFaceColors, ordinalPoints } from '../../geometry/faceColors';
import { patternFollowers } from '../entity/patternCopies';
import { replaceEntity } from '../entity/entityOps';

/** Picks within this fraction of the mesh diagonal count as on the mesh (covers the chordal deviation of curved faces). */
const PICK_TOLERANCE = 0.01;

const formatPoint = (p: Vec3): string => `[${p.map((x) => Number(x.toFixed(4))).join(', ')}]`;

/**
 * @affects sets `color` on each existing target and on its pattern copies that still carry the target's colour; affected = changed ids
 * @invariant geometry, placement and materials are not changed; an entity whose colour already equals `color` is still listed
 * @failure color not #rrggbb, or no target id exists -> no-op, affected:[]
 */
export const setEntityColor = defineCommand({
  name: 'set_entity_color',
  annotations: { idempotent: true },
  description:
    'Set the display colour of one or more entities (2D or 3D). Pattern copies made by array_linear / array_polar / pattern_along_path ' +
    'follow their seed: a copy whose colour still equals its seed colour is recoloured too (a copy recoloured on its own is left alone). ' +
    'An assigned material (assign_material) still draws with the material colour in the viewport; the summary says so. Unknown ids are ' +
    'skipped and listed. Per-face colours of a mesh solid: set_face_color.',
  params: z.object({
    entityIds: z.array(z.string()).min(1).describe('Ids of the entities to recolour, e.g. ["box-1.1"].'),
    color: z.string().describe('Hex colour "#rrggbb", e.g. "#c8553d"; any other format is rejected.'),
  }),
  run: (doc, { entityIds, color }): CommandResult => {
    if (!isHexColor(color)) return noop(doc, `set_entity_color: color must be a #rrggbb hex string (got "${color}").`);
    const targets = [...new Set(entityIds)].filter((id) => Object.hasOwn(doc.entities, id));
    const missing = entityIds.filter((id) => !Object.hasOwn(doc.entities, id));
    if (targets.length === 0) return noop(doc, `set_entity_color: no entity found — missing: ${missing.join(', ')}.`);
    const followers = patternFollowers(doc, targets, 'color');
    const entities: Record<string, Entity> = { ...doc.entities };
    for (const id of [...targets, ...followers]) entities[id] = { ...(entities[id] as Entity), color };
    const parts = [
      `set_entity_color: ${targets.length} ${targets.length === 1 ? 'entity' : 'entities'} set to ${color} (${targets.join(', ')}).`,
    ];
    if (followers.length > 0)
      parts.push(
        `Also recoloured ${followers.length} pattern ${followers.length === 1 ? 'copy' : 'copies'} of them (${followers.join(', ')}).`,
      );
    const withMaterial = [...targets, ...followers].filter((id) => doc.entities[id]?.materialId !== undefined);
    if (withMaterial.length > 0) parts.push(`Note: ${withMaterial.join(', ')} draw with their assigned material colour in the viewport.`);
    if (missing.length > 0) parts.push(`Missing ids skipped: ${missing.join(', ')}.`);
    return changed({ ...doc, entities }, parts.join(' '), [...targets, ...followers]);
  },
});

/**
 * @affects sets / replaces / removes entries of `faceColors` on one mesh solid or parametric primitive; affected = [id]
 * @invariant geometry, `color` and placement are not changed; picks are stored in the entity frame, so moving the solid keeps its face colours
 * @failure unknown id, an entity kind without faces to colour, color not #rrggbb, or no pick on the solid -> no-op, affected:[]
 */
export const setFaceColor = defineCommand({
  name: 'set_face_color',
  annotations: { idempotent: true },
  description:
    'Colour single faces of a mesh solid (kind "mesh": results of booleans, fillets, shells and other kernel operations, imported bodies) or of a ' +
    'parametric primitive (box, cylinder, sphere, cone, torus, wedge, pyramid, extrusion, revolution; the faces are those of its tessellation, e.g. the six sides of a box). ' +
    'Pick each face by a point on it (faceNear, document frame, like draft_faces facesNear). A face is the smooth surface patch around ' +
    'the point (bounded by its B-rep edges on exact-kernel results, by creases sharper than 30 degrees on other meshes). Omit color to ' +
    'reset the picked faces to the entity colour. Drawn in the viewport (mesh solids), in render_view and written to glTF / GLB exports (one mesh node per face colour). ' +
    'Points farther than 1% of the solid size from it are skipped and listed. On a parametric primitive the picked patches are recorded as ordinals (faces) so the colour stays on the same side when the primitive is resized by edit_step_params; a revolution with few segments (facets steeper than 30 degrees) has one patch per facet strip.',
  params: z.object({
    id: z.string().describe('Id of the mesh solid or parametric primitive.'),
    faceNear: z
      .array(vec3('A point [x, y, z] on the face, document frame.'))
      .min(1)
      .optional()
      .describe('One point per face to colour (give this or faces).'),
    faces: z
      .array(z.number().int().min(0))
      .min(1)
      .optional()
      .describe(
        'Parametric primitives only: patch ordinals (the `faces` this command recorded for a faceNear pick, in triangle order of the tessellation). They win over faceNear and survive a resize of the primitive.',
      ),
    color: z.string().optional().describe('Hex colour "#rrggbb". Omit to clear the colour of the picked faces.'),
  }),
  run: (doc, { id, faceNear, faces, color }): CommandResult => {
    const entity = doc.entities[id];
    if (entity === undefined) return noop(doc, `set_face_color: entity '${id}' does not exist.`);
    if (!acceptsFaceColors(entity))
      return noop(
        doc,
        `set_face_color: '${id}' is a ${entity.kind}; per-face colours apply to mesh solids and to box, cylinder, sphere, cone, torus, wedge, pyramid, extrusion and revolution. Use set_entity_color for the whole entity.`,
      );
    if (color !== undefined && !isHexColor(color)) return noop(doc, `set_face_color: color must be a #rrggbb hex string (got "${color}").`);
    const mesh = faceColorMesh(entity);
    const parametric = entity.kind !== 'mesh';
    if (faces !== undefined && !parametric)
      return noop(
        doc,
        `set_face_color: faces (patch ordinals) apply to parametric primitives; '${id}' is a mesh solid, pick with faceNear.`,
      );
    if (faces === undefined && faceNear === undefined)
      return noop(doc, 'set_face_color: give faceNear (points on the faces) or faces (patch ordinals).');
    const centres = faces === undefined ? [] : ordinalPoints(mesh);
    const outOfRange = (faces ?? []).filter((ordinal) => ordinal >= centres.length);
    const local: Vec3[] =
      faces === undefined
        ? (faceNear ?? []).map((point) => inverseEulerXYZ(sub3(point, entity.position), entity.rotation))
        : faces.flatMap((ordinal) => (centres[ordinal] === undefined ? [] : [centres[ordinal] as Vec3]));
    const tolerance = PICK_TOLERANCE * meshDiagonal(mesh) + 1e-9;
    const merge = mergeFaceColors(mesh, 'faceColors' in entity ? (entity.faceColors ?? []) : [], local, color, tolerance, parametric);
    const missed = faces === undefined ? (faceNear ?? []).filter((_, index) => merge.missed.includes(local[index] as Vec3)) : [];
    if (merge.applied.length === 0)
      return noop(
        doc,
        `set_face_color: no point lies on '${id}' (${[...missed.map(formatPoint), ...outOfRange.map((o) => `face ${o}`)].join(', ')}).`,
      );
    const next: Entity & { faceColors?: ReadonlyArray<FaceColor> } = { ...entity };
    if (merge.faceColors.length > 0) next.faceColors = merge.faceColors;
    else delete next.faceColors;
    const action = color === undefined ? 'cleared the colour of' : `set ${color} on`;
    const skipped = missed.length === 0 ? '' : ` Skipped points off the solid: ${missed.map(formatPoint).join(', ')}.`;
    const dropped = outOfRange.length === 0 ? '' : ` Dropped faces with no such patch: ${outOfRange.join(', ')}.`;
    const kept = parametric ? ` Patch ordinals ${merge.ordinals.join(', ')} are recorded and replayed; faceNear is then ignored.` : '';
    return {
      ...changed(
        replaceEntity(doc, next),
        `set_face_color: ${action} ${merge.applied.length} face(s) of ${id} (${merge.faceColors.length} coloured face(s) in total).${skipped}${dropped}${kept}`,
        [id],
      ),
      ...(parametric ? { recordExtras: { faces: merge.ordinals } } : {}),
    };
  },
});

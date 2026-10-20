import { SURFACE_PARAMETERS, type NotePmi, type SurfaceTexturePmi } from '../../model/pmi';
import { pmiText } from '../../geometry/pmiText';
import { nextId } from '../../lib/id';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { changed } from '../noop';
import { facesNearField, featureOf, isRefusal, placementField, placementFor, resolveOn, solidTarget } from './featureOps';
import { REVIEW_REQUIRED, refuse, withItem } from './pmiOps';

/**
 * @affects adds 1 SurfaceTexturePmi; affected = [pmiId]
 * @invariant value > 0; parameter in Ra Rz Rq Rsk Rku Rmax Sa Sz; unit um (default) or uin
 * @failure unknown parameter, value <= 0, not a solid, no OCC topology, point not on a face -> coded refusal, affected:[]
 */
export const addSurfaceTexture = defineCommand({
  name: 'add_surface_texture',
  annotations: { requiresKernel: true },
  description:
    'Add a surface texture requirement (roughness) on faces of a 3D solid: parameter (Ra, Rz, Rq, Rsk, Rku, Rmax, Sa, Sz), value > 0 in ' +
    'micrometres (unit um, default) or microinches (uin), optional lay symbol text and process text (e.g. "ground"). Faces are named by ' +
    'facesNear points. Needs the OCC kernel. Refusals: GDT_SURFACE_PARAMETER_UNKNOWN, GDT_ZONE_NON_POSITIVE, GDT_POINT_NOT_ON_FACE. Review required.',
  params: z.object({
    entityId: z.string().describe('Id of the 3D solid.'),
    facesNear: facesNearField,
    parameter: z.string().describe('Roughness parameter: Ra, Rz, Rq, Rsk, Rku, Rmax, Sa or Sz.'),
    value: z.number().describe('Requirement value, > 0, in the unit below.'),
    unit: z.enum(['um', 'uin']).optional().describe('um = micrometres (default), uin = microinches.'),
    lay: z.string().optional().describe('Lay symbol text, e.g. "=" or "perpendicular".'),
    process: z.string().optional().describe('Manufacturing process text, e.g. "ground".'),
    placement: placementField.optional(),
  }),
  run: (doc, { entityId, facesNear, parameter, value, unit = 'um', lay, process, placement }, ctx): CommandResult => {
    const command = 'add_surface_texture';
    if (!(SURFACE_PARAMETERS as readonly string[]).includes(parameter))
      return refuse(doc, command, 'GDT_SURFACE_PARAMETER_UNKNOWN', `unknown parameter '${parameter}'`, [], ['parameter']);
    if (!(value > 0)) return refuse(doc, command, 'GDT_ZONE_NON_POSITIVE', `value ${value} must be > 0`, [], ['value']);
    const target = solidTarget(doc, command, entityId, ctx);
    if (isRefusal(target)) return target;
    const resolved = resolveOn(doc, command, target, facesNear, 'facesNear');
    if (isRefusal(resolved)) return resolved;
    const id = nextId('pmi');
    const item: SurfaceTexturePmi = {
      id,
      kind: 'surface_texture',
      parameter,
      value,
      unit,
      ...(lay === undefined ? {} : { lay }),
      ...(process === undefined ? {} : { process }),
      feature: featureOf(entityId, facesNear, resolved),
      placement: placementFor(doc, resolved.faces[0], resolved.diagonal, placement),
      review: REVIEW_REQUIRED,
    };
    return changed(
      withItem(doc, item),
      `add_surface_texture: ${pmiText(item)} (${id}) on '${entityId}' face(s) ${item.feature.faceIndices.join(', ')}; review required.`,
      [id],
    );
  },
});

/**
 * @affects adds 1 NotePmi; affected = [pmiId]
 * @invariant text non-empty; with entityId + facesNear the note is attached to those faces (OCC kernel needed), else it is a free note
 * @failure empty text; facesNear without entityId; attached note without OCC topology -> coded refusal, affected:[]
 */
export const addPmiNote = defineCommand({
  name: 'add_pmi_note',
  description:
    'Add a text note to the PMI: a drawing / model note such as "BREAK ALL SHARP EDGES 0.2-0.5". Free by default (no kernel needed); with ' +
    'entityId + facesNear it is attached to faces of a 3D solid (needs the OCC kernel) and placed on their annotation plane. Text is stored as ' +
    'given. Review required.',
  params: z.object({
    text: z.string().describe('Note text (non-empty).'),
    entityId: z.string().optional().describe('Id of the 3D solid, required with facesNear.'),
    facesNear: facesNearField.optional(),
    placement: placementField.optional(),
  }),
  run: (doc, { text, entityId, facesNear, placement }, ctx): CommandResult => {
    const command = 'add_pmi_note';
    if (text.trim() === '') return refuse(doc, command, 'GDT_NOTE_EMPTY', 'the note text is empty', [], ['text']);
    if (facesNear !== undefined && entityId === undefined)
      return refuse(doc, command, 'GDT_ENTITY_NOT_SOLID', 'facesNear needs the entityId of the solid', [], ['entityId']);
    const id = nextId('pmi');
    const base = { id, kind: 'note', text, review: REVIEW_REQUIRED } as const;
    if (facesNear === undefined || entityId === undefined) {
      const item: NotePmi = { ...base, placement: placementFor(doc, undefined, 1, placement) };
      return changed(withItem(doc, item), `add_pmi_note: free note ${id}: "${text}"; review required.`, [id]);
    }
    const target = solidTarget(doc, command, entityId, ctx);
    if (isRefusal(target)) return target;
    const resolved = resolveOn(doc, command, target, facesNear, 'facesNear');
    if (isRefusal(resolved)) return resolved;
    const item: NotePmi = {
      ...base,
      feature: featureOf(entityId, facesNear, resolved),
      placement: placementFor(doc, resolved.faces[0], resolved.diagonal, placement),
    };
    return changed(withItem(doc, item), `add_pmi_note: note ${id} on '${entityId}': "${text}"; review required.`, [id]);
  },
});

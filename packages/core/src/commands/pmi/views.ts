import type { PmiCamera, SavedView } from '../../model/pmi';
import { VIEW_DIRECTIONS } from '../../model/sheet';
import { fitFraming } from '../../geometry/viewFraming';
import type { CadDocument } from '../../model/types';
import { nextId } from '../../lib/id';
import type { CommandResult } from '../types';
import { defineCommand, vec3, z } from '../schema';
import { changed, noop, report } from '../noop';
import { DIRECTION_PRESETS } from '../document/camera';
import { computeSceneSnapshot } from '../inspect/scene';
import { pmiOf, refuse, withSavedView, withoutSavedView } from './pmiOps';

const cameraField = z
  .object({
    target: vec3('Orbit target [x, y, z], document units.'),
    azimuth: z.number().describe('Horizontal orbit angle, radians (see set_camera).'),
    polar: z.number().describe('Vertical orbit angle, radians (0 = overhead).'),
    distance: z.number().positive().describe('Orbit radius, document units, > 0.'),
  })
  .describe('Explicit camera { target, azimuth, polar, distance } (same fields as set_camera).');

const sectionField = z
  .object({
    direction: z.enum(VIEW_DIRECTIONS).describe('Side the section is viewed from.'),
    offset: z.number().describe('World coordinate of the cutting plane on the axis the view looks along, document units.'),
  })
  .describe('Optional section: cutting plane for this view.');

/** Camera framing the scene from a preset `direction` (the fit_view framing). */
function directionCamera(doc: CadDocument, direction: string): PmiCamera | null {
  const preset = Object.hasOwn(DIRECTION_PRESETS, direction) ? DIRECTION_PRESETS[direction] : undefined;
  if (preset === undefined) return null;
  const { bounds } = computeSceneSnapshot(doc);
  if (!bounds) return { target: [0, 0, 0], azimuth: preset.azimuth, polar: preset.polar, distance: 10 };
  const { center, distance } = fitFraming(bounds, 1, 1.2);
  return { target: center, azimuth: preset.azimuth, polar: preset.polar, distance };
}

/** The unknown PMI / entity ids of a view definition, or null. */
function referenceProblem(
  doc: CadDocument,
  pmiIds: readonly string[],
  entityIds: readonly string[],
): { ids: string[]; message: string } | null {
  const unknownPmi = pmiIds.filter((id) => doc.pmi === undefined || !Object.hasOwn(doc.pmi.items, id));
  const unknownEntity = entityIds.filter((id) => !Object.hasOwn(doc.entities, id));
  const ids = [...unknownPmi, ...unknownEntity];
  return ids.length === 0
    ? null
    : {
        ids,
        message: `unknown ${unknownPmi.length > 0 ? 'PMI id(s) ' + unknownPmi.join(', ') : ''}${unknownPmi.length > 0 && unknownEntity.length > 0 ? ' and ' : ''}${unknownEntity.length > 0 ? 'entity id(s) ' + unknownEntity.join(', ') : ''}`,
      };
}

const findView = (doc: CadDocument, id: string): SavedView | undefined =>
  doc.pmi !== undefined && Object.hasOwn(doc.pmi.savedViews, id) ? doc.pmi.savedViews[id] : undefined;

/**
 * @affects adds 1 SavedView; affected = [savedViewId]
 * @invariant camera = the explicit one, else the preset direction framing of the scene (as fit_view); pmiIds / entityIds exist
 * @failure neither direction nor camera, unknown preset, unknown PMI / entity id -> coded refusal, affected:[]
 */
export const createSavedView = defineCommand({
  name: 'create_saved_view',
  description:
    'Create a named saved view: a camera (a preset direction framing the scene, or an explicit camera), the set of PMI items shown in it, an ' +
    'optional entity filter and an optional section. Saved views are what a reviewer opens (activate_saved_view) and what AP242 exchange ' +
    'carries. Give direction (front, back, left, right, top, bottom, iso) OR camera. pmiIds default to none, so list the items to show ' +
    '(e.g. "$holeSize"). Refusals: GDT_VIEW_REF_UNKNOWN, GDT_FIELD_INVALID_FOR_KIND. Returns the saved view id in affected.',
  params: z.object({
    name: z.string().min(1).describe('View name, e.g. "TOP - HOLE PATTERN".'),
    direction: z.enum(VIEW_DIRECTIONS).optional().describe('Preset viewing direction framing the scene.'),
    camera: cameraField.optional(),
    pmiIds: z.array(z.string()).optional().describe('Ids of the PMI items visible in this view. Default none.'),
    entityIds: z.array(z.string()).optional().describe('Optional entity filter: only these solids are shown.'),
    section: sectionField.optional(),
  }),
  run: (doc, { name, direction, camera, pmiIds = [], entityIds, section }): CommandResult => {
    const command = 'create_saved_view';
    if ((direction === undefined) === (camera === undefined))
      return refuse(doc, command, 'GDT_FIELD_INVALID_FOR_KIND', 'give exactly one of direction or camera', [], ['direction']);
    const missing = referenceProblem(doc, pmiIds, entityIds ?? []);
    if (missing !== null) return refuse(doc, command, 'GDT_VIEW_REF_UNKNOWN', missing.message, missing.ids, ['pmiIds']);
    const resolved = camera ?? directionCamera(doc, direction ?? '');
    if (resolved === null) return noop(doc, `create_saved_view: unknown direction '${String(direction)}'; no-op.`);
    const id = nextId('pview');
    const view: SavedView = {
      id,
      name,
      camera: resolved,
      pmiIds: [...pmiIds],
      ...(entityIds === undefined ? {} : { entityIds: [...entityIds] }),
      ...(section === undefined ? {} : { section }),
    };
    const withModel = doc.pmi === undefined ? { ...doc, pmi: pmiOf(doc) } : doc;
    return changed(withSavedView(withModel, view), `create_saved_view: "${name}" (${id}) showing ${pmiIds.length} PMI item(s).`, [id]);
  },
});

/**
 * @affects replaces 1 SavedView
 * @invariant ids stay valid; the camera is replaced as a whole
 * @failure unknown view / PMI / entity id; nothing to change -> coded refusal or no-op
 */
export const updateSavedView = defineCommand({
  name: 'update_saved_view',
  annotations: { idempotent: true },
  description:
    'Edit a saved view: rename it, replace its camera (explicit or a preset direction), its PMI list, entity filter or section. Only the ' +
    'fields given change. Refusals: GDT_VIEW_REF_UNKNOWN (unknown view, PMI or entity id). Unchanged values are a no-op.',
  params: z.object({
    savedViewId: z.string().describe('Id of the saved view (from create_saved_view).'),
    name: z.string().min(1).optional().describe('New name.'),
    direction: z.enum(VIEW_DIRECTIONS).optional().describe('New preset direction (re-frames the scene).'),
    camera: cameraField.optional(),
    pmiIds: z.array(z.string()).optional().describe('Replacement list of visible PMI ids.'),
    entityIds: z.array(z.string()).optional().describe('Replacement entity filter ([] clears it).'),
    section: sectionField.optional(),
  }),
  run: (doc, { savedViewId, name, direction, camera, pmiIds, entityIds, section }): CommandResult => {
    const command = 'update_saved_view';
    const view = findView(doc, savedViewId);
    if (view === undefined)
      return refuse(doc, command, 'GDT_VIEW_REF_UNKNOWN', `no saved view '${savedViewId}'`, [savedViewId], ['savedViewId']);
    if (direction !== undefined && camera !== undefined)
      return refuse(doc, command, 'GDT_FIELD_INVALID_FOR_KIND', 'give direction or camera, not both', [], ['direction']);
    const missing = referenceProblem(doc, pmiIds ?? [], entityIds ?? []);
    if (missing !== null) return refuse(doc, command, 'GDT_VIEW_REF_UNKNOWN', missing.message, missing.ids, ['pmiIds']);
    const nextCamera = camera ?? (direction === undefined ? view.camera : (directionCamera(doc, direction) ?? view.camera));
    const entities = entityIds === undefined ? view.entityIds : entityIds.length === 0 ? undefined : entityIds;
    const cut = section ?? view.section;
    const next: SavedView = {
      id: view.id,
      name: name ?? view.name,
      camera: nextCamera,
      pmiIds: pmiIds ?? view.pmiIds,
      ...(entities === undefined ? {} : { entityIds: entities }),
      ...(cut === undefined ? {} : { section: cut }),
    };
    if (JSON.stringify(next) === JSON.stringify(view))
      return noop(doc, `update_saved_view: '${savedViewId}' already has those values; no-op.`);
    return changed(withSavedView(doc, next), `update_saved_view: "${next.name}" (${savedViewId}) updated.`, [savedViewId]);
  },
});

/**
 * @affects removes 1 SavedView; clears the active view when it was that one
 * @failure unknown id -> coded refusal, affected:[]
 */
export const deleteSavedView = defineCommand({
  name: 'delete_saved_view',
  annotations: { destructive: true },
  description: 'Delete a saved view by id. PMI items are untouched. Refusal: GDT_VIEW_REF_UNKNOWN for an unknown id.',
  params: z.object({ savedViewId: z.string().describe('Id of the saved view to delete.') }),
  run: (doc, { savedViewId }): CommandResult => {
    if (findView(doc, savedViewId) === undefined)
      return refuse(doc, 'delete_saved_view', 'GDT_VIEW_REF_UNKNOWN', `no saved view '${savedViewId}'`, [savedViewId], ['savedViewId']);
    const removed = withoutSavedView(doc, savedViewId);
    const { activeSavedViewId, ...rest } = pmiOf(removed);
    const cleared = activeSavedViewId === savedViewId || activeSavedViewId === undefined ? rest : { ...rest, activeSavedViewId };
    return changed({ ...removed, pmi: cleared }, `delete_saved_view: removed ${savedViewId}.`, [savedViewId]);
  },
});

/**
 * @affects sets document.camera and pmi.activeSavedViewId (view state; no FeatureStep, survives replay)
 * @invariant the camera goes through the same field set as set_camera
 * @failure unknown id -> coded refusal, affected:[]
 */
export const activateSavedView = defineCommand({
  name: 'activate_saved_view',
  annotations: { metaHistory: true, idempotent: true },
  description:
    'Open a saved view: point the camera at its stored camera and make its PMI list the visible set (the viewport and render_view show only ' +
    'those items). View state only: it adds no feature-history step. Returns data { savedViewId, pmiIds, entityIds?, section? }. Refusal: ' +
    'GDT_VIEW_REF_UNKNOWN.',
  params: z.object({ savedViewId: z.string().describe('Id of the saved view to open.') }),
  run: (doc, { savedViewId }): CommandResult => {
    const view = findView(doc, savedViewId);
    if (view === undefined)
      return refuse(doc, 'activate_saved_view', 'GDT_VIEW_REF_UNKNOWN', `no saved view '${savedViewId}'`, [savedViewId], ['savedViewId']);
    const document: CadDocument = { ...doc, camera: view.camera, pmi: { ...pmiOf(doc), activeSavedViewId: savedViewId } };
    return report(document, `activate_saved_view: "${view.name}" (${savedViewId}) active; ${view.pmiIds.length} PMI item(s) visible.`, {
      savedViewId,
      pmiIds: view.pmiIds,
      ...(view.entityIds === undefined ? {} : { entityIds: view.entityIds }),
      ...(view.section === undefined ? {} : { section: view.section }),
    });
  },
});

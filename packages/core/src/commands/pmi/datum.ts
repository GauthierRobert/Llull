import { DATUM_TARGET_KINDS, type DatumFeaturePmi, type DatumTargetPmi } from '../../model/pmi';
import { nextId } from '../../lib/id';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { changed } from '../noop';
import { facesNearField, featureOf, isRefusal, placementField, placementFor, resolveOn, solidTarget } from './featureOps';
import { REVIEW_REQUIRED, nextDatumLabel, pmiItems, refuse, withItem } from './pmiOps';

const DATUM_SURFACES: readonly string[] = ['plane', 'cylinder', 'cone', 'sphere'];
const LABEL = /^[A-Z]{1,2}$/;

/** Datum labels already used on `entityId`. */
const labelsOn = (items: ReturnType<typeof pmiItems>, entityId: string): ReadonlyMap<string, string> =>
  new Map(
    items.flatMap((item) => (item.kind === 'datum_feature' && item.feature.entityId === entityId ? [[item.label, item.id] as const] : [])),
  );

/**
 * @affects adds 1 DatumFeaturePmi; affected = [pmiId]
 * @invariant label unique per solid and ^[A-Z]{1,2}$; the feature resolves to >= 1 plane / cylinder / cone / sphere face of the solid
 * @failure not a 3D solid, no OCC topology, point not on a face / ambiguous, label taken or invalid, unsupported surface -> coded refusal, affected:[]
 */
export const addDatumFeature = defineCommand({
  name: 'add_datum_feature',
  annotations: { requiresKernel: true },
  description:
    'Define a datum feature (datum A, B, C ...) on faces of a 3D solid: a plane, cylinder, cone or sphere named by facesNear points on the ' +
    'face(s), re-found at every replay. Omit label to take the next free letter on that solid; labels are 1-2 capital letters, unique per ' +
    'solid. Needs the OCC kernel (exact faces); Manifold refuses with GDT_KERNEL_NO_TOPOLOGY. The item is created review-required: a ' +
    'qualified engineer must accept_pmi_review it in the app. Refusals carry a code (GDT_DATUM_DUPLICATE, GDT_DATUM_LABEL_INVALID, ' +
    'GDT_POINT_NOT_ON_FACE, GDT_FACE_AMBIGUOUS, GDT_ENTITY_NOT_SOLID, GDT_KERNEL_NO_TOPOLOGY). Reference the datum afterwards from ' +
    'add_geometric_tolerance datums. Returns the pmi id in affected.',
  params: z.object({
    entityId: z.string().describe('Id of the 3D solid that carries the datum.'),
    facesNear: facesNearField,
    label: z.string().optional().describe('Datum letter(s), e.g. "A". Omit to take the next free letter.'),
    placement: placementField.optional(),
  }),
  run: (doc, { entityId, facesNear, label, placement }, ctx): CommandResult => {
    const target = solidTarget(doc, 'add_datum_feature', entityId, ctx);
    if (isRefusal(target)) return target;
    const taken = labelsOn(pmiItems(doc), entityId);
    if (label !== undefined && !LABEL.test(label))
      return refuse(doc, 'add_datum_feature', 'GDT_DATUM_LABEL_INVALID', `label '${label}' must be 1-2 capital letters`, [], ['label']);
    if (label !== undefined && taken.has(label))
      return refuse(
        doc,
        'add_datum_feature',
        'GDT_DATUM_DUPLICATE',
        `datum '${label}' already exists on '${entityId}' (${taken.get(label)})`,
        [taken.get(label) ?? ''],
        ['label'],
      );
    const resolved = resolveOn(doc, 'add_datum_feature', target, facesNear, 'facesNear');
    if (isRefusal(resolved)) return resolved;
    if (resolved.faces.some((face) => !DATUM_SURFACES.includes(face.surface)))
      return refuse(
        doc,
        'add_datum_feature',
        'GDT_POINT_NOT_ON_FACE',
        `a datum feature must be a plane, cylinder, cone or sphere; the faces are ${resolved.surface}`,
        [entityId],
        ['facesNear'],
      );
    const chosen = label ?? nextDatumLabel(new Set(taken.keys()));
    const id = nextId('pmi');
    const item: DatumFeaturePmi = {
      id,
      kind: 'datum_feature',
      label: chosen,
      feature: featureOf(entityId, facesNear, resolved),
      placement: placementFor(doc, resolved.faces[0], resolved.diagonal, placement),
      review: REVIEW_REQUIRED,
    };
    return changed(
      withItem(doc, item),
      `add_datum_feature: datum ${chosen} (${id}) on '${entityId}', ${resolved.surface} face(s) ${item.feature.faceIndices.join(', ')}; review required.`,
      [id],
    );
  },
});

/**
 * @affects adds 1 DatumTargetPmi; affected = [pmiId]
 * @invariant the datum label must already exist on the same solid; targetNumber unique per datum
 * @failure undefined datum, not a solid, no OCC topology, point not on a face, targetNumber taken, area without areaSize -> coded refusal, affected:[]
 */
export const addDatumTarget = defineCommand({
  name: 'add_datum_target',
  annotations: { requiresKernel: true },
  description:
    'Add a datum target (point, line or area contact) of an existing datum on faces of the same solid, shown as A1, A2 ... Area targets need ' +
    'areaSize (contact diameter, document units). Targets are used when a whole feature is too irregular to be the datum (castings, sheet). ' +
    'The datum must exist first (add_datum_feature). Omit targetNumber for the next number of that datum. Needs the OCC kernel. ' +
    'Returns the pmi id in affected; review required.',
  params: z.object({
    entityId: z.string().describe('Id of the 3D solid.'),
    label: z.string().describe('Letter of the datum this target belongs to; must already exist on the solid.'),
    targetKind: z.enum(DATUM_TARGET_KINDS).describe('point, line or area.'),
    facesNear: facesNearField,
    targetNumber: z.number().int().min(1).optional().describe('Target index within the datum (A1 = 1). Omit for the next free number.'),
    areaSize: z.number().positive().optional().describe('Area targets only: diameter of the contact area, document units.'),
    placement: placementField.optional(),
  }),
  run: (doc, { entityId, label, targetKind, facesNear, targetNumber, areaSize, placement }, ctx): CommandResult => {
    const target = solidTarget(doc, 'add_datum_target', entityId, ctx);
    if (isRefusal(target)) return target;
    const items = pmiItems(doc);
    if (!labelsOn(items, entityId).has(label))
      return refuse(doc, 'add_datum_target', 'GDT_DATUM_UNDEFINED', `datum '${label}' is not defined on '${entityId}'`, [], ['label']);
    if (targetKind === 'area' && areaSize === undefined)
      return refuse(doc, 'add_datum_target', 'GDT_ZONE_NON_POSITIVE', 'an area target needs areaSize > 0', [], ['areaSize']);
    const used = items.flatMap((item): number[] => (item.kind === 'datum_target' && item.label === label ? [item.targetNumber] : []));
    const number = targetNumber ?? Math.max(0, ...used) + 1;
    if (used.includes(number))
      return refuse(doc, 'add_datum_target', 'GDT_DATUM_DUPLICATE', `target ${label}${number} already exists`, [], ['targetNumber']);
    const resolved = resolveOn(doc, 'add_datum_target', target, facesNear, 'facesNear');
    if (isRefusal(resolved)) return resolved;
    const id = nextId('pmi');
    const item: DatumTargetPmi = {
      id,
      kind: 'datum_target',
      label,
      targetNumber: number,
      targetKind,
      ...(areaSize === undefined ? {} : { areaSize }),
      feature: featureOf(entityId, facesNear, resolved),
      placement: placementFor(doc, resolved.faces[0], resolved.diagonal, placement),
      review: REVIEW_REQUIRED,
    };
    return changed(
      withItem(doc, item),
      `add_datum_target: ${targetKind} target ${label}${number} (${id}) on '${entityId}'; review required.`,
      [id],
    );
  },
});

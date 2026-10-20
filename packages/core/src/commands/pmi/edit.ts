import { SIZE_MODIFIERS, ZONE_MODIFIERS, type PmiItem, type PmiKind } from '../../model/pmi';
import { pmiText } from '../../geometry/pmiText';
import type { CadDocument } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { changed, noop } from '../noop';
import { facesNearField, placementField, placementFor } from './featureOps';
import { REVIEW_REQUIRED, cleanDatums, cleanZone, findPmi, pmiItems, pmiOf, refuse, withItem, withoutItems } from './pmiOps';
import { autoPlacementOf, createSolidLookup, refreshItem } from './refresh';
import { toleranceFindings } from './rules';
import { toleranceField, toleranceProblem } from './dimension';
import { currentContext } from '../context';

/** Fields `update_pmi` accepts per item kind (everything else is GDT_FIELD_INVALID_FOR_KIND). */
const FIELDS_BY_KIND: Readonly<Record<PmiKind, readonly string[]>> = {
  datum_feature: ['label', 'facesNear'],
  datum_target: ['targetNumber', 'areaSize', 'facesNear'],
  size_dimension: ['tolerance', 'sizeModifiers', 'facesNear'],
  location_dimension: ['tolerance'],
  geometric_tolerance: ['zone', 'materialCondition', 'modifiers', 'datums', 'facesNear'],
  surface_texture: ['parameter', 'value', 'unit', 'lay', 'process', 'facesNear'],
  note: ['text', 'facesNear'],
};
const COMMON_FIELDS = ['placement', 'autoPlacement'];

const zoneEdit = z
  .object({
    value: z.number().describe('Tolerance zone width or diameter, document units; > 0.'),
    diametral: z.boolean().optional().describe('true = Ø zone.'),
    spherical: z.boolean().optional().describe('true = SØ zone.'),
    projectedLength: z.number().optional().describe('Projected zone length, document units; > 0.'),
    unequallyDisposed: z.number().optional().describe('UZ value within [0, value].'),
    maxValue: z.number().optional().describe('Maximum value of the tolerance.'),
  })
  .describe('Replacement tolerance zone (geometric_tolerance).');

/** Optional-property clean-up of the structured edit fields. */
const normalised = (key: string, value: unknown): unknown =>
  key === 'zone'
    ? cleanZone(value as Parameters<typeof cleanZone>[0])
    : key === 'datums'
      ? cleanDatums(value as Parameters<typeof cleanDatums>[0])
      : value;

/** The item with `patch` applied, or the first field that is invalid for its kind. */
function patched(item: PmiItem, patch: Readonly<Record<string, unknown>>): PmiItem | { readonly invalid: string } {
  const allowed = [...FIELDS_BY_KIND[item.kind], ...COMMON_FIELDS];
  const given = Object.keys(patch).filter((key) => patch[key] !== undefined);
  const invalid = given.find((key) => !allowed.includes(key));
  if (invalid !== undefined) return { invalid };
  const fields = Object.fromEntries(
    given.filter((key) => key !== 'facesNear' && !COMMON_FIELDS.includes(key)).map((key) => [key, normalised(key, patch[key])]),
  );
  return { ...item, ...fields } as PmiItem;
}

const setFacesNear = (item: PmiItem, points: readonly (readonly [number, number, number])[]): PmiItem => {
  const near = points.map((p): readonly [number, number, number] => [p[0], p[1], p[2]]);
  switch (item.kind) {
    case 'geometric_tolerance':
      return 'feature' in item.target ? { ...item, target: { feature: { ...item.target.feature, facesNear: near } } } : item;
    case 'location_dimension':
      return item;
    case 'note':
      return item.feature === undefined ? item : { ...item, feature: { ...item.feature, facesNear: near } };
    default:
      return { ...item, feature: { ...item.feature, facesNear: near } };
  }
};

/**
 * @affects replaces 1 PMI item (id and kind never change); a renamed datum label also rewrites the frames that reference it
 * @invariant the edited item is review-required again; derived data (faceIndices, measured size, count) is re-resolved when the kernel can
 * @failure unknown id, field invalid for the kind, rule of check_pmi violated, label taken, facesNear that resolve to nothing, same values -> no-op
 */
export const updatePmi = defineCommand({
  name: 'update_pmi',
  annotations: { idempotent: true },
  description:
    'Edit one PMI item by id. Each kind takes only its own fields: datum_feature (label, facesNear), datum_target (targetNumber, areaSize, ' +
    'facesNear), size_dimension (tolerance, sizeModifiers, facesNear), location_dimension (tolerance), geometric_tolerance (zone, ' +
    'materialCondition, modifiers, datums, facesNear), surface_texture (parameter, value, unit, lay, process, facesNear), note (text, ' +
    'facesNear); any kind takes placement (explicit annotation plane, kept) or autoPlacement: true (recompute). facesNear re-attaches the ' +
    'item to the faces at those points (needs the OCC kernel); other edits keep the faces and refresh derived data when a kernel is present. ' +
    'Renaming a datum label rewrites the frames that reference it. The edited item needs review again. Refusals: GDT_PMI_UNKNOWN, ' +
    'GDT_FIELD_INVALID_FOR_KIND, GDT_DATUM_DUPLICATE, GDT_LIMITS_INVERTED and the add_* rule codes; unchanged values are a no-op.',
  params: z.object({
    pmiId: z.string().describe('Id of the PMI item to edit (from list_pmi or the add_* affected id).'),
    label: z.string().optional().describe('datum_feature: new datum letter(s), unique on the solid.'),
    targetNumber: z.number().int().min(1).optional().describe('datum_target: new target number.'),
    areaSize: z.number().positive().optional().describe('datum_target: new area diameter, document units.'),
    tolerance: toleranceField.optional(),
    sizeModifiers: z.array(z.enum(SIZE_MODIFIERS)).optional().describe('size_dimension: replacement ISO 14405 modifier list ([] clears).'),
    zone: zoneEdit.optional(),
    materialCondition: z.enum(['MMC', 'LMC', 'RFS']).optional().describe('geometric_tolerance: new material condition.'),
    modifiers: z.array(z.enum(ZONE_MODIFIERS)).optional().describe('geometric_tolerance: replacement zone modifier list.'),
    datums: z
      .array(
        z.object({ label: z.string().describe('Datum letter(s).'), boundary: z.enum(['MMB', 'LMB']).optional().describe('MMB or LMB.') }),
      )
      .optional()
      .describe('geometric_tolerance: replacement ordered datum references.'),
    parameter: z.string().optional().describe('surface_texture: roughness parameter.'),
    value: z.number().optional().describe('surface_texture: value > 0.'),
    unit: z.enum(['um', 'uin']).optional().describe('surface_texture: um or uin.'),
    lay: z.string().optional().describe('surface_texture: lay text.'),
    process: z.string().optional().describe('surface_texture: process text.'),
    text: z.string().optional().describe('note: replacement text.'),
    facesNear: facesNearField.optional(),
    placement: placementField.optional(),
    autoPlacement: z.boolean().optional().describe('true = recompute the automatic annotation placement.'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const command = 'update_pmi';
    const { pmiId, ...fields } = params;
    const original = findPmi(doc, pmiId);
    if (original === undefined) return refuse(doc, command, 'GDT_PMI_UNKNOWN', `no PMI item '${pmiId}'`, [pmiId], ['pmiId']);
    const result = patched(original, fields);
    if ('invalid' in result)
      return refuse(
        doc,
        command,
        'GDT_FIELD_INVALID_FOR_KIND',
        `field '${result.invalid}' does not apply to a ${original.kind}`,
        [pmiId],
        [result.invalid],
      );
    let next: PmiItem = fields.facesNear === undefined ? result : setFacesNear(result, fields.facesNear);
    if (fields.placement !== undefined) next = { ...next, placement: placementFor(doc, undefined, 1, fields.placement) };
    if (JSON.stringify({ ...next, review: 0 }) === JSON.stringify({ ...original, review: 0 }) && fields.autoPlacement !== true)
      return noop(doc, `update_pmi: '${pmiId}' already has those values; no-op.`);
    const renamed = next.kind === 'datum_feature' && original.kind === 'datum_feature' && next.label !== original.label ? next : undefined;
    if (renamed !== undefined) {
      if (!/^[A-Z]{1,2}$/.test(renamed.label))
        return refuse(doc, command, 'GDT_DATUM_LABEL_INVALID', `label '${renamed.label}' must be 1-2 capital letters`, [], ['label']);
      const clash = pmiItems(doc).find(
        (o) => o.kind === 'datum_feature' && o.id !== pmiId && o.label === renamed.label && o.feature.entityId === renamed.feature.entityId,
      );
      if (clash !== undefined)
        return refuse(doc, command, 'GDT_DATUM_DUPLICATE', `datum '${renamed.label}' already exists (${clash.id})`, [clash.id], ['label']);
    }
    if ((next.kind === 'size_dimension' || next.kind === 'location_dimension') && fields.tolerance !== undefined) {
      const problem = toleranceProblem(fields.tolerance);
      if (problem !== null) return refuse(doc, command, 'GDT_LIMITS_INVERTED', problem, [pmiId], ['tolerance']);
    }
    if (next.kind === 'surface_texture' && !(next.value > 0))
      return refuse(doc, command, 'GDT_ZONE_NON_POSITIVE', `value ${next.value} must be > 0`, [pmiId], ['value']);
    if (next.kind === 'note' && next.text.trim() === '')
      return refuse(doc, command, 'GDT_NOTE_EMPTY', 'the note text is empty', [pmiId], ['text']);
    const lookup = createSolidLookup(doc, (ctx ?? currentContext()).kernel);
    const reattach = fields.facesNear !== undefined;
    const refreshed = refreshItem(next, lookup, reattach);
    const blocking = refreshed.findings.find((f) => f.severity === 'error');
    if (reattach && blocking !== undefined) return refuse(doc, command, blocking.code, blocking.message, [pmiId], blocking.paths);
    if (reattach && refreshed.notRun)
      return refuse(
        doc,
        command,
        'GDT_KERNEL_NO_TOPOLOGY',
        'requires the OCC kernel (exact topology and face queries)',
        [pmiId],
        ['facesNear'],
      );
    next = { ...refreshed.item, review: REVIEW_REQUIRED };
    if (fields.autoPlacement === true || (reattach && next.placement.auto))
      next = { ...next, placement: autoPlacementOf(doc, next, lookup) };
    let document = doc;
    const touched = [pmiId];
    if (original.kind === 'datum_feature' && next.kind === 'datum_feature' && next.label !== original.label) {
      for (const other of pmiItems(doc)) {
        const rename = (label: string): string => (label === original.label ? next.label : label);
        if (other.kind === 'geometric_tolerance' && other.datums.some((d) => d.label === original.label) && other.target !== undefined) {
          const entity = 'feature' in other.target ? other.target.feature.entityId : undefined;
          if (entity !== undefined && entity !== original.feature.entityId) continue;
          document = withItem(document, { ...other, datums: other.datums.map((d) => ({ ...d, label: rename(d.label) })) });
          touched.push(other.id);
        }
        if (other.kind === 'datum_target' && other.label === original.label && other.feature.entityId === original.feature.entityId) {
          document = withItem(document, { ...other, label: next.label });
          touched.push(other.id);
        }
      }
    }
    if (next.kind === 'geometric_tolerance') {
      const problem = toleranceFindings(next, { ...pmiOf(document).items, [next.id]: next }).find((f) => f.severity === 'error');
      if (problem !== undefined) return refuse(doc, command, problem.code, problem.message, problem.pmiIds, problem.paths);
    }
    return changed(
      withItem(document, next),
      `update_pmi: ${original.kind} ${pmiId} now ${pmiText(next)}${touched.length > 1 ? `; also rewrote ${touched.slice(1).join(', ')}` : ''}; review required.`,
      touched,
    );
  },
});

/** Ids of the items that depend on `id` and go with it: frames targeting a size dimension, composite lower segments. */
function dependents(doc: CadDocument, id: string): string[] {
  const found = new Set<string>();
  const queue = [id];
  for (let current = queue.pop(); current !== undefined; current = queue.pop()) {
    for (const item of pmiItems(doc)) {
      if (item.kind !== 'geometric_tolerance' || found.has(item.id) || item.id === id) continue;
      if (('pmiId' in item.target && item.target.pmiId === current) || item.compositeOf === current) {
        found.add(item.id);
        queue.push(item.id);
      }
    }
  }
  return [...found];
}

/** Frames and targets that reference datum `datum` (label on its solid). */
function datumReferrers(doc: CadDocument, datum: Extract<PmiItem, { kind: 'datum_feature' }>): string[] {
  return pmiItems(doc).flatMap((item) => {
    if (item.kind === 'datum_target' && item.label === datum.label && item.feature.entityId === datum.feature.entityId) return [item.id];
    if (item.kind !== 'geometric_tolerance' || !item.datums.some((d) => d.label === datum.label)) return [];
    const entity = 'feature' in item.target ? item.target.feature.entityId : undefined;
    return entity === undefined || entity === datum.feature.entityId ? [item.id] : [];
  });
}

/**
 * @affects removes the item, the frames that target it (size dimension) or compose it, and saved-view references; a datum still referenced is refused unless cascade
 * @invariant affected lists the removed ids, the requested one first
 * @failure unknown id; a referenced datum without cascade -> coded refusal, affected:[]
 */
export const deletePmi = defineCommand({
  name: 'delete_pmi',
  annotations: { destructive: true },
  description:
    'Delete one PMI item by id. Deleting a size dimension also deletes the feature control frames that target it, and an upper composite frame ' +
    'its lower segments; the removed ids are listed in affected. A datum feature still referenced by frames or datum targets is refused ' +
    '(GDT_DATUM_REFERENCED) unless cascade is true, which deletes the referrers as well. Saved views drop the removed ids.',
  params: z.object({
    pmiId: z.string().describe('Id of the PMI item to delete.'),
    cascade: z
      .boolean()
      .optional()
      .describe('true = also delete the frames / targets that reference a datum being deleted. Default false.'),
  }),
  run: (doc, { pmiId, cascade = false }): CommandResult => {
    const command = 'delete_pmi';
    const item = findPmi(doc, pmiId);
    if (item === undefined) return refuse(doc, command, 'GDT_PMI_UNKNOWN', `no PMI item '${pmiId}'`, [pmiId], ['pmiId']);
    const referrers = item.kind === 'datum_feature' ? datumReferrers(doc, item) : [];
    if (referrers.length > 0 && !cascade)
      return refuse(
        doc,
        command,
        'GDT_DATUM_REFERENCED',
        `datum ${item.kind === 'datum_feature' ? item.label : ''} is referenced by ${referrers.join(', ')}`,
        referrers,
        ['pmiId'],
      );
    const removed = [...new Set([pmiId, ...referrers, ...dependents(doc, pmiId), ...referrers.flatMap((r) => dependents(doc, r))])];
    return changed(
      withoutItems(doc, removed),
      `delete_pmi: removed ${removed.join(', ')} (${removed.length} item(s)); ${pmiOf(doc).order.length - removed.length} left.`,
      removed,
    );
  },
});

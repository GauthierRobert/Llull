/**
 * apply_pmi_set (03 GDT M6, TR-GDT-13): many PMI items on one solid in one step, the landing point of the AP242 import
 * (`import_step_exact` PMI stage) and of any agent that already holds a PMI list. Items name faces by `facesNear` points, exactly as the
 * single-item commands do; the import maps the face indices of the file to points before it calls this.
 * An import takes the data as found: it never refuses an item for a rule (check_pmi reports those); a feature that resolves to no face is kept
 * with `faceIndices: []` and counted in `doc.pmi.import.unresolved`.
 */

import type {
  DatumFeaturePmi,
  GeometricTolerancePmi,
  LocationDimensionPmi,
  PmiFeature,
  PmiImportRecord,
  PmiItem,
  PmiTolerance,
  SizeDimensionPmi,
} from '../../model/pmi';
import { GEOMETRIC_CHARACTERISTICS } from '../../model/pmi';
import type { CadDocument, Vec3 } from '../../model/types';
import { featureElement, locate, measureSize } from '../../geometry/pmiMeasure';
import { type ResolvedFeature, type SolidFaces, openSolid, isFeatureProblem, resolveIn } from '../../geometry/pmiFeatures';
import { nextId } from '../../lib/id';
import { defineCommand, z } from '../schema';
import { changed } from '../noop';
import type { CommandResult } from '../types';
import { type SolidTarget, facesNearField, featureOf, isRefusal, placementFor, solidTarget } from './featureOps';
import { pmiItems, pmiOf, refuse, withItem } from './pmiOps';
import { toleranceField, toleranceProblem } from './dimension';

const NO_FACE = 'the feature resolves to no face of the solid';

const draftSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('datum_feature').describe('A datum feature (datum A, B, ...).'),
    label: z.string().describe('Datum letter(s), 1-2 capitals, unique on the solid.'),
    facesNear: facesNearField,
  }),
  z.object({
    kind: z.literal('geometric_tolerance').describe('A feature control frame.'),
    characteristic: z.enum(GEOMETRIC_CHARACTERISTICS).describe('Geometric characteristic (roundness = circularity).'),
    zone: z
      .object({
        value: z.number().describe('Zone width or diameter, document length units.'),
        diametral: z.boolean().optional().describe('true = cylindrical zone (diameter symbol).'),
      })
      .describe('The tolerance zone.'),
    datums: z.array(z.string()).optional().describe('Datum labels in reference order, primary first.'),
    facesNear: facesNearField,
  }),
  z.object({
    kind: z.literal('size_dimension').describe('A size dimension on a feature of size.'),
    sizeKind: z.enum(['diameter', 'radius', 'width', 'spherical_diameter']).describe('Kind of size.'),
    tolerance: toleranceField,
    nominal: z
      .number()
      .optional()
      .describe('Nominal the source states (document units); compared with the B-rep, a difference marks the item unverified.'),
    facesNear: facesNearField,
  }),
  z.object({
    kind: z.literal('location_dimension').describe('A location dimension between two features.'),
    measure: z.enum(['distance', 'angle']).describe('distance in document units, or angle in degrees.'),
    tolerance: toleranceField.optional().describe('Tolerance; omitted = basic.'),
    nominal: z.number().optional().describe('Nominal the source states; kept when the B-rep cannot measure the two features.'),
    from: facesNearField,
    to: facesNearField,
  }),
]);

export type PmiDraft = z.output<typeof draftSchema>;

interface ApplyOutcome {
  readonly document: CadDocument;
  readonly ids: readonly string[];
  /** Items whose feature resolved to no face. */
  readonly unresolved: number;
  /** Items created but flagged unverified (unresolved, or a nominal the B-rep disagrees with). */
  readonly unverified: number;
}

/** Relative gap between a stated nominal and the measured one above which the item is flagged. */
const NOMINAL_MISMATCH = 1e-4;

const mismatch = (stated: number | undefined, measured: number): stated is number =>
  stated !== undefined && Math.abs(stated - measured) > NOMINAL_MISMATCH * Math.max(1, Math.abs(stated));

const differs = (stated: number, measured: number): string =>
  `the file states nominal ${stated} but the B-rep measures ${Number(measured.toPrecision(9))}`;

/** Items are added to `doc` in order; every item starts review-required with the import as its reason. */
export function applyPmiDrafts(doc: CadDocument, target: SolidTarget, drafts: readonly PmiDraft[], source: string): ApplyOutcome {
  const entityId = target.entity.id;
  const frame = openSolid(target.kernel, target.recipe);
  const open: SolidFaces | null = 'code' in frame ? null : frame;
  const review = { required: true, reason: `imported from ${source} — not approved by a qualified engineer` } as const;
  let next = doc;
  const ids: string[] = [];
  let unresolved = 0;
  let unverified = 0;

  const feature = (points: readonly Vec3[]): { feature: PmiFeature; faces: ResolvedFeature | null; why: string } => {
    const resolved = open === null ? null : resolveIn(open, points);
    if (resolved === null || isFeatureProblem(resolved))
      return {
        feature: { entityId, facesNear: points.map((p): Vec3 => [p[0], p[1], p[2]]), faceIndices: [], surface: 'other' },
        faces: null,
        why: resolved === null ? `${NO_FACE} (the solid cannot be opened)` : `${NO_FACE}: ${resolved.code} ${resolved.message}`,
      };
    return { feature: featureOf(entityId, points, resolved), faces: resolved, why: '' };
  };
  const placement = (resolved: ResolvedFeature | null): PmiItem['placement'] =>
    placementFor(next, resolved?.faces[0], open?.diagonal ?? 1, undefined);
  const add = (item: PmiItem, problems: readonly string[], unresolvedFeature: boolean): void => {
    next = withItem(next, problems.length > 0 ? { ...item, unverified: { reason: problems.join('; ') } } : item);
    ids.push(item.id);
    if (unresolvedFeature) unresolved += 1;
    if (problems.length > 0) unverified += 1;
  };

  for (const draft of drafts) {
    const id = nextId('pmi');
    if (draft.kind === 'datum_feature') {
      const at = feature(draft.facesNear);
      const item: DatumFeaturePmi = {
        id,
        kind: 'datum_feature',
        label: draft.label,
        feature: at.feature,
        placement: placement(at.faces),
        review,
      };
      add(item, at.faces === null ? [at.why] : [], at.faces === null);
    } else if (draft.kind === 'geometric_tolerance') {
      const at = feature(draft.facesNear);
      const defined = new Set(
        pmiItems(next).flatMap((existing) =>
          existing.kind === 'datum_feature' && existing.feature.entityId === entityId ? [existing.label] : [],
        ),
      );
      const missing = (draft.datums ?? []).filter((label) => !defined.has(label));
      const item: GeometricTolerancePmi = {
        id,
        kind: 'geometric_tolerance',
        characteristic: draft.characteristic,
        target: { feature: at.feature },
        zone: { value: draft.zone.value, ...(draft.zone.diametral === true ? { diametral: true } : {}) },
        materialCondition: 'RFS',
        modifiers: [],
        datums: (draft.datums ?? []).map((label) => ({ label })),
        placement: placement(at.faces),
        review,
      };
      add(
        item,
        [
          ...(at.faces === null ? [at.why] : []),
          ...(missing.length > 0 ? [`datum ${missing.join(', ')} is not defined on the solid`] : []),
        ],
        at.faces === null,
      );
    } else if (draft.kind === 'size_dimension') {
      const at = feature(draft.facesNear);
      const problems: string[] = at.faces === null ? [at.why] : [];
      let size: PmiFeature['ofSize'];
      let count = 1;
      if (at.faces !== null) {
        const measured = measureSize(at.faces.faces, draft.sizeKind, at.faces.topology, at.faces.tolerance);
        if ('code' in measured) problems.push(`${measured.code}: ${measured.message}`);
        else {
          size = measured.ofSize;
          count = measured.count;
          const nominal = draft.sizeKind === 'radius' ? measured.ofSize.measured / 2 : measured.ofSize.measured;
          if (mismatch(draft.nominal, nominal)) problems.push(differs(draft.nominal, nominal));
        }
      }
      const item: SizeDimensionPmi = {
        id,
        kind: 'size_dimension',
        sizeKind: draft.sizeKind,
        tolerance: draft.tolerance as PmiTolerance,
        count,
        feature: size === undefined ? at.feature : { ...at.feature, ofSize: size },
        placement: placement(at.faces),
        review,
      };
      add(item, problems, at.faces === null);
    } else {
      const from = feature(draft.from);
      const to = feature(draft.to);
      const problems: string[] = [from, to].filter((side) => side.faces === null).map((side) => side.why);
      let measured = draft.nominal ?? 0;
      if (from.faces !== null && to.faces !== null) {
        const a = featureElement(from.faces.faces, from.faces.tolerance);
        const b = featureElement(to.faces.faces, to.faces.tolerance);
        const located = 'code' in a || 'code' in b ? null : locate(a, b, draft.measure);
        if (located === null || 'code' in located) problems.push('the B-rep cannot measure the two features: the file nominal is kept');
        else {
          if (mismatch(draft.nominal, located.measured)) problems.push(differs(draft.nominal, located.measured));
          measured = located.measured;
        }
      }
      const item: LocationDimensionPmi = {
        id,
        kind: 'location_dimension',
        measure: draft.measure,
        measured,
        tolerance: (draft.tolerance ?? { type: 'basic' }) as PmiTolerance,
        from: from.feature,
        to: to.feature,
        placement: placement(to.faces),
        review,
      };
      add(item, problems, from.faces === null || to.faces === null);
    }
  }
  return { document: next, ids, unresolved, unverified };
}

/** `doc` with the import totals recorded (replaces the previous record). */
export function withImportRecord(doc: CadDocument, record: PmiImportRecord): CadDocument {
  return { ...doc, pmi: { ...pmiOf(doc), import: record } };
}

/**
 * @affects adds n PMI items on one solid (datum_feature, geometric_tolerance, size_dimension, location_dimension); sets doc.pmi.import; affected = the new pmi ids
 * @invariant features are re-found from facesNear points; every item review-required; an unresolved feature is kept with faceIndices [] and unverified
 * @failure unknown / non-solid entity, no OCC topology, duplicate datum label, inverted tolerance -> coded refusal, affected:[]
 */
export const applyPmiSet = defineCommand({
  name: 'apply_pmi_set',
  annotations: { requiresKernel: true },
  description:
    'Add many semantic PMI items to one 3D solid in one step: datum features, feature control frames (characteristic, zone, datum labels), size and ' +
    'location dimensions with tolerances. Each item names its faces by facesNear points (document units, one point ON each face; inspect_faces lists them), ' +
    'exactly as add_datum_feature / add_geometric_tolerance / add_size_dimension / add_location_dimension do, and is re-found at every replay. This is the ' +
    'import path of AP242 PMI (import_step_exact calls it per body) and the bulk path for an agent that already holds a PMI list. Items are taken as found: no ' +
    'rule is enforced (check_pmi reports them); a feature that resolves to no face is kept with faceIndices [] and counted (doc.pmi.import.unresolved), a nominal ' +
    'the B-rep disagrees with is flagged unverified. Every item is review-required; only a signed human accept_pmi_review clears it. Needs the OCC kernel. ' +
    'Refusals: GDT_ENTITY_NOT_SOLID, GDT_KERNEL_NO_TOPOLOGY, GDT_DATUM_DUPLICATE, GDT_LIMITS_INVERTED. Returns data { created, unresolved, unverified }.',
  params: z.object({
    entityId: z.string().describe('Id of the 3D solid the items attach to.'),
    items: z.array(draftSchema).min(1).describe('PMI items in creation order; a datum feature must precede the frames that reference it.'),
    source: z
      .string()
      .optional()
      .describe('Where the items come from (file name or tool), recorded in the review reason. Default "apply_pmi_set".'),
  }),
  run: (doc, { entityId, items, source }, ctx): CommandResult => {
    const command = 'apply_pmi_set';
    const target = solidTarget(doc, command, entityId, ctx);
    if (isRefusal(target)) return target;
    const taken = new Set(
      pmiItems(doc).flatMap((item) => (item.kind === 'datum_feature' && item.feature.entityId === entityId ? [item.label] : [])),
    );
    for (const [index, item] of items.entries()) {
      if (item.kind === 'datum_feature') {
        if (taken.has(item.label))
          return refuse(
            doc,
            command,
            'GDT_DATUM_DUPLICATE',
            `datum '${item.label}' already exists on '${entityId}'`,
            [],
            [`items.${index}.label`],
          );
        taken.add(item.label);
      }
      const problem =
        item.kind === 'size_dimension' || item.kind === 'location_dimension' ? toleranceProblem(item.tolerance ?? { type: 'basic' }) : null;
      if (problem !== null) return refuse(doc, command, 'GDT_LIMITS_INVERTED', problem, [], [`items.${index}.tolerance`]);
    }
    const label = source ?? command;
    const outcome = applyPmiDrafts(doc, target, items, label);
    const record: PmiImportRecord = { source: label, items: outcome.ids.length, unresolved: outcome.unresolved, unmapped: 0 };
    return {
      ...changed(
        withImportRecord(outcome.document, record),
        `apply_pmi_set: ${outcome.ids.length} PMI item(s) on '${entityId}' (${outcome.ids.join(', ')}); ${outcome.unresolved} unresolved, ${outcome.unverified} unverified; review required.`,
        [...outcome.ids],
      ),
      data: { created: outcome.ids.length, unresolved: outcome.unresolved, unverified: outcome.unverified },
    };
  },
});

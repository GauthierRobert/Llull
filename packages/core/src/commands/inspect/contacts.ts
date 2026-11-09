import { type CadDocument, type Entity, type InstanceEntity, is3D } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { codedRejection, report } from '../noop';
import { MM_PER_UNIT, fromMm } from '../../model/units';
import { entityBoundsInDoc } from '../../geometry/bounds';
import { type ContactBody, type ContactPair, contactPairs } from '../../geometry/contacts';
import { expandInstance } from '../../geometry/instanceExpansion';

const COMMAND = 'find_contacts';
/** 1e-4 in: the 08 MAT stack contact tolerance (COR FR-COR-14). */
const DEFAULT_TOLERANCE_MM = 0.0025;
const MAX_NESTING = 8;
const FIND_REMEDIATION = 'list the ids with find_entities';
const MAX_LISTED = 12;

interface Skipped {
  readonly id: string;
  readonly reason: string;
}

/** Solids of `entity`: itself, or for an instance its expanded children (ids `<instance>/<child>`, materials of the child), recursively. */
function solidsOf(doc: CadDocument, entity: Entity, path: string, depth: number, skipped: Skipped[]): ContactBody[] {
  if (entity.kind !== 'instance') return [{ id: `${path}${entity.id}`, entity, bounds: entityBoundsInDoc(doc, entity) }];
  const component = Object.hasOwn(doc.components, entity.componentId) ? doc.components[entity.componentId] : undefined;
  if (component === undefined || depth >= MAX_NESTING) {
    skipped.push({
      id: `${path}${entity.id}`,
      reason: component === undefined ? `component '${entity.componentId}' is missing` : `nesting deeper than ${MAX_NESTING} levels`,
    });
    return [];
  }
  const prefix = `expanded::${entity.id}::`;
  return expandInstance(entity as InstanceEntity, component).flatMap((child) =>
    solidsOf(
      doc,
      { ...child, id: child.id.startsWith(prefix) ? child.id.slice(prefix.length) : child.id },
      `${path}${entity.id}/`,
      depth + 1,
      skipped,
    ),
  );
}

const countsOf = (pairs: readonly ContactPair[]): Record<string, number> =>
  pairs.reduce<Record<string, number>>((counts, { kind }) => ({ ...counts, [kind]: (counts[kind] ?? 0) + 1 }), {});

/**
 * @affects nothing; read-only, document returned unchanged, affected: []
 * @invariant data = { pairs, nearMisses, skipped, tolerance: { value, unit, defaulted, source }, unit, counts }; pairs sorted by (a, b, kind) with a < b; gap / area / volume in document
 *   units; closed form for two unrotated boxes (exact), every other pair is an AABB `possible` contact flagged approximate; the broad phase uses ctx.spatialIndex
 * @failure unknown id -> COR_ENTITY_NOT_FOUND; 2D / non-solid id -> COR_ENTITY_NOT_SOLID; tolerance <= 0, not finite or nearMissFactor < 1 -> COR_TOLERANCE_INVALID (all rejections, document unchanged)
 */
export const findContacts = defineCommand({
  name: COMMAND,
  annotations: { readOnly: true, idempotent: true, readsMeshTriangles: true },
  description:
    'List which solids touch or interfere (read-only). A pair is reported when its separation is within `tolerance`: kind interference (overlap volume), ' +
    'face (contact area and the normal from a toward b), edge, vertex, or possible (non-box or rotated solids: bounding-box proximity only, approximate: true, ' +
    'no area or volume). Two unrotated boxes are exact (closed form). Assembly instances are expanded into their children (ids "<instanceId>/<childId>", ' +
    'each with its own material). Returns data: { pairs: [{ a, b, kind, gap, area, volume, normal?, materials, source, approximate }], nearMisses: [{ a, b, gap }], skipped: [{ id, reason }] (solids NOT tested: an instance whose component is missing, nesting deeper than 8), ' +
    'tolerance: { value, unit, defaulted, source }, unit, counts }; lengths, areas and volumes are in document units. Pairs are sorted by id, so equal documents give equal output. ' +
    'Default tolerance 0.0025 mm (1e-4 in), reported defaulted: true. Next: check_material_compatibility (corrosion), measure_distance.',
  params: z.object({
    entityIds: z
      .array(z.string())
      .optional()
      .describe('Only contacts among these solids (an instance id stands for its children). Omit for every 3D solid of the document.'),
    tolerance: z
      .object({
        value: z.number().describe('Positive, finite.'),
        unit: z.enum(['mm', 'cm', 'm', 'in', 'ft']).describe('Length unit of value.'),
      })
      .optional()
      .describe('Largest gap still counted as a contact. Default 0.0025 mm.'),
    nearMissFactor: z
      .number()
      .optional()
      .describe('>= 1. Also list as nearMisses the pairs whose gap is > tolerance and <= tolerance * nearMissFactor. Default: none.'),
  }),
  run: (doc, { entityIds, tolerance, nearMissFactor }, ctx): CommandResult => {
    const fail = (code: string, message: string, remediation: string, ids: readonly string[] = []): CommandResult =>
      codedRejection(doc, COMMAND, code, message, remediation, ids);
    const defaulted = tolerance === undefined;
    const toleranceMm = tolerance === undefined ? DEFAULT_TOLERANCE_MM : tolerance.value * MM_PER_UNIT[tolerance.unit];
    if (!Number.isFinite(toleranceMm) || toleranceMm <= 0)
      return fail('COR_TOLERANCE_INVALID', 'tolerance must be a finite length > 0', 'pass tolerance { value > 0, unit }');
    if (nearMissFactor !== undefined && !(Number.isFinite(nearMissFactor) && nearMissFactor >= 1))
      return fail('COR_TOLERANCE_INVALID', 'nearMissFactor must be a finite number >= 1', 'pass nearMissFactor >= 1 or omit it');
    const selected = entityIds ?? doc.order;
    const bodies: ContactBody[] = [];
    const skipped: Skipped[] = [];
    for (const id of selected) {
      const entity = Object.hasOwn(doc.entities, id) ? doc.entities[id] : undefined;
      if (entity === undefined) {
        if (entityIds !== undefined) return fail('COR_ENTITY_NOT_FOUND', `no entity '${id}'`, FIND_REMEDIATION, [id]);
        continue;
      }
      if (!is3D(entity)) {
        if (entityIds !== undefined)
          return fail('COR_ENTITY_NOT_SOLID', `'${id}' (${entity.kind}) is not a 3D solid`, FIND_REMEDIATION, [id]);
        continue;
      }
      bodies.push(...solidsOf(doc, entity, '', 0, skipped));
    }
    const tol = fromMm(doc, toleranceMm);
    const { pairs, nearMisses } = contactPairs(bodies, tol, tol * (nearMissFactor ?? 1), ctx?.spatialIndex);
    pairs.sort((x, y) => (x.a === y.a ? (x.b === y.b ? (x.kind < y.kind ? -1 : 1) : x.b < y.b ? -1 : 1) : x.a < y.a ? -1 : 1));
    const counts = countsOf(pairs);
    const listed = pairs
      .slice(0, MAX_LISTED)
      .map(
        (pair) =>
          `${pair.a}|${pair.b} ${pair.kind}${pair.area === null || pair.kind === 'possible' ? '' : ` area ${pair.area}`}${pair.volume ? ` volume ${pair.volume}` : ''}`,
      );
    const toleranceData = {
      value: tolerance === undefined ? DEFAULT_TOLERANCE_MM : tolerance.value,
      unit: tolerance === undefined ? 'mm' : tolerance.unit,
      defaulted,
      source: defaulted ? '08 MAT stack contact tolerance 1e-4 in' : 'caller',
    };
    const skippedText =
      skipped.length === 0
        ? ''
        : ` SKIPPED ${skipped.length} solid(s) that were NOT tested: ${skipped.map((entry) => `${entry.id} (${entry.reason})`).join('; ')}.`;
    const summary =
      `${COMMAND}: ${pairs.length} contact(s) among ${bodies.length} solid(s) (${
        Object.entries(counts)
          .map(([kind, n]) => `${kind} ${n}`)
          .join(', ') || 'none'
      }); ` +
      `${nearMisses.length} near miss(es); tolerance ${toleranceData.value} ${toleranceData.unit}${defaulted ? ' (defaulted)' : ''}; lengths in ${doc.units}` +
      `${listed.length > 0 ? `: ${listed.join('; ')}${pairs.length > MAX_LISTED ? '; …' : ''}` : ''}.` +
      skippedText;
    return report(doc, summary, { pairs, nearMisses, skipped, tolerance: toleranceData, unit: doc.units, counts });
  },
});

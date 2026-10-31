import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { isKindOf, resolvedOrNull } from '../classes';
import { resolveNode, subtreeIds } from '../hierarchy';
import { getPlantData, type PlantDataModel, type PlantObject } from '../model';
import { naturalCompare } from '../naturalSort';
import { formatParts } from '../objectTag';
import { sequenceField } from '../tagFormat';
import { refuse } from './params';
import { retagObjects } from './retag';

/**
 * @affects sequence field and tag of every object of the class (and its subclasses) in the hierarchy node, in natural tag order; the tag is written back to the model object; ONE step
 * @invariant new sequence = startSequence + k * step for the k-th object in natural tag order, reserved tags included; atomic: a collision or an overflow refuses the whole renumbering; a permutation of existing tags is valid
 * @failure unknown class / hierarchy, class without a sequence field, range wider than the padded field, new tag held by an object outside the selection -> DAT_* refusal, document unchanged
 */
export const renumberTags = defineCommand({
  name: 'renumber_tags',
  description:
    'Renumber the tags of a class in a hierarchy node in bulk (re-numbering after a unit split, or after importing a client tag list). The objects of className (subclasses included) at ' +
    'hierarchy (node and below; omit for the whole plant) are taken in natural tag order (P-2 before P-10), reserved tags included, and the k-th (from 0) gets the sequence number ' +
    'startSequence + k * step in the sequence field of the class tag format ({seq} or a padded integer such as {seq:2}); all other fields stay, the tags are regenerated and written ' +
    'into the model objects (equipment marks, line numbers) in the same step. Example: P-101, P-103, P-104 with startSequence 11 become P-111, P-112, P-113 (format {classCode}-{area}{seq:2}). ' +
    'Atomic: if a new tag would equal a tag held outside the selection, or the numbers do not fit the padded width, nothing changes. Returns data = { mapping [{ id, from, to }] (only ' +
    'changed tags), count, unchanged }. Refusals: DAT_CLASS_UNKNOWN, DAT_HIERARCHY_UNKNOWN, DAT_TAG_FORMAT (the format has no sequence field), DAT_RENUMBER_RANGE, DAT_TAG_DUPLICATE, ' +
    'DAT_TARGET_TAG_READONLY. Next: check_plant_data, plant_report tag_register.',
  params: z.object({
    className: z.string().min(1).describe('Class whose objects are renumbered (subclasses included), e.g. "CentrifugalPump".'),
    hierarchy: z
      .string()
      .optional()
      .describe('Hierarchy node (code, path S1/P1/U10 or id) to restrict the renumbering to; omit for the whole plant.'),
    startSequence: z.number().int().min(0).max(999_999_999).describe('Sequence number of the first object in natural tag order, e.g. 11.'),
    step: z.number().int().min(1).max(1_000_000).optional().describe('Increment between consecutive objects (default 1).'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const data = getPlantData(doc);
    const className = params.className;
    if (data.classes[className] === undefined)
      return refuse(doc, 'renumber_tags', {
        code: 'DAT_CLASS_UNKNOWN',
        message: `no class "${className}" (${data.classOrder.join(', ')})`,
        paths: ['className'],
      });
    let scope: Set<string> | null = null;
    if (params.hierarchy !== undefined) {
      const node = resolveNode(data, params.hierarchy);
      if (node === null || node === 'ambiguous')
        return refuse(doc, 'renumber_tags', {
          code: 'DAT_HIERARCHY_UNKNOWN',
          message: `no (or an ambiguous) hierarchy node "${params.hierarchy}"`,
          paths: ['hierarchy'],
        });
      scope = subtreeIds(data, node.id);
    }
    const selected = data.objectOrder
      .flatMap((id) => data.objects[id] ?? [])
      .filter((object) => isKindOf(data, object.className, className) && (scope === null || scope.has(object.hierarchyId)))
      .sort((a, b) => naturalCompare(a.tag, b.tag) || naturalCompare(a.id, b.id));
    const step = params.step ?? 1;
    const objects: Record<string, PlantObject> = { ...data.objects };
    for (const [k, object] of selected.entries()) {
      const resolved = resolvedOrNull(data, object.className);
      const parts = resolved === null ? null : formatParts(resolved);
      const counter = parts === null ? undefined : sequenceField(parts);
      if (counter === undefined)
        return refuse(doc, 'renumber_tags', {
          code: 'DAT_TAG_FORMAT',
          message: `the tag format of ${object.className} (${resolved?.tagFormat ?? 'none'}) has no sequence field ({seq} or a padded integer): ${object.tag} cannot be renumbered`,
          ids: [object.id],
          paths: ['className'],
        });
      const sequence = params.startSequence + k * step;
      if (counter.width !== undefined && String(sequence).length > counter.width)
        return refuse(doc, 'renumber_tags', {
          code: 'DAT_RENUMBER_RANGE',
          message: `the ${k + 1}-th object would get sequence ${sequence}, which does not fit {${counter.name}:${counter.width}}: widen the format or start lower`,
          ids: [object.id],
          paths: ['startSequence'],
        });
      const isProperty = resolved?.properties.some((definition) => definition.name === counter.name) === true;
      objects[object.id] = isProperty
        ? { ...object, properties: { ...object.properties, [counter.name]: sequence } }
        : { ...object, tagFields: { ...object.tagFields, [counter.name]: sequence } };
    }
    const next: PlantDataModel = { ...data, objects };
    const retagged = retagObjects(
      doc,
      next,
      selected.map((object) => object.id),
      ctx,
    );
    if (!retagged.ok) return refuse(doc, 'renumber_tags', retagged);
    const mapping = retagged.changes.map(({ id, from, to }) => ({ id, from, to }));
    if (mapping.length === 0)
      return {
        document: doc,
        summary: `renumber_tags: ${selected.length} object(s) of ${className} already carry these numbers; nothing changed.`,
        affected: [],
        data: { mapping, count: 0, unchanged: selected.length },
      };
    return {
      ...changed(
        retagged.document,
        `renumber_tags ${className}: ${mapping.length} of ${selected.length} tag(s) renumbered from ${params.startSequence} step ${step}${
          mapping.length === 0
            ? ''
            : ` (${mapping
                .slice(0, 3)
                .map((entry) => `${entry.from} -> ${entry.to}`)
                .join(', ')}${mapping.length > 3 ? ', ...' : ''})`
        }.`,
        [...new Set([...selected.map((object) => object.id), ...mapping.map((entry) => entry.id)])],
      ),
      data: { mapping, count: mapping.length, unchanged: selected.length - mapping.length },
    };
  },
});

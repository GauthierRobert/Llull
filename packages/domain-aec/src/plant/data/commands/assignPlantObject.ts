import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import { pathOf } from '../hierarchy';
import { getPlantData } from '../model';
import { elementOf } from '../providers';
import { assignObject } from './assignObject';
import { provenanceSchema, refuse, scalarSchema, valueSchema } from './params';

/** One assignment: the parameters of `assign_plant_object`, also the item of `assign_plant_objects`. */
export const assignItemSchema = z.object({
  target: z
    .union([
      z.string(),
      z.object({
        provider: z.string().describe('Provider name, e.g. "pipeLine".'),
        id: z.string().describe('Id of the object in that provider.'),
      }),
    ])
    .describe('The model object: element id, routed line id, { provider, id }, or "reserved".'),
  className: z.string().min(1).describe('Concrete class name (not abstract), e.g. "CentrifugalPump".'),
  hierarchy: z.string().min(1).describe('Hierarchy node: its code (unique), its path S1/P1/U10, or its id.'),
  tagFields: z
    .record(z.string(), scalarSchema)
    .optional()
    .describe(
      'Values of the tag format fields that are not class properties, e.g. { "seq": 1 }. Class property fields may be given here too.',
    ),
  tag: z
    .string()
    .optional()
    .describe('A typed tag; must match the class format and its fields must agree with the other values. Omit to generate it.'),
  nextSequence: z
    .boolean()
    .optional()
    .describe('true: use the next free sequence number among the tags with the same other fields (max + 1).'),
  properties: z.record(z.string(), valueSchema).optional().describe('Property values by name.'),
  provenance: z.record(z.string(), provenanceSchema).optional().describe('Provenance by property name.'),
  line: z.string().optional().describe('Id or tag of the process line object this object belongs to.'),
});

/**
 * @affects creates 1 plant object (plant.data); writes the tag into the model object (equipment mark, legacy pipe line number, routed line number)
 * @invariant tag = generate(class tag format, tag fields, class, hierarchy) and is unique in its tag scope and among the unique model tags; one plant object per target
 * @failure unknown / abstract class, unknown hierarchy or target, target already tagged, malformed / duplicate tag, missing tag field, invalid property -> DAT_* refusal, document unchanged
 */
export const assignPlantObject = defineCommand({
  name: 'assign_plant_object',
  description:
    'Classify a model object as a plant object: give it a class (define_plant_class / load_plant_class_library), a place in the plant hierarchy ' +
    '(define_plant_hierarchy) and a tag, and fill its typed properties. The tag is GENERATED from the class tag format: pass tagFields for the variable ' +
    'fields (e.g. { seq: 1 }; class code and area come from the class and the hierarchy node), or nextSequence: true for the next free sequence number, or ' +
    'type the tag (it must match the format; a hand-typed tag that breaks it is refused with DAT_TAG_FORMAT). Tags are unique per scope (the plant by ' +
    'default) and against the other tag fields of the model: a duplicate is refused with the holder ids and the next free tag. The tag is written back into ' +
    'the model object (equipment mark, pipe line number, routed line number), so schedules, plans and IFC show it. target: an element id ' +
    '(equipment-2, pipe-3 from building_schedule), a routed line id (line-4 from create_pipeline), { provider, id }, or "reserved" to hold a tag before ' +
    'its object exists. Facts the model object already carries (equipment name and weight, line size, service, spec, sequence, design pressure) fill the ' +
    'class fields you do not send. properties: values by property name, physical numbers in the unit of the definition (plant_data_table columns) or ' +
    '{ value, unit }; provenance: { source, ref?, unverified? } per property. line: id or tag of the process line object a pipe or component belongs to. ' +
    'A tag held by an ORPHAN plant object of the same class (its model object was deleted) is re-bound to the new target instead of being refused as a duplicate (data.rebound). Returns the plant object id (affected[0]) and data = { objectId, tag, className, hierarchy, scope, seeded, tagWritten, rebound }. Next: set_plant_properties, check_plant_data, plant_data_table.',
  params: assignItemSchema,
  run: (doc, params, ctx): CommandResult => {
    const outcome = assignObject(doc, params, ctx);
    if (!outcome.ok) return refuse(doc, 'assign_plant_object', outcome);
    const { assigned } = outcome;
    const data = getPlantData(assigned.document);
    const model = elementOf(doc, assigned.object.target);
    const hierarchy = pathOf(data, assigned.object.hierarchyId);
    return {
      ...changed(
        assigned.document,
        `assign_plant_object: ${assigned.object.className} ${assigned.object.tag} (${assigned.object.id}) at ${hierarchy}${model === null ? ' (reserved tag)' : ` for ${model.element.label}`}${assigned.rebound ? '; re-bound the orphaned plant object that held this tag' : ''}${assigned.tagWritten ? '; tag written to the model object' : ''}${assigned.seeded.length === 0 ? '' : `; defaults from the model: ${assigned.seeded.join(', ')}`}.`,
        [...assigned.affected],
      ),
      data: {
        objectId: assigned.object.id,
        tag: assigned.object.tag,
        className: assigned.object.className,
        hierarchy,
        scope: assigned.scope,
        seeded: assigned.seeded,
        tagWritten: assigned.tagWritten,
        rebound: assigned.rebound,
      },
    };
  },
});

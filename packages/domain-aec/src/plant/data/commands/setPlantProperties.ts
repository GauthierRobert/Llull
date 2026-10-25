import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed, noop } from '@core/commands/noop';
import { resolvedOrNull } from '../classes';
import { getPlantData, type PlantObject, type PlantValue, type ValueProvenance, copyObject } from '../model';
import { formatParts } from '../objectTag';
import { coerceValue } from '../properties';
import { objectByRef } from '../registry';
import { fieldNames } from '../tagFormat';
import { provenanceSchema, refuse, valueSchema, type Refusal } from './params';
import { retagObjects } from './retag';

const MAX_REPORTED = 50;

interface Working {
  properties: Record<string, PlantValue>;
  provenance: Record<string, ValueProvenance>;
  touched: Set<string>;
}

/**
 * @affects changes property values (and provenance) of existing plant objects in plant.data as ONE step; a tag-driving property regenerates the tag and writes it into the model object
 * @invariant atomic: every edit of the batch is validated first and one invalid edit refuses the whole batch; an edit without provenance drops the old provenance of that value
 * @failure unknown object / property, read-only property, wrong type, unit or pattern, new tag duplicate -> DAT_* refusal listing every bad edit in paths, document unchanged
 */
export const setPlantProperties = defineCommand({
  name: 'set_plant_properties',
  description:
    'Set typed property values on plant objects (the Data Manager edit), up to 10000 edits as ONE atomic step: all edits are validated first and a single bad ' +
    'edit refuses the whole batch (paths lists every bad edit as edits[i].property). edits: [{ object, property, value, provenance? }]. object: plant object ' +
    'id or its tag (ids when a tag exists in several plants). value by the type of the property (plant_data_table columns): text (must match the pattern), ' +
    'integer, real, boolean, enum (one of enumValues), physical numbers in the unit of the definition, or { value, unit } to send another unit of the same family; ' +
    'null clears the value. provenance { source, ref?, unverified? } records where the value comes from; unverified values are flagged by reports and ' +
    'check_plant_data. Changing a property the tag format reads (e.g. nominalSize in a line tag) regenerates the object tag, refuses the batch on a duplicate, ' +
    'and writes the new tag into the model object. Returns data = { changed (values), objects [ids], retagged [{ id, from, to }] }. ' +
    'Refusals: DAT_OBJECT_UNKNOWN, DAT_PROPERTY_UNKNOWN, DAT_PROPERTY_READONLY, DAT_PROPERTY_TYPE, DAT_PROPERTY_UNIT, DAT_TAG_DUPLICATE. Next: check_plant_data.',
  params: z.object({
    edits: z
      .array(
        z.object({
          object: z.string().describe('Plant object id (plantobj-3.1) or tag (P-101).'),
          property: z.string().describe('Property name of the object class, e.g. "DesignPressure".'),
          value: valueSchema,
          provenance: provenanceSchema.optional(),
        }),
      )
      .min(1)
      .max(10000)
      .describe('The edits, applied in order (a later edit of the same property wins).'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const data = getPlantData(doc);
    const working = new Map<string, Working>();
    const refusals: Refusal[] = [];
    const bad = (code: string, message: string, path: string, ids: readonly string[] = []): void => {
      refusals.push({ code, message, paths: [path], ids });
    };
    for (const [index, edit] of params.edits.entries()) {
      const path = `edits[${index}]`;
      const object = objectByRef(data, edit.object);
      if (object === null || object === 'ambiguous') {
        bad(
          'DAT_OBJECT_UNKNOWN',
          object === null ? `no plant object "${edit.object}"` : `tag "${edit.object}" exists in several scopes: pass the id`,
          `${path}.object`,
        );
        continue;
      }
      const resolved = resolvedOrNull(data, object.className);
      const definition = resolved?.properties.find((candidate) => candidate.name === edit.property);
      if (edit.property === 'tag' || edit.property === 'className') {
        bad(
          'DAT_PROPERTY_READONLY',
          `${edit.property} of ${object.tag} is derived (tag format fields change it; set_tag_format)`,
          `${path}.property`,
          [object.id],
        );
        continue;
      }
      if (definition === undefined) {
        bad('DAT_PROPERTY_UNKNOWN', `${object.className} has no property "${edit.property}" (${object.tag})`, `${path}.property`, [
          object.id,
        ]);
        continue;
      }
      if (definition.readOnly === true) {
        bad('DAT_PROPERTY_READONLY', `${edit.property} of ${object.tag} is read-only`, `${path}.property`, [object.id]);
        continue;
      }
      const coerced = coerceValue(definition, edit.value);
      if (!coerced.ok) {
        bad(coerced.code, `${object.tag}: ${coerced.message}`, `${path}.value`, [object.id]);
        continue;
      }
      let state = working.get(object.id);
      if (state === undefined) {
        state = { properties: { ...object.properties }, provenance: { ...object.provenance }, touched: new Set() };
        working.set(object.id, state);
      }
      if (coerced.value === null) delete state.properties[edit.property];
      else state.properties[edit.property] = coerced.value;
      if (edit.provenance === undefined) delete state.provenance[edit.property];
      else state.provenance[edit.property] = edit.provenance;
      state.touched.add(edit.property);
    }
    if (refusals.length > 0) {
      const first = refusals[0] as Refusal;
      return refuse(doc, 'set_plant_properties', {
        code: first.code,
        message: `${refusals.length} of ${params.edits.length} edit(s) are invalid, nothing applied; first: ${first.message}`,
        paths: refusals.slice(0, MAX_REPORTED).flatMap((refusal) => refusal.paths ?? []),
        ids: [...new Set(refusals.flatMap((refusal) => refusal.ids ?? []))].slice(0, MAX_REPORTED),
        detail: {
          errors: refusals.slice(0, MAX_REPORTED).map(({ code, message, paths }) => ({ code, message, paths })),
          errorCount: refusals.length,
        },
      });
    }
    const objects = { ...data.objects };
    const retagIds: string[] = [];
    let values = 0;
    for (const [id, state] of working) {
      const object = objects[id] as PlantObject;
      const changedNames = [...state.touched].filter(
        (name) => object.properties[name] !== state.properties[name] || !sameProvenance(object.provenance?.[name], state.provenance[name]),
      );
      if (changedNames.length === 0) continue;
      values += changedNames.filter((name) => object.properties[name] !== state.properties[name]).length;
      objects[id] = copyObject(object, { properties: state.properties, provenance: state.provenance });
      const resolved = resolvedOrNull(data, object.className);
      const parts = resolved === null ? null : formatParts(resolved);
      if (
        parts !== null &&
        changedNames.some((name) => object.properties[name] !== state.properties[name] && fieldNames(parts).includes(name))
      )
        retagIds.push(id);
    }
    const touchedIds = [...working.keys()].filter((id) => objects[id] !== data.objects[id]);
    if (touchedIds.length === 0) return noop(doc, 'set_plant_properties: every value already equals the request; nothing changed.');
    const next = { ...data, objects };
    const retagged = retagObjects(doc, next, retagIds, ctx);
    if (!retagged.ok) return refuse(doc, 'set_plant_properties', retagged);
    return {
      ...changed(
        retagged.document,
        `set_plant_properties: ${values} value(s) changed on ${touchedIds.length} object(s)${
          retagged.changes.length === 0
            ? ''
            : `; ${retagged.changes.length} tag(s) regenerated (${retagged.changes
                .slice(0, 3)
                .map((change) => `${change.from} -> ${change.to}`)
                .join(', ')})`
        }.`,
        [...touchedIds, ...retagged.changes.map((change) => change.id).filter((id) => !touchedIds.includes(id))],
      ),
      data: { changed: values, objects: touchedIds, retagged: retagged.changes },
    };
  },
});

const sameProvenance = (a: ValueProvenance | undefined, b: ValueProvenance | undefined): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Material classes (plant 09 VIS §5.6): define / delete / assign / list. Display only and metaHistory: no geometry, no feature step. */

import {
  assignedMaterialClass,
  DEFAULT_MATERIAL_CLASSES,
  effectiveMaterialClasses,
  findMaterialClass,
} from '../../geometry/materialClasses';
import type { DisplayModel, MaterialClass } from '../../model/display';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { changed, report } from '../noop';
import { is3D } from '../../model/types';
import { displayOf, displayRejection } from './displayModel';

const ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
const fraction = (value: number): boolean => Number.isFinite(value) && value >= 0 && value <= 1;

/**
 * @affects adds or replaces doc.display.materialClasses[id] (affected: []); metaHistory
 * @invariant id snake_case; colour #rrggbb or null; metalness / roughness in [0, 1]; a default's id is overridden, never duplicated
 * @failure bad id / colour / number -> VIS_MATERIAL_CLASS_INVALID
 */
export const defineMaterialClass = defineCommand({
  name: 'define_material_class',
  description:
    'Define a display material class, or override a named default (list_material_classes shows them: structural_steel_painted, galvanized_steel, ' +
    'carbon_steel_pipe_painted, stainless_steel, insulation_cladding_aluminium, concrete, grating, cast_steel_valve, alloy_bolting, frp). A class gives ' +
    'a display colour, metalness and roughness (metalness and roughness are stored but not used by renders yet); entities take it with assign_material_class and render_view / render_walkthrough then draw them in the ' +
    'class colour (a matching colour-profile rule still wins). Display only: geometry and create_material materials are untouched. Re-defining an ' +
    'id replaces it. Error: VIS_MATERIAL_CLASS_INVALID. Does not add a feature step.',
  annotations: { metaHistory: true },
  params: z.object({
    id: z.string().describe('Class id, snake_case (lowercase letters, digits, underscore), e.g. "painted_handrail".'),
    name: z.string().optional().describe('Display name. Default: the id.'),
    colour: z.string().nullable().describe('Display colour #rrggbb, or null to keep the entity colour (its profile colour still applies).'),
    metalness: z.number().describe('Metalness 0..1.'),
    roughness: z.number().describe('Roughness 0..1.'),
  }),
  run: (doc, params): CommandResult => {
    const fail = (message: string, path: string): CommandResult =>
      displayRejection(doc, 'define_material_class', 'VIS_MATERIAL_CLASS_INVALID', message, [], [path]);
    if (!ID_PATTERN.test(params.id)) return fail(`id '${params.id}' must be snake_case`, 'id');
    if (params.colour !== null && !HEX.test(params.colour)) return fail(`colour '${params.colour}' is not #rrggbb or null`, 'colour');
    if (!fraction(params.metalness)) return fail('metalness must be in [0, 1]', 'metalness');
    if (!fraction(params.roughness)) return fail('roughness must be in [0, 1]', 'roughness');
    const entry: MaterialClass = {
      id: params.id,
      name: params.name ?? params.id,
      colour: params.colour === null ? null : params.colour.toLowerCase(),
      metalness: params.metalness,
      roughness: params.roughness,
    };
    const display = displayOf(doc);
    const next: DisplayModel = { ...display, materialClasses: { ...display.materialClasses, [entry.id]: entry } };
    const summary = `Defined material class '${entry.id}' (${entry.colour ?? 'entity colour'}, metalness ${entry.metalness}, roughness ${entry.roughness}).`;
    return { ...changed({ ...doc, display: next }, summary, []), data: { materialClass: entry } };
  },
});

/**
 * @affects removes doc.display.materialClasses[id] (affected: []); a default id returns to its named default; metaHistory
 * @failure no document class with that id -> VIS_MATERIAL_CLASS_NOT_FOUND; a non-default class still assigned -> VIS_MATERIAL_CLASS_IN_USE
 */
export const deleteMaterialClass = defineCommand({
  name: 'delete_material_class',
  description:
    'Delete a document material class defined with define_material_class. Deleting an override of a named default restores the default. ' +
    'A custom class that entities still use is refused (VIS_MATERIAL_CLASS_IN_USE: assign_material_class with classId null first). ' +
    'A named default has nothing to delete: VIS_MATERIAL_CLASS_NOT_FOUND. Does not add a feature step.',
  annotations: { metaHistory: true, destructive: true },
  params: z.object({ id: z.string().describe('Class id to delete.') }),
  run: (doc, { id }): CommandResult => {
    const display = displayOf(doc);
    const own = display.materialClasses;
    if (own === undefined || !Object.hasOwn(own, id))
      return displayRejection(
        doc,
        'delete_material_class',
        'VIS_MATERIAL_CLASS_NOT_FOUND',
        `no document material class '${id}'`,
        [],
        ['id'],
      );
    const isDefault = DEFAULT_MATERIAL_CLASSES.some((entry) => entry.id === id);
    const users = Object.entries(display.materialClassOf ?? {})
      .filter(([entityId, classId]) => classId === id && doc.entities[entityId] !== undefined)
      .map(([entityId]) => entityId);
    if (!isDefault && users.length > 0)
      return displayRejection(
        doc,
        'delete_material_class',
        'VIS_MATERIAL_CLASS_IN_USE',
        `class '${id}' is assigned to ${users.length} entity(ies)`,
        users,
      );
    const { [id]: _removed, ...rest } = own;
    const { materialClasses: _all, ...others } = display;
    const next: DisplayModel = Object.keys(rest).length === 0 ? others : { ...others, materialClasses: rest };
    return changed(
      { ...doc, display: next },
      isDefault ? `Restored the default material class '${id}'.` : `Deleted material class '${id}'.`,
      [],
    );
  },
});

/**
 * @affects sets or clears doc.display.materialClassOf for each existing entity id (affected: those ids); metaHistory
 * @failure unknown class -> VIS_MATERIAL_CLASS_NOT_FOUND; no entity id exists -> VIS_MATERIAL_CLASS_INVALID
 */
export const assignMaterialClass = defineCommand({
  name: 'assign_material_class',
  description:
    'Assign a display material class (list_material_classes) to entities, or pass classId null to clear it. Unknown entity ids are skipped and ' +
    'named in the summary; 2D shapes and curves are refused (VIS_MATERIAL_CLASS_INVALID: a class is drawn on 3D solids, meshes and instances only). The class colour is then drawn by render_view and render_walkthrough, the class id is the entity property "materialClass" ' +
    '(colour-profile rules can test it) and it is the material class of the render plan. Display only: geometry, create_material materials and ' +
    'assign_material are untouched. The assignment is keyed by entity id: deleting the entity drops it, copies and duplicates do not carry it. Metalness and roughness are stored but not used by any render yet (only the colour is). Errors: VIS_MATERIAL_CLASS_NOT_FOUND, VIS_MATERIAL_CLASS_INVALID (no entity id exists). Does not add a feature step.',
  annotations: { metaHistory: true },
  params: z.object({
    classId: z.string().nullable().describe('Class id (define_material_class / a named default), or null to clear the assignment.'),
    entityIds: z.array(z.string()).describe('Entity ids to classify.'),
  }),
  run: (doc, { classId, entityIds }): CommandResult => {
    const display = displayOf(doc);
    if (classId !== null && findMaterialClass(display, classId) === undefined)
      return displayRejection(
        doc,
        'assign_material_class',
        'VIS_MATERIAL_CLASS_NOT_FOUND',
        `no material class '${classId}'`,
        [],
        ['classId'],
      );
    const unique = [...new Set(entityIds)];
    const exists = (id: string): boolean => Object.hasOwn(doc.entities, id);
    const flat = unique.filter((id) => {
      const entity = exists(id) ? doc.entities[id] : undefined;
      return entity !== undefined && !is3D(entity);
    });
    if (classId !== null && flat.length > 0)
      return displayRejection(
        doc,
        'assign_material_class',
        'VIS_MATERIAL_CLASS_INVALID',
        `2D shapes and curves are never drawn in a class colour: ${flat.slice(0, 5).join(', ')}`,
        flat,
        ['entityIds'],
      );
    const known = unique.filter(exists);
    const skipped = unique.filter((id) => !exists(id));
    if (known.length === 0)
      return displayRejection(doc, 'assign_material_class', 'VIS_MATERIAL_CLASS_INVALID', 'no entity id exists', skipped, ['entityIds']);
    const current = { ...display.materialClassOf };
    for (const id of known) {
      if (classId === null) delete current[id];
      else current[id] = classId;
    }
    const { materialClassOf: _previous, ...others } = display;
    const next: DisplayModel = Object.keys(current).length === 0 ? others : { ...others, materialClassOf: current };
    const verb = classId === null ? 'Cleared the material class of' : `Assigned material class '${classId}' to`;
    const note = skipped.length === 0 ? '' : ` Skipped unknown id(s): ${skipped.slice(0, 5).join(', ')}.`;
    return changed({ ...doc, display: next }, `${verb} ${known.length} entity(ies).${note}`, known);
  },
});

/**
 * @affects nothing — read-only; data { classes[{ id, name, colour, metalness, roughness, source, assigned }] }
 * @invariant defaults first (their order), then document classes in insertion order; assigned counts existing entities only
 */
export const listMaterialClasses = defineCommand({
  name: 'list_material_classes',
  description:
    'List the material classes in force: the ten named defaults (matclass:llull-v1) with any document override, and the classes of define_material_class. ' +
    'data { classes: [{ id, name, colour (#rrggbb | null), metalness, roughness, source: "default" | "document", assigned (entity count) }] }. Read-only.',
  annotations: { readOnly: true },
  params: z.object({}),
  run: (doc): CommandResult => {
    const display = displayOf(doc);
    const counts = new Map<string, number>();
    for (const id of doc.order) {
      const assigned = assignedMaterialClass(doc, id);
      if (assigned !== undefined) counts.set(assigned.id, (counts.get(assigned.id) ?? 0) + 1);
    }
    const own = display.materialClasses ?? {};
    const classes = effectiveMaterialClasses(display).map((entry) => ({
      ...entry,
      source: Object.hasOwn(own, entry.id) ? 'document' : 'default',
      assigned: counts.get(entry.id) ?? 0,
    }));
    const used = classes.filter((entry) => entry.assigned > 0).length;
    return report(doc, `${classes.length} material class(es), ${used} in use.`, { classes });
  },
});

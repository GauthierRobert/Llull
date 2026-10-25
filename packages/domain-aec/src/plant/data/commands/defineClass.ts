import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import { resolveClass } from '../classes';
import { ifcMappingProblem } from '../ifcMapping';
import { getPlantData, PROPERTY_TYPES, withPlantData, type IfcMapping, type PlantClass, type PropertyDefinition } from '../model';
import { definitionProblem, IDENTIFIER } from '../properties';
import { parseTagFormat } from '../tagFormat';
import { unitsOf } from '../units';
import { refuse, scalarSchema } from './params';

const CLASS_NAME = /^[A-Z][A-Za-z0-9]*$/;
const CLASS_CODE = /^[A-Za-z0-9_-]{1,8}$/;

const propertyDefinitionSchema = z.object({
  name: z.string().describe('Identifier without spaces (letters, digits, _; starts with a letter), e.g. "DesignPressure".'),
  displayName: z.string().optional().describe('Column heading in tables and sheets; defaults to the name.'),
  type: z
    .enum(PROPERTY_TYPES)
    .describe(
      'text, integer, real, boolean, enum, or a physical type that needs a unit: length, pressure, temperature, mass, volumetricFlow, massFlow.',
    ),
  unit: z
    .string()
    .optional()
    .describe(
      `Unit of a physical type; values are stored in it. ${(
        ['length', 'pressure', 'temperature', 'mass', 'volumetricFlow', 'massFlow'] as const
      )
        .map((type) => `${type}: ${unitsOf(type).join(', ')}`)
        .join('; ')}.`,
    ),
  enumValues: z.array(z.string()).optional().describe('Allowed values of an enum property.'),
  pattern: z.string().optional().describe('Regular expression a text value must match entirely, e.g. "[A-Z]{1,3}".'),
  required: z.boolean().optional().describe('true: check_plant_data reports an object whose value is empty.'),
  readOnly: z.boolean().optional().describe('true: set_plant_properties and imports never change it.'),
  default: scalarSchema.optional().describe('Value a new object gets when none is given.'),
});

/**
 * @affects adds 1 class to plant.data.classes (source project); no object changes
 * @invariant a subclass only tightens an inherited property (required, narrower enum, default), never changes its type or unit; library classes are read-only
 * @failure existing / library class name, unknown parent, bad tag format, property or IFC mapping -> DAT_* refusal, document unchanged
 */
export const definePlantClass = defineCommand({
  name: 'define_plant_class',
  description:
    'Define a plant class: a named kind of object (Tank, CentrifugalPump, ProcessLine, ...) with typed properties, a tag format and an IFC mapping. ' +
    'A class inherits its parent (parent) : properties, tagFormat, classCode, tagScope and ifc are inherited unless set, and a subclass may tighten an ' +
    'inherited property (required, a narrower enum, a default) but never change its type or unit. abstract: true classes cannot be assigned. tagFormat: ' +
    'literal text and {field} / {field:width} parts, e.g. "{classCode}-{area}{seq:2}" (width zero-pads an integer; {{ and }} write braces); fields are ' +
    'classCode, area (the areaNumber of the unit or area node), hierarchy.<kind>.<property> (code, name or a node property), or the name of a class ' +
    'property or a tag field such as seq. classCode: short code used by {classCode}. tagScope: where tags must be unique (plant by default, site, project). ' +
    'ifc: { entity, predefinedType?, objectType? } with an IFC4X3_ADD2 entity and a value of its type enumeration, or USERDEFINED plus objectType. ' +
    'Returns data = { className, tagFormat, classCode, tagScope, resolvedProperties [{ name, type, unit, required }] }. Refusals: DAT_CLASS_EXISTS, ' +
    'DAT_LIBRARY_CLASS_LOCKED, DAT_CLASS_PARENT_UNKNOWN, DAT_TAG_FORMAT_INVALID, DAT_PROPERTY_DEFINITION_INVALID, DAT_IFC_MAPPING_INVALID. ' +
    'Next: define_plant_hierarchy, assign_plant_object.',
  params: z.object({
    name: z.string().describe('Class name, PascalCase identifier, e.g. "FeedPump".'),
    parent: z.string().optional().describe('Name of the class to inherit from (library or project); omit for a root class.'),
    abstract: z.boolean().optional().describe('true: only a base for subclasses, cannot be assigned. Default false.'),
    classCode: z.string().optional().describe('Code for {classCode} in tag formats, 1-8 letters, digits, _ or -, e.g. "P".'),
    tagFormat: z.string().optional().describe('Tag format, e.g. "{classCode}-{area}{seq:2}"; inherited when omitted.'),
    tagScope: z
      .enum(['plant', 'site', 'project'])
      .optional()
      .describe('Scope in which tags of this class are unique; inherited when omitted, plant at the root.'),
    properties: z.array(propertyDefinitionSchema).optional().describe('Own property definitions (added to the inherited ones).'),
    ifc: z
      .object({
        entity: z.string().describe('IFC4X3_ADD2 entity, e.g. "IfcPump".'),
        predefinedType: z.string().optional().describe('Value of the entity type enumeration, e.g. "ENDSUCTION", or "USERDEFINED".'),
        objectType: z.string().optional().describe('Required with USERDEFINED, e.g. "COLUMN".'),
        pset: z.string().optional().describe('Template property set to fill, e.g. "Pset_PumpTypeCommon".'),
        propertyMap: z.record(z.string(), z.string()).optional().describe('Class property name -> property set property name.'),
      })
      .optional()
      .describe('IFC4X3_ADD2 mapping used by the IFC export.'),
  }),
  run: (doc, params): CommandResult => {
    const data = getPlantData(doc);
    const name = params.name.trim();
    const fail = (code: string, message: string, path: string): CommandResult =>
      refuse(doc, 'define_plant_class', { code, message, paths: [path] });
    if (!CLASS_NAME.test(name))
      return fail('DAT_PROPERTY_DEFINITION_INVALID', `class name "${name}" must be a PascalCase identifier`, 'name');
    const existing = data.classes[name];
    if (existing?.source === 'library') return fail('DAT_LIBRARY_CLASS_LOCKED', `${name} is a library class: subclass it`, 'name');
    if (existing !== undefined) return fail('DAT_CLASS_EXISTS', `class ${name} already exists`, 'name');
    const parent = params.parent?.trim();
    if (parent === name) return fail('DAT_CLASS_CYCLE', `class ${name} cannot inherit from itself`, 'parent');
    if (parent !== undefined && data.classes[parent] === undefined)
      return fail('DAT_CLASS_PARENT_UNKNOWN', `no parent class "${parent}"`, 'parent');
    const tagFormat = params.tagFormat?.trim();
    if (tagFormat !== undefined) {
      const parsed = parseTagFormat(tagFormat);
      if (!parsed.ok) return fail('DAT_TAG_FORMAT_INVALID', parsed.problem, 'tagFormat');
    }
    if (params.classCode !== undefined && !CLASS_CODE.test(params.classCode))
      return fail('DAT_PROPERTY_DEFINITION_INVALID', 'classCode is 1-8 letters, digits, _ or -', 'classCode');
    const properties: PropertyDefinition[] = [];
    for (const [index, input] of (params.properties ?? []).entries()) {
      const { displayName, ...rest } = input;
      const definition: PropertyDefinition = { ...rest, displayName: displayName ?? input.name };
      const problem = IDENTIFIER.test(input.name)
        ? definitionProblem(definition)
        : `property name "${input.name}" must be an identifier without spaces`;
      if (problem !== null) return fail('DAT_PROPERTY_DEFINITION_INVALID', problem, `properties[${index}]`);
      if (properties.some((other) => other.name === input.name))
        return fail('DAT_PROPERTY_DEFINITION_INVALID', `property ${input.name} is defined twice`, `properties[${index}].name`);
      properties.push(definition);
    }
    if (params.ifc !== undefined) {
      const problem = ifcMappingProblem(params.ifc);
      if (problem !== null) return fail('DAT_IFC_MAPPING_INVALID', problem, 'ifc');
    }
    const cls: PlantClass = {
      name,
      parent: parent ?? null,
      abstract: params.abstract === true,
      ...(params.classCode === undefined ? {} : { classCode: params.classCode }),
      ...(tagFormat === undefined ? {} : { tagFormat }),
      ...(params.tagScope === undefined ? {} : { tagScope: params.tagScope }),
      properties,
      ...(params.ifc === undefined ? {} : { ifc: params.ifc as IfcMapping }),
      source: 'project',
    };
    const next = withPlantData(doc, { ...data, classes: { ...data.classes, [name]: cls }, classOrder: [...data.classOrder, name] });
    const resolution = resolveClass(getPlantData(next), name);
    if (!resolution.ok) return fail(resolution.code, resolution.message, 'properties');
    const { resolved } = resolution;
    return {
      ...changed(
        next,
        `define_plant_class: ${resolved.abstract ? 'abstract ' : ''}class ${name}${parent === undefined ? '' : ` < ${parent}`}, ${resolved.properties.length} propert${resolved.properties.length === 1 ? 'y' : 'ies'}, tag format ${resolved.tagFormat ?? '(none)'}.`,
        [name],
      ),
      data: {
        className: name,
        tagFormat: resolved.tagFormat ?? null,
        classCode: resolved.classCode ?? null,
        tagScope: resolved.tagScope,
        resolvedProperties: resolved.properties.map((property) => ({
          name: property.name,
          type: property.type,
          unit: property.unit ?? null,
          required: property.required === true,
        })),
      },
    };
  },
});

/** define_bond_path / delete_bond_path (PHY-15 FR-EOP-06, FR-EOP-07): electrical bond paths as data, with sourced limits. */

import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { convertValue, isUnitFailure } from '@lib/quantity';
import { is3D, type CadDocument } from '@core/model/types';
import { nextId } from '@lib/id';
import { refuseEop } from './codes';
import { electroOpticalOf, withElectroOptical } from './model';
import type { BondElement, BondLimit, BondPath } from './types';

const DEFINE = 'define_bond_path';

const quantity = (what: string): z.ZodObject<{ value: z.ZodNumber; unit: z.ZodString }> =>
  z
    .object({ value: z.number().describe(`${what}: positive, finite.`), unit: z.string().describe("Unit, e.g. 'mohm', 'mm', 'mm^2'.") })
    .describe(`${what} as { value, unit }.`);
const sourceSchema = z.object({
  citation: z.string().describe('Report, datasheet or standard.'),
  locator: z.string().optional().describe('Page / table.'),
});

const elementSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('joint').describe("Element kind: 'joint'."),
    resistance: quantity('Measured or specified joint resistance').describe('Resistance, e.g. { value: 0.5, unit: "mohm" }.'),
    source: sourceSchema.describe('REQUIRED: measurement report or rule the resistance comes from.'),
    interfaces: z
      .tuple([z.string(), z.string()])
      .optional()
      .describe(
        'The two solids the joint connects: check_bonding confirms they touch (find_contacts) and reads their bonded-interface coatings.',
      ),
  }),
  z.object({
    kind: z.literal('strap').describe("Element kind: 'strap'."),
    material: z.string().describe('Material id with a PHY-01 electricalResistivity model (define_property_model, unit ohm*m).'),
    length: quantity('Conductor length'),
    crossSection: quantity('Conductor cross-section area'),
  }),
]);

const positiveIn = (q: { value: number; unit: string }, reference: string): boolean => {
  const converted = convertValue(q.value, q.unit, reference);
  return !isUnitFailure(converted) && Number.isFinite(converted.value) && converted.value > 0;
};

/** The first problem of an element, or null. */
function elementProblem(doc: CadDocument, element: BondElement): string | null {
  if (element.kind === 'joint') {
    if (!positiveIn(element.resistance, 'ohm')) return 'a joint needs a positive resistance in a resistance unit (ohm, mohm)';
    if (element.source.citation.trim() === '') return 'a joint needs a source citation';
    return null;
  }
  if (!Object.hasOwn(doc.materials, element.material)) return `no material '${element.material}' for the strap`;
  if (!positiveIn(element.length, 'm')) return 'a strap needs a positive length in a length unit';
  if (!positiveIn(element.crossSection, 'm^2')) return 'a strap needs a positive cross-section in an area unit';
  return null;
}

const isSolid = (doc: CadDocument, id: string): boolean => {
  const entity = Object.hasOwn(doc.entities, id) ? doc.entities[id] : undefined;
  return entity !== undefined && is3D(entity);
};

/**
 * @affects doc.electroOptical.bondPaths (adds 1 path `bp-<step>.<k>`; affected: [pathId])
 * @invariant at least one element; every joint has a resistance and a source; a limit has a rule id and a source and is stored `unverified: true` (no command verifies a limit); no default limit exists
 * @failure unknown / 2D endpoint or interface -> EOP_ENTITY_NOT_FOUND; invalid element -> EOP_BOND_ELEMENT_INVALID; limit without source -> EOP_LIMIT_SOURCE_REQUIRED; blank name -> EOP_PARAMS_INVALID (document unchanged)
 */
export const defineBondPath = defineCommand({
  name: DEFINE,
  description:
    'Define an electrical bond path from one solid to another as an ordered series of elements: joint (resistance with its source, optionally the two solids it connects) ' +
    'and strap (material with an electricalResistivity model, length, cross-section: R = rho L / A). Optional limit { value, unit, ruleId, source }: llull has NO default bond limit ' +
    '(the 2.5 mohm figure is a programme rule the owner supplies with its citation); the limit is stored unverified. temperature: the temperature the resistivities are evaluated at. ' +
    'Returns the path id in affected[0]. Next: check_bonding.',
  params: z.object({
    name: z.string().describe('Path name.'),
    from: z.string().describe('Entity id of the first solid (e.g. the equipment box).'),
    to: z.string().describe('Entity id of the last solid (e.g. the structure).'),
    elements: z.array(elementSchema).describe('Series elements in order, at least one.'),
    limit: z
      .object({
        value: z.number().describe('Positive limit value.'),
        unit: z.string().describe("Resistance unit, e.g. 'mohm'."),
        ruleId: z.string().describe('Id of the programme rule the limit comes from.'),
        source: sourceSchema.describe('REQUIRED citation of the rule.'),
      })
      .optional()
      .describe('Resistance limit of the path as a sourced rule entry.'),
    temperature: quantity('Evaluation temperature')
      .optional()
      .describe("Temperature for the resistivity models, e.g. { value: 20, unit: 'degC' }."),
  }),
  run: (doc, { name, from, to, elements, limit, temperature }): CommandResult => {
    const fail = (code: string, message: string, ids: readonly string[], path: string): CommandResult =>
      refuseEop(doc, DEFINE, code, message, ids, [path]);
    if (name.trim() === '') return fail('EOP_PARAMS_INVALID', 'a bond path needs a name', [], 'name');
    const joined = elements.flatMap((element) => (element.kind === 'joint' ? (element.interfaces ?? []) : []));
    const missing = [from, to, ...joined].find((id) => !isSolid(doc, id));
    if (missing !== undefined) return fail('EOP_ENTITY_NOT_FOUND', `no solid '${missing}'`, [missing], 'from');
    if (elements.length === 0) return fail('EOP_BOND_ELEMENT_INVALID', 'a path needs at least one element', [], 'elements');
    for (const [index, element] of elements.entries()) {
      const problem = elementProblem(doc, element);
      if (problem !== null) return fail('EOP_BOND_ELEMENT_INVALID', `element ${index}: ${problem}`, [], `elements.${index}`);
    }
    if (limit !== undefined) {
      if (limit.source.citation.trim() === '' || limit.ruleId.trim() === '')
        return fail(
          'EOP_LIMIT_SOURCE_REQUIRED',
          'a limit needs a rule id and a source citation: llull has no default bond limit',
          [],
          'limit.source',
        );
      if (!positiveIn(limit, 'ohm')) return fail('EOP_PARAMS_INVALID', 'the limit must be positive in a resistance unit', [], 'limit');
    }
    if (temperature !== undefined && isUnitFailure(convertValue(temperature.value, temperature.unit, 'K')))
      return fail('EOP_PARAMS_INVALID', `temperature unit '${temperature.unit}' is not a temperature`, [], 'temperature');
    const model = electroOpticalOf(doc);
    const id = nextId('bp');
    const stored: BondLimit | undefined = limit === undefined ? undefined : { ...limit, unverified: true };
    const path: BondPath = {
      id,
      name,
      from,
      to,
      elements: elements as readonly BondElement[],
      ...(stored === undefined ? {} : { limit: stored }),
      ...(temperature === undefined ? {} : { temperature }),
    };
    const limitText =
      stored === undefined
        ? 'no limit (check_bonding reports EOP_BOND_LIMIT_MISSING)'
        : `limit ${stored.value} ${stored.unit} (${stored.ruleId}, unverified)`;
    return changed(
      withElectroOptical(doc, { bondPaths: { ...model.bondPaths, [id]: path } }),
      `${DEFINE}: '${name}' ${id} from ${from} to ${to}, ${elements.length} element(s), ${limitText}.`,
      [id],
    );
  },
});

const DELETE = 'delete_bond_path';

/**
 * @affects doc.electroOptical.bondPaths and its disposition (removes 1 path; affected: [pathId])
 * @failure unknown path id -> EOP_PATH_NOT_FOUND (document unchanged)
 */
export const deleteBondPath = defineCommand({
  name: DELETE,
  description: 'Delete a bond path (and any human disposition recorded for it). The id is the affected id of define_bond_path.',
  params: z.object({ pathId: z.string().describe("Bond path id, e.g. 'bp-5.1'.") }),
  run: (doc, { pathId }): CommandResult => {
    const model = electroOpticalOf(doc);
    if (!Object.hasOwn(model.bondPaths, pathId))
      return refuseEop(doc, DELETE, 'EOP_PATH_NOT_FOUND', `no bond path '${pathId}'`, [pathId], ['pathId']);
    const without = <T>(record: Readonly<Record<string, T>>): Record<string, T> =>
      Object.fromEntries(Object.entries(record).filter(([key]) => key !== pathId));
    return changed(
      withElectroOptical(doc, { bondPaths: without(model.bondPaths), dispositions: without(model.dispositions) }),
      `${DELETE}: removed ${pathId}.`,
      [pathId],
    );
  },
});

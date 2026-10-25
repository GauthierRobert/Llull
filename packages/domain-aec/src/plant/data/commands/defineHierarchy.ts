import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import { nextId } from '@lib/id';
import { kindRank, pathOf, resolveNode } from '../hierarchy';
import { getPlantData, HIERARCHY_KINDS, withPlantData, type HierarchyNode, type PlantDataModel } from '../model';
import { refuse, scalarSchema } from './params';

const CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * @affects creates the given hierarchy nodes in plant.data (with replace: true, replaces the whole hierarchy first)
 * @invariant kind order site > plant > area > unit > system (a child's kind is lower than its parent's); codes unique among siblings; atomic
 * @failure unknown / ambiguous parent, kind order broken, site with a parent, bad code, replace with plant objects present -> DAT_HIERARCHY_INVALID; sibling code reused -> DAT_HIERARCHY_DUPLICATE_CODE
 */
export const definePlantHierarchy = defineCommand({
  name: 'define_plant_hierarchy',
  description:
    'Define the plant breakdown objects are placed in: site > plant > area > unit > system (a node may skip levels, e.g. a unit directly under a plant). ' +
    'Each node has a code unique among its siblings (S1, P1, U10), a kind, an optional name and properties that tag formats can read ' +
    '(a unit or area property areaNumber feeds the {area} field of a tag format). Nodes are created in order, so a parent may be defined earlier in the same ' +
    'call. parent: the code of an existing node (or its path S1/P1 when a code repeats under different parents); a site has no parent. replace: true first ' +
    'discards the existing hierarchy (refused while plant objects exist). Returns data = { nodeIds, nodes [{ id, code, kind, path }] }. ' +
    'Refusals: DAT_HIERARCHY_INVALID, DAT_HIERARCHY_DUPLICATE_CODE. Next: load_plant_class_library, assign_plant_object.',
  params: z.object({
    nodes: z
      .array(
        z.object({
          code: z.string().min(1).describe('Short code, unique among siblings: letters, digits, _ . - (no slash), e.g. "U10".'),
          kind: z.enum(HIERARCHY_KINDS).describe('site, plant, area, unit or system, in that order from the top.'),
          name: z.string().optional().describe('Human name; defaults to the code.'),
          parent: z
            .string()
            .optional()
            .describe('Code (or S1/P1 path) of the parent node, defined earlier or in this call. Omit for a site.'),
          properties: z.record(z.string(), scalarSchema).optional().describe('Node properties, e.g. { "areaNumber": "1" }.'),
        }),
      )
      .min(1)
      .max(1000)
      .describe('Nodes to create, parents first.'),
    replace: z.boolean().optional().describe('true: discard the existing hierarchy first (refused while plant objects exist).'),
  }),
  run: (doc, params): CommandResult => {
    const start = getPlantData(doc);
    if (params.replace === true && start.objectOrder.length > 0)
      return refuse(doc, 'define_plant_hierarchy', {
        code: 'DAT_HIERARCHY_INVALID',
        message: `replace: ${start.objectOrder.length} plant object(s) are placed in the hierarchy`,
        paths: ['replace'],
        ids: start.objectOrder.slice(0, 20),
      });
    let data: PlantDataModel = params.replace === true ? { ...start, hierarchy: {}, hierarchyOrder: [] } : start;
    const created: HierarchyNode[] = [];
    for (const [index, input] of params.nodes.entries()) {
      const path = `nodes[${index}]`;
      const invalid = (message: string, field: string): CommandResult =>
        refuse(doc, 'define_plant_hierarchy', {
          code: 'DAT_HIERARCHY_INVALID',
          message: `${input.code}: ${message}`,
          paths: [`${path}.${field}`],
        });
      const code = input.code.trim();
      if (!CODE.test(code)) return invalid('the code uses letters, digits, _ . - and starts with a letter or digit', 'code');
      let parent: HierarchyNode | null = null;
      if (input.parent !== undefined) {
        const found = resolveNode(data, input.parent.trim());
        if (found === null || found === 'ambiguous')
          return invalid(
            found === null ? `parent "${input.parent}" is not defined` : `parent "${input.parent}" is ambiguous: give its path`,
            'parent',
          );
        parent = found;
      }
      if (input.kind === 'site' && parent !== null) return invalid('a site has no parent', 'parent');
      if (input.kind !== 'site' && parent === null) return invalid(`a ${input.kind} needs a parent`, 'parent');
      if (parent !== null && kindRank(input.kind) <= kindRank(parent.kind))
        return invalid(`a ${input.kind} cannot be below a ${parent.kind} (site > plant > area > unit > system)`, 'kind');
      const twin = data.hierarchyOrder
        .map((id) => data.hierarchy[id])
        .find((node) => node?.parentId === (parent?.id ?? null) && node.code === code);
      if (twin !== undefined)
        return refuse(doc, 'define_plant_hierarchy', {
          code: 'DAT_HIERARCHY_DUPLICATE_CODE',
          message: `code ${code} is already used under ${parent === null ? 'the root' : pathOf(data, parent.id)} (${twin.id})`,
          paths: [`${path}.code`],
          ids: [twin.id],
        });
      const node: HierarchyNode = {
        id: nextId('hier'),
        code,
        kind: input.kind,
        name: input.name?.trim() || code,
        parentId: parent?.id ?? null,
        properties: input.properties ?? {},
      };
      created.push(node);
      data = { ...data, hierarchy: { ...data.hierarchy, [node.id]: node }, hierarchyOrder: [...data.hierarchyOrder, node.id] };
    }
    const nodes = created.map((node) => ({ id: node.id, code: node.code, kind: node.kind, path: pathOf(data, node.id) }));
    return {
      ...changed(
        withPlantData(doc, data),
        `define_plant_hierarchy: ${nodes.length} node(s): ${nodes.map((node) => `${node.path} (${node.id})`).join(', ')}.`,
        created.map((node) => node.id),
      ),
      data: { nodeIds: created.map((node) => node.id), nodes },
    };
  },
});

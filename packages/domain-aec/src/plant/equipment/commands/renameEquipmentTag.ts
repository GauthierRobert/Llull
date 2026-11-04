import type { BuildingElement, EquipmentElement } from '@aec/building/types';
import { defineCommand, z } from '@core/commands/schema';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import { commitBuilding } from '../../../building/evaluate/evaluateElements';
import { elementsOf, getBuilding } from '../../../building/model';
import { getPiping } from '../../piping/model';
import { refuse } from '../model';
import { followableRenames, followMarkInColourRules, renamedReference } from '../tagReferences';
import { equipmentRefParam, findEquipment } from './equipmentRef';

/**
 * @affects changes the tag (mark) of equipment, parametric vessels included, and every reference to it: legacy pipe from / to (`<tag>` and `<tag>:<nozzle>`), routed line from / to text (through update_pipeline); the `mark` clauses (equals / in) of colour rules (09 VIS) follow the new mark unless another element still carries the old one; the plant objects of 08 DAT are NOT touched (the plant-data guard refuses a direct rename of classified equipment)
 * @invariant the tag grammar of add_vessel (no whitespace, no ':'), equipment tags unique after the whole batch (a swap is valid); element ids, nozzle marks, geometry and routed ports (by element id) are untouched
 * @failure unknown equipment, bad or duplicate tag -> EQP_* refusal, document unchanged
 */
export const renameEquipmentTag = defineCommand({
  name: 'rename_equipment_tag',
  description:
    'Rename the tag (mark) of equipment and keep every reference to it consistent: a legacy pipe from / to naming the tag or a port "<tag>:<nozzle>" and the from / to ' +
    'text of routed lines follow. This is the ONLY command that renames a parametric vessel (update_equipment refuses those because size, shape and weight are derived; ' +
    'the tag carries no geometry). The tag must not be empty nor contain whitespace or ":" (the port id is <tag>:<mark>) and must be unique among equipment after the ' +
    'whole batch (swapping two tags in one call is valid). renames: [{ equipment (tag or element id), tag }]. Returns data = { renamed [{ id, from, to }], pipes, lines } ' +
    'with the ids of the pipes and lines whose references were rewritten; display colour rules with a mark clause (equals / in) on the old tag are rewritten to the new one (data.colourRules; ' +
    'a mark regular expression cannot be rewritten: data.patternRules). Equipment already classified with assign_plant_object is renamed through plant data (assign_plant_object / set_plant_properties / ' +
    'set_tag_format retag), a direct rename is refused with DAT_DIRECT_RENAME; unassign_plant_object first to rename it freely. Refusals: EQP_NOT_FOUND, EQP_PARAM_INVALID, EQP_TAG_DUPLICATE. Used by assign_plant_object (plant data) to write a tag back.',
  params: z.object({
    renames: z
      .array(z.object({ equipment: equipmentRefParam, tag: z.string().describe('New tag, e.g. "P-101": no whitespace, no ":".') }))
      .min(1)
      .max(10000)
      .describe('Equipment and their new tags.'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const building = getBuilding(doc);
    const targets = new Map<string, string>();
    for (const [index, entry] of params.renames.entries()) {
      const element = findEquipment(building, entry.equipment);
      const path = `renames[${index}]`;
      if (element === undefined)
        return refuse(
          doc,
          'rename_equipment_tag',
          'EQP_NOT_FOUND',
          `no equipment with tag or id '${entry.equipment}'`,
          [],
          [`${path}.equipment`],
        );
      const tag = entry.tag.trim();
      if (tag === '' || /[:\s]/.test(tag))
        return refuse(
          doc,
          'rename_equipment_tag',
          'EQP_PARAM_INVALID',
          `tag "${entry.tag}" must not be empty nor contain whitespace or ':' (the port id is <tag>:<mark>)`,
          [element.id],
          [`${path}.tag`],
        );
      targets.set(element.id, tag);
    }
    const equipment = elementsOf(building, 'equipment');
    const finalMarks = new Map<string, string>();
    for (const element of equipment) {
      const mark = targets.get(element.id) ?? element.mark;
      const twin = finalMarks.get(mark);
      if (twin !== undefined)
        return refuse(
          doc,
          'rename_equipment_tag',
          'EQP_TAG_DUPLICATE',
          `tag '${mark}' would be used by ${twin} and ${element.id}`,
          [twin, element.id],
          ['renames'],
        );
      finalMarks.set(mark, element.id);
    }
    const renames = new Map<string, string>();
    const renamed: Array<{ id: string; from: string; to: string }> = [];
    for (const element of equipment) {
      const to = targets.get(element.id);
      if (to === undefined || to === element.mark) continue;
      renames.set(element.mark, to);
      renamed.push({ id: element.id, from: element.mark, to });
    }
    if (renamed.length === 0)
      return { document: doc, summary: 'rename_equipment_tag: every equipment already has these tags; nothing changed.', affected: [] };
    const elements: Record<string, BuildingElement> = { ...building.elements };
    for (const change of renamed) elements[change.id] = { ...(elements[change.id] as EquipmentElement), mark: change.to };
    const pipes: string[] = [];
    for (const pipe of elementsOf(building, 'pipe')) {
      const from = renamedReference(pipe.from, renames);
      const to = renamedReference(pipe.to, renames);
      if (from === undefined && to === undefined) continue;
      elements[pipe.id] = { ...pipe, ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) };
      pipes.push(pipe.id);
    }
    let current = commitBuilding(doc, { ...building, elements }, [...renamed.map((change) => change.id), ...pipes], '').document;
    const lines: string[] = [];
    const piping = getPiping(doc);
    for (const lineId of piping.lineOrder) {
      const line = piping.lines[lineId];
      const from = renamedReference(line?.from, renames);
      const to = renamedReference(line?.to, renames);
      if (from === undefined && to === undefined) continue;
      const updated = execute(
        current,
        'update_pipeline',
        { lineId, ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) },
        ctx,
      );
      if (updated.rejected === true)
        return refuse(
          doc,
          'rename_equipment_tag',
          'EQP_PARAM_INVALID',
          `line ${lineId} cannot follow the rename: ${updated.summary}`,
          [lineId],
          ['renames'],
        );
      current = updated.document;
      lines.push(lineId);
    }
    const rules = followMarkInColourRules(
      current,
      followableRenames(building.elements, new Set(renamed.map((change) => change.id)), renames),
    );
    return {
      document: rules.document,
      summary: `rename_equipment_tag: ${renamed.length} equipment renamed (${renamed
        .slice(0, 4)
        .map((change) => `${change.from} -> ${change.to}`)
        .join(', ')}${renamed.length > 4 ? ', ...' : ''}); ${pipes.length} pipe and ${lines.length} line reference(s) followed${
        rules.followed.length === 0 ? '' : `, ${rules.followed.length} colour rule(s) (${rules.followed.join(', ')})`
      }${rules.patterned.length === 0 ? '' : `; colour rule(s) ${rules.patterned.join(', ')} match the old mark by pattern and were not rewritten`}.`,
      affected: [...renamed.map((change) => change.id), ...pipes, ...lines],
      data: { renamed, pipes, lines, colourRules: rules.followed, patternRules: rules.patterned },
    };
  },
});

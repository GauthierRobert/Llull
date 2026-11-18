/** import_composite_ap242: rebuilds the composite part, its plies, rosettes and materials from the records of export_composite_ap242, unverified and for review (06 CMP M5). */

import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import { nextId } from '@lib/id';
import { sig } from '../../shared/results';
import { refuseCmp } from '../codes';
import { syncOutlines } from '../derive';
import { compositesErrors } from '../document';
import { compositesOf, findPart, withComposites } from '../state';
import { importSolids, insertPlies, linkPlies, mergeMaterials, mergeRosettes, partOf, solidFindings, stepTextOf } from './importPhases';
import { readComposite } from './reader';
import { rebuildPart } from './rebuild';
import { checkComposite } from './standardCheck';
import { worstBand } from './validation';

const NAME = 'import_composite_ap242';

/**
 * @affects creates doc.composites.parts[part-<step>.<k>], its plies (ply-<step>.<k>), the rosettes and lamina materials the file names that the document lacks (materials unverified), and with importSolids the exact solids of the file (entities named as in the file) through import_step_exact
 * @invariant plies come back with the file's names, sequences, stacking order, orientations (part frame), materials, rosettes and boundaries; the embedded validation properties (number of plies, ply areas, thickness, mass) are recomputed from the rebuilt plies and compared (data.validation.band); the result is always reviewRequired: nothing imported is verified
 * @failure no text -> CMP_PARAM_INVALID; file without composite records -> CMP_AP242_NO_COMPOSITE; damaged records -> CMP_AP242_MALFORMED; part name taken -> CMP_NAME_TAKEN; solids refused by the kernel -> CMP_AP242_SOLIDS_FAILED
 */
export const importCompositeAp242 = defineCommand({
  name: NAME,
  description:
    'Import the composite laminate of a STEP AP242 file written by export_composite_ap242: a composite part (tool surface frame, laminate side, rules), its plies in ' +
    'stacking order with name, sequence, material, orientation (part frame, degrees), rosette and boundary polygons, the rosettes, and the lamina materials the document ' +
    'does not have yet (created with basis "unknown", so every result computed from them is unverified). With importSolids (default) the exact solids of the file (the tool ' +
    'solid and the ply solids) are imported first through import_step_exact and the part is attached to the imported tool solid. The validation properties embedded in the ' +
    'file (the CAx-IF composite validation properties: counts, total ply surface area, orientation values, sequence order, curve lengths, areas per material and rosette; and ' +
    'llull own area of each ply, summed thickness, mass) are recomputed from the rebuilt plies and compared, and the CAx-IF structure of the file (laminate table, sequences, ' +
    'plies, materials, orientation angles, ply pieces) is read back and compared with the plies (properties named "structure: ..."): data.validation lists property, subject, embedded, ' +
    'recomputed, relative difference and band green / yellow / red / not_checkable. Nothing imported is verified: data.reviewRequired is true. Files without llull composite ' +
    'records (from other systems, or the CAx-IF structure alone) are refused with CMP_AP242_NO_COMPOSITE. Give the file as `text` or `stepBase64`. Needs the OCC kernel only when importSolids is true. A ply solid the file lists but the import did not yield under its name, a tool solid that did not import, and a ply solid whose volume differs from ply area x thickness are red findings (reasons solids_unlinked, tool_not_imported, validation_red).',
  params: z.object({
    text: z.string().describe('ISO 10303-21 text of the file (or give stepBase64).').optional(),
    stepBase64: z.string().describe('The file as base64 (or give text).').optional(),
    name: z.string().min(1).describe('Name of the created part; default the part name in the file.').optional(),
    importSolids: z
      .boolean()
      .describe(
        'Import the exact solids of the file (tool and ply solids) with import_step_exact; default true. false builds the part only, with the tool entity id of the file.',
      )
      .optional(),
  }),
  run: (doc, params, ctx): CommandResult => {
    const fail = (code: string, message: string, ids: readonly string[] = [], paths: readonly string[] = []): CommandResult =>
      refuseCmp(doc, NAME, code, message, ids, paths);
    const text = stepTextOf(params);
    if (typeof text !== 'string') return fail(text.code, text.message, [], text.paths);
    const read = readComposite(text);
    if (!read.ok) return fail(read.code === 'no_composite' ? 'CMP_AP242_NO_COMPOSITE' : 'CMP_AP242_MALFORMED', read.reason);
    const { record, embedded } = read;
    const partName = params.name ?? record.name;
    if (findPart(compositesOf(doc), partName) !== null)
      return fail('CMP_NAME_TAKEN', `a part named "${partName}" exists`, [], ['params.name']);

    const wantSolids = params.importSolids !== false;
    const solids = importSolids(doc, text, wantSolids, ctx);
    if ('refused' in solids) return fail('CMP_AP242_SOLIDS_FAILED', solids.refused);
    const { base, solidIds, solidsReport } = solids;
    const byName = new Map(solidIds.map((id) => [base.entities[id]?.name ?? id, id] as const));
    const toolEntity = byName.get(record.tool.name);

    const model = compositesOf(base);
    const { materials, created: createdMaterials, reused: reusedMaterials } = mergeMaterials(model, record);
    const { rosettes, rosetteIdOf, created: createdRosettes } = mergeRosettes(model, record);
    const partRosette = rosetteIdOf.get(record.partRosette);
    if (partRosette === undefined) return fail('CMP_AP242_MALFORMED', `the part rosette "${record.partRosette}" is not in the file`);

    const partId = nextId('part');
    const part = partOf(partId, partName, record, toolEntity, partRosette);
    const { working, plies } = insertPlies(
      { ...model, materials, rosettes, parts: { ...model.parts, [partId]: part } },
      part,
      record,
      rosetteIdOf,
      partRosette,
    );
    const invalid = compositesErrors(working);
    if (invalid.length > 0)
      return fail(
        'CMP_AP242_MALFORMED',
        `the composite data of the file is not valid: ${invalid.slice(0, 5).join('; ')}`,
        [],
        invalid.slice(0, 5).map((message) => message.split(' ')[0] ?? message),
      );
    const next = syncOutlines(withComposites(base, working));

    const rebuilt = rebuildPart(record);
    const checked = checkComposite(record, rebuilt.part, rebuilt.plies, embedded, read.standard);
    const linked = linkPlies(record, plies, byName);
    const unlinked = linked.reduce((sum, entry) => sum + entry.expectedSolids - entry.solids.length, 0);
    const geometry = wantSolids ? solidFindings(record, rebuilt, linked, solidsReport, base.units, toolEntity) : [];
    const findings = [...checked.findings, ...geometry];
    const validation = { ...checked, findings, band: worstBand(findings) };
    const reasons = [
      'composite_import_unverified',
      ...(wantSolids && unlinked > 0 ? ['solids_unlinked'] : []),
      ...(wantSolids && toolEntity === undefined ? ['tool_not_imported'] : []),
      ...(validation.band === 'green' ? [] : [`validation_${validation.band}`]),
    ];
    const data = {
      part: partId,
      name: partName,
      plies: plies.map((ply) => ({
        id: ply.id,
        name: ply.name,
        order: ply.order,
        material: ply.materialName,
        orientation: ply.orientation,
      })),
      materials: { created: createdMaterials, reused: reusedMaterials },
      rosettes: { created: createdRosettes },
      tool: { entityId: toolEntity ?? record.tool.entityId, imported: toolEntity !== undefined, name: record.tool.name },
      solids: { imported: solidIds, perPly: linked, unlinked, linkedInFile: read.linkedSolids },
      validation,
      importReport: solidsReport,
      reviewRequired: { value: true, reasons },
      laminatesInFile: read.laminates,
    };
    const result = changed(
      next,
      `${NAME}: part "${partName}" (${partId}) with ${plies.length} ply(ies) on tool '${data.tool.entityId}'${data.tool.imported ? '' : ' (tool solid not imported)'}, ${createdMaterials.length} material(s) created unverified, ${solidIds.length} solid(s) imported (${unlinked} ply solid(s) not found by name); validation ${validation.band} (${validation.findings.length} comparisons, thickness ${sig(embedded.thickness ?? Number.NaN)}). Review required: nothing imported is verified.`,
      [partId, ...plies.map((ply) => ply.id), ...solidIds],
    );
    return { ...result, data };
  },
});

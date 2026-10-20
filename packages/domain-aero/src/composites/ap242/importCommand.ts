/** import_composite_ap242: rebuilds the composite part, its plies, rosettes and materials from the records of export_composite_ap242, unverified and for review (06 CMP M5). */

import { defineCommand, z } from '@core/commands/schema';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import type { CompositePart, LaminaMaterial, Ply, Rosette } from '@core/model/composites';
import type { CadDocument } from '@core/model/types';
import { base64ToText } from '@lib/base64';
import { MM_PER_UNIT } from '@core/model/units';
import { nextId } from '@lib/id';
import { sig } from '../../shared/results';
import { refuseCmp } from '../codes';
import { syncOutlines } from '../derive';
import { insertPly } from '../plyCommands';
import { compositesErrors } from '../document';
import { compositesOf, findPart, withComposites } from '../state';
import { readComposite } from './reader';
import { withoutCompositeUsages } from './standardReader';
import { rebuildPart } from './rebuild';
import { checkComposite } from './standardCheck';
import { type ValidationFinding, compare, plyArea, worstBand } from './validation';

const MAX_STEP_CHARS = 64 * 1024 * 1024;

/** Relative difference between a ply solid's volume and area x thickness: green up to 1 % (curvature of the offset, faceting), yellow up to 5 %. */
const VOLUME_GREEN = 0.01;
const VOLUME_YELLOW = 0.05;
const NAME = 'import_composite_ap242';

/** An imported lamina record: the original data with its basis reset to unknown (nobody verified it here) and the origin in the source. */
const unverifiedMaterial = (material: LaminaMaterial): LaminaMaterial => ({
  ...material,
  basis: 'unknown',
  source: `imported from STEP AP242 (original basis ${material.basis}; ${material.source})`,
});

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
    if (params.stepBase64 !== undefined && params.stepBase64.length > Math.ceil((MAX_STEP_CHARS * 4) / 3))
      return fail('CMP_PARAM_INVALID', 'the file is larger than 64 MiB', [], ['params.stepBase64']);
    const text = params.text ?? (params.stepBase64 === undefined ? undefined : base64ToText(params.stepBase64));
    if (text === undefined || text === null || text.length === 0)
      return fail('CMP_PARAM_INVALID', 'give the file as text or stepBase64', [], ['params.text']);
    if (text.length > MAX_STEP_CHARS) return fail('CMP_PARAM_INVALID', 'the file is larger than 64 MiB', [], ['params.text']);
    const read = readComposite(text);
    if (!read.ok) return fail(read.code === 'no_composite' ? 'CMP_AP242_NO_COMPOSITE' : 'CMP_AP242_MALFORMED', read.reason);
    const { record, embedded } = read;
    const partName = params.name ?? record.name;
    if (findPart(compositesOf(doc), partName) !== null)
      return fail('CMP_NAME_TAKEN', `a part named "${partName}" exists`, [], ['params.name']);

    let base: CadDocument = doc;
    let solidIds: string[] = [];
    let solidsReport: unknown;
    if (params.importSolids !== false) {
      const imported = execute(doc, 'import_step_exact', { text: withoutCompositeUsages(text) }, ctx);
      if (imported.error !== undefined || imported.affected.length === 0)
        return fail('CMP_AP242_SOLIDS_FAILED', `import_step_exact answered: ${imported.summary}`);
      base = imported.document;
      solidIds = imported.affected;
      solidsReport = (imported.data as { report?: unknown } | undefined)?.report;
    }
    const byName = new Map(solidIds.map((id) => [base.entities[id]?.name ?? id, id] as const));
    const toolEntity = byName.get(record.tool.name);

    const model = compositesOf(base);
    const materials: Record<string, LaminaMaterial> = { ...model.materials };
    const createdMaterials: string[] = [];
    const reusedMaterials: string[] = [];
    for (const material of record.materials) {
      if (materials[material.name] === undefined) {
        materials[material.name] = unverifiedMaterial(material);
        createdMaterials.push(material.name);
      } else reusedMaterials.push(material.name);
    }
    const rosettes: Record<string, Rosette> = { ...model.rosettes };
    const rosetteIdOf = new Map<string, string>();
    for (const entry of Object.values(rosettes)) if (!rosetteIdOf.has(entry.name)) rosetteIdOf.set(entry.name, entry.id);
    const createdRosettes: string[] = [];
    for (const entry of record.rosettes) {
      if (rosetteIdOf.has(entry.name)) continue;
      const id = nextId('ros');
      rosettes[id] = { id, ...entry };
      rosetteIdOf.set(entry.name, id);
      createdRosettes.push(entry.name);
    }
    const partRosette = rosetteIdOf.get(record.partRosette);
    if (partRosette === undefined) return fail('CMP_AP242_MALFORMED', `the part rosette "${record.partRosette}" is not in the file`);

    const partId = nextId('part');
    const part: CompositePart = {
      id: partId,
      name: partName,
      toolFaces: [
        {
          entityId: toolEntity ?? record.tool.entityId,
          faceNear: record.tool.faceNear,
          ...(record.tool.faceIndex === undefined ? {} : { faceIndex: record.tool.faceIndex }),
        },
      ],
      laminateSide: record.laminateSide,
      rosetteId: partRosette,
      surface: record.surface,
      outline: record.outline,
      ...(record.rules === undefined ? {} : { rules: record.rules }),
      ...(record.plyDropRules === undefined ? {} : { plyDropRules: record.plyDropRules }),
    };
    let working = { ...model, materials, rosettes, parts: { ...model.parts, [partId]: part } };
    const plies: Ply[] = [];
    for (const entry of [...record.plies].sort((a, b) => a.order - b.order)) {
      const inserted = insertPly(working, part, {
        name: entry.name,
        materialName: entry.material,
        orientation: entry.orientation,
        sequence: entry.sequence,
        rosetteId: rosetteIdOf.get(entry.rosette) ?? partRosette,
        boundary: entry.boundary,
        ...(entry.drape === undefined ? {} : { drape: entry.drape }),
        ...(entry.cuts === undefined ? {} : { cuts: entry.cuts }),
      });
      working = inserted.model;
      plies.push(inserted.ply);
    }
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
    const linked = record.plies.map((entry) => ({
      ply: plies.find((ply) => ply.name === entry.name)?.id ?? '',
      name: entry.name,
      solids: entry.solids.flatMap((solid) => (byName.has(solid) ? [byName.get(solid) as string] : [])),
      expectedSolids: entry.solids.length,
    }));
    const unlinked = linked.reduce((sum, entry) => sum + entry.expectedSolids - entry.solids.length, 0);
    const wantSolids = params.importSolids !== false;
    const geometry: ValidationFinding[] = [];
    /** Volume (document units^3) of the products the entities belong to, from the import report's recomputed values (millimetres); undefined when not reported. */
    const reported =
      (solidsReport as { exchange?: { products?: { entityIds?: string[]; recomputed?: { volume: number } }[] } } | undefined)?.exchange
        ?.products ?? [];
    const cubic = MM_PER_UNIT[base.units] ** 3;
    const volumesOf = (ids: readonly string[]): (number | undefined)[] => {
      const products = [...new Set(ids.map((id) => reported.find((product) => product.entityIds?.includes(id))))];
      return products.map((product) => (product?.recomputed === undefined ? undefined : product.recomputed.volume / cubic));
    };
    if (wantSolids) {
      geometry.push(compare('structure: tool solid imported', record.tool.name, 1, toolEntity === undefined ? 0 : 1));
      for (const entry of linked)
        if (entry.expectedSolids > 0)
          geometry.push(compare('structure: ply solids linked', entry.name, entry.expectedSolids, entry.solids.length));
      for (const entry of linked) {
        const rebuiltPly = rebuilt.plies.find((candidate) => candidate.record.name === entry.name);
        if (rebuiltPly === undefined || entry.solids.length === 0 || entry.solids.length < entry.expectedSolids) continue;
        const volumes = volumesOf(entry.solids);
        const expected = plyArea(rebuilt.part, rebuiltPly.ply) * rebuiltPly.record.thickness;
        if (volumes.some((volume) => typeof volume !== 'number')) {
          geometry.push({
            property: 'structure: ply solid volume',
            subject: entry.name,
            embedded: null,
            recomputed: expected,
            relativeDifference: null,
            band: 'not_checkable',
          });
          continue;
        }
        const total = (volumes as number[]).reduce((sum, volume) => sum + volume, 0);
        const relative = Math.abs(total - expected) / Math.max(expected, 1e-300);
        geometry.push({
          property: 'structure: ply solid volume',
          subject: entry.name,
          embedded: total,
          recomputed: expected,
          relativeDifference: relative,
          band: relative <= VOLUME_GREEN ? 'green' : relative <= VOLUME_YELLOW ? 'yellow' : 'red',
        });
      }
    }
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

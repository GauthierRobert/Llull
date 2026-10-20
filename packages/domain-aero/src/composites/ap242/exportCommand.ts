/** export_composite_ap242: STEP AP242 with the exact tool solid, the explicit ply solids and the implicit ply table with its validation properties (06 CMP M5). */

import { confirmExportControlled, defineCommand, z } from '@core/commands/schema';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import { exportRefusal, rejection, report } from '@core/commands/noop';
import type { CompositePart, Ply } from '@core/model/composites';
import type { CadDocument, Vec3 } from '@core/model/types';
import { sig } from '../../shared/results';
import { refuseCmp } from '../codes';
import { piecesOf } from '../geometry2d';
import { normalizeAngle } from '../notation';
import { orientationInRosette } from '../plyFrame';
import { fromFlat } from '../surface';
import { compositesOf, findPart, pliesOf } from '../state';
import type { CompositeRecord, PlyRecord, RosetteRecord } from './interchange';
import { readComposite } from './reader';
import { rebuildPart } from './rebuild';
import { checkComposite } from './standardCheck';
import { laminateValidation, plyArea } from './validation';
import { appendComposite } from './writer';

const EPOCH_TIMESTAMP = '1970-01-01T00:00:00';
const nameOf = (entity: { readonly id: string; readonly name?: string | undefined }): string => entity.name ?? entity.id;

/** Boundary polylines of a ply on the tool surface (chart vertices mapped to the surface). */
const curvesOf = (part: CompositePart, ply: Ply): Vec3[][] =>
  piecesOf(ply, part).map((piece) => piece.map((uv) => fromFlat(part.surface, uv)));

/** Entities of `doc` named "<ply name> piece <n>" (the solids `create_ply_solids` makes), in document order. */
function solidsOfPly(doc: CadDocument, ply: Ply): string[] {
  const prefix = `${ply.name} piece `;
  return doc.order.filter((id) => {
    const entity = doc.entities[id];
    return (
      entity !== undefined &&
      entity.kind === 'mesh' &&
      entity.name?.startsWith(prefix) === true &&
      /^\d+$/.test(entity.name.slice(prefix.length))
    );
  });
}

/**
 * @affects nothing (read-only)
 * @invariant data.step is an AP242 file with the tool solid and the ply solids (exact where the kernel builds them) from export_step_ap242, followed by the CAx-IF composite structure (ply_laminate_table, sequences, plies, material and orientation links, ply pieces, base surface, composite validation properties) and the llull records (part frame, chart polygons, lamina data, area / thickness / mass); the written text is read back and everything is compared with the model (data.selfCheck)
 * @failure unknown part -> CMP_REF_MISSING; no plies -> CMP_NO_PLIES; tool solid gone -> CMP_AP242_TOOL_MISSING; clashing names -> CMP_AP242_NAME_CLASH; kernel / writer refusal -> its XCH_* code; self-check red -> CMP_AP242_SELFCHECK_RED
 */
export const exportCompositeAp242 = defineCommand({
  name: 'export_composite_ap242',
  annotations: { readOnly: true, requiresKernel: true },
  description:
    'Export a composite part to STEP AP242 (ISO 10303-21): the exact tool solid and, when create_ply_solids made them, the explicit per-ply solids ("<ply> piece <n>"; ' +
    'exact B-reps where the kernel builds the slab, triangles otherwise) go through export_step_ap242 (named products, flat, geometric validation properties); llull then ' +
    'appends the implicit laminate definition as the CAx-IF composite structure (Recommended Practices for Composite Materials v4.4): a ply_laminate_table with its ' +
    'ply_laminate_sequence_definitions in stacking order, one product per ply (category "ply") with its material (make_from_usage_option to a stock-material product), ' +
    'thickness, orientation (ply_orientation_angle against a reinforcement_orientation_basis rosette) and boundary curves, the ply solids as ply pieces under their ply, ' +
    'the base surface (plane, cylinder, cone, sphere; not a NURBS sheet) and the composite validation properties named as the CAx-IF validation practice names them ' +
    '(number of tables / sequences / plies / cores / materials / orientations / rosettes, total ply surface area, ordered orientation values, ordered sequences per ' +
    'laminate table, curve length and ply-piece count per ply, boundary length per rosette, area per material). llull also writes its own lossless records (part frame, ' +
    'chart polygons, lamina data, per-ply area, thickness, mass) as property records of the tool product. The written text is read back and everything is compared with ' +
    'the model (data.selfCheck). import_composite_ap242 reads it back. Returns data: { format, ' +
    'step, schema, part, tool, plies[{ ply, name, order, area, thickness, solids }], validation, selfCheck, solids: { exact, faceted }, records, policy, reviewRequired }. ' +
    'Needs the OCC kernel. Does not modify the document.',
  params: z.object({
    part: z.string().describe('Part id or name.'),
    includeSolids: z
      .boolean()
      .describe(
        'Write the explicit ply solids (the "<ply> piece <n>" entities) with the tool solid; default true. false writes the tool solid and the implicit table only.',
      )
      .optional(),
    fileName: z.string().describe('File name recorded in the Part 21 header; default llull-composite.stp.').optional(),
    timestamp: z
      .string()
      .describe('ISO 8601 time recorded in the header; default 1970-01-01T00:00:00 so the output is reproducible.')
      .optional(),
    acceptUnverified: confirmExportControlled.describe(
      'Human confirmation to export imported bodies whose validation properties were red (a signature object; an agent cannot give it).',
    ),
    confirmExportControlled,
  }),
  run: (doc, params, ctx): CommandResult => {
    const fail = (code: string, message: string, ids: readonly string[] = [], paths: readonly string[] = []): CommandResult =>
      refuseCmp(doc, 'export_composite_ap242', code, message, ids, paths);
    const refused = exportRefusal(doc, 'export_composite_ap242', 'step', params.confirmExportControlled, ctx);
    if (refused !== null) return refused;
    const model = compositesOf(doc);
    const part = findPart(model, params.part);
    if (part === null) return fail('CMP_REF_MISSING', `no part '${params.part}'`, [], ['params.part']);
    const plies = pliesOf(model, part.id);
    if (plies.length === 0) return fail('CMP_NO_PLIES', `part "${part.name}" has no plies`, [part.id], ['params.part']);
    const toolId = part.toolFaces[0]?.entityId ?? '';
    const tool = doc.entities[toolId];
    if (tool === undefined)
      return fail('CMP_AP242_TOOL_MISSING', `the tool solid '${toolId}' of part "${part.name}" no longer exists`, [part.id, toolId]);
    const missing = plies.find((ply) => model.materials[ply.materialName] === undefined || model.rosettes[ply.rosetteId] === undefined);
    if (missing !== undefined)
      return fail('CMP_REF_MISSING', `ply "${missing.name}" refers to an unknown material or rosette`, [missing.id]);

    const solidsByPly = new Map(plies.map((ply) => [ply.id, params.includeSolids === false ? [] : solidsOfPly(doc, ply)] as const));
    const solidIds = [...new Set([...solidsByPly.values()].flat())];
    const names = [toolId, ...solidIds].map((id) => nameOf(doc.entities[id] as { id: string; name?: string }));
    const clash = names.find((name, index) => names.indexOf(name) !== index);
    if (clash !== undefined) return fail('CMP_AP242_NAME_CLASH', `two exported solids are named "${clash}"`, [toolId, ...solidIds]);

    const written = execute(
      doc,
      'export_step_ap242',
      {
        entityIds: [toolId, ...solidIds],
        schema: 'ap242',
        assembly: 'flat',
        fileName: params.fileName ?? 'llull-composite.stp',
        timestamp: params.timestamp ?? EPOCH_TIMESTAMP,
        ...(params.acceptUnverified === undefined ? {} : { acceptUnverified: params.acceptUnverified }),
        ...(params.confirmExportControlled === undefined ? {} : { confirmExportControlled: params.confirmExportControlled }),
      },
      ctx,
    );
    const base = (written.data as { step?: string; faceted?: string[]; solidCount?: number } | undefined) ?? {};
    if (written.error !== undefined || typeof base.step !== 'string')
      return written.error === undefined
        ? fail('CMP_AP242_WRITE_FAILED', `the STEP writer answered: ${written.summary}`, [part.id])
        : rejection(doc, `export_composite_ap242: ${written.summary}`, written.error);

    const rosetteRecord = (id: string): RosetteRecord => {
      const rosette = model.rosettes[id] as NonNullable<(typeof model.rosettes)[string]>;
      return {
        name: rosette.name,
        origin: rosette.origin,
        axis0: rosette.axis0,
        normal: rosette.normal,
        method: rosette.method,
        ...(rosette.axis === undefined ? {} : { axis: rosette.axis }),
      };
    };
    const plyRecords: PlyRecord[] = plies.map((ply) => {
      const material = model.materials[ply.materialName] as NonNullable<(typeof model.materials)[string]>;
      return {
        name: ply.name,
        sequence: ply.sequence,
        order: ply.order,
        material: ply.materialName,
        orientation: ply.orientation,
        rosetteOrientation:
          Math.round(normalizeAngle(orientationInRosette(part, model.rosettes[ply.rosetteId], ply.orientation)) * 1e9) / 1e9 + 0,
        rosette: model.rosettes[ply.rosetteId]?.name ?? '',
        boundary: ply.boundary,
        ...(ply.drape === undefined ? {} : { drape: ply.drape }),
        ...(ply.cuts === undefined ? {} : { cuts: ply.cuts }),
        thickness: material.plyThickness,
        area: plyArea(part, ply),
        solids: (solidsByPly.get(ply.id) ?? []).map((id) => nameOf(doc.entities[id] as { id: string; name?: string })),
        curves3d: curvesOf(part, ply),
      };
    });
    const materials = [...new Set(plies.map((ply) => ply.materialName))].map(
      (name) => model.materials[name] as NonNullable<(typeof model.materials)[string]>,
    );
    const rosetteIds = [...new Set([part.rosetteId, ...plies.map((ply) => ply.rosetteId)])].filter(
      (id) => model.rosettes[id] !== undefined,
    );
    const record: CompositeRecord = {
      name: part.name,
      units: doc.units,
      laminateSide: part.laminateSide,
      tool: {
        name: nameOf(tool),
        entityId: toolId,
        faceNear: part.toolFaces[0]?.faceNear ?? [0, 0, 0],
        ...(part.toolFaces[0]?.faceIndex === undefined ? {} : { faceIndex: part.toolFaces[0].faceIndex }),
      },
      partRosette: model.rosettes[part.rosetteId]?.name ?? '',
      rosettes: rosetteIds.map(rosetteRecord),
      surface: part.surface,
      outline: part.outline,
      ...(part.rules === undefined ? {} : { rules: part.rules }),
      ...(part.plyDropRules === undefined ? {} : { plyDropRules: part.plyDropRules }),
      materials,
      plies: plyRecords,
      validation: laminateValidation(plyRecords, model.materials),
    };
    const appended = appendComposite(base.step, record);
    if (!appended.ok) return fail('CMP_AP242_WRITE_FAILED', appended.reason, [part.id]);

    const readBack = readComposite(appended.text);
    if (!readBack.ok)
      return fail('CMP_AP242_SELFCHECK_RED', `the written composite records cannot be read back: ${readBack.reason}`, [part.id]);
    const rebuilt = rebuildPart(readBack.record);
    const selfCheck = checkComposite(readBack.record, rebuilt.part, rebuilt.plies, readBack.embedded, readBack.standard);
    if (selfCheck.band !== 'green')
      return fail('CMP_AP242_SELFCHECK_RED', `the validation properties read back from the file are ${selfCheck.band}`, [part.id]);

    const slabRefused = base.faceted ?? [];
    const isExact = (id: string): boolean => {
      const entity = doc.entities[id];
      return entity?.kind === 'mesh' && entity.stepSlab !== undefined && !slabRefused.includes(id);
    };
    const faceted = solidIds.filter((id) => !isExact(id));
    const exactCount = solidIds.length - faceted.length;
    const { validation } = record;
    return report(
      doc,
      `export_composite_ap242: part "${part.name}" (${part.id}) -> STEP AP242, tool '${nameOf(tool)}' + ${solidIds.length} ply solid(s) (${exactCount} exact, ${faceted.length} faceted), ${plies.length} ply(ies) in the table, thickness ${sig(validation.thickness)}${validation.mass === undefined ? '' : `, mass ${sig(validation.mass)}`}, ${appended.records} composite record(s), ${appended.text.length} bytes; self-check ${selfCheck.band} (${selfCheck.findings.length} comparisons).`,
      {
        format: 'step',
        step: appended.text,
        schema: 'ap242',
        part: part.id,
        tool: { entityId: toolId, name: nameOf(tool) },
        plies: plyRecords.map(({ name, order, area, thickness, solids }, index) => ({
          ply: plies[index]?.id,
          name,
          order,
          area: sig(area),
          thickness,
          solids,
        })),
        validation: {
          plyCount: validation.plyCount,
          thickness: sig(validation.thickness),
          ...(validation.mass === undefined ? {} : { mass: sig(validation.mass) }),
        },
        selfCheck,
        solids: { exact: exactCount, faceted },
        records: appended.records,
        policy: {
          encoding:
            'CAx-IF Recommended Practices for Composite Materials v4.4 structure plus the llull-composite-2 records (see 06 TECHNICAL_SPEC 13.6 for what is and is not written)',
          selfCheck: selfCheck.policy,
        },
        reviewRequired: { value: false, reasons: [] },
      },
    );
  },
});

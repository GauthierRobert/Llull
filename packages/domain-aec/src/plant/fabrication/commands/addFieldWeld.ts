import { defineCommand, vec3, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { MM_PER_UNIT } from '@core/model/units';
import type { Vec3 } from '@core/model/vectors';
import { nextId } from '@lib/id';
import { distance3 } from '@lib/vec3';
import { refuseIso } from '../codes';
import { nearestPipe } from '../fieldWelds';
import { isLineRead, loadLine } from '../lineNetwork';
import type { FieldWeldRecord } from '../model';
import { getFabrication, withFabrication } from '../state';

const round1 = (value: number): number => Math.round(value * 10) / 10 + 0;

/**
 * @affects plant.fabrication.fieldWelds[weldId] (one field weld, world mm); the line's network is split there when read
 * @invariant the base line (routed, imported, legacy) is not edited: queries and export_pcf apply the weld as WELD (SKEY WS / WF, ERECTION-ITEM) between two pipe pieces `<pipeId>.s1`, `<pipeId>.s2`;
 *   the stored point is the projection of `at` on the centreline (0.1 mm); ids are step-scoped (fw-<step>.<k>)
 * @failure unknown line -> ISO_LINE_NOT_FOUND; `at` farther than 1 mm from every pipe -> ISO_WELD_NOT_ON_PIPE; a piece shorter than max(1 mm, minCutPieceMm) -> ISO_WELD_TOO_CLOSE; the document is unchanged
 */
export const addFieldWeld = defineCommand({
  name: 'add_field_weld',
  description:
    'Add a field weld on a pipe of a line: a site weld (WS, welded on site) or a field-fit weld (WF, cut to length on site with an allowance). The pipe through the point is split in two pieces ' +
    'with a WELD between them; the line itself (routed, imported with import_pcf, or legacy) is not edited, the weld is stored in doc.plant.fabrication and applied wherever the line is read ' +
    '(weld_list, number_welds, split_spools, cut_list, piping_bom, export_pcf writes it as a WELD record). A site or field-fit weld ends a spool. `at` is a point on the pipe centreline in ' +
    'document units, world coordinates (z absolute, the same frame as export_pcf); it is projected on the pipe within 1 mm. Returns affected = [weldId] and data = { weldId, lineId, at (world mm), type, ' +
    'splitPipeIds: [pieceBefore, pieceAfter], pieceLengthsMm }. Weld numbers are not assigned here: run number_welds afterwards (existing numbers are kept, the new weld takes highest + 1). ' +
    'Refusals (document unchanged): ISO_LINE_NOT_FOUND, ISO_WELD_NOT_ON_PIPE, ISO_WELD_TOO_CLOSE (a piece shorter than minCutPieceMm of set_fabrication_rules, at least 1 mm).',
  params: z.object({
    lineId: z
      .string()
      .min(1)
      .describe('The line: a routed line id (affected[0] of create_pipeline), an imported PCF line number or a legacy pipe line number.'),
    at: vec3(
      'Point on the pipe centreline [x, y, z] in document units, world coordinates (z absolute). Projected on the nearest pipe within 1 mm.',
    ),
    type: z
      .enum(['site', 'field_fit'])
      .optional()
      .describe(
        'site = welded on site (SKEY WS); field_fit = cut to length on site, adds the field-fit allowance to the adjoining cuts (SKEY WF). Default site.',
      ),
  }),
  run: (doc, params): CommandResult => {
    const read = loadLine(doc, 'add_field_weld', params.lineId);
    if (!isLineRead(read)) return read;
    const scale = MM_PER_UNIT[doc.units];
    const at: Vec3 = [params.at[0] * scale, params.at[1] * scale, params.at[2] * scale];
    const hit = nearestPipe(read.network.components, at);
    if (hit === null)
      return refuseIso(
        doc,
        'add_field_weld',
        'ISO_WELD_NOT_ON_PIPE',
        `no pipe of line ${params.lineId} within 1 mm of the point`,
        [params.lineId],
        ['at'],
      );
    const [start, end] = hit.component.ends;
    const length = start === undefined || end === undefined ? 0 : distance3(start.xyz, end.xyz);
    const fabrication = getFabrication(doc);
    const minimum = Math.max(1, fabrication.rules?.minCutPieceMm?.value ?? 0);
    const before = hit.t * length;
    const after = (1 - hit.t) * length;
    if (before < minimum || after < minimum)
      return refuseIso(
        doc,
        'add_field_weld',
        'ISO_WELD_TOO_CLOSE',
        `pipe ${hit.component.id} would be left with a piece of ${Math.min(before, after).toFixed(1)} mm (minimum ${minimum} mm)`,
        [hit.component.id],
        ['at'],
      );
    const weld: FieldWeldRecord = {
      id: nextId('fw'),
      lineId: params.lineId,
      xyz: [round1(hit.point[0]), round1(hit.point[1]), round1(hit.point[2])],
      type: params.type ?? 'site',
    };
    const next = withFabrication(doc, { ...fabrication, fieldWelds: { ...fabrication.fieldWelds, [weld.id]: weld } });
    const pieces = loadLine(next, 'add_field_weld', params.lineId);
    const split = isLineRead(pieces) ? (pieces.pieces[weld.id] ?? []) : [];
    return {
      document: next,
      summary: `add_field_weld: ${weld.type === 'site' ? 'site' : 'field-fit'} weld ${weld.id} on line ${params.lineId} at (${weld.xyz.join(', ')}) mm splits pipe ${hit.component.id} into ${split.join(' and ')} (${before.toFixed(1)} + ${after.toFixed(1)} mm); run number_welds to number it`,
      affected: [weld.id],
      data: {
        weldId: weld.id,
        lineId: params.lineId,
        at: weld.xyz,
        type: weld.type,
        splitPipeIds: split,
        pieceLengthsMm: [round1(before), round1(after)],
      },
    };
  },
});

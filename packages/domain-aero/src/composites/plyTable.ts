/** export_ply_table, import_ply_table, ply_book_data: the ply list as CSV and the numeric content of the ply book (FR-CMP-51, FR-CMP-53). */

import { confirmExportControlled, defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed, exportRefusal, report } from '@core/commands/noop';
import { MM_PER_UNIT } from '@core/model/units';
import { polygonArea, polygonPerimeter } from '@lib/polygon';
import { sig } from '../shared/results';
import { refuseCmp } from './codes';
import { syncOutlines } from './derive';
import { piecesOf } from './geometry2d';
import { normalizeAngle } from './notation';
import { insertPly } from './plyCommands';
import { isUnverified } from './provenance';
import { compositesOf, findPart, findRosette, pliesOf, withComposites, zonesOf } from './state';

const COLUMNS = ['ply', 'sequence', 'order', 'material', 'orientation', 'rosette', 'zones', 'area_mm2', 'mass'] as const;

const quote = (cell: string): string => (/[",\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell);

/** Rows of cells of an RFC 4180 CSV text (quotes, doubled quotes, CRLF / LF); null on an unterminated quote. */
function parseCsv(text: string): string[][] | null {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const character = text[i] as string;
    if (quoted) {
      if (character === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"') quoted = true;
    else if (character === ',') {
      row.push(cell);
      cell = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += character;
  }
  if (quoted) return null;
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c !== ''));
}

/**
 * @affects nothing (read-only)
 * @invariant columns ply,sequence,order,material,orientation,rosette,zones,area_mm2,mass; UTF-8, "," separator, "." decimal mark, RFC 4180 quoting; area in mm^2, mass = area x thickness x density in density unit x document unit^3 (empty without density)
 * @failure unknown part -> CMP_REF_MISSING; no plies -> CMP_NO_PLIES
 */
export const exportPlyTable = defineCommand({
  name: 'export_ply_table',
  annotations: { readOnly: true },
  description:
    'Export the plies of a composite part, tool side first, as a CSV text (data.files[0].content, text/csv): columns ply (name), sequence, order ' +
    '(0 = tool side), material, orientation (degrees from the rosette), rosette (name), zones (names joined by |), area_mm2 (covered area in ' +
    'mm^2, ramps included) and mass (area x cured thickness x density, density unit x document unit^3; empty when the material has no density). ' +
    'import_ply_table reads the same layout back. Read-only.',
  params: z.object({ part: z.string().describe('Part id or name.'), confirmExportControlled }),
  run: (doc, { part: partRef, confirmExportControlled: confirmation }, ctx): CommandResult => {
    const refused = exportRefusal(doc, 'export_ply_table', 'data', confirmation, ctx);
    if (refused !== null) return refused;
    const model = compositesOf(doc);
    const part = findPart(model, partRef);
    if (part === null) return refuseCmp(doc, 'export_ply_table', 'CMP_REF_MISSING', `no part '${partRef}'`, [], ['params.part']);
    const plies = pliesOf(model, part.id);
    if (plies.length === 0)
      return refuseCmp(doc, 'export_ply_table', 'CMP_NO_PLIES', `part "${part.name}" has no plies`, [part.id], ['params.part']);
    const scale = MM_PER_UNIT[doc.units] ** 2;
    const lines = plies.map((ply) => {
      const material = model.materials[ply.materialName];
      const area = piecesOf(ply, part).reduce((sum, piece) => sum + polygonArea(piece), 0);
      const names = (ply.zoneOrigin?.zoneIds ?? []).map((id) => model.zones[id]?.name ?? id).join('|');
      const mass = material?.density === undefined ? '' : String(sig(area * material.plyThickness * material.density));
      return [
        ply.name,
        ply.sequence,
        String(ply.order),
        ply.materialName,
        String(ply.orientation),
        model.rosettes[ply.rosetteId]?.name ?? ply.rosetteId,
        names,
        String(sig(area * scale)),
        mass,
      ]
        .map(quote)
        .join(',');
    });
    const content = `${COLUMNS.join(',')}\n${lines.join('\n')}\n`;
    return report(doc, `export_ply_table: part "${part.name}": ${plies.length} ply row(s), ${content.length} characters.`, {
      part: part.id,
      columns: [...COLUMNS],
      rows: plies.length,
      files: [{ name: `${part.name.replace(/[^A-Za-z0-9_-]/g, '_')}_plies.csv`, mime: 'text/csv', content }],
    });
  },
});

/**
 * @affects creates one whole-face ply per CSV row (ply-<step>.<k>) in stacking order, replacing the part's plies when replace is true
 * @invariant only ply, material and orientation are required; sequence, order (sort key), rosette fill the rest; area_mm2, zones and mass are informational and ignored; plies cover the whole face (edit_ply sets regions)
 * @failure unknown part -> CMP_REF_MISSING; unreadable CSV or missing column -> CMP_CSV_PARSE; unknown material / rosette -> CMP_REF_MISSING; part with plies and no replace -> CMP_PARAM_INVALID
 */
export const importPlyTable = defineCommand({
  name: 'import_ply_table',
  description:
    'Create plies of a composite part from a CSV text in the export_ply_table layout (header row required): ply (name), material (lamina record ' +
    'name) and orientation (degrees) are required; sequence, order (sorts the rows; 0 = tool side) and rosette (name) are optional; area_mm2, ' +
    'zones and mass columns are ignored. Every ply covers the whole face; refine regions with edit_ply. A part that already has plies needs ' +
    '`replace` true (its plies are removed first). Refused with the row number on a bad row.',
  params: z.object({
    part: z.string().describe('Part id or name.'),
    csv: z.string().describe('CSV text with a header row (ply,sequence,order,material,orientation,rosette,...).'),
    replace: z.boolean().describe('Remove the part plies first; default false.').optional(),
  }),
  run: (doc, { part: partRef, csv, replace = false }): CommandResult => {
    let model = compositesOf(doc);
    const part = findPart(model, partRef);
    if (part === null) return refuseCmp(doc, 'import_ply_table', 'CMP_REF_MISSING', `no part '${partRef}'`, [], ['params.part']);
    const rows = parseCsv(csv);
    const header = rows?.[0]?.map((cell) => cell.trim());
    if (rows === null || header === undefined)
      return refuseCmp(
        doc,
        'import_ply_table',
        'CMP_CSV_PARSE',
        'the CSV is empty or has an unterminated quote',
        [part.id],
        ['params.csv'],
      );
    const column = (name: string): number => header.indexOf(name);
    const missing = ['ply', 'material', 'orientation'].filter((name) => column(name) < 0);
    if (missing.length > 0)
      return refuseCmp(doc, 'import_ply_table', 'CMP_CSV_PARSE', `header lacks column(s) ${missing.join(', ')}`, [part.id], ['params.csv']);
    if (pliesOf(model, part.id).length > 0 && !replace)
      return refuseCmp(
        doc,
        'import_ply_table',
        'CMP_PARAM_INVALID',
        `part "${part.name}" already has plies; pass replace true`,
        [part.id],
        ['params.replace'],
      );
    const cell = (row: readonly string[], name: string): string => (row[column(name)] ?? '').trim();
    const parsed = rows
      .slice(1)
      .map((row, k) => ({
        line: k + 2,
        name: cell(row, 'ply'),
        material: cell(row, 'material'),
        orientation: Number(cell(row, 'orientation')),
        sequence: cell(row, 'sequence'),
        order: column('order') < 0 ? k : Number(cell(row, 'order')),
        rosette: cell(row, 'rosette'),
      }));
    const bad = parsed.find((row) => row.name === '' || !Number.isFinite(row.orientation) || !Number.isFinite(row.order));
    if (bad !== undefined)
      return refuseCmp(
        doc,
        'import_ply_table',
        'CMP_CSV_PARSE',
        `row ${bad.line}: needs a ply name, a numeric orientation and a numeric order`,
        [part.id],
        ['params.csv'],
      );
    const unknown = parsed.find(
      (row) => model.materials[row.material] === undefined || (row.rosette !== '' && findRosette(model, row.rosette) === null),
    );
    if (unknown !== undefined)
      return refuseCmp(
        doc,
        'import_ply_table',
        'CMP_REF_MISSING',
        `row ${unknown.line}: unknown material '${unknown.material}' or rosette '${unknown.rosette}'`,
        [part.id],
        ['params.csv'],
      );
    if (new Set(parsed.map((row) => row.name)).size !== parsed.length)
      return refuseCmp(doc, 'import_ply_table', 'CMP_NAME_TAKEN', 'ply names in the CSV repeat', [part.id], ['params.csv']);
    if (parsed.length === 0)
      return refuseCmp(doc, 'import_ply_table', 'CMP_CSV_PARSE', 'the CSV has a header but no rows', [part.id], ['params.csv']);
    const drop = new Set(pliesOf(model, part.id).map((ply) => ply.id));
    model = {
      ...model,
      plies: Object.fromEntries(Object.entries(model.plies).filter(([id]) => !drop.has(id))),
      plyOrder: model.plyOrder.filter((id) => !drop.has(id)),
    };
    const ids: string[] = [];
    for (const row of [...parsed].sort((a, b) => a.order - b.order || a.line - b.line)) {
      const rosette = row.rosette === '' ? null : findRosette(model, row.rosette);
      const result = insertPly(model, part, {
        name: row.name,
        materialName: row.material,
        orientation: normalizeAngle(row.orientation),
        sequence: row.sequence === '' ? `S${ids.length + 1}` : row.sequence,
        rosetteId: rosette?.id ?? part.rosetteId,
        boundary: { kind: 'whole_face' },
      });
      model = result.model;
      ids.push(result.ply.id);
    }
    return changed(
      syncOutlines(withComposites(doc, model)),
      `import_ply_table: part "${part.name}": ${ids.length} whole-face ply(ies) created from the CSV.`,
      ids,
    );
  },
});

/**
 * @affects nothing (read-only)
 * @invariant plies are grouped by sequence label in first-seen order; flatPieceIds are the ply piece ids (outline entity ids on planar parts, <ply>#<k> otherwise); lengths in mm, areas in mm^2
 * @failure unknown part -> CMP_REF_MISSING; no plies -> CMP_NO_PLIES
 */
export const plyBookData = defineCommand({
  name: 'ply_book_data',
  annotations: { readOnly: true },
  description:
    'Numeric content of the ply book of a composite part: plies grouped by sequence label (one sheet per sequence), each with its id, name, ' +
    'material, orientation in degrees, covered area in mm^2, the ids of its flat pieces (the pieces export_flat_patterns_dxf writes) and the ' +
    'boundary length in mm. The ply book sheets themselves (SVG / PDF) are not generated yet. The result is flagged reviewRequired (a ply book ' +
    'is a release document) and unverified when a lamina record is mean / unknown data. Read-only.',
  params: z.object({ part: z.string().describe('Part id or name.') }),
  run: (doc, { part: partRef }): CommandResult => {
    const model = compositesOf(doc);
    const part = findPart(model, partRef);
    if (part === null) return refuseCmp(doc, 'ply_book_data', 'CMP_REF_MISSING', `no part '${partRef}'`, [], ['params.part']);
    const plies = pliesOf(model, part.id);
    if (plies.length === 0)
      return refuseCmp(doc, 'ply_book_data', 'CMP_NO_PLIES', `part "${part.name}" has no plies`, [part.id], ['params.part']);
    const scale = MM_PER_UNIT[doc.units];
    const sequences = new Map<string, Record<string, unknown>[]>();
    for (const ply of plies) {
      const pieces = piecesOf(ply, part);
      const entry = {
        id: ply.id,
        name: ply.name,
        material: ply.materialName,
        orientationDeg: ply.orientation,
        areaMm2: sig(pieces.reduce((sum, piece) => sum + polygonArea(piece), 0) * scale * scale),
        flatPieceIds: pieces.map((_, k) => (part.surface.type === 'plane' ? `${ply.id}.o${k}` : `${ply.id}#${k}`)),
        boundaryLengthMm: sig(pieces.reduce((sum, piece) => sum + polygonPerimeter(piece), 0) * scale),
      };
      sequences.set(ply.sequence, [...(sequences.get(ply.sequence) ?? []), entry]);
    }
    const unverified = plies.some((ply) => {
      const material = model.materials[ply.materialName];
      return material !== undefined && isUnverified(material);
    });
    return report(
      doc,
      `ply_book_data: part "${part.name}": ${plies.length} ply(ies) in ${sequences.size} sequence(s); needs review before release.`,
      {
        part: part.id,
        zones: zonesOf(model, part.id).map((zone) => zone.name),
        sequences: [...sequences].map(([sequence, list]) => ({ sequence, plies: list })),
        unit: 'mm',
        reviewRequired: true,
        reviewReason: 'computed by llull, not approved: a ply book is a release document',
        unverified,
        provenance: { method: 'ply list of the part', reference: 'llull composites', inputs: { part: part.id } },
      },
    );
  },
});

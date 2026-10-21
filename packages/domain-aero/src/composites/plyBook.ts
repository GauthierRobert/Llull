/** export_ply_book: one SVG ply-book sheet per sequence label (06 CMP FR-CMP-51, VC-CMP-28): flat patterns, location on the part, ply table. */

import { escapeXml } from '@lib/escapeXml';
import { confirmExportControlled, defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { exportRefusal, report } from '@core/commands/noop';
import type { CompositePart, Ply } from '@core/model/composites';
import { MM_PER_UNIT } from '@core/model/units';
import type { Vec2 } from '@core/model/types';
import { polygonArea, polygonPerimeter } from '@lib/polygon';
import { sig } from '../shared/results';
import { refuseCmp } from './codes';
import { type FlatPieces, flatPiecesOf } from './flatPieces';
import { piecesOf } from './geometry2d';
import { isUnverified } from '@lib/laminate/provenance';
import { compositesOf, findPart, pliesOf } from './state';

const SHEETS = { A4: [297, 210], A3: [420, 297], A2: [594, 420] } as const;
const MARGIN = 10;
const PALETTE = ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c', '#0891b2'];

const path = (points: readonly Vec2[], map: (p: Vec2) => Vec2): string =>
  `${points.map((p, k) => `${k === 0 ? 'M' : 'L'}${map(p)[0].toFixed(3)} ${map(p)[1].toFixed(3)}`).join(' ')} Z`;

interface Row {
  readonly ply: Ply;
  readonly flat: FlatPieces;
  readonly areaMm2: number;
  readonly boundaryMm: number;
}

/** The SVG of one sequence sheet; `scaleMm` converts document units to millimetres. */
function sheetSvg(
  part: CompositePart,
  sequence: string,
  rows: readonly Row[],
  size: readonly [number, number],
  scaleMm: number,
  materialOf: (ply: Ply) => string,
): string {
  const [width, height] = size;
  const flats = rows.flatMap((row, k) =>
    row.flat.ok ? row.flat.pieces.map((piece) => ({ row, piece, color: PALETTE[k % PALETTE.length] as string })) : [],
  );
  const all = flats.flatMap(({ piece }) => piece.polygon);
  const [minX, maxX] = [Math.min(...all.map(([x]) => x)), Math.max(...all.map(([x]) => x))];
  const [minY, maxY] = [Math.min(...all.map(([, y]) => y)), Math.max(...all.map(([, y]) => y))];
  const area = { x: MARGIN, y: MARGIN + 12, w: width - 2 * MARGIN - 100, h: height - 2 * MARGIN - 12 - 55 };
  const extent = all.length === 0 ? 1 : Math.max((maxX - minX) * scaleMm, (maxY - minY) * scaleMm, 1e-9);
  const fit = all.length === 0 ? 1 : Math.min(area.w / ((maxX - minX) * scaleMm || 1), area.h / ((maxY - minY) * scaleMm || 1), 1);
  const toSheet = ([x, y]: Vec2): Vec2 => [area.x + (x - minX) * scaleMm * fit, area.y + (maxY - y) * scaleMm * fit];
  const loc = { x: width - MARGIN - 90, y: MARGIN + 12, w: 90, h: 70 };
  const outline = part.outline;
  const [oMinX, oMaxX] = [Math.min(...outline.map(([x]) => x)), Math.max(...outline.map(([x]) => x))];
  const [oMinY, oMaxY] = [Math.min(...outline.map(([, y]) => y)), Math.max(...outline.map(([, y]) => y))];
  const locFit = Math.min(loc.w / (oMaxX - oMinX || 1), loc.h / (oMaxY - oMinY || 1));
  const toLocation = ([x, y]: Vec2): Vec2 => [loc.x + (x - oMinX) * locFit, loc.y + (oMaxY - y) * locFit];
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="${height}mm" viewBox="0 0 ${width} ${height}" font-family="sans-serif" font-size="3.2">`,
    `<rect x="${MARGIN / 2}" y="${MARGIN / 2}" width="${width - MARGIN}" height="${height - MARGIN}" fill="none" stroke="#111" stroke-width="0.4"/>`,
    `<text x="${MARGIN}" y="${MARGIN + 5}" font-size="5" font-weight="bold">${escapeXml(part.name)} - ply book sequence ${escapeXml(sequence)}</text>`,
    `<g id="flat-patterns">`,
  ];
  for (const { row, piece, color } of flats) {
    out.push(`<path d="${path(piece.polygon, toSheet)}" fill="${color}" fill-opacity="0.12" stroke="${color}" stroke-width="0.4"/>`);
    const centre = toSheet([
      piece.polygon.reduce((s, [x]) => s + x, 0) / piece.polygon.length,
      piece.polygon.reduce((s, [, y]) => s + y, 0) / piece.polygon.length,
    ]);
    const arrow = Math.min(15, 0.2 * extent * fit);
    const tip: Vec2 = [centre[0] + piece.fibre[0] * arrow, centre[1] - piece.fibre[1] * arrow];
    out.push(
      `<line x1="${centre[0].toFixed(3)}" y1="${centre[1].toFixed(3)}" x2="${tip[0].toFixed(3)}" y2="${tip[1].toFixed(3)}" stroke="${color}" stroke-width="0.5"/>`,
    );
    out.push(
      `<text x="${centre[0].toFixed(3)}" y="${(centre[1] + 6).toFixed(3)}" text-anchor="middle" fill="${color}">${escapeXml(`${row.ply.name} ${row.ply.orientation}deg`)}</text>`,
    );
  }
  for (const row of rows)
    if (!row.flat.ok)
      out.push(
        `<text x="${area.x}" y="${area.y + 6 + 5 * rows.indexOf(row)}" fill="#b91c1c">${escapeXml(`${row.ply.name}: no flat pattern (${row.flat.message})`)}</text>`,
      );
  out.push(
    '</g>',
    `<g id="location"><rect x="${loc.x}" y="${loc.y}" width="${loc.w}" height="${loc.h}" fill="none" stroke="#888" stroke-width="0.3"/>`,
  );
  out.push(`<path d="${path(outline, toLocation)}" fill="#eee" stroke="#555" stroke-width="0.3"/>`);
  rows.forEach((row, k) => {
    for (const piece of piecesOf(row.ply, part))
      out.push(`<path d="${path(piece, toLocation)}" fill="${PALETTE[k % PALETTE.length]}" fill-opacity="0.35" stroke="none"/>`);
  });
  out.push(`<text x="${loc.x}" y="${loc.y + loc.h + 4}">location on the ${part.surface.type} tool face (part frame)</text></g>`);
  out.push(
    `<g id="table"><text x="${MARGIN}" y="${height - 40}" font-weight="bold">ply | material | angle (deg) | area (mm2) | pieces | boundary (mm)</text>`,
  );
  rows.forEach((row, k) => {
    out.push(
      `<text x="${MARGIN}" y="${height - 34 + 5 * k}">${escapeXml(`${row.ply.name} | ${materialOf(row.ply)} | ${row.ply.orientation} | ${sig(row.areaMm2)} | ${piecesOf(row.ply, part).length} | ${sig(row.boundaryMm)}`)}</text>`,
    );
  });
  out.push(
    `<text x="${MARGIN}" y="${height - 8}" fill="#b91c1c">Scale 1:${(1 / fit).toFixed(2)} - computed by llull, not approved: needs a qualified engineer.</text></g>`,
    '</svg>',
  );
  return out.join('\n');
}

/**
 * @affects nothing (read-only)
 * @invariant one sheet per sequence label (in first-ply order), each with the flat pattern of every ply of the sequence (warp along +x; developed chart on plane / cylinder / cone, fishnet drape on sphere / nurbs), a location view in the part frame and the ply table; areas in mm2 equal the DXF piece areas
 * @failure unknown part -> CMP_REF_MISSING; no plies -> CMP_NO_PLIES; unknown sheet size -> rejected by the schema
 */
export const exportPlyBook = defineCommand({
  name: 'export_ply_book',
  annotations: { readOnly: true },
  description:
    'SHEETS form of the ply book (same plies as ply_book_data = numbers): ply book of a composite part as SVG sheets (one per sequence label): each sheet shows the flat pattern of the plies of that sequence ' +
    '(with the fibre arrow and the ply label), a location view of the pieces on the tool-face outline (the part frame), and a table with ply, ' +
    'material, orientation, area in mm2, piece count and boundary length in mm. On doubly curved faces (sphere cap, nurbs_surface) the flat ' +
    'pattern comes from the fishnet drape and is omitted, with a note, where the shear exceeds the material locking angle. `sheetSize` A4, ' +
    'A3 (default) or A2 landscape; the drawing is scaled to fit (never above 1:1). Returns the SVG texts in data.files (save with the CLI --save ' +
    'option); the document is not modified. PDF is not written. The sheets are computed by llull and not approved (reviewRequired).',
  params: z.object({
    part: z.string().describe('Part id or name.'),
    format: z.enum(['svg']).describe('Output format: "svg" (the only one built).').optional(),
    sheetSize: z.enum(['A4', 'A3', 'A2']).describe('Sheet size, landscape: A4, A3 (default) or A2.').optional(),
    confirmExportControlled,
  }),
  run: (doc, { part: partRef, sheetSize = 'A3', confirmExportControlled: confirmation }, ctx): CommandResult => {
    const refused = exportRefusal(doc, 'export_ply_book', 'data', confirmation, ctx);
    if (refused !== null) return refused;
    const model = compositesOf(doc);
    const part = findPart(model, partRef);
    if (part === null) return refuseCmp(doc, 'export_ply_book', 'CMP_REF_MISSING', `no part '${partRef}'`, [], ['params.part']);
    const plies = pliesOf(model, part.id);
    if (plies.length === 0)
      return refuseCmp(doc, 'export_ply_book', 'CMP_NO_PLIES', `part "${part.name}" has no plies`, [part.id], ['params.part']);
    const scaleMm = MM_PER_UNIT[doc.units];
    const sequences = [...new Set(plies.map((ply) => ply.sequence))];
    const files = sequences.map((sequence) => {
      const rows: Row[] = plies
        .filter((ply) => ply.sequence === sequence)
        .map((ply) => {
          const pieces = piecesOf(ply, part);
          return {
            ply,
            flat: flatPiecesOf(part, ply, model.materials[ply.materialName], false),
            areaMm2: pieces.reduce((sum, piece) => sum + polygonArea(piece), 0) * scaleMm * scaleMm,
            boundaryMm: pieces.reduce((sum, piece) => sum + polygonPerimeter(piece), 0) * scaleMm,
          };
        });
      const flatArea = (row: Row): number =>
        row.flat.ok ? row.flat.pieces.reduce((sum, piece) => sum + polygonArea(piece.polygon), 0) * scaleMm * scaleMm : row.areaMm2;
      const sized = rows.map((row) => ({ ...row, areaMm2: flatArea(row) }));
      return {
        name: `${part.name.replace(/\s+/g, '_')}_${sequence.replace(/[^A-Za-z0-9_-]/g, '_')}.svg`,
        mime: 'image/svg+xml',
        sequence,
        content: sheetSvg(part, sequence, sized, SHEETS[sheetSize], scaleMm, (ply) => ply.materialName),
        plies: sized.map((row) => ({
          ply: row.ply.id,
          name: row.ply.name,
          areaMm2: sig(row.areaMm2),
          flat: row.flat.ok ? row.flat.method : row.flat.code,
        })),
      };
    });
    const unverified = plies.some((ply) => {
      const material = model.materials[ply.materialName];
      return material !== undefined && isUnverified(material);
    });
    return report(
      doc,
      `export_ply_book: part "${part.name}": ${files.length} sheet(s) (${sheetSize}) for ${plies.length} ply(ies), one per sequence label. Computed by llull, not approved.`,
      {
        part: part.id,
        sheetSize,
        sheets: files.map(({ sequence, name, plies: rows }) => ({ sequence, file: name, plies: rows })),
        files: files.map(({ name, mime, content }) => ({ name, mime, content })),
        unverified,
        reviewRequired: true,
        reviewReason: 'ply book computed by llull, not approved: check flats against the tool before cutting',
        provenance: {
          method: 'flat patterns + location view + table per sequence',
          reference: 'llull composites',
          inputs: { part: part.id },
        },
      },
    );
  },
});

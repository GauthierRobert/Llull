import { confirmExportControlled, defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { exportRefusal, report } from '@core/commands/noop';
import { PAPER_SIZES } from '@core/model/sheet';
import { sha256Hex } from '@lib/sha256';
import { analyseLine, isAnalysis } from '../analysis';
import { isoIssue, refuseIso } from '../codes';
import { buildIsoGraph } from '../iso/isoGraph';
import { axisAngles, TRUE_ISO_SCALE } from '../iso/isoProjection';
import { dxfOf, svgOf } from '../iso/isoRender';
import { buildIsoSheet } from '../iso/isoSheet';
import { TABLE_NAMES } from '../iso/isoTables';

const fileStem = (key: string): string => key.replace(/[^A-Za-z0-9._-]/g, '_');

/**
 * @affects none (query: returns the same document; the files are in `data.files[]`)
 * @invariant true isometric projection (east -30, north +30, up 90 degrees; north arrow up-right or up-left), not to scale; every dimension, elevation and coordinate is computed from the 3D centreline and listed with its value; the same document and options give byte-identical files; every sheet is NOT FOR CONSTRUCTION with reviewRequired true
 * @failure unknown line -> ISO_LINE_NOT_FOUND; no piping -> ISO_NO_PIPING; components not connected to the line start -> ISO_DISCONNECTED; export-controlled content without confirmation -> MAT_EXPORT_CONTROLLED
 */
export const exportIsometric = defineCommand({
  name: 'export_isometric',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Draw the isometric sheet of one pipe line (routed line, imported PCF line or legacy pipe line) as SVG and / or DXF R12: true isometric projection (east axis -30 degrees, north +30, vertical 90; north arrow up-right, or up-left) ' +
    'NOT TO SCALE, one sheet. Pipes along their projected axis with readable lengths (log scaled, collisions resolved or broken), symbols by component family (elbow arc, tee dot, flange double bar, reducer, valve bow-tie, cap, ' +
    'instrument) and weld class (shop dot, site cross, field-fit cross in a circle), weld numbers (provisional until number_welds) and spool names, centreline string dimensions per straight run that close to the overall ' +
    '(76 + 2424 + 2348 + 152 = 5000), EL elevations, E/N coordinates at line ends and branches, and SLOPE 1:n with a fall arrow on a run that falls along a horizontal axis. Style final prints the tables bom, cut_list, weld_list, ' +
    'spool_list (cut_list needs a stored weld gap, else it is left out with a warning); style check prints none unless tables is given. Every sheet carries NOT FOR CONSTRUCTION and reviewRequired true: a human issues it. ' +
    'Returns data = { lineId, style, paper, files: [{ name, format, content, sha256 }], sheets: [{ index, files, sha256, componentIds, continuation }], projection: { axes: { east, north, up: { angleDeg } }, interAxisAngleDeg, trueIsoScale }, ' +
    'northArrow: { mode, angleDeg }, dimensions: [{ run, axis, values, overall, labels, overallLabel, points }], dimensionMismatches, annotations: [{ kind elevation | coordinate | slope | weld | spool, text, at, sheet, ... }], ' +
    'tables: { <name>: { rows, columns, data } }, layout: { k, scale, overflow, passes, crossings }, warnings, reviewRequired: true }. ' +
    'Refusals (document unchanged): ISO_LINE_NOT_FOUND, ISO_NO_PIPING, ISO_DISCONNECTED, MAT_EXPORT_CONTROLLED. Save with llull export_isometric --save <dir>.',
  params: z.object({
    lineId: z.string().min(1).describe('The line: routed line id, imported PCF line number or legacy pipe line number.'),
    style: z
      .enum(['check', 'final'])
      .optional()
      .describe('check (default): drawing only. final: also prints the tables bom, cut_list, weld_list and spool_list.'),
    paper: z.enum(PAPER_SIZES).optional().describe('Paper size, landscape ISO A0..A4. Default A3.'),
    formats: z
      .array(z.enum(['svg', 'dxf']))
      .min(1)
      .optional()
      .describe('Output formats: svg and / or dxf. Default ["svg"].'),
    tables: z
      .array(z.enum(TABLE_NAMES))
      .optional()
      .describe('Tables to print: bom, cut_list, weld_list, spool_list. Default: all four for style final, none for check.'),
    northArrow: z
      .enum(['up_right', 'up_left'])
      .optional()
      .describe(
        'Direction the plant north projects: up_right (default, 30 degrees) or up_left (150 degrees; the plant is turned +90 degrees about Z).',
      ),
    confirmExportControlled,
  }),
  run: (doc, params, ctx): CommandResult => {
    const refused = exportRefusal(doc, 'export_isometric', 'sheet', params.confirmExportControlled, ctx);
    if (refused !== null) return refused;
    const analysis = analyseLine(doc, 'export_isometric', params.lineId);
    if (!isAnalysis(analysis)) return analysis;
    const graph = buildIsoGraph(analysis.read.network);
    if (graph.steps.length === 0)
      return refuseIso(
        doc,
        'export_isometric',
        'ISO_NO_PIPING',
        `line ${params.lineId} has no drawable component`,
        [params.lineId],
        ['lineId'],
      );
    if (graph.groups > 1)
      return refuseIso(
        doc,
        'export_isometric',
        'ISO_DISCONNECTED',
        `${graph.unreachable.length} component(s) of line ${params.lineId} are not connected to the line start: ${graph.unreachable.join(', ')}`,
        graph.unreachable,
        ['lineId'],
      );
    const style = params.style ?? 'check';
    const paper = params.paper ?? 'A3';
    const northArrow = params.northArrow ?? 'up_right';
    const sheet = buildIsoSheet(analysis, {
      style,
      paper,
      northArrow,
      tables: params.tables ?? (style === 'final' ? TABLE_NAMES : []),
      project: doc.building?.project.name.trim() || 'llull',
    });
    const mismatches = sheet.dimensions.reduce((sum, dimension) => sum + dimension.mismatches, 0);
    const unnumbered = analysis.numbering.entries.filter((entry) => entry.status === 'assigned');
    const warnings = [
      ...analysis.read.network.warnings,
      ...sheet.warnings,
      ...(mismatches === 0
        ? []
        : [isoIssue('ISO_DIMENSION_MISMATCH', 'error', `${mismatches} dimension label(s) differ from the 3D distance`, [params.lineId])]),
      ...(unnumbered.length === 0
        ? []
        : [
            isoIssue(
              'ISO_WELDS_UNNUMBERED',
              'warning',
              `${unnumbered.length} weld number(s) on the sheet are provisional`,
              unnumbered.map((entry) => entry.record.number),
            ),
          ]),
    ];
    const stem = `${fileStem(analysis.name)}_iso_sheet1`;
    const files = (params.formats ?? ['svg'])
      .filter((format, at, all) => all.indexOf(format) === at)
      .map((format) => {
        const content = format === 'svg' ? svgOf(sheet.primitives, sheet.width, sheet.height, sheet.title) : dxfOf(sheet.primitives);
        return { name: `${stem}.${format}`, format, content, sha256: sha256Hex(content) };
      });
    const angles = axisAngles(northArrow);
    return report(
      doc,
      `export_isometric: line ${analysis.name}: 1 sheet ${paper} (${style}), ${graph.runs.length} run(s), ${sheet.dimensions.length} dimension string(s) (${mismatches} mismatch), ` +
        `${sheet.annotations.length} label(s), ${sheet.tables.length} table(s), ${files.map((file) => file.name).join(', ')}; NOT FOR CONSTRUCTION, review required` +
        `${warnings.length === 0 ? '' : `; warnings: ${[...new Set(warnings.map((warning) => warning.code))].join(', ')}`}`,
      {
        lineId: analysis.name,
        style,
        paper,
        files,
        sheets: [
          {
            index: 1,
            files: files.map((file) => file.name),
            sha256: files[0]?.sha256 ?? '',
            componentIds: analysis.read.network.components.map((component) => component.id),
            continuation: {},
          },
        ],
        projection: {
          axes: { east: { angleDeg: angles.east }, north: { angleDeg: angles.north }, up: { angleDeg: angles.up } },
          interAxisAngleDeg: 120,
          trueIsoScale: TRUE_ISO_SCALE,
        },
        northArrow: { mode: northArrow, angleDeg: angles.northArrow },
        dimensions: sheet.dimensions,
        dimensionMismatches: mismatches,
        annotations: sheet.annotations,
        tables: Object.fromEntries(
          sheet.tables.map((table) => [table.name, { rows: table.rows.length, columns: table.columns, data: table.rows }]),
        ),
        layout: {
          k: sheet.layout.k,
          scale: sheet.layout.scale,
          overflow: sheet.layout.overflow,
          passes: sheet.layout.passes,
          crossings: sheet.layout.crossings.length,
        },
        warnings,
        reviewRequired: true,
      },
    );
  },
});

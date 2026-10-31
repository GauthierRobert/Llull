import { confirmExportControlled, defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { exportRefusal, report } from '@core/commands/noop';
import { PAPER_SIZES } from '@core/model/sheet';
import { sha256Hex } from '@lib/sha256';
import { analyseLine, isAnalysis } from '../analysis';
import { isoIssue, refuseIso } from '../codes';
import { basisOf, issueState } from '../issues';
import { buildIsoGraph } from '../iso/isoGraph';
import { axisAngles, TRUE_ISO_SCALE } from '../iso/isoProjection';
import { dxfOf, svgOf } from '../iso/isoRender';
import { buildIsoSheet, type IsoSheet } from '../iso/isoSheet';
import { continuationOf, planSheets, type SheetInfo } from '../iso/isoSheets';
import { isoTables, TABLE_NAMES } from '../iso/isoTables';
import type { IsoIssue, IsoStyle } from '../model';

const fileStem = (key: string): string => key.replace(/[^A-Za-z0-9._-]/g, '_');

const tablesOf = (sheet: Pick<IsoSheet, 'tables'>): Record<string, unknown> =>
  Object.fromEntries(sheet.tables.map((table) => [table.name, { rows: table.rows.length, columns: table.columns, data: table.rows }]));

/**
 * @affects none (query: returns the same document; the files are in `data.files[]`)
 * @invariant true isometric projection (east -30, north +30, up 90 degrees; north arrow up-right or up-left), not to scale; every dimension, elevation and coordinate is computed from the 3D centreline and listed with its value; the same document and options give byte-identical files; a sheet is NOT FOR CONSTRUCTION with reviewRequired true unless a human issue (issue_isometric) matches the current line content; with a define_isometric budget the sheets are cut only at welds, keep stored components on their sheet, and print matching continuation marks
 * @failure unknown line -> ISO_LINE_NOT_FOUND; no piping -> ISO_NO_PIPING; components not connected to the line start -> ISO_DISCONNECTED; unknown spoolId -> ISO_SPOOL_NOT_FOUND; spoolId with another style -> ISO_PARAM_INVALID; export-controlled content without confirmation -> MAT_EXPORT_CONTROLLED
 */
export const exportIsometric = defineCommand({
  name: 'export_isometric',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Draw the isometric sheet(s) of one pipe line (routed line, imported PCF line or legacy pipe line) as SVG and / or DXF R12: true isometric projection (east axis -30 degrees, north +30, vertical 90; north arrow up-right, or up-left) ' +
    'NOT TO SCALE. Pipes along their projected axis with readable lengths (log scaled, collisions resolved or broken), symbols by component family (elbow arc, tee dot, flange double bar, reducer, valve bow-tie, cap, ' +
    'instrument) and weld class (shop dot, site cross, field-fit cross in a circle), weld numbers (provisional until number_welds) and spool names, centreline string dimensions per straight run that close to the overall ' +
    '(76 + 2424 + 2348 + 152 = 5000), EL elevations, E/N coordinates at line ends and branches, and SLOPE 1:n with a fall arrow on a run that falls along a horizontal axis. Style final prints the tables bom, cut_list, weld_list, ' +
    'spool_list (cut_list needs a stored weld gap, else it is left out with a warning); style check prints none unless tables is given. Without define_isometric the line is one sheet; with it, the stored paper, north arrow, style and ' +
    'sheet split apply (params override paper, northArrow, style): a line over maxPipePiecesPerSheet is cut into sheets only at welds, each cut joint is printed on both sheets as "CONT. ON SHEET n - W<number>" / "CONT. FROM SHEET n - W<number>" ' +
    'with its coordinates, components keep their stored sheet after an edit so unchanged sheets are byte-identical, and the tables of a sheet cover its components. Style spool gives one sheet per spool with its spool tables (spoolId = one spool only). ' +
    'Every sheet carries NOT FOR CONSTRUCTION and reviewRequired true until a human issues the line (issue_isometric); an issue stays valid only while the line content is unchanged. ' +
    'Returns data = { lineId, style, paper, files: [{ name, format, content, sha256 }], sheets: [{ index, files, sha256 (of the first file), componentIds, pipes, spool?, continuation: { previous?, next?, all: [{ sheet, weld, joint, at, componentIds }] }, tables, layout }], ' +
    'projection: { axes: { east, north, up: { angleDeg } }, interAxisAngleDeg, trueIsoScale }, northArrow: { mode, angleDeg }, dimensions: [{ sheetIndex, run, axis, values, overall, labels, overallLabel, points }], dimensionMismatches, ' +
    'annotations: [{ sheetIndex, kind elevation | coordinate | slope | weld | spool | continuation, text, at, sheet, ... }], tables: { <name>: { rows, columns, data } } (whole line), layout (first sheet), warnings, reviewRequired, issue? }. ' +
    'Refusals (document unchanged): ISO_LINE_NOT_FOUND, ISO_NO_PIPING, ISO_DISCONNECTED, ISO_SPOOL_NOT_FOUND, ISO_PARAM_INVALID, MAT_EXPORT_CONTROLLED. Save with llull export_isometric --save <dir>.',
  params: z.object({
    lineId: z.string().min(1).describe('The line: routed line id, imported PCF line number or legacy pipe line number.'),
    style: z
      .enum(['check', 'final', 'spool'])
      .optional()
      .describe(
        'check: drawing only. final: also prints the tables bom, cut_list, weld_list and spool_list. spool: one sheet per spool with the same tables. Default: the style of define_isometric, else check.',
      ),
    paper: z.enum(PAPER_SIZES).optional().describe('Paper size, landscape ISO A0..A4. Default: the paper of define_isometric, else A3.'),
    formats: z
      .array(z.enum(['svg', 'dxf']))
      .min(1)
      .optional()
      .describe('Output formats: svg and / or dxf. Default ["svg"].'),
    tables: z
      .array(z.enum(TABLE_NAMES))
      .optional()
      .describe('Tables to print: bom, cut_list, weld_list, spool_list. Default: all four for styles final and spool, none for check.'),
    northArrow: z
      .enum(['up_right', 'up_left'])
      .optional()
      .describe(
        'Direction the plant north projects: up_right (30 degrees) or up_left (150 degrees; the plant is turned +90 degrees about Z). Default: define_isometric, else up_right.',
      ),
    spoolId: z
      .string()
      .min(1)
      .optional()
      .describe('A spool name from spool_list (e.g. L-101-SP02): draw only that spool (implies style spool).'),
    confirmExportControlled,
  }),
  run: (doc, params, ctx): CommandResult => {
    const refused = exportRefusal(doc, 'export_isometric', 'sheet', params.confirmExportControlled, ctx);
    if (refused !== null) return refused;
    if (params.spoolId !== undefined && params.style !== undefined && params.style !== 'spool')
      return refuseIso(
        doc,
        'export_isometric',
        'ISO_PARAM_INVALID',
        'spoolId is for the spool style: omit style or pass style spool',
        [params.spoolId],
        ['spoolId', 'style'],
      );
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
    const definition = analysis.fabrication.isometrics?.[analysis.lineId];
    const style: IsoStyle = params.style ?? (params.spoolId === undefined ? (definition?.style ?? 'check') : 'spool');
    const paper = params.paper ?? definition?.paper ?? 'A3';
    const northArrow = params.northArrow ?? definition?.northArrow ?? 'up_right';
    const plan = planSheets(
      analysis,
      style === 'spool'
        ? { kind: 'spool' }
        : {
            kind: 'budget',
            splitAt: definition?.splitAt ?? 'weld',
            stored: definition?.sheetAssignment ?? {},
            ...(definition?.maxPipePiecesPerSheet === undefined ? {} : { budget: definition.maxPipePiecesPerSheet }),
          },
    );
    const chosen = params.spoolId === undefined ? plan.sheets : plan.sheets.filter((sheet) => sheet.spool === params.spoolId);
    if (chosen.length === 0)
      return refuseIso(
        doc,
        'export_isometric',
        'ISO_SPOOL_NOT_FOUND',
        `line ${params.lineId} has no spool "${params.spoolId}" (${plan.sheets.map((sheet) => sheet.spool).join(', ')})`,
        [params.lineId],
        ['spoolId'],
      );
    const wanted = params.tables ?? (style === 'check' ? [] : TABLE_NAMES);
    const { latest, current } = issueState(analysis.fabrication, analysis.lineId, basisOf(analysis));
    const scoped = style === 'spool' || plan.sheets.length > 1;
    const built: Array<{ info: SheetInfo; sheet: IsoSheet; continuation: ReturnType<typeof continuationOf> }> = [];
    for (const info of chosen) {
      const continuation = continuationOf(plan, info.index);
      const sheet = buildIsoSheet(analysis, {
        style,
        paper,
        northArrow,
        tables: wanted,
        project: doc.building?.project.name.trim() || 'llull',
        ...(current === undefined
          ? {}
          : { issue: { revision: current.revision, purpose: current.purpose.replace('_', ' '), signer: current.signer } }),
        ...(scoped
          ? {
              sheet: {
                index: info.index,
                total: plan.sheets.length,
                include: new Set(info.componentIds),
                indices: new Set(info.indices),
                partial: style !== 'spool',
                continuation: continuation.all,
                ...(info.spool === undefined ? {} : { spool: info.spool }),
              },
            }
          : {}),
      });
      if (sheet.graph.groups > 1)
        return refuseIso(
          doc,
          'export_isometric',
          'ISO_DISCONNECTED',
          `sheet ${info.index} of line ${params.lineId} is not connected: ${sheet.graph.unreachable.join(', ')}`,
          sheet.graph.unreachable,
          ['lineId'],
        );
      built.push({ info, sheet, continuation });
    }
    const mismatches = built.reduce(
      (total, { sheet }) => total + sheet.dimensions.reduce((sum, dimension) => sum + dimension.mismatches, 0),
      0,
    );
    const unnumbered = analysis.numbering.entries.filter((entry) => entry.status === 'assigned');
    const warnings: IsoIssue[] = [];
    const warn = (issue: IsoIssue): void => {
      if (!warnings.some((have) => have.code === issue.code && have.message === issue.message)) warnings.push(issue);
    };
    [...analysis.read.network.warnings, ...plan.warnings, ...built.flatMap(({ sheet }) => sheet.warnings)].forEach(warn);
    if (mismatches > 0)
      warn(isoIssue('ISO_DIMENSION_MISMATCH', 'error', `${mismatches} dimension label(s) differ from the 3D distance`, [params.lineId]));
    if (unnumbered.length > 0)
      warn(
        isoIssue(
          'ISO_WELDS_UNNUMBERED',
          'warning',
          `${unnumbered.length} weld number(s) on the sheet are provisional`,
          unnumbered.map((entry) => entry.record.number),
        ),
      );
    if (latest !== undefined && current === undefined)
      warn(isoIssue('ISO_ISSUE_STALE', 'warning', `the line changed after issue ${latest.id} (revision ${latest.revision})`, [latest.id]));
    const stem = fileStem(analysis.name);
    const formats = (params.formats ?? ['svg']).filter((format, at, all) => all.indexOf(format) === at);
    const files = built.flatMap(({ info, sheet }) =>
      formats.map((format) => {
        const content = format === 'svg' ? svgOf(sheet.primitives, sheet.width, sheet.height, sheet.title) : dxfOf(sheet.primitives);
        return { name: `${stem}_iso_sheet${info.index}.${format}`, format, content, sha256: sha256Hex(content), sheetIndex: info.index };
      }),
    );
    const angles = axisAngles(northArrow);
    const whole = scoped ? isoTables(analysis, wanted).tables : (built[0]?.sheet.tables ?? []);
    const first = (built[0] as (typeof built)[number]).sheet;
    return report(
      doc,
      `export_isometric: line ${analysis.name}: ${built.length} sheet(s) ${paper} (${style}), ${graph.runs.length} run(s), ${built.reduce((sum, { sheet }) => sum + sheet.dimensions.length, 0)} dimension string(s) (${mismatches} mismatch), ` +
        `${built.reduce((sum, { sheet }) => sum + sheet.annotations.length, 0)} label(s), ${whole.length} table(s), ${files.map((file) => file.name).join(', ')}; ` +
        `${current === undefined ? 'NOT FOR CONSTRUCTION, review required' : `issued ${current.purpose.replace('_', ' ')} rev ${current.revision} by ${current.signer}`}` +
        `${warnings.length === 0 ? '' : `; warnings: ${[...new Set(warnings.map((warning) => warning.code))].join(', ')}`}`,
      {
        lineId: analysis.name,
        style,
        paper,
        files: files.map(({ sheetIndex: _sheetIndex, ...file }) => file),
        sheets: built.map(({ info, sheet, continuation }) => {
          const own = files.filter((file) => file.sheetIndex === info.index);
          return {
            index: info.index,
            files: own.map((file) => file.name),
            sha256: own[0]?.sha256 ?? '',
            componentIds: info.componentIds,
            pipes: info.pipes,
            ...(info.spool === undefined ? {} : { spool: info.spool }),
            continuation,
            tables: tablesOf(sheet),
            layout: { k: sheet.layout.k, scale: sheet.layout.scale, overflow: sheet.layout.overflow },
          };
        }),
        projection: {
          axes: { east: { angleDeg: angles.east }, north: { angleDeg: angles.north }, up: { angleDeg: angles.up } },
          interAxisAngleDeg: 120,
          trueIsoScale: TRUE_ISO_SCALE,
        },
        northArrow: { mode: northArrow, angleDeg: angles.northArrow },
        dimensions: built.flatMap(({ info, sheet }) => sheet.dimensions.map((dimension) => ({ ...dimension, sheetIndex: info.index }))),
        dimensionMismatches: mismatches,
        annotations: built.flatMap(({ info, sheet }) => sheet.annotations.map((annotation) => ({ ...annotation, sheetIndex: info.index }))),
        tables: tablesOf({ tables: whole }),
        layout: {
          k: first.layout.k,
          scale: first.layout.scale,
          overflow: first.layout.overflow,
          passes: first.layout.passes,
          crossings: first.layout.crossings.length,
        },
        warnings,
        reviewRequired: current === undefined,
        ...(current === undefined ? {} : { issue: current }),
      },
    );
  },
});

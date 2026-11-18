import { confirmExportControlled, defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { exportRefusal } from '@core/commands/noop';
import { PAPER_SIZES } from '@core/model/sheet';
import { analyseLine, isAnalysis } from '../analysis';
import { basisOf, issueState } from '../issues';
import { buildIsoGraph } from '../iso/isoGraph';
import { TABLE_NAMES } from '../iso/isoTables';
import {
  buildSheets,
  chosenSheets,
  graphRefusal,
  isometricReport,
  issueComparison,
  mismatchesOf,
  paramRefusal,
  settingsOf,
  warningsOf,
} from './exportIsometricPhases';

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
    '(76 + 2424 + 2348 + 152 = 5000), EL elevations, E/N coordinates at line ends and branches, and SLOPE 1:n with a fall arrow on a run that falls along a horizontal axis. A run not parallel to a plant axis (a 45 degree offset, a rolling offset) is drawn at its projected angle in a skew box: the squaring-in legs along the plant axes, each dimensioned, with the length and the angle (annotations kind skew and skew_leg). Pipe supports (add_pipe_support on a routed or legacy line, SUPPORT records of an imported line) are drawn where they lie on a pipe with their mark (annotations kind support; data.supports). Style final prints the tables bom, cut_list, weld_list, ' +
    'spool_list (cut_list needs a stored weld gap, else it is left out with a warning); style check prints none unless tables is given. Without define_isometric the line is one sheet; with it, the stored paper, north arrow, style and ' +
    'sheet split apply (params override paper, northArrow, style): a line over maxPipePiecesPerSheet is cut into sheets only at welds, each cut joint is printed on both sheets as "CONT. ON SHEET n - W<number>" / "CONT. FROM SHEET n - W<number>" ' +
    'with its coordinates, components keep their stored sheet after an edit so unchanged sheets are byte-identical, and the tables of a sheet cover its components. Style spool gives one sheet per spool with its spool tables (spoolId = one spool only). ' +
    'With compareToIssue the line is compared with its last issued revision and what is new or changed is circled by revision clouds with delta triangles (layer ISO-REV). Every sheet carries NOT FOR CONSTRUCTION and reviewRequired true until a human issues the line (issue_isometric); an issue stays valid only while the line content is unchanged. ' +
    'Returns data = { lineId, style, paper, files: [{ name, format, content, sha256 }], sheets: [{ index, files, sha256 (of the first file), componentIds, pipes, spool?, continuation: { previous?, next?, all: [{ sheet, weld, joint, at, componentIds }] }, tables, layout }], ' +
    'projection: { axes: { east, north, up: { angleDeg } }, interAxisAngleDeg, trueIsoScale }, northArrow: { mode, angleDeg }, dimensions: [{ sheetIndex, run, axis, values, overall, labels, overallLabel, points }], dimensionMismatches, ' +
    'annotations: [{ sheetIndex, kind elevation | coordinate | slope | weld | spool | continuation | support | skew | skew_leg, text, at, sheet, ... }] (a skew annotation has lengthMm, legsMm, legAxes, angleDeg, plane), supports: [{ id, mark, type, at, sheetIndex }], comparison? (compareToIssue: { issueId, issuedRevision, purpose, unchanged, clouds, delta: { components, welds, dimensions, bom: { added, removed, changed }, bomChanges, total } }), tables: { <name>: { rows, columns, data } } (whole line), layout (first sheet), warnings, reviewRequired, issue? }. ' +
    'Refusals (document unchanged): ISO_LINE_NOT_FOUND, ISO_NO_PIPING, ISO_DISCONNECTED, ISO_SPOOL_NOT_FOUND, ISO_PARAM_INVALID, ISO_ISSUE_NOT_FOUND, ISO_ISSUE_SNAPSHOT_MISSING (compareToIssue), MAT_EXPORT_CONTROLLED. Save with llull export_isometric --save <dir>.',
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
    compareToIssue: z
      .boolean()
      .optional()
      .describe(
        'Compare the line with its last issued revision (the issue_isometric stamp): components, welds, dimension strings and BOM rows that are new, removed or changed. Added and changed components and welds are circled by a revision cloud with a delta triangle on the sheet (layer ISO-REV; annotations kind revision); removed ones are counted in the legend and listed in data.comparison. Needs an issue with a stored snapshot.',
      ),
    revision: z
      .string()
      .trim()
      .min(1)
      .max(8)
      .optional()
      .describe('Label printed in the delta triangles of compareToIssue (the revision being drawn, e.g. "B"). Default "*".'),
    confirmExportControlled,
  }),
  run: (doc, params, ctx): CommandResult => {
    const refused = exportRefusal(doc, 'export_isometric', 'sheet', params.confirmExportControlled, ctx);
    if (refused !== null) return refused;
    const paramProblem = paramRefusal(doc, params);
    if (paramProblem !== null) return paramProblem;
    const analysis = analyseLine(doc, 'export_isometric', params.lineId);
    if (!isAnalysis(analysis)) return analysis;
    const graph = buildIsoGraph(analysis.read.network);
    const graphProblem = graphRefusal(doc, params, graph);
    if (graphProblem !== null) return graphProblem;
    const settings = settingsOf(analysis, params);
    const chosen = chosenSheets(doc, params, settings.plan);
    if (!chosen.ok) return chosen.result;
    const issues = issueState(analysis.fabrication, analysis.lineId, basisOf(analysis));
    const compared = issueComparison(doc, params, analysis, issues.latest);
    if (!compared.ok) return compared.result;
    const { comparison, revision } = compared.value;
    const sheets = buildSheets(doc, params, analysis, settings, chosen.value, revision, issues.current);
    if (!sheets.ok) return sheets.result;
    const built = sheets.value;
    const mismatches = mismatchesOf(built);
    return isometricReport({
      doc,
      analysis,
      graph,
      settings,
      scoped: settings.style === 'spool' || settings.plan.sheets.length > 1,
      built,
      mismatches,
      warnings: warningsOf(params, analysis, settings.plan, built, mismatches, issues),
      comparison,
      current: issues.current,
      params,
    });
  },
});

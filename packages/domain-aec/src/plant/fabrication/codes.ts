/** Stable `ISO_*` codes of the piping fabrication plugin with their one-line fixes (plant 05 ISO, TECHNICAL_SPEC §7). */

import { tableRejection } from '@core/commands/noop';
import type { IsoIssue, IssueSeverity } from './model';

const REMEDIATION: Readonly<Record<string, string>> = {
  ISO_PCF_HEADER: 'Export the PCF again from the source tool: the first line must be ISOGEN-FILES <file>.',
  ISO_PCF_TAB: 'Replace the TAB with spaces (a PCF forbids TAB characters).',
  ISO_PCF_LINE_TOO_LONG: 'Shorten the attribute on that line (a PCF line is at most 1024 characters).',
  ISO_PCF_TOO_LARGE: 'Split the file: one PCF per pipe line, at most 16 MB and 200000 lines.',
  ISO_PCF_UNITS_MISSING: 'Add UNITS-BORE and UNITS-CO-ORDS (MM or INCH) to the header: units are never assumed.',
  ISO_PCF_RECORD_INVALID:
    'Fix the record on the line named in paths (a point is: END-POINT x y z bore [end type]; CENTRE-POINT and CO-ORDS: x y z).',
  ISO_PCF_LINE_EXISTS: 'Pass lineIdOverride with a free line id, or delete the existing line first (delete_pcf_line for an imported one).',
  ISO_PCF_UNKNOWN_RECORD: 'Nothing to fix: the record is kept and written back verbatim, but this model does not read it.',
  ISO_PCF_BORE_UNMAPPED: 'Nothing to fix if the bore is intended; a nominal inch bore is the NPS (4 for DN100).',
  ISO_PCF_UNITS_VERBATIM:
    'Export without units (the line is written in the units it was read in), or import a file whose unknown attributes carry no lengths.',
  ISO_LINE_DUPLICATE:
    'Rename one of the lines (update_pipeline lineNumber, import_pcf lineIdOverride, or the legacy pipe line number) so every PIPELINE-REFERENCE is unique.',
  ISO_PCF_LINE_TRUNCATED: 'Shorten the description or attribute: a PCF line is at most 1024 characters.',
  ISO_LINE_NOT_FOUND: 'List the lines with building_schedule kind=pipe, piping_takeoff (routed) or by importing a PCF with import_pcf.',
  ISO_NO_PIPING: 'Route a line with route_pipe (or add_pipe_run for a legacy pipe) or import_pcf first.',
  ISO_SKEY_MISSING:
    'Set the isometric key of the spec item (01 PSC) or export without strictSkey (the component is then written without SKEY and listed).',
  ISO_LEGACY_FITTINGS_DERIVED: 'Re-route the line with a spec (convert_pipe_run) to place real fittings.',
  ISO_SEGMENT_TOO_SHORT: 'Lengthen the segment between the two bends, or use a bend of a smaller radius.',
  ISO_LEVEL_MISSING: 'Recreate the level (add_level) or move the pipe onto an existing level: its z is relative to the level elevation.',
  ISO_OPEN_END: 'Add an end flange or cap, or set from / to on the pipe.',
  ISO_PARAM_INVALID: 'Fix the parameter named in paths.',
  ISO_WELD_NOT_ON_PIPE: 'Pick a point on the centreline of a pipe of the line (within 1 mm); weld_list and cut_list show the pipe pieces.',
  ISO_WELD_TOO_CLOSE:
    'Move the weld away from the joint: both pieces must be at least minCutPieceMm (set_fabrication_rules) and 1 mm long.',
  ISO_WELD_NOT_FOUND:
    'List the numbered welds with weld_list (number them first with number_welds) and pass a weldId or a point on a numbered weld.',
  ISO_WELDS_UNNUMBERED: 'Run number_welds on the line to store the numbers (the listed ones are provisional).',
  ISO_GAP_UNDEFINED:
    'Pass weldGapMm (and fieldFitAllowanceMm for field-fit welds) or store them with set_fabrication_rules weldGapMm=... source=...: no value is assumed.',
  ISO_CUT_LENGTH_SHORT: 'Move the weld, reduce the gap, or merge the pieces: a cut piece must be longer than 0 and than minCutPieceMm.',
  ISO_SPOOL_TOO_LARGE: 'Add a field weld (add_field_weld) or run split_spools with autoBreak=true.',
  ISO_SPOOL_TOO_HEAVY: 'Add a field weld (add_field_weld) or run split_spools with autoBreak=true.',
  ISO_SPOOL_NOT_FOUND: 'List the spools of the line with spool_list and pass one of the names.',
  ISO_ITEM_CODE_MISSING: 'Assign the spec item (01 PSC) or the ITEM-CODE of the PCF record: the component is left out of the BOM rows.',
  ISO_BOLTING_UNRESOLVED:
    'Nothing to fix if the flange is not ASME B16.5: otherwise name the pressure class in the flange item code (e.g. FLWN-100-150) so the bolt table row can be found.',
  ISO_FIELD_WELD_STALE:
    'The weld no longer lies on a pipe of the line (it was edited): it is ignored; delete the line data or re-add the weld.',
  ISO_DISCONNECTED:
    'Reconnect the listed components (their connection points must coincide within 0.1 mm) or split them into separate lines.',
  ISO_DIMENSION_MISMATCH: 'Report a bug with the plan: a dimension string must close to its overall by construction.',
  ISO_UNVERIFIED_CATALOGUE: 'Verify the spec rows of the listed components (01 PSC) before the isometric is issued.',
  ISO_SHEET_OVERFLOW:
    'Use a larger paper, or split the line over sheets: define_isometric with maxPipePiecesPerSheet (a cut is possible only at a weld, or a flanged joint with splitAt flange).',
  ISO_SHEET_NOT_FOUND: 'Pass a sheet number between 1 and the number of sheets (export_isometric lists them in data.sheets).',
  ISO_ISOMETRIC_NOT_DEFINED: 'Run define_isometric for the line first: sheets exist only for a defined isometric.',
  ISO_ISSUE_STALE:
    'The line changed after it was issued: the isometric is NOT FOR CONSTRUCTION again; a human issues it anew (issue_isometric).',
  ISO_HUMAN_GATE:
    'Ask the reviewer to issue the isometric in the desktop app: confirmation is a signature object over the act, produced there.',
  ISO_CHECK_FAILED: 'Fix the errors check_isometric lists for the line (style final), then issue again.',
  ISO_REVIEW_REQUIRED: 'An unissued isometric is for review only (NOT FOR CONSTRUCTION): a human issues it.',
  ISO_ISSUE_NOT_FOUND:
    'The line has no issue stamp to compare with: a human issues it first (issue_isometric), then compareToIssue draws the changes.',
  ISO_ISSUE_SNAPSHOT_MISSING:
    'The issue predates snapshots: issue the line anew (issue_isometric) to store the content it is compared with.',
  ISO_GA_OVERFLOW: 'Use a smaller scale (a larger number) or a larger paper, or draw fewer lines (lineIds).',
  ISO_ROUTE_UNSUPPORTED:
    'Import the line as pcf_line (as omitted), or edit the PCF: route mode rebuilds a line from its centreline with the spec, so it takes pipes, elbows, bends, tees, olets, reducers, valves, end flanges, field welds and supports only.',
  ISO_ROUTE_NO_LEVEL:
    'Add a building level (add_level) so the supports can be placed, or import with supports false (they are then not created).',
  ISO_ROUTE_TOO_LARGE: 'Split the PCF: route mode rebuilds at most 400 components per line (every component is derived from the spec).',
  ISO_ROUTE_STEP_FAILED: 'Fix the step named in the message (it is a command that changed nothing), or import the line as pcf_line.',
  ISO_ROUTE_SPEC_MISSING: 'Pass spec with the id of a spec loaded in the document (list_pipe_specs): the PCF names none (PIPING-SPEC).',
  ISO_ROUTE_DIMENSIONS_CHANGED:
    'Nothing to fix if the spec dimensions are intended: the routed line follows the spec (flange sets, gaskets, centre-to-ends), not the file. Compare data.route.comparison, or keep the file as it is with pcf_line.',
  ISO_ROUTE_SUPPORTS_DROPPED: 'Import with supports true (default) after add_level to create them, or place them with add_pipe_support.',
  ISO_SPOOL_WEIGHT_INCOMPLETE: 'Components without a WEIGHT are not counted: the spool weight is a lower bound.',
};

export const refuseIso = tableRejection(REMEDIATION);

/** A finding with its table remediation. */
export function isoIssue(
  code: string,
  severity: IssueSeverity,
  message: string,
  ids: readonly string[] = [],
  paths: readonly string[] = [],
): IsoIssue {
  return { code, severity, message, ids, paths, remediation: REMEDIATION[code] ?? 'see the command description' };
}

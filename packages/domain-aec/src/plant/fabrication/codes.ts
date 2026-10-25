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
  ISO_OPEN_END: 'Add an end flange or cap, or set from / to on the pipe.',
  ISO_PARAM_INVALID: 'Fix the parameter named in paths.',
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

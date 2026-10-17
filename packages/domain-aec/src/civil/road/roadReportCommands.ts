/**
 * Read-only road queries and drawings: alignment report (stations, volumes, design-speed checks), long section and cross-section SVG
 * sheets.
 */

import type { CadDocument } from '@core/model/types';
import type { AlignmentObject } from '@core/model/civil';
import type { CommandResult } from '@core/commands/types';
import { commandCatalog, defineCommand, z, confirmExportControlled } from '@core/commands/schema';
import { noop, report, exportRefusal } from '@core/commands/noop';
import { safeFileName } from '@lib/safeFileName';
import { alignmentLength } from '../alignment/alignmentGeometry';
import { civilObjectOrNoop, getCivil } from '../model';
import { alignmentIdParam } from './roadParams';
import { designChecks } from './roadChecks';
import { analyseStations, reportCsv, reportRows, reportStations } from './roadReport';
import { longSectionSvg } from '../sheets/longSectionSvg';
import { crossSectionSvg, MAX_CROSS_SECTIONS } from './crossSectionSvg';
import { validateProfile } from '../alignment/profileGeometry';
import { toMetres } from '@core/model/units';

const intervalField = (spacing: string, fallback: string): z.ZodOptional<z.ZodNumber> =>
  z.number().optional().describe(`${spacing} spacing, document units. Default: ${fallback}.`);

function checkedAlignment(
  doc: CadDocument,
  params: { alignmentId: string; interval?: number | undefined },
  command: string,
): { alignment: AlignmentObject; interval: number } | CommandResult {
  const alignment = civilObjectOrNoop(doc, params.alignmentId, 'alignment', command);
  if ('summary' in alignment) return alignment;
  const interval = params.interval ?? alignment.stationInterval;
  if (!(interval > 0)) return noop(doc, `${command} failed: interval must be > 0.`);
  if (alignmentLength(alignment) <= 0) return noop(doc, `${command} failed: ${alignment.name} has no valid geometry.`);
  return { alignment, interval };
}

/**
 * @affects none (read-only)
 * @failure unknown alignment / interval <= 0 -> no-op
 */
export const alignmentReport = defineCommand({
  name: 'alignment_report',
  description:
    'Station-by-station report of an alignment (metres): x, y, ground, design, cut/fill (design - ground, + = fill), cross-section cut / ' +
    'fill areas (m2, need profile + road section + surface), cumulative cut / fill volumes (m3, average-end-area method) and the ' +
    'mass-haul ordinate (cum. cut - cum. fill, no bulking). Also `data.csv`. With `designSpeedKmh` it checks horizontal curve radii ' +
    'against R = V^2 / (127 (e + f)) with e = the set_superelevation maxRate (0 plus a warning when none is set) and f from a simple speed table (0.28 at 30 .. 0.09 at 120 km/h), and vertical curve ' +
    'K against minimum crest / sag K (AASHTO-style stopping sight distance table), plus grade breaks over 0.5 % without a vertical ' +
    'curve; failures are listed.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({
    alignmentId: alignmentIdParam,
    interval: intervalField('Row', 'the alignment station interval'),
    designSpeedKmh: z.number().optional().describe('Design speed (km/h, > 0) to enable the geometric checks.'),
  }),
  run: (doc, params): CommandResult => {
    const checked = checkedAlignment(doc, params, 'alignment_report');
    if ('summary' in checked) return checked;
    const { alignment, interval } = checked;
    if (params.designSpeedKmh !== undefined && !(params.designSpeedKmh > 0))
      return noop(doc, 'alignment_report failed: designSpeedKmh must be > 0.');
    const stations = reportStations(alignment, interval);
    const rows = reportRows(doc, alignment, analyseStations(doc, getCivil(doc), alignment, stations));
    const last = rows[rows.length - 1];
    const totals = {
      lengthM: Number(toMetres(doc, alignmentLength(alignment)).toFixed(3)),
      cutM3: last?.cumulativeCutM3 ?? 0,
      fillM3: last?.cumulativeFillM3 ?? 0,
      netM3: last?.massHaulM3 ?? 0,
    };
    const checks = params.designSpeedKmh === undefined ? undefined : designChecks(doc, alignment, params.designSpeedKmh);
    const earthworks = rows.some((row) => row.cutAreaM2 !== null)
      ? `cut ${totals.cutM3} m3, fill ${totals.fillM3} m3, net ${totals.netM3} m3 (+ = surplus)`
      : 'earthworks need a profile, a road section and a ground surface';
    const checkText = checks
      ? (checks.failures.length === 0
          ? ` Design speed ${checks.designSpeedKmh} km/h: all checks pass.`
          : ` Design speed ${checks.designSpeedKmh} km/h: ${checks.failures.length} failure(s): ${checks.failures.join(' ')}`) +
        checks.warnings.map((warning) => ` WARNING: ${warning}`).join('')
      : '';
    return report(
      doc,
      `${alignment.name} (${alignment.id}): ${rows.length} stations over ${totals.lengthM} m; ${earthworks}.${checkText}`,
      { rows, totals, csv: reportCsv(rows), ...(checks ? { checks } : {}) },
    );
  },
});

/**
 * @affects none (read-only)
 * @failure unknown alignment / no valid profile -> no-op
 */
export const exportLongSection = defineCommand({
  name: 'export_long_section',
  description:
    'Long section (profile) drawing of an alignment as SVG text in `data.svg` (alias `data.text`) (`data.fileName`): ground line, design line, PVIs with ' +
    'vertical-curve length / K / high-low point, grades, and a table band (station, ground, design, cut/fill) under the plot. Needs ' +
    'set_alignment_profile; ground needs a linked surface. Vertical exaggeration scales the vertical axis against the horizontal one.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({
    confirmExportControlled,
    alignmentId: alignmentIdParam,
    verticalExaggeration: z.number().optional().describe('Vertical / horizontal scale ratio (> 0). Default 10.'),
    interval: intervalField('Table column', 'the station interval'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const refused = exportRefusal(doc, 'export_long_section', 'sheet', params.confirmExportControlled, ctx);
    if (refused !== null) return refused;
    const checked = checkedAlignment(doc, params, 'export_long_section');
    if ('summary' in checked) return checked;
    const { alignment, interval } = checked;
    const exaggeration = params.verticalExaggeration ?? 10;
    if (!(exaggeration > 0)) return noop(doc, 'export_long_section failed: verticalExaggeration must be > 0.');
    if (validateProfile(alignment.profile) !== null) {
      return noop(doc, `export_long_section failed: ${alignment.name} has no design profile (set_alignment_profile).`);
    }
    const civil = getCivil(doc);
    const stations = reportStations(alignment, interval);
    const rows = reportRows(doc, alignment, analyseStations(doc, civil, alignment, stations));
    const text = longSectionSvg(doc, civil, alignment, rows, exaggeration);
    if (text === null) return noop(doc, 'export_long_section failed: the profile has no stations on the alignment.');
    const fileName = `${safeFileName(alignment.name, alignment.id)}_long_section.svg`;
    return report(doc, `Long section of ${alignment.name}: ${fileName} (${text.length} bytes, VE x${exaggeration}).`, {
      text,
      svg: text,
      fileName,
    });
  },
});

/**
 * @affects none (read-only)
 * @failure unknown alignment / no profile or road section -> no-op
 */
export const exportCrossSections = defineCommand({
  name: 'export_cross_sections',
  description:
    'Cross-section sheet of an alignment as SVG text in `data.svg` (alias `data.text`) (`data.fileName`): one panel per station with the existing ground, ' +
    'the road template with batters to daylight, and the cut / fill areas (m2), all at one 1:1 scale. Needs set_alignment_profile and ' +
    'set_road_section; ground and areas need a linked surface. At most 60 stations are drawn (the spacing is widened).',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({ confirmExportControlled, alignmentId: alignmentIdParam, interval: intervalField('Section', 'the station interval') }),
  run: (doc, params, ctx): CommandResult => {
    const refused = exportRefusal(doc, 'export_cross_sections', 'sheet', params.confirmExportControlled, ctx);
    if (refused !== null) return refused;
    const checked = checkedAlignment(doc, params, 'export_cross_sections');
    if ('summary' in checked) return checked;
    const { alignment } = checked;
    if (!alignment.section || validateProfile(alignment.profile) !== null) {
      return noop(doc, `export_cross_sections failed: ${alignment.name} needs a design profile and a road section.`);
    }
    let interval = checked.interval;
    let stations = reportStations(alignment, interval);
    if (stations.length > MAX_CROSS_SECTIONS) {
      interval *= Math.ceil(stations.length / MAX_CROSS_SECTIONS);
      stations = reportStations(alignment, interval).slice(0, MAX_CROSS_SECTIONS);
    }
    const civil = getCivil(doc);
    const analysis = analyseStations(doc, civil, alignment, stations);
    const text = crossSectionSvg(doc, civil, alignment, analysis);
    if (text === null) return noop(doc, 'export_cross_sections failed: no station lies on the design profile.');
    const fileName = `${safeFileName(alignment.name, alignment.id)}_cross_sections.svg`;
    const drawn = analysis.filter((entry) => entry.cross !== null).length;
    return report(doc, `Cross sections of ${alignment.name}: ${drawn} stations, ${fileName}.`, {
      text,
      svg: text,
      fileName,
      stations: drawn,
    });
  },
});

export const roadReportCommands = commandCatalog(alignmentReport, exportLongSection, exportCrossSections);

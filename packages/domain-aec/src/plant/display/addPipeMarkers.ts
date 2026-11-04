/**
 * add_pipe_markers (plant 09 VIS §5.7, TR-VIS-04): stores the ASME A13.1 marker placement of the pipes and routed runs of the model: one marker within 600 mm of each valve,
 * flanged joint and direction change, the straight-run interval between them, the legend size from the OD (plus covering), the letters of the colour profile rule of the pipe's service.
 */

import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { changed, tableRejection } from '@core/commands/noop';
import { compileProfile, profileProblems } from '@core/geometry/colourRules';
import { createDisplayModel, findProfile, type PipeMarker } from '@core/model/display';
import { allPipeIds, entryOf, type Entry } from './markerEntries';
import { markerRecords } from './markerRecords';
import { DEFAULT_SPACING_MM } from './markerPlan';

/** Most markers one call stores; a smaller spacing over a larger plant is refused, never truncated. */
const MAX_MARKERS = 5000;

const REMEDIATION: Readonly<Record<string, string>> = {
  VIS_MARKER_NOT_FOUND: 'ids are building pipe ids or 02 RTE run ids; list_pipe_runs / list_elements show them',
  VIS_PROFILE_NOT_FOUND: 'apply_service_colour_scheme with markerLetters builds a profile; pass its profileId',
  VIS_MARKER_NO_OD: 'give the pipe a diameter (add_pipe_run dn / diameter) or the run a spec so its outside diameter is known',
  VIS_MARKER_LIMIT: `raise spacingMm or narrow ids / lines: one call stores at most ${MAX_MARKERS} markers`,
};
const reject = tableRejection(REMEDIATION);

/**
 * @affects doc.display.pipeMarkers: the markers of each selected pipe are replaced (affected: the pipe ids); other pipes' markers are kept
 * @invariant pure; a rerun with the same parameters gives the same document; ids `<pipe id>:<k>`; penetrations are not planned (the model has none)
 * @failure unknown id -> VIS_MARKER_NOT_FOUND; unknown profile -> VIS_PROFILE_NOT_FOUND; pipe without OD -> VIS_MARKER_NO_OD; over 5000 markers -> VIS_MARKER_LIMIT; nothing selected -> unchanged
 */
export const addPipeMarkers = defineCommand({
  name: 'add_pipe_markers',
  description:
    'Store ASME A13.1 pipe-content markers on the pipes of the model (building pipes from add_pipe_run and routed 02 RTE runs). Placement: one marker within 600 mm of each valve, ' +
    'flanged joint and direction change (a valve wins over a flange, a flange over a bend when they lie within 600 mm), then the straight-run interval spacingMm (default 7620 mm = 25 ft, ' +
    'grade B) between them, at least one marker per pipe. Wall / floor penetrations are NOT planned: the model has no penetration data. Each marker carries the A13.1 legend size of the pipe ' +
    '(field length and letter height in mm from the outside diameter plus 2 x insulationMm; an OD between two table rows takes the next larger row and sets bandInterpolated true: a reviewer ' +
    "confirms with the edition in force), the letters / colour of the colour-profile rule the pipe's service selects (profile from apply_service_colour_scheme with markerLetters), and a " +
    'both-ways arrow when the plant data line object has bidirectional true. Replaces the markers of the selected pipes (ids "<pipe id>:<k>"), keeps the others. Returns data = ' +
    '{ markers, pipes, perPipe [{ id, markers, row, fieldLengthMm, letterHeightMm, bandInterpolated }], interpolated [pipe ids] }. check_pipe_markers verifies a stored placement. ' +
    'Errors: VIS_MARKER_NOT_FOUND, VIS_PROFILE_NOT_FOUND, VIS_MARKER_NO_OD, VIS_MARKER_LIMIT.',
  params: z.object({
    ids: z.array(z.string().min(1)).optional().describe('Building pipe ids and / or 02 RTE run ids. Default: every pipe and run.'),
    lines: z.array(z.string().min(1)).optional().describe('Keep only pipes whose line number is listed (e.g. ["CW-101"]).'),
    scheme: z.literal('asme_a13_1').optional().describe('Marker scheme; only asme_a13_1 (the default) has a legend size table.'),
    spacingMm: z
      .number()
      .positive()
      .optional()
      .describe(`Straight-run marker interval in mm. Default ${DEFAULT_SPACING_MM} (25 ft, grade B).`),
    insulationMm: z
      .number()
      .min(0)
      .optional()
      .describe('Insulation thickness (each side) in mm added to the OD for the legend size. Default 0 (bare pipe).'),
    profileId: z.string().optional().describe('Colour profile that supplies the letters. Default: the active display profile, if any.'),
  }),
  run: (doc, { ids, lines, spacingMm = DEFAULT_SPACING_MM, insulationMm = 0, profileId }): CommandResult => {
    const wantedProfile = profileId ?? doc.display?.activeProfileId;
    const profile = wantedProfile === undefined || doc.display === undefined ? undefined : findProfile(doc.display, wantedProfile);
    if (profileId !== undefined && profile === undefined)
      return reject(doc, 'add_pipe_markers', 'VIS_PROFILE_NOT_FOUND', `no colour profile '${profileId}'`, [], ['profileId']);
    const found = (ids ?? allPipeIds(doc)).map((id) => ({ id, entry: entryOf(doc, id) }));
    const missing = found.filter((item) => item.entry === null).map((item) => item.id);
    if (missing.length > 0)
      return reject(doc, 'add_pipe_markers', 'VIS_MARKER_NOT_FOUND', `no pipe or derivable run: ${missing.join(', ')}`, missing, ['ids']);
    const selected = found.flatMap(({ entry }): Entry[] =>
      entry === null || (lines !== undefined && (entry.line === null || !lines.includes(entry.line))) ? [] : [entry],
    );
    const noOd = selected.filter((entry) => !(entry.source.odMm > 0)).map((entry) => entry.id);
    if (noOd.length > 0)
      return reject(doc, 'add_pipe_markers', 'VIS_MARKER_NO_OD', `no outside diameter: ${noOd.join(', ')}`, noOd, ['ids']);
    if (selected.length === 0) return { document: doc, summary: 'add_pipe_markers: no pipe selected; nothing stored.', affected: [] };
    const compiled = profile === undefined || profileProblems(profile).length > 0 ? undefined : compileProfile(profile);
    const replaced = new Set(selected.map((entry) => entry.id));
    const stored: Record<string, PipeMarker> = Object.fromEntries(
      Object.entries(doc.display?.pipeMarkers ?? {}).filter(([, marker]) => !replaced.has(marker.pipeId)),
    );
    const perPipe = [];
    let total = 0;
    for (const entry of selected) {
      const { legend, markers } = markerRecords(doc, entry, spacingMm, insulationMm, compiled);
      total += markers.length;
      if (total > MAX_MARKERS)
        return reject(
          doc,
          'add_pipe_markers',
          'VIS_MARKER_LIMIT',
          `more than ${MAX_MARKERS} markers at spacing ${spacingMm} mm`,
          [entry.id],
          ['spacingMm'],
        );
      for (const marker of markers) stored[marker.id] = marker;
      perPipe.push({
        id: entry.id,
        markers: markers.length,
        row: legend.row,
        fieldLengthMm: legend.fieldLengthMm,
        letterHeightMm: legend.letterHeightMm,
        bandInterpolated: legend.bandInterpolated,
      });
    }
    const interpolated = perPipe.filter((pipe) => pipe.bandInterpolated).map((pipe) => pipe.id);
    const summary =
      `Stored ${total} A13.1 marker(s) on ${selected.length} pipe(s) at ${spacingMm} mm${profile === undefined ? '' : `; profile '${profile.id}'`}` +
      `${interpolated.length > 0 ? `; ${interpolated.length} pipe(s) between two table rows (VIS_MARKER_BAND_INTERPOLATED: a reviewer confirms with the edition in force)` : ''}; no penetration markers (no penetration data).`;
    return {
      ...changed({ ...doc, display: { ...(doc.display ?? createDisplayModel()), pipeMarkers: stored } }, summary, [...replaced]),
      data: { markers: total, pipes: selected.length, perPipe, interpolated },
    };
  },
});

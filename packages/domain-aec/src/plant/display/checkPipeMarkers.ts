/**
 * check_pipe_markers (plant 09 VIS §5.7, TR-VIS-04): compares the stored markers (`add_pipe_markers`) with the placement rule. Per pipe: every valve, flanged joint and direction change
 * has a marker within 600 mm, no stretch between markers (or from a pipe end) is longer than the interval, and the stored legend size is the A13.1 row of the pipe's current OD.
 */

import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { PipeMarker } from '@core/model/display';
import { allPipeIds, entryOf } from './markerEntries';
import { legendFor } from './markerLegend';
import { DEFAULT_SPACING_MM, NEAR_MM, lengthOf, requirements, type MarkerReason } from './markerPlan';

interface Missing {
  readonly atMm: number;
  readonly reason: MarkerReason;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Where a pipe lacks a marker: unserved requirements, and the middle of every stretch longer than the interval. */
function missingOf(requiredAt: readonly Missing[], marked: readonly number[], total: number, spacingMm: number): Missing[] {
  const missing: Missing[] = requiredAt.filter((item) => !marked.some((atMm) => Math.abs(atMm - item.atMm) <= NEAR_MM));
  const bounds = [0, ...marked, total];
  for (let i = 0; i < bounds.length - 1; i++) {
    const [from, to] = [bounds[i] as number, bounds[i + 1] as number];
    if (to - from > spacingMm || (marked.length === 0 && total > 0)) missing.push({ atMm: round3((from + to) / 2), reason: 'interval' });
  }
  return missing.sort((a, b) => a.atMm - b.atMm);
}

/**
 * @affects nothing — read-only; data { status, spacingMm, rows[{ id, kind, line, odIn, fieldLengthMm, letterHeightMm, bandInterpolated, markers, legendCurrent, missingAt[{ atMm, reason }] }], orphans[marker ids], markerCount }
 * @invariant a pipe with no stored marker is missing at least its interval marker; status: pass, else warn (never fail: a marker is an annotation)
 * @failure an id that is no pipe is listed in data.unknown, never thrown
 */
export const checkPipeMarkers = defineCommand({
  name: 'check_pipe_markers',
  description:
    'Check the stored ASME A13.1 pipe markers (add_pipe_markers) against the placement rule: per pipe, every valve, flanged joint and direction change has a marker within 600 mm, no stretch ' +
    'is longer than spacingMm (default 7620 mm), and the stored legend size is the A13.1 row of the current outside diameter (plus insulationMm each side; legendCurrent false when the pipe was ' +
    'resized or the covering changed). Returns data = { status: pass | warn, spacingMm, rows [{ id, kind, line, odIn, fieldLengthMm, letterHeightMm, bandInterpolated, markers, legendCurrent, missingAt [{ atMm, reason ' +
    'valve | flange | bend | interval }] }], orphans [stored marker ids whose pipe no longer exists], unknown [ids that are no pipe], markerCount }. Read-only; wall / floor penetrations are not checked (no data).',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({
    ids: z.array(z.string().min(1)).optional().describe('Building pipe ids and / or 02 RTE run ids. Default: every pipe and run.'),
    lines: z.array(z.string().min(1)).optional().describe('Keep only pipes whose line number is listed.'),
    spacingMm: z.number().positive().optional().describe(`Straight-run interval to hold in mm. Default ${DEFAULT_SPACING_MM}.`),
    insulationMm: z.number().min(0).optional().describe('Insulation thickness (each side) in mm used for the legend size. Default 0.'),
  }),
  run: (doc, { ids, lines, spacingMm = DEFAULT_SPACING_MM, insulationMm = 0 }): CommandResult => {
    const stored = Object.values(doc.display?.pipeMarkers ?? {});
    const byPipe = new Map<string, PipeMarker[]>();
    for (const marker of stored) byPipe.set(marker.pipeId, [...(byPipe.get(marker.pipeId) ?? []), marker]);
    const unknown: string[] = [];
    const rows = [];
    for (const id of ids ?? allPipeIds(doc)) {
      const entry = entryOf(doc, id);
      if (entry === null) {
        unknown.push(id);
        continue;
      }
      if (lines !== undefined && (entry.line === null || !lines.includes(entry.line))) continue;
      const markers = (byPipe.get(id) ?? []).sort((a, b) => a.atMm - b.atMm);
      const legend = legendFor(entry.source.odMm, insulationMm);
      const total = lengthOf(entry.source.points);
      rows.push({
        id,
        kind: entry.kind,
        line: entry.line,
        odIn: round3(entry.source.odMm / 25.4),
        fieldLengthMm: legend.fieldLengthMm,
        letterHeightMm: legend.letterHeightMm,
        bandInterpolated: legend.bandInterpolated,
        markers: markers.length,
        legendCurrent: markers.every(
          (marker) => marker.fieldLengthMm === legend.fieldLengthMm && marker.letterHeightMm === legend.letterHeightMm,
        ),
        missingAt: missingOf(
          requirements(doc, entry.source),
          markers.map((marker) => marker.atMm),
          total,
          spacingMm,
        ),
      });
    }
    const live = new Set(allPipeIds(doc));
    const orphans = stored.filter((marker) => !live.has(marker.pipeId)).map((marker) => marker.id);
    const status = rows.some((row) => row.missingAt.length > 0 || !row.legendCurrent) || orphans.length > 0 ? 'warn' : 'pass';
    const gaps = rows.reduce((sum, row) => sum + row.missingAt.length, 0);
    return report(
      doc,
      `check_pipe_markers: ${status}: ${rows.length} pipe(s), ${stored.length} stored marker(s), ${gaps} missing, ${orphans.length} orphan(s)${unknown.length > 0 ? `, ${unknown.length} unknown id(s)` : ''}.`,
      { status, spacingMm, rows, orphans, unknown, markerCount: stored.length },
    );
  },
});

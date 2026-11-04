/**
 * pipe_markers (plant 09 VIS-M7): where a viewport draws pipe-content markers. For every building pipe and 02 RTE run in scope: evenly spread
 * placements along the centreline (absolute mm), the flow tangent, line number, service and, from the display profile, the marker colours and letters.
 * Centrelines come from the stress-model source resolver (one reader for building pipes and routed runs).
 */

import type { Vec3 } from '@core/model/vectors';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { report, tableRejection } from '@core/commands/noop';
import { findProfile } from '@core/model/display';
import { compileProfile, profileProblems } from '@core/geometry/colourRules';
import { allPipeIds, entryOf, ruleOf } from './markerEntries';
import { DEFAULT_SPACING_MM } from './markerPlan';

/** Most placements one call returns; a smaller spacing over a larger plant is refused, never truncated. */
const MAX_MARKERS = 5000;

const REMEDIATION: Readonly<Record<string, string>> = {
  VIS_MARKER_NOT_FOUND: 'ids are building pipe ids or 02 RTE run ids; list_pipe_runs / list_elements show them',
  VIS_PROFILE_NOT_FOUND: 'apply_service_colour_scheme with markerLetters builds a profile; pass its profileId',
  VIS_MARKER_LIMIT: `raise spacingMm or narrow ids / lines: one call returns at most ${MAX_MARKERS} placements`,
};
const reject = tableRejection(REMEDIATION);

interface Mark {
  readonly positionMm: Vec3;
  readonly tangent: Vec3;
  readonly atMm: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (v: Vec3): number => Math.hypot(v[0], v[1], v[2]);
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

const legsOf = (points: readonly Vec3[]): { a: Vec3; b: Vec3; length: number }[] =>
  points.slice(1).map((end, i) => ({ a: points[i] as Vec3, b: end, length: norm(sub(end, points[i] as Vec3)) }));

/** Marks at the middles of `count` equal parts: none is further than the spacing from its neighbour. One cursor over the legs (linear). */
function placements(legs: ReturnType<typeof legsOf>, total: number, count: number): Mark[] {
  const marks: Mark[] = [];
  let index = 0;
  let before = 0;
  for (let k = 0; k < count; k++) {
    const atMm = ((k + 0.5) * total) / count;
    while (index < legs.length - 1 && atMm - before > (legs[index] as { length: number }).length) {
      before += (legs[index] as { length: number }).length;
      index++;
    }
    const leg = legs[index] as (typeof legs)[number];
    const t = leg.length === 0 ? 0 : Math.min(1, (atMm - before) / leg.length);
    const direction = sub(leg.b, leg.a);
    marks.push({
      positionMm: [round3(leg.a[0] + t * direction[0]), round3(leg.a[1] + t * direction[1]), round3(leg.a[2] + t * direction[2])],
      tangent:
        leg.length === 0
          ? [1, 0, 0]
          : [round3(direction[0] / leg.length), round3(direction[1] / leg.length), round3(direction[2] / leg.length)],
      atMm: round3(atMm),
    });
  }
  return marks;
}

/**
 * @affects nothing — read-only; data { spacingMm, profileId, runs[{ id, kind, line, service, lengthMm, rule, markers[{ positionMm, tangent, atMm }] }], skipped[], markerCount }
 * @invariant deterministic; tangent follows the centreline order (from end to to end; not a verified flow direction); placements are mm in document coordinates; letters / colours only from the profile
 * @failure unknown id -> VIS_MARKER_NOT_FOUND; unknown profile -> VIS_PROFILE_NOT_FOUND; over MAX_MARKERS placements -> VIS_MARKER_LIMIT
 */
export const pipeMarkers = defineCommand({
  name: 'pipe_markers',
  description:
    'List where pipe-content markers go on the pipes of the model: building pipes (add_pipe_run) and routed 02 RTE runs. Per pipe: line number, service, centreline length (mm), and markers[] ' +
    '{ positionMm [x,y,z] absolute mm, tangent [dx,dy,dz] unit vector along the pipe at the marker, in the order of its centreline points (the from end towards the to end), atMm arc length from the start }. Placements are spread evenly: ' +
    'ceil(length / spacingMm) markers at the middles of equal parts (so at most spacingMm apart, at least one per pipe). With a colour profile (profileId, default the active one) built by ' +
    'apply_service_colour_scheme, each pipe also gets rule { ruleId, category, fieldHex, legend, markerLetters, letterHex } (any rule predicate works; null when no rule matches; markerLetters and letterHex are null unless the profile was built with markerLetters: true). ' +
    'Without a profile the geometry is still returned. Read-only; the viewport draws from this. Valves, flanges and direction changes are not special-cased here: add_pipe_markers stores the rule-based placement (valve, flange, bend, interval). ' +
    'Errors: VIS_MARKER_NOT_FOUND, VIS_PROFILE_NOT_FOUND, VIS_MARKER_LIMIT.',
  annotations: { readOnly: true },
  params: z.object({
    ids: z.array(z.string().min(1)).optional().describe('Building pipe ids and / or 02 RTE run ids. Default: every pipe and run.'),
    lines: z.array(z.string().min(1)).optional().describe('Keep only pipes whose line number is listed (e.g. ["CW-101"]).'),
    spacingMm: z.number().positive().optional().describe(`Straight-run marker interval in mm. Default ${DEFAULT_SPACING_MM} (25 ft).`),
    profileId: z
      .string()
      .optional()
      .describe('Colour profile that supplies colours and letters. Default: the active display profile, if any.'),
  }),
  run: (doc, { ids, lines, spacingMm = DEFAULT_SPACING_MM, profileId }): CommandResult => {
    const wantedProfile = profileId ?? doc.display?.activeProfileId;
    const profile = wantedProfile === undefined || doc.display === undefined ? undefined : findProfile(doc.display, wantedProfile);
    if (profileId !== undefined && profile === undefined)
      return reject(doc, 'pipe_markers', 'VIS_PROFILE_NOT_FOUND', `no colour profile '${profileId}'`, [], ['profileId']);
    const wanted = ids ?? allPipeIds(doc);
    const found = wanted.map((id) => ({ id, entry: entryOf(doc, id) }));
    const missing = found.filter((item) => item.entry === null).map((item) => item.id);
    if (missing.length > 0)
      return reject(doc, 'pipe_markers', 'VIS_MARKER_NOT_FOUND', `no pipe or derivable run: ${missing.join(', ')}`, missing, ['ids']);
    const compiled = profile === undefined || profileProblems(profile).length > 0 ? undefined : compileProfile(profile);
    const skipped: { id: string; reason: string }[] = [];
    const runs = [];
    let markerCount = 0;
    for (const { entry } of found) {
      if (entry === null || (lines !== undefined && (entry.line === null || !lines.includes(entry.line)))) continue;
      const legs = legsOf(entry.source.points);
      const total = legs.reduce((sum, leg) => sum + leg.length, 0);
      if (!(total > 0)) {
        skipped.push({ id: entry.id, reason: 'zero-length centreline' });
        continue;
      }
      const count = Math.max(1, Math.ceil(total / spacingMm));
      if (markerCount + count > MAX_MARKERS)
        return reject(
          doc,
          'pipe_markers',
          'VIS_MARKER_LIMIT',
          `more than ${MAX_MARKERS} placements at spacing ${spacingMm} mm`,
          [entry.id],
          ['spacingMm'],
        );
      markerCount += count;
      const rule = ruleOf(compiled, entry);
      runs.push({
        id: entry.id,
        kind: entry.kind,
        line: entry.line,
        service: entry.service,
        lengthMm: round3(total),
        rule:
          rule === null
            ? null
            : {
                ruleId: rule.id,
                category: rule.scheme?.category ?? null,
                fieldHex: rule.appearance.colour,
                legend: rule.legend,
                markerLetters: rule.marker?.letters ?? null,
                letterHex: rule.marker?.letterHex ?? null,
              },
        markers: placements(legs, total, count),
      });
    }
    const profileText = profile === undefined ? '' : `; profile '${profile.id}'`;
    return report(
      doc,
      `${markerCount} marker placement(s) on ${runs.length} pipe(s) at ${spacingMm} mm${profileText}${skipped.length > 0 ? `; ${skipped.length} skipped` : ''}.`,
      { spacingMm, profileId: profile?.id ?? null, runs, skipped, markerCount },
    );
  },
});

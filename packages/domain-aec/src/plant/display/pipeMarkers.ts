/**
 * pipe_markers (plant 09 VIS-M7): where a viewport draws pipe-content markers. For every building pipe and 02 RTE run in scope: evenly spread
 * placements along the centreline (absolute mm), the flow tangent, line number, service and, from the display profile, the marker colours and letters.
 * Centrelines come from the stress-model source resolver (one reader for building pipes and routed runs).
 */

import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { report, tableRejection } from '@core/commands/noop';
import { findProfile, type ColourProfile, type ColourRule } from '@core/model/display';
import { getBuilding } from '../../building/model';
import { getPiping } from '../piping/model';
import { resolveSources, type SourcePipe } from '../stress/model/sources';

/** Straight-run interval of the spec (§5.7): 25 ft, grade B named default. */
const DEFAULT_SPACING_MM = 7620;
/** Most placements one call returns; a smaller spacing over a larger plant is refused, never truncated. */
const MAX_MARKERS = 5000;

const REMEDIATION: Readonly<Record<string, string>> = {
  VIS_MARKER_NOT_FOUND: 'ids are building pipe ids or 02 RTE run ids; list_pipe_runs / list_elements show them',
  VIS_PROFILE_NOT_FOUND: 'apply_service_colour_scheme with markerLetters builds a profile; pass its profileId',
  VIS_MARKER_LIMIT: `raise spacingMm or narrow ids / lines: one call returns at most ${MAX_MARKERS} placements`,
};
const reject = tableRejection(REMEDIATION);

interface Entry {
  readonly id: string;
  readonly kind: 'pipe' | 'run';
  readonly line: string | null;
  readonly service: string | null;
  readonly source: SourcePipe;
}

interface Mark {
  readonly positionMm: Vec3;
  readonly tangent: Vec3;
  readonly atMm: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (v: Vec3): number => Math.hypot(v[0], v[1], v[2]);
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

function entryOf(doc: CadDocument, id: string): Entry | null {
  const building = getBuilding(doc);
  const element = Object.hasOwn(building.elements, id) ? building.elements[id] : undefined;
  if (element?.category === 'pipe') {
    const source = resolveSources(doc, { scope: { kind: 'pipes', ids: [id] } }).pipes[0];
    return source === undefined ? null : { id, kind: 'pipe', line: element.line ?? null, service: element.service, source };
  }
  const piping = getPiping(doc);
  const run = Object.hasOwn(piping.runs, id) ? piping.runs[id] : undefined;
  if (run === undefined) return null;
  const source = resolveSources(doc, { scope: { kind: 'runs', ids: [id] } }).pipes[0];
  const line = piping.lines[run.lineId];
  return source === undefined ? null : { id, kind: 'run', line: line?.lineNumber ?? null, service: line?.service ?? null, source };
}

/** First rule whose equals-clause matches the pipe (case-insensitive); the rules `apply_service_colour_scheme` builds are of that form. */
function ruleOf(profile: ColourProfile | undefined, entry: Entry): ColourRule | undefined {
  if (profile === undefined) return undefined;
  const bag: Readonly<Record<string, string | null>> = { service: entry.service, line: entry.line };
  return profile.rules.find((rule) => {
    const wanted = rule.when.equals;
    const have = rule.when.property === undefined ? null : (bag[rule.when.property] ?? null);
    return have !== null && wanted !== undefined && String(wanted).toLowerCase() === have.toLowerCase();
  });
}

/** n = ceil(length / spacing) placements at the middles of n equal parts: none is further than spacing from its neighbour. */
function placements(points: readonly Vec3[], spacingMm: number): { total: number; marks: Mark[] } {
  const legs = points.slice(1).map((end, i) => ({ a: points[i] as Vec3, b: end, length: norm(sub(end, points[i] as Vec3)) }));
  const total = legs.reduce((sum, leg) => sum + leg.length, 0);
  if (!(total > 0)) return { total, marks: [] };
  const count = Math.max(1, Math.ceil(total / spacingMm));
  const marks: Mark[] = [];
  for (let k = 0; k < count; k++) {
    const atMm = ((k + 0.5) * total) / count;
    let remaining = atMm;
    const leg = legs.find((candidate) => {
      if (remaining <= candidate.length) return true;
      remaining -= candidate.length;
      return false;
    }) ?? (legs[legs.length - 1] as (typeof legs)[number]);
    const t = leg.length === 0 ? 0 : Math.min(1, remaining / leg.length);
    const direction = sub(leg.b, leg.a);
    marks.push({
      positionMm: [round3(leg.a[0] + t * direction[0]), round3(leg.a[1] + t * direction[1]), round3(leg.a[2] + t * direction[2])],
      tangent: leg.length === 0 ? [1, 0, 0] : [round3(direction[0] / leg.length), round3(direction[1] / leg.length), round3(direction[2] / leg.length)],
      atMm: round3(atMm),
    });
  }
  return { total, marks };
}

/**
 * @affects nothing — read-only; data { spacingMm, profileId, runs[{ id, kind, line, service, lengthMm, rule, markers[{ positionMm, tangent, atMm }] }], skipped[], markerCount }
 * @invariant deterministic; flow runs from the first to the last centreline point; placements are mm in document coordinates; letters / colours only from the profile
 * @failure unknown id -> VIS_MARKER_NOT_FOUND; unknown profile -> VIS_PROFILE_NOT_FOUND; over MAX_MARKERS placements -> VIS_MARKER_LIMIT
 */
export const pipeMarkers = defineCommand({
  name: 'pipe_markers',
  description:
    'List where pipe-content markers go on the pipes of the model: building pipes (add_pipe_run) and routed 02 RTE runs. Per pipe: line number, service, centreline length (mm), and markers[] ' +
    '{ positionMm [x,y,z] absolute mm, tangent [dx,dy,dz] unit vector in the flow direction (first to last centreline point), atMm arc length from the start }. Placements are spread evenly: ' +
    'ceil(length / spacingMm) markers at the middles of equal parts (so at most spacingMm apart, at least one per pipe). With a colour profile (profileId, default the active one) built by ' +
    'apply_service_colour_scheme, each pipe also gets rule { ruleId, category, fieldHex, legend, markerLetters, letterHex } (null when no rule matches; markerLetters and letterHex are null unless the profile was built with markerLetters: true). ' +
    'Without a profile the geometry is still returned. Read-only; the viewport draws from this. Valves, flanges and penetrations are not special-cased (use spacingMm). ' +
    'Errors: VIS_MARKER_NOT_FOUND, VIS_PROFILE_NOT_FOUND, VIS_MARKER_LIMIT.',
  annotations: { readOnly: true },
  params: z.object({
    ids: z.array(z.string().min(1)).optional().describe('Building pipe ids and / or 02 RTE run ids. Default: every pipe and run.'),
    lines: z.array(z.string().min(1)).optional().describe('Keep only pipes whose line number is listed (e.g. ["CW-101"]).'),
    spacingMm: z.number().positive().optional().describe(`Straight-run marker interval in mm. Default ${DEFAULT_SPACING_MM} (25 ft).`),
    profileId: z.string().optional().describe('Colour profile that supplies colours and letters. Default: the active display profile, if any.'),
  }),
  run: (doc, { ids, lines, spacingMm = DEFAULT_SPACING_MM, profileId }): CommandResult => {
    const wantedProfile = profileId ?? doc.display?.activeProfileId;
    const profile = wantedProfile === undefined || doc.display === undefined ? undefined : findProfile(doc.display, wantedProfile);
    if (profileId !== undefined && profile === undefined)
      return reject(doc, 'pipe_markers', 'VIS_PROFILE_NOT_FOUND', `no colour profile '${profileId}'`, [], ['profileId']);
    const missing = (ids ?? []).filter((id) => entryOf(doc, id) === null);
    if (missing.length > 0)
      return reject(doc, 'pipe_markers', 'VIS_MARKER_NOT_FOUND', `no pipe or derivable run: ${missing.join(', ')}`, missing, ['ids']);
    const every = [
      ...Object.values(getBuilding(doc).elements)
        .filter((element) => element.category === 'pipe')
        .map((element) => element.id),
      ...getPiping(doc).runOrder,
    ];
    const entries = (ids ?? every)
      .map((id) => entryOf(doc, id))
      .filter((entry): entry is Entry => entry !== null && (lines === undefined || (entry.line !== null && lines.includes(entry.line))));
    const skipped: { id: string; reason: string }[] = [];
    const runs = [];
    let markerCount = 0;
    for (const entry of entries) {
      const placed = placements(entry.source.points, spacingMm);
      if (placed.marks.length === 0) {
        skipped.push({ id: entry.id, reason: 'zero-length centreline' });
        continue;
      }
      markerCount += placed.marks.length;
      if (markerCount > MAX_MARKERS)
        return reject(doc, 'pipe_markers', 'VIS_MARKER_LIMIT', `more than ${MAX_MARKERS} placements at spacing ${spacingMm} mm`, [], ['spacingMm']);
      const rule = ruleOf(profile, entry);
      runs.push({
        id: entry.id,
        kind: entry.kind,
        line: entry.line,
        service: entry.service,
        lengthMm: round3(placed.total),
        rule:
          rule === undefined
            ? null
            : {
                ruleId: rule.id,
                category: rule.scheme?.category ?? null,
                fieldHex: rule.appearance.colour,
                legend: rule.legend,
                markerLetters: rule.scheme?.names['markerLetters'] ?? null,
                letterHex: rule.scheme?.names['letterHex'] ?? null,
              },
        markers: placed.marks,
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

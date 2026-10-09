/**
 * Road alignment, profile and cross-section commands (create / edit); queries and drawings live in
 * roadReportCommands.ts.
 * @layer domain-aec/civil
 */

import type { CadDocument } from '@core/model/types';
import type { AlignmentObject, ProfilePvi, RoadSection } from '@core/model/civil';
import type { CommandDefinition, CommandResult } from '@core/commands/types';
import { defineCommand, z, vec2 } from '@core/commands/schema';
import { noop } from '@core/commands/noop';
import { alignmentLength, endStation, validateHorizontal } from './alignmentGeometry';
import { grades, validateProfile, verticalCurves } from './profileGeometry';
import {
  civilAffected,
  civilObject,
  civilObjectsOf,
  formatStation,
  fromMetres,
  getCivil,
  nextCivilId,
  toMetresText,
  withObject,
} from './model';
import { regenerateCivil } from './evaluate';
import { roadReportCommands } from './roadReportCommands';
import { toMetres } from '../model';

function pointsInput(): z.ZodArray<z.ZodTuple<[z.ZodNumber, z.ZodNumber], null>> {
  return z.array(vec2('Point of intersection [x, y] in document units.'));
}

function findAlignment(doc: CadDocument, alignmentId: string): AlignmentObject | undefined {
  return civilObject(getCivil(doc), alignmentId, 'alignment');
}

function commit(doc: CadDocument, alignment: AlignmentObject): CadDocument {
  return regenerateCivil(doc, withObject(getCivil(doc), alignment));
}

function surfaceProblem(doc: CadDocument, surfaceId: string | undefined): string | null {
  if (surfaceId === undefined || surfaceId === '') return null;
  return civilObject(getCivil(doc), surfaceId, 'surface') ? null : `no surface ${surfaceId}.`;
}

/**
 * @command add_alignment
 * @pure
 * @affects creates 1 alignment: centreline, station ticks + labels, curve annotations
 * @failure fewer than 2 points / radii count mismatch / curves that do not fit / unknown surface -> no-op
 */
export const addAlignment = defineCommand({
  name: 'add_alignment',
  description:
    'Create a road / channel alignment from points of intersection (PIs, document units). Each ' +
    'interior PI can carry a simple circular curve of the given radius (0 = sharp corner). Draws the ' +
    'centreline, station ticks labelled km+mmm.mm every `stationInterval`, and PC / PT / R labels. ' +
    'Add a design profile with set_alignment_profile and a road template with set_road_section to get ' +
    'the corridor, batters to daylight and earthworks; report with alignment_report.',
  params: z.object({
    points: pointsInput().describe('PIs from start to end, at least 2: [[x, y], ...].'),
    radii: z
      .array(z.number())
      .optional()
      .describe('Curve radius per interior PI (length = points - 2); 0 = no curve. Default all 0.'),
    startStation: z
      .number()
      .optional()
      .describe('Station of the first point, document units. Default 0.'),
    stationInterval: z
      .number()
      .optional()
      .describe('Station tick / section spacing (> 0). Default 20 m.'),
    surfaceId: z.string().optional().describe('Existing-ground surface id (from create_surface).'),
    name: z.string().optional().describe('Alignment name. Default "Alignment <n>".'),
  }),
  run: (doc, params): CommandResult => {
    const civil = getCivil(doc);
    const radii = params.radii ?? params.points.slice(2).map(() => 0);
    const problem = validateHorizontal(params.points, radii);
    if (problem !== null) return noop(doc, `add_alignment failed: ${problem}`);
    const interval = params.stationInterval ?? fromMetres(doc, 20);
    if (!(interval > 0)) return noop(doc, 'add_alignment failed: stationInterval must be > 0.');
    const startStation = params.startStation ?? 0;
    if (!Number.isFinite(startStation))
      return noop(doc, 'add_alignment failed: startStation must be a number.');
    const surface = surfaceProblem(doc, params.surfaceId);
    if (surface !== null) return noop(doc, `add_alignment failed: ${surface}`);
    const id = nextCivilId(civil, 'alignment');
    const alignment: AlignmentObject = {
      id,
      category: 'alignment',
      name: params.name?.trim() || `Alignment ${civilObjectsOf(civil, 'alignment').length + 1}`,
      entityIds: [],
      points: params.points,
      radii,
      startStation,
      stationInterval: interval,
      ...(params.surfaceId ? { surfaceId: params.surfaceId } : {}),
      profile: [],
    };
    const document = commit(doc, alignment);
    const lengthM = toMetres(doc, alignmentLength(alignment));
    return {
      document,
      summary:
        `Created alignment ${alignment.name} (${id}): ${params.points.length} PIs, ` +
        `${radii.filter((radius) => radius > 0).length} curve(s), length ${lengthM.toFixed(2)} m, ` +
        `stations ${formatStation(toMetres(doc, startStation))} to ${formatStation(toMetres(doc, endStation(alignment)))}.`,
      affected: civilAffected(document, [id]),
      data: { alignmentId: id, lengthM: Number(lengthM.toFixed(3)) },
    };
  },
});

/**
 * @command update_alignment
 * @pure
 * @affects regenerates 1 alignment (centreline, ticks, corridor, daylight)
 * @failure unknown alignment / invalid geometry / unknown surface / no change -> no-op
 */
export const updateAlignment = defineCommand({
  name: 'update_alignment',
  description:
    'Edit an alignment: new PI `points`, curve `radii`, `startStation`, `stationInterval`, linked ' +
    '`surfaceId` ("" removes the link) or `name`. Profile, road section and everything derived ' +
    '(corridor, batters, report) follow. If `points` changes length without `radii`, radii are padded ' +
    'with 0 / truncated.',
  params: z.object({
    alignmentId: z.string().describe('Alignment id, e.g. "alignment-1".'),
    points: pointsInput().optional().describe('New PIs, at least 2.'),
    radii: z.array(z.number()).optional().describe('New radii (length = points - 2).'),
    startStation: z.number().optional().describe('New start station, document units.'),
    stationInterval: z.number().optional().describe('New station spacing (> 0).'),
    surfaceId: z.string().optional().describe('Ground surface id; "" removes the link.'),
    name: z.string().optional().describe('New name.'),
  }),
  run: (doc, params): CommandResult => {
    const alignment = findAlignment(doc, params.alignmentId);
    if (!alignment)
      return noop(doc, `update_alignment failed: no alignment ${params.alignmentId}.`);
    const points = params.points ?? alignment.points;
    const fitted = Array.from(
      { length: Math.max(points.length - 2, 0) },
      (_, i) => alignment.radii[i] ?? 0,
    );
    const radii = params.radii ?? fitted;
    const problem = validateHorizontal(points, radii);
    if (problem !== null) return noop(doc, `update_alignment failed: ${problem}`);
    const interval = params.stationInterval ?? alignment.stationInterval;
    if (!(interval > 0)) return noop(doc, 'update_alignment failed: stationInterval must be > 0.');
    const startStation = params.startStation ?? alignment.startStation;
    if (!Number.isFinite(startStation))
      return noop(doc, 'update_alignment failed: startStation must be a number.');
    const surface = surfaceProblem(doc, params.surfaceId);
    if (surface !== null) return noop(doc, `update_alignment failed: ${surface}`);
    const surfaceId =
      params.surfaceId === undefined ? alignment.surfaceId : params.surfaceId || undefined;
    const updated: AlignmentObject = {
      id: alignment.id,
      category: 'alignment',
      entityIds: alignment.entityIds,
      name: params.name?.trim() || alignment.name,
      points,
      radii,
      startStation,
      stationInterval: interval,
      ...(surfaceId !== undefined ? { surfaceId } : {}),
      profile: alignment.profile,
      ...(alignment.section ? { section: alignment.section } : {}),
    };
    if (JSON.stringify(updated) === JSON.stringify(alignment)) {
      return noop(doc, `update_alignment: nothing to change on ${alignment.id}.`);
    }
    const document = commit(doc, updated);
    const last = alignment.profile[alignment.profile.length - 1];
    const outside =
      last &&
      (last.station > endStation(updated) + 1e-6 ||
        (alignment.profile[0]?.station ?? 0) < startStation - 1e-6)
        ? ' Warning: the profile now extends beyond the alignment stations.'
        : '';
    return {
      document,
      summary:
        `Updated alignment ${updated.name} (${updated.id}): length ` +
        `${toMetres(doc, alignmentLength(updated)).toFixed(2)} m.${outside}`,
      affected: civilAffected(document, [updated.id]),
    };
  },
});

function gradeSummary(doc: CadDocument, profile: ReadonlyArray<ProfilePvi>): string {
  const gradeText = grades(profile)
    .map((g) => `${(g * 100).toFixed(2)}%`)
    .join(', ');
  const curves = verticalCurves(profile)
    .map(
      (c) =>
        `${c.kind} PVI ${formatStation(toMetres(doc, c.pviStation))} L=${toMetres(doc, c.length).toFixed(1)} m K=${c.k.toFixed(1)}`,
    )
    .join('; ');
  return `Grades: ${gradeText}.${curves ? ` Vertical curves: ${curves}.` : ' No vertical curves.'}`;
}

/**
 * @command set_alignment_profile
 * @pure
 * @affects replaces the design profile of 1 alignment (corridor, batters regenerate)
 * @failure unknown alignment / fewer than 2 PVIs / unordered or overlapping PVIs / PVIs outside the alignment -> no-op
 */
export const setAlignmentProfile = defineCommand({
  name: 'set_alignment_profile',
  description:
    'Set the vertical design profile of an alignment from PVIs [{ station, elevation, curveLength? }] ' +
    '(document units). Grades are straight between PVIs; an interior PVI with `curveLength` > 0 gets a ' +
    'symmetric parabolic vertical curve centred on it (first / last PVI cannot). The first and last ' +
    'PVI stations must lie within the alignment stations. The summary lists grades and K values.',
  params: z.object({
    alignmentId: z.string().describe('Alignment id, e.g. "alignment-1".'),
    pvis: z
      .array(
        z.object({
          station: z.number().describe('PVI station, document units.'),
          elevation: z.number().describe('Design elevation at the PVI, document units.'),
          curveLength: z.number().optional().describe('Vertical curve length (>= 0). Default 0.'),
        }),
      )
      .describe('At least 2 PVIs; sorted by station automatically.'),
  }),
  run: (doc, { alignmentId, pvis }): CommandResult => {
    const alignment = findAlignment(doc, alignmentId);
    if (!alignment) return noop(doc, `set_alignment_profile failed: no alignment ${alignmentId}.`);
    const profile = pvis
      .map(
        (pvi): ProfilePvi => ({
          station: pvi.station,
          elevation: pvi.elevation,
          curveLength: pvi.curveLength ?? 0,
        }),
      )
      .sort((a, b) => a.station - b.station);
    const problem = validateProfile(profile);
    if (problem !== null) return noop(doc, `set_alignment_profile failed: ${problem}`);
    const start = alignment.startStation;
    const end = endStation(alignment);
    const first = profile[0] as ProfilePvi;
    const last = profile[profile.length - 1] as ProfilePvi;
    if (first.station < start - 1e-6 || last.station > end + 1e-6) {
      return noop(
        doc,
        `set_alignment_profile failed: PVIs span ${first.station} to ${last.station} but the alignment runs ${start} to ${end}.`,
      );
    }
    const document = commit(doc, { ...alignment, profile });
    return {
      document,
      summary: `Set profile of ${alignment.name} (${alignment.id}): ${profile.length} PVIs. ${gradeSummary(doc, profile)}`,
      affected: civilAffected(document, [alignment.id]),
    };
  },
});

/**
 * @command set_road_section
 * @pure
 * @affects sets the road template of 1 alignment (corridor, batters regenerate)
 * @failure unknown alignment / non-positive width or slope / crossfall outside 0..0.3 -> no-op
 */
export const setRoadSection = defineCommand({
  name: 'set_road_section',
  description:
    'Set the symmetric road template of an alignment: carriageway `laneWidth` and `shoulderWidth` each ' +
    'side of the centreline (document units), `crossfall` (ratio falling away from the centreline, ' +
    '0.025 = 2.5 %), and the `cutSlope` / `fillSlope` batters (horizontal per 1 vertical). Defaults: ' +
    '3.5 m lane, 1.0 m shoulder, 0.025, 1.5, 2.0 - or the current template values. With a profile the ' +
    'corridor is drawn; with a surface too, batters run to daylight.',
  params: z.object({
    alignmentId: z.string().describe('Alignment id, e.g. "alignment-1".'),
    laneWidth: z.number().optional().describe('Carriageway width each side (> 0). Default 3.5 m.'),
    shoulderWidth: z
      .number()
      .optional()
      .describe('Shoulder width each side (>= 0). Default 1.0 m.'),
    crossfall: z.number().optional().describe('Crossfall ratio 0..0.3. Default 0.025.'),
    cutSlope: z.number().optional().describe('Cut batter H per 1 V (> 0). Default 1.5.'),
    fillSlope: z.number().optional().describe('Fill batter H per 1 V (> 0). Default 2.0.'),
  }),
  run: (doc, params): CommandResult => {
    const alignment = findAlignment(doc, params.alignmentId);
    if (!alignment)
      return noop(doc, `set_road_section failed: no alignment ${params.alignmentId}.`);
    const current = alignment.section;
    const section: RoadSection = {
      laneWidth: params.laneWidth ?? current?.laneWidth ?? fromMetres(doc, 3.5),
      shoulderWidth: params.shoulderWidth ?? current?.shoulderWidth ?? fromMetres(doc, 1),
      crossfall: params.crossfall ?? current?.crossfall ?? 0.025,
      cutSlope: params.cutSlope ?? current?.cutSlope ?? 1.5,
      fillSlope: params.fillSlope ?? current?.fillSlope ?? 2,
    };
    const valid =
      section.laneWidth > 0 &&
      section.shoulderWidth >= 0 &&
      section.crossfall >= 0 &&
      section.crossfall <= 0.3 &&
      section.cutSlope > 0 &&
      section.fillSlope > 0 &&
      Object.values(section).every(Number.isFinite);
    if (!valid) {
      return noop(
        doc,
        'set_road_section failed: laneWidth and slopes must be > 0, shoulderWidth >= 0, crossfall between 0 and 0.3.',
      );
    }
    const document = commit(doc, { ...alignment, section });
    return {
      document,
      summary:
        `Set road section of ${alignment.name} (${alignment.id}): lane ${toMetresText(doc, section.laneWidth)} m, ` +
        `shoulder ${toMetresText(doc, section.shoulderWidth)} m, crossfall ${(section.crossfall * 100).toFixed(1)}%, ` +
        `cut ${section.cutSlope}H:1V, fill ${section.fillSlope}H:1V.`,
      affected: civilAffected(document, [alignment.id]),
    };
  },
});

export const roadCommands = [
  addAlignment,
  updateAlignment,
  setAlignmentProfile,
  setRoadSection,
  ...roadReportCommands,
] as ReadonlyArray<CommandDefinition<unknown>>;

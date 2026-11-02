/**
 * Geometry of a pipe rack (06 STA §5.6, VC-STA-09): bents at the stations, columns on the column lines up to the top tier, rigid tier beams across
 * every bent, pinned struts along the column lines and X-bracing in the column-line planes of the chosen bays. Pure: a spec in, member runs out.
 */

import type { CadDocument, Vec3 } from '@core/model/types';
import { fromMm } from '@core/model/units';
import type { BaseFixity, JointFixity, MemberRole } from '@aec/building/types';
import { round } from '../../../shared/numeric';
import { findProfile } from '../../../steel/profiles';
import type { StaCode } from '../codes';
import type { RackSpec } from './rackSpec';

import { MAX_BENTS, MAX_COLUMN_LINES, MAX_RACK_MEMBERS, MAX_TIERS } from './rackLimits';

export type RackMemberKind = 'column' | 'tierBeam' | 'strut' | 'brace';

export interface RackRun {
  readonly kind: RackMemberKind;
  readonly role: MemberRole;
  readonly profile: string;
  readonly start: Vec3;
  readonly end: Vec3;
  readonly roll: number;
  readonly startJoint?: JointFixity;
  readonly endJoint?: JointFixity;
  readonly baseFixity?: BaseFixity;
  readonly note: string;
}

export interface RackLayout {
  /** Distances of the bents along the direction. */
  readonly stations: number[];
  /** Offsets of the column lines to the left of the direction, from the first line. */
  readonly lines: number[];
  readonly runs: RackRun[];
}

export interface RackProblem {
  readonly code: StaCode;
  readonly message: string;
  readonly paths: string[];
}

const problem = (code: StaCode, message: string, ...paths: string[]): RackProblem => ({ code, message, paths });

/** Label of column line `index`: A, B, ... Z, AA ... */
export const lineLabel = (index: number): string =>
  index < 26 ? String.fromCharCode(65 + index) : `${lineLabel(Math.floor(index / 26) - 1)}${String.fromCharCode(65 + (index % 26))}`;

/** Number of bays of a regular run (n = ceil(length / bentSpacing)); NaN when it is not a finite count. */
const baysOf = (along: { length: number; bentSpacing: number }): number => {
  const bays = Math.ceil(along.length / along.bentSpacing - 1e-9);
  return Number.isFinite(bays) && bays >= 1 ? bays : Number.NaN;
};

/** Bent stations of a run: regular bays are equal and at most bentSpacing wide. Empty when the run has no finite bay count or more than MAX_BENTS bents (nothing is allocated first). */
export function stationsOf(along: RackSpec['along']): number[] {
  if ('stations' in along) return [...along.stations];
  const bays = baysOf(along);
  if (!(bays + 1 <= MAX_BENTS)) return [];
  return Array.from({ length: bays + 1 }, (_, index) => (index === bays ? along.length : (index * along.length) / bays));
}

/** Column line offsets of `across`. */
export function linesOf(across: RackSpec['across']): number[] {
  if ('width' in across) return [0, across.width];
  return across.baysAcross.reduce<number[]>((lines, bay) => [...lines, (lines[lines.length - 1] as number) + bay], [0]);
}

/** Roll that puts the column depth across the rack (strong axis in the bent plane): roll 0 puts the depth along X (docs/INDUSTRIAL.md pipe-rack bent). */
export const columnRoll = (direction: readonly [number, number]): number => {
  const quarter = Math.PI / 2;
  const angle = (((Math.atan2(direction[1], direction[0]) + quarter) % Math.PI) + Math.PI) % Math.PI;
  const snapped = Math.round(angle / quarter) * quarter;
  return Math.abs(angle - snapped) < 1e-12 ? snapped % Math.PI : angle;
};

/** True when tier `tierIndex` carries struts. */
export const hasStruts = (spec: Pick<RackSpec, 'struts' | 'tiers'>, tierIndex: number): boolean =>
  spec.struts === 'every_tier' || (spec.struts === 'top' && tierIndex === spec.tiers.length - 1);

/**
 * @failure STA_RACK_SPACING (bays, widths, counts), STA_RACK_TIERS (order, heights), STA_RACK_BRACING (bays, profile, chords), STA_INVALID_GEOMETRY (direction, profiles, member cap)
 */
export function layoutRack(doc: CadDocument, spec: RackSpec): RackLayout | RackProblem {
  const [dx, dy] = spec.direction;
  const norm = Math.hypot(dx, dy);
  if (![dx, dy, ...spec.origin].every(Number.isFinite) || !(norm > 0))
    return problem('STA_INVALID_GEOMETRY', 'origin must be finite and direction a non-zero plan vector', 'origin', 'direction');
  const [ux, uy] = [dx / norm, dy / norm];
  const column = findProfile(spec.columnProfile);
  const beam = findProfile(spec.tierBeamProfile);
  const strut = findProfile(spec.strutProfile);
  const brace = spec.bracingProfile === undefined ? undefined : findProfile(spec.bracingProfile);
  const unknown = (
    [
      ['columnProfile', spec.columnProfile, column],
      ['tierBeamProfile', spec.tierBeamProfile, beam],
      ['strutProfile', spec.strutProfile, strut],
      ['bracingProfile', spec.bracingProfile ?? '', spec.bracingProfile === undefined ? column : brace],
    ] as const
  ).find(([, , found]) => found === undefined);
  if (unknown !== undefined || column === undefined || beam === undefined || strut === undefined)
    return problem(
      'STA_INVALID_GEOMETRY',
      `unknown steel profile '${unknown?.[1] ?? ''}' (list_steel_profiles)`,
      unknown?.[0] ?? 'columnProfile',
    );
  const columnSize = fromMm(doc, Math.max(column.h, column.b));
  const beamDepth = fromMm(doc, beam.h);
  const strutDepth = fromMm(doc, strut.h);

  if ('length' in spec.along && !(spec.along.bentSpacing <= spec.along.length))
    return problem(
      'STA_RACK_SPACING',
      `bentSpacing ${spec.along.bentSpacing} exceeds the length ${spec.along.length}: the rack needs at least one bay`,
      'bentSpacing',
      'length',
    );
  const stations = stationsOf(spec.along);
  if (stations.length > MAX_BENTS || stations.length === 0)
    return problem(
      'STA_RACK_SPACING',
      `more than ${MAX_BENTS} bents or no finite bay count (at most ${MAX_BENTS}): check the unit of length and bentSpacing (document units)`,
      'bentSpacing',
      'length',
    );
  if (stations.some((value, index) => index > 0 && !(value > (stations[index - 1] as number))))
    return problem('STA_RACK_SPACING', 'stations must be strictly ascending', 'stations');
  const narrow = stations.findIndex((value, index) => index > 0 && value - (stations[index - 1] as number) <= columnSize);
  if (narrow > 0)
    return problem(
      'STA_RACK_SPACING',
      `bay ${narrow} is no wider than the column section (${columnSize} ${doc.units}): check the unit`,
      'bentSpacing',
      'stations',
    );
  const lines = linesOf(spec.across);
  if (lines.length > MAX_COLUMN_LINES)
    return problem('STA_RACK_SPACING', `${lines.length} column lines (at most ${MAX_COLUMN_LINES})`, 'baysAcross');
  if (lines.some((value, index) => index > 0 && value - (lines[index - 1] as number) <= columnSize))
    return problem(
      'STA_RACK_SPACING',
      `a bay across is no wider than the column section (${columnSize} ${doc.units}): check the unit`,
      'width',
      'baysAcross',
    );

  const { tiers } = spec;
  if (tiers.length > MAX_TIERS) return problem('STA_RACK_TIERS', `${tiers.length} tiers (at most ${MAX_TIERS})`, 'tiers');
  const deepest = Math.max(beamDepth, strutDepth);
  if (tiers.some((tier, index) => !Number.isFinite(tier) || (index > 0 && !(tier - (tiers[index - 1] as number) > deepest))))
    return problem('STA_RACK_TIERS', 'tiers must be strictly ascending, more than the beam depth apart', 'tiers');
  if (!((tiers[0] as number) > deepest))
    return problem('STA_RACK_TIERS', `the lowest tier ${tiers[0]} must be higher than the beam depth (${deepest} ${doc.units})`, 'tiers');

  const bays = stations.length - 1;
  if (spec.bracingBays.length > 0) {
    if (brace === undefined) return problem('STA_RACK_BRACING', 'bracingBays need a bracingProfile', 'bracingProfile');
    if (spec.struts === 'none')
      return problem('STA_RACK_BRACING', 'a braced bay needs struts as chords: struts is none', 'struts', 'bracingBays');
    const bad = spec.bracingBays.filter((bay, index) => bay > bays || spec.bracingBays.indexOf(bay) !== index);
    if (bad.length > 0)
      return problem('STA_RACK_BRACING', `bracingBays ${bad.join(', ')} repeat or exceed the ${bays} bay(s) (1-based)`, 'bracingBays');
  }

  const strutTiers = tiers.map((_, index) => hasStruts(spec, index));
  const count =
    stations.length * lines.length +
    tiers.length * stations.length * (lines.length - 1) +
    strutTiers.filter(Boolean).length * bays * lines.length +
    spec.bracingBays.length * lines.length * tiers.length * 2;
  if (count > MAX_RACK_MEMBERS)
    return problem(
      'STA_INVALID_GEOMETRY',
      `${count} members (at most ${MAX_RACK_MEMBERS}): check the unit and the spacing`,
      'bentSpacing',
      'tiers',
    );

  const at = (station: number, line: number, z: number): Vec3 => [
    round(spec.origin[0] + ux * station - uy * line, 6),
    round(spec.origin[1] + uy * station + ux * line, 6),
    round(z, 6),
  ];
  const prefix = spec.gridPrefix;
  const roll = columnRoll([ux, uy]);
  const top = tiers[tiers.length - 1] as number;
  const runs: RackRun[] = [];
  stations.forEach((station, bent) =>
    lines.forEach((line, lineIndex) =>
      runs.push({
        kind: 'column',
        role: 'column',
        profile: column.name,
        start: at(station, line, 0),
        end: at(station, line, top),
        roll,
        ...(spec.baseFixity === undefined ? {} : { baseFixity: spec.baseFixity }),
        note: `${prefix}${lineLabel(lineIndex)}${bent + 1}`,
      }),
    ),
  );
  tiers.forEach((tier, tierIndex) =>
    stations.forEach((station, bent) =>
      lines
        .slice(1)
        .forEach((line, bay) =>
          runs.push({
            kind: 'tierBeam',
            role: 'beam',
            profile: beam.name,
            start: at(station, lines[bay] as number, tier - beamDepth / 2),
            end: at(station, line, tier - beamDepth / 2),
            roll: 0,
            startJoint: 'rigid',
            endJoint: 'rigid',
            note: `${prefix}${bent + 1} T${tierIndex + 1}${lines.length > 2 ? ` ${lineLabel(bay)}-${lineLabel(bay + 1)}` : ''}`,
          }),
        ),
    ),
  );
  tiers.forEach((tier, tierIndex) => {
    if (!strutTiers[tierIndex]) return;
    lines.forEach((line, lineIndex) =>
      stations
        .slice(1)
        .forEach((station, bay) =>
          runs.push({
            kind: 'strut',
            role: 'beam',
            profile: strut.name,
            start: at(stations[bay] as number, line, tier - strutDepth / 2),
            end: at(station, line, tier - strutDepth / 2),
            roll: 0,
            note: `${prefix}${lineLabel(lineIndex)} T${tierIndex + 1} B${bay + 1}`,
          }),
        ),
    );
  });
  const heights = [0, ...tiers.map((tier, index) => tier - (strutTiers[index] ? strutDepth : beamDepth) / 2)];
  for (const bay of spec.bracingBays) {
    lines.forEach((line, lineIndex) =>
      heights.slice(1).forEach((high, panel) => {
        const low = heights[panel] as number;
        const [from, to] = [stations[bay - 1] as number, stations[bay] as number];
        const diagonals = [
          [at(from, line, low), at(to, line, high)],
          [at(to, line, low), at(from, line, high)],
        ] as const;
        diagonals.forEach(([start, end], diagonal) =>
          runs.push({
            kind: 'brace',
            role: 'brace',
            profile: brace?.name ?? '',
            start,
            end,
            roll: 0,
            note: `${prefix}${lineLabel(lineIndex)} B${bay} P${panel + 1} D${diagonal + 1}`,
          }),
        );
      }),
    );
  }
  return { stations, lines, runs };
}

export const isRackProblem = <Other extends object>(value: Other | RackProblem): value is RackProblem => 'code' in value;

/**
 * Pre-engineered steel hall generator (portal frames) and crane runways.
 * @layer core/commands/building/industrial
 */

import type { CadDocument, Vec2, Vec3 } from '../../../model/types';
import type { BuildingModel, SlabElement } from '../../../model/building';
import type { CommandDefinition, CommandResult } from '../../types';
import {
  elementAffected,
  fromMm,
  getBuilding,
  isFiniteNumber,
  isVec2,
  nextElementId,
  nextMark,
  noChange,
  resolveLevel,
  toMetres,
  toVec2,
  withElement,
} from '../model';
import { regenerateBuilding } from '../evaluate';
import { findProfile, type SteelProfile } from '../steel/profiles';
import {
  appendFootings,
  appendMembers,
  appendPanel,
  columnFeet,
  MAX_GENERATED_MEMBERS,
  withoutFootings,
} from './members';
import { panelFrame } from './evaluate';
import { appendBasePlates, columnsWithoutPlates } from './plates';
import { appendConnections, findMomentJoints } from './connections';
import { addGrid, gridLabels, nextFreeLabel } from '../grid';

type MemberSpecs = Parameters<typeof appendMembers>[2];
type MemberSpec = MemberSpecs[number];

/** Steel mass of members created by a generator, kg. */
function steelMass(doc: CadDocument, building: BuildingModel, ids: ReadonlyArray<string>): number {
  return ids.reduce((sum, id) => {
    const element = building.elements[id];
    if (element?.category !== 'member') return sum;
    const profile = findProfile(element.profile);
    const length = Math.hypot(
      element.end[0] - element.start[0],
      element.end[1] - element.start[1],
      element.end[2] - element.start[2],
    );
    return sum + (profile ? toMetres(doc, length) * profile.massPerMetre : 0);
  }, 0);
}

interface RunwaySpec {
  readonly start: Vec2;
  readonly end: Vec2;
  readonly railHeight: number;
  readonly profile: SteelProfile;
  readonly supports: ReadonlyArray<number>;
  readonly bracket: SteelProfile;
  readonly note: string;
}

/** Runway beam segments between supports + brackets to the nearest steel column at each support. */
function runwayMembers(
  doc: CadDocument,
  building: BuildingModel,
  levelId: string,
  spec: RunwaySpec,
): MemberSpec[] {
  const dx = spec.end[0] - spec.start[0];
  const dy = spec.end[1] - spec.start[1];
  const length = Math.hypot(dx, dy);
  const at = (distance: number): Vec2 => [
    spec.start[0] + (dx / length) * distance,
    spec.start[1] + (dy / length) * distance,
  ];
  const axisZ = spec.railHeight - fromMm(doc, spec.profile.h) / 2;
  const stations = [
    ...new Set([0, ...spec.supports.filter((s) => s > 0 && s < length), length]),
  ].sort((a, b) => a - b);
  const members: MemberSpec[] = [];
  for (let index = 0; index + 1 < stations.length; index++) {
    const [from, to] = [at(stations[index] as number), at(stations[index + 1] as number)];
    members.push({
      role: 'crane',
      profile: spec.profile.name,
      start: [from[0], from[1], axisZ],
      end: [to[0], to[1], axisZ],
      note: spec.note,
    });
  }
  const columns = Object.values(building.elements).filter(
    (element) =>
      element.category === 'member' && element.role === 'column' && element.levelId === levelId,
  );
  const bracketZ = spec.railHeight - fromMm(doc, spec.profile.h) - fromMm(doc, spec.bracket.h) / 2;
  for (const station of stations) {
    const point = at(station);
    let nearest: Vec2 | null = null;
    let best = fromMm(doc, 2000);
    for (const column of columns) {
      if (column.category !== 'member') continue;
      const [x, y] = column.start;
      const distance = Math.hypot(x - point[0], y - point[1]);
      if (distance > 0 && distance < best) {
        best = distance;
        nearest = [x, y];
      }
    }
    if (nearest) {
      members.push({
        role: 'beam',
        profile: spec.bracket.name,
        start: [nearest[0], nearest[1], bracketZ],
        end: [point[0], point[1], bracketZ],
        note: 'crane bracket',
      });
    }
  }
  return members;
}

interface AddCraneRunwayParams {
  start: Vec2;
  end: Vec2;
  railHeight: number;
  profile?: string;
  capacity?: number;
  supportSpacing?: number;
  bracketProfile?: string;
  levelId?: string;
}

/**
 * @command add_crane_runway
 * @pure
 * @affects creates runway beam segments + brackets to nearby steel columns
 * @failure bad points / railHeight <= 0 / unknown profile -> no-op
 */
export const addCraneRunway: CommandDefinition<AddCraneRunwayParams> = {
  name: 'add_crane_runway',
  description:
    'Add an overhead-crane runway: crane beams along a plan line with their top at railHeight, split at ' +
    'supports every supportSpacing, each support carried by a bracket cantilevered from the nearest steel ' +
    'column (within 2 m). Capacity (t) is noted on the members for schedules.',
  paramsSchema: {
    type: 'object',
    properties: {
      start: { type: 'array', items: { type: 'number' }, description: 'Runway start [x, y].' },
      end: { type: 'array', items: { type: 'number' }, description: 'Runway end [x, y].' },
      railHeight: { type: 'number', description: 'Top of the runway beam above the level (> 0).' },
      profile: { type: 'string', description: 'Runway beam section. Default HEB300.' },
      capacity: {
        type: 'number',
        description: 'Crane capacity in tonnes (for notes). Default 10.',
      },
      supportSpacing: {
        type: 'number',
        description: 'Distance between supports. Default 6000 mm.',
      },
      bracketProfile: { type: 'string', description: 'Bracket section. Default HEB200.' },
      levelId: { type: 'string', description: 'Level id. Default: the active level.' },
    },
    required: ['start', 'end', 'railHeight'],
  },
  run: (doc, params): CommandResult => {
    if (!isVec2(params.start) || !isVec2(params.end)) {
      return noChange(doc, 'add_crane_runway failed: start and end must be [x, y].');
    }
    const length = Math.hypot(params.end[0] - params.start[0], params.end[1] - params.start[1]);
    const spacing = params.supportSpacing ?? fromMm(doc, 6000);
    if (
      !(length > 0) ||
      !(isFiniteNumber(params.railHeight) && params.railHeight > 0) ||
      !(isFiniteNumber(spacing) && spacing > 0)
    ) {
      return noChange(
        doc,
        'add_crane_runway failed: distinct points, railHeight > 0 and supportSpacing > 0 required.',
      );
    }
    const profile = findProfile(params.profile ?? 'HEB300');
    const bracket = findProfile(params.bracketProfile ?? 'HEB200');
    if (!profile || !bracket)
      return noChange(doc, 'add_crane_runway failed: unknown steel profile.');
    if (params.railHeight <= fromMm(doc, profile.h + bracket.h)) {
      return noChange(
        doc,
        `add_crane_runway failed: railHeight must exceed the runway beam + bracket depth (${profile.h + bracket.h} mm).`,
      );
    }
    if (length / spacing > MAX_GENERATED_MEMBERS) {
      return noChange(
        doc,
        `add_crane_runway failed: supportSpacing too small (over ${MAX_GENERATED_MEMBERS} segments).`,
      );
    }
    const resolution = resolveLevel(doc, getBuilding(doc), params.levelId);
    if (!resolution.ok) return noChange(doc, `add_crane_runway failed: ${resolution.reason}.`);
    const supports: number[] = [];
    for (let distance = spacing; distance < length; distance += spacing) supports.push(distance);
    const capacity = params.capacity ?? 10;
    const specs = runwayMembers(doc, resolution.building, resolution.level.id, {
      start: toVec2(params.start),
      end: toVec2(params.end),
      railHeight: params.railHeight,
      profile,
      supports,
      bracket,
      note: `Crane ${capacity} t, rail top ${params.railHeight}`,
    });
    const added = appendMembers(resolution.building, resolution.level.id, specs);
    if ('reason' in added) return noChange(doc, `add_crane_runway failed: ${added.reason}.`);
    const document = regenerateBuilding(doc, added.building);
    return {
      document,
      summary: `Added crane runway (${capacity} t): ${specs.filter((spec) => spec.role === 'crane').length} beam segment(s) ${profile.name}, ${specs.filter((spec) => spec.role !== 'crane').length} bracket(s).`,
      affected: elementAffected(document, added.ids),
      data: { elementIds: added.ids },
    };
  },
};

/** One roof slope of a span: from its low end at a column line up to its high end. */
interface Slope {
  readonly side: -1 | 1;
  readonly lowX: number;
  readonly lowZ: number;
  readonly highX: number;
  readonly highZ: number;
}

interface PortalHallParams {
  origin?: Vec2;
  span?: number;
  spans?: number[];
  length?: number;
  baySpacing?: number;
  eaveHeight?: number;
  roofPitch?: number;
  roofType?: 'duopitch' | 'monopitch';
  columnProfile?: string;
  rafterProfile?: string;
  purlinProfile?: string;
  railProfile?: string;
  braceProfile?: string;
  gablePostProfile?: string;
  purlinSpacing?: number;
  railSpacing?: number;
  footings?: boolean;
  basePlates?: boolean;
  columnBase?: 'pinned' | 'fixed';
  connections?: boolean;
  cladding?: boolean;
  floorSlab?: boolean;
  crane?: { capacity?: number; railHeight: number; profile?: string };
  levelId?: string;
}

/** Outward-facing panel corners: reversed when the Newell normal points against `outward`. */
function facing(corners: Vec3[], outward: Vec3): Vec3[] {
  const frame = panelFrame(corners);
  if (!frame) return corners;
  const dot =
    frame.normal[0] * outward[0] + frame.normal[1] * outward[1] + frame.normal[2] * outward[2];
  return dot >= 0 ? corners : [...corners].reverse();
}

/**
 * @command add_portal_frame_building
 * @pure
 * @affects creates a complete steel hall (members, footings, cladding, slab) — all-or-nothing
 * @failure invalid dimensions / unknown profiles / crane above eaves -> no-op
 */
export const addPortalFrameBuilding: CommandDefinition<PortalHallParams> = {
  name: 'add_portal_frame_building',
  description:
    'Generate a pre-engineered steel hall (factory / warehouse) in one step: portal frames every baySpacing ' +
    'along Y (columns + pitched rafters spanning X; several spans side by side with spans: [...]), gable posts, purlins and side rails, X-bracing in the ' +
    'end bays (roof and walls), pad footings under every column, roof / wall / gable cladding, a ground ' +
    'slab and optionally an overhead crane runway on brackets. All sizes in document units, roofPitch in ' +
    'degrees. Defaults: 24 m span, 48 m long, 6 m bays, 7 m eaves, 6° roof, HEA400 columns, IPE450 rafters.',
  paramsSchema: {
    type: 'object',
    properties: {
      origin: {
        type: 'array',
        items: { type: 'number' },
        description: 'Corner (gridline A1) [x, y]. Default [0, 0].',
      },
      span: {
        type: 'number',
        description: 'Clear span between column axes (X). Default 24000 mm.',
      },
      spans: {
        type: 'array',
        items: { type: 'number' },
        description:
          'Multi-span hall: widths of side-by-side spans along X (internal columns on shared lines, ' +
          'valley between roofs). Overrides span.',
      },
      length: { type: 'number', description: 'Hall length (Y). Default 48000 mm.' },
      baySpacing: {
        type: 'number',
        description: 'Target frame spacing; adjusted to divide the length. Default 6000 mm.',
      },
      eaveHeight: { type: 'number', description: 'Column height to the eaves. Default 7000 mm.' },
      roofPitch: { type: 'number', description: 'Roof slope in degrees. Default 6.' },
      roofType: {
        type: 'string',
        enum: ['duopitch', 'monopitch'],
        description:
          "Roof shape: 'duopitch' (default: ridge mid-span, eaveHeight at both column lines) or 'monopitch' " +
          '(one rafter per span rising at roofPitch from the low eaves at the left (x = origin, height eaveHeight) ' +
          'to the high eaves on the right; the columns get different heights, with several spans the slope ' +
          'continues across the internal column lines; no apex connection, two eaves connections per frame; wind ' +
          'with EN 1991-1-4 Tab. 7.3a monopitch coefficients).',
      },
      columnProfile: { type: 'string', description: 'Default HEA400.' },
      rafterProfile: { type: 'string', description: 'Default IPE450.' },
      purlinProfile: { type: 'string', description: 'Default C200x75x2.5.' },
      railProfile: {
        type: 'string',
        description:
          'Side rails. Default C200x75x2.5 (passes check_purlins at qp 0.6 on 6 m bays).',
      },
      braceProfile: { type: 'string', description: 'Bracing. Default CHS76.1x3.6.' },
      gablePostProfile: { type: 'string', description: 'Gable wind posts. Default HEA200.' },
      purlinSpacing: { type: 'number', description: 'Along the slope. Default 1800 mm.' },
      railSpacing: { type: 'number', description: 'Vertical. Default 1800 mm.' },
      footings: { type: 'boolean', description: 'Pad footings under columns. Default true.' },
      connections: {
        type: 'boolean',
        description: 'Bolted end-plate moment connections (haunched eaves, apex). Default true.',
      },
      basePlates: {
        type: 'boolean',
        description: 'Base plates with 4 M24 anchor bolts under every column. Default true.',
      },
      columnBase: {
        type: 'string',
        enum: ['pinned', 'fixed'],
        description:
          "Column base fixity: 'pinned' (default) or 'fixed' (rotation restrained in the frame analysis: " +
          'stiffer sway, base moments in the reactions and footing / base plate M+N checks; requires basePlates; ' +
          'size the plates with design_portal_frames).',
      },
      cladding: { type: 'boolean', description: 'Roof, side and gable cladding. Default true.' },
      floorSlab: { type: 'boolean', description: 'Ground-bearing slab. Default true.' },
      crane: {
        type: 'object',
        description: 'Optional crane runway on both sides: { capacity (t), railHeight, profile }.',
        properties: {
          capacity: { type: 'number', description: 'Tonnes. Default 10.' },
          railHeight: {
            type: 'number',
            description: 'Top of runway beam (must be below the eaves).',
          },
          profile: { type: 'string', description: 'Runway section. Default HEB300.' },
        },
        required: ['railHeight'],
      },
      levelId: { type: 'string', description: 'Level id. Default: the active level.' },
    },
    required: [],
  },
  run: (doc, params): CommandResult => {
    const mm = (value: number): number => fromMm(doc, value);
    const origin = params.origin ?? [0, 0];
    const span = Array.isArray(params.spans)
      ? Math.max(...params.spans.map(Number))
      : (params.span ?? mm(24000));
    const hallLength = params.length ?? mm(48000);
    const targetBay = params.baySpacing ?? mm(6000);
    const eave = params.eaveHeight ?? mm(7000);
    const pitchDegrees = params.roofPitch ?? 6;
    const purlinSpacing = params.purlinSpacing ?? mm(1800);
    const railSpacing = params.railSpacing ?? mm(1800);
    if (
      params.spans !== undefined &&
      !(
        Array.isArray(params.spans) &&
        params.spans.length >= 1 &&
        params.spans.length <= 10 &&
        params.spans.every((width) => isFiniteNumber(width) && width > 0)
      )
    ) {
      return noChange(
        doc,
        'add_portal_frame_building failed: spans must be 1–10 widths, each > 0.',
      );
    }
    const spanCount = params.spans?.length ?? 1;
    const sizes = [span, hallLength, targetBay, eave, purlinSpacing, railSpacing];
    if (!isVec2(origin) || sizes.some((value) => !(isFiniteNumber(value) && value > 0))) {
      return noChange(
        doc,
        'add_portal_frame_building failed: origin [x, y] and all sizes > 0 required.',
      );
    }
    if (!(isFiniteNumber(pitchDegrees) && pitchDegrees >= 0 && pitchDegrees < 45)) {
      return noChange(
        doc,
        'add_portal_frame_building failed: roofPitch must be in [0, 45) degrees.',
      );
    }
    const roofType = params.roofType ?? 'duopitch';
    if (roofType !== 'duopitch' && roofType !== 'monopitch') {
      return noChange(
        doc,
        "add_portal_frame_building failed: roofType must be 'duopitch' or 'monopitch'.",
      );
    }
    const columnBase = params.columnBase ?? 'pinned';
    if (columnBase !== 'pinned' && columnBase !== 'fixed') {
      return noChange(
        doc,
        "add_portal_frame_building failed: columnBase must be 'pinned' or 'fixed'.",
      );
    }
    if (columnBase === 'fixed' && params.basePlates === false) {
      return noChange(
        doc,
        "add_portal_frame_building failed: columnBase 'fixed' needs base plates (basePlates must not be false).",
      );
    }
    const names = {
      column: params.columnProfile ?? 'HEA400',
      rafter: params.rafterProfile ?? 'IPE450',
      purlin: params.purlinProfile ?? 'C200x75x2.5',
      rail: params.railProfile ?? 'C200x75x2.5',
      brace: params.braceProfile ?? 'CHS76.1x3.6',
      gable: params.gablePostProfile ?? 'HEA200',
    };
    const profiles = Object.fromEntries(
      Object.entries(names).map(([key, name]) => [key, findProfile(name)]),
    ) as Record<keyof typeof names, SteelProfile | undefined>;
    const missing = Object.entries(profiles).filter(([, profile]) => !profile);
    if (missing.length > 0) {
      return noChange(
        doc,
        `add_portal_frame_building failed: unknown profile(s) ${missing.map(([key]) => names[key as keyof typeof names]).join(', ')} (see list_steel_profiles).`,
      );
    }
    const p = profiles as Record<keyof typeof names, SteelProfile>;
    if (
      params.crane &&
      !(
        isFiniteNumber(params.crane.railHeight) &&
        params.crane.railHeight > 0 &&
        params.crane.railHeight < eave
      )
    ) {
      return noChange(
        doc,
        'add_portal_frame_building failed: crane.railHeight must be > 0 and below the eaves.',
      );
    }
    const resolution = resolveLevel(doc, getBuilding(doc), params.levelId);
    if (!resolution.ok)
      return noChange(doc, `add_portal_frame_building failed: ${resolution.reason}.`);
    const levelId = resolution.level.id;

    const bays = Math.max(1, Math.round(hallLength / targetBay));
    const bay = hallLength / bays;
    const pitch = (pitchDegrees * Math.PI) / 180;
    const estimatedMembers =
      bays *
      (6 * spanCount +
        2 * spanCount * (Math.ceil(span / 2 / Math.cos(pitch) / purlinSpacing) + 1) +
        2 * Math.ceil(eave / railSpacing));
    if (estimatedMembers > MAX_GENERATED_MEMBERS) {
      return noChange(
        doc,
        `add_portal_frame_building failed: about ${estimatedMembers} members — over the ${MAX_GENERATED_MEMBERS} limit; increase baySpacing, purlinSpacing or railSpacing.`,
      );
    }
    const spanWidths = params.spans ?? [span];
    const columnLines = spanWidths.reduce<number[]>(
      (lines, width) => [...lines, (lines[lines.length - 1] as number) + width],
      [origin[0]],
    );
    const spanBounds = spanWidths.map((_, index): readonly [number, number] => [
      columnLines[index] as number,
      columnLines[index + 1] as number,
    ]);
    const x0 = columnLines[0] as number;
    const x1 = columnLines[columnLines.length - 1] as number;
    const totalWidth = x1 - x0;
    const ys = Array.from({ length: bays + 1 }, (_, index) => origin[1] + index * bay);
    const rise = Math.tan(pitch);
    const monopitch = roofType === 'monopitch';
    /** Roof-line height above x: monopitch rises from the low eaves at x0, duopitch peaks mid-span. */
    const roofLine = (x: number): number => {
      if (monopitch) return eave + (x - x0) * rise;
      const [a, b] =
        spanBounds.find(([from, to]) => x >= from && x <= to) ??
        (x < x0
          ? (spanBounds[0] as readonly [number, number])
          : (spanBounds[spanBounds.length - 1] as readonly [number, number]));
      return eave + Math.min(x - a, b - x) * rise;
    };
    /** Column height at a column line (the eaves). */
    const columnTop = (x: number): number => (monopitch ? roofLine(x) : eave);
    /** Roof slopes of a span, each from its low end (at a column line) up to its high end. */
    const slopesOf = (bounds: readonly [number, number]): Slope[] => {
      const [a, b] = bounds;
      if (monopitch) {
        return [{ side: -1, lowX: a, lowZ: roofLine(a), highX: b, highZ: roofLine(b) }];
      }
      const middle = (a + b) / 2;
      const peak = eave + ((b - a) / 2) * rise;
      return [
        { side: -1, lowX: a, lowZ: eave, highX: middle, highZ: peak },
        { side: 1, lowX: b, lowZ: eave, highX: middle, highZ: peak },
      ];
    };
    const ridge = Math.max(
      ...spanBounds.flatMap((bounds) => slopesOf(bounds).map((slope) => slope.highZ)),
    );
    const y0 = ys[0] as number;
    const yEnd = ys[ys.length - 1] as number;
    const h = (profile: SteelProfile): number => mm(profile.h);
    const specs: MemberSpec[] = [];

    // Portal frames: columns on every column line, the rafters of every roof slope per span.
    for (const y of ys) {
      for (const x of columnLines) {
        specs.push({
          role: 'column',
          profile: p.column.name,
          start: [x, y, 0],
          end: [x, y, columnTop(x)],
        });
      }
      for (const bounds of spanBounds) {
        for (const slope of slopesOf(bounds)) {
          specs.push({
            role: 'rafter',
            profile: p.rafter.name,
            start: [slope.lowX, y, slope.lowZ],
            end: [slope.highX, y, slope.highZ],
          });
        }
      }
    }
    // Gable wind posts at both ends (≈ 6 m centres per span), up to the rafter underside.
    for (const [a, b] of spanBounds) {
      const posts = Math.max(0, Math.ceil((b - a) / mm(6000)) - 1);
      for (const y of [y0, yEnd]) {
        for (let index = 1; index <= posts; index++) {
          const x = a + ((b - a) * index) / (posts + 1);
          const roofZ = roofLine(x) - h(p.rafter) / 2 / Math.cos(pitch);
          // Wind posts span out of the gable plane: strong axis along Y.
          specs.push({
            role: 'column',
            profile: p.gable.name,
            start: [x, y, 0],
            end: [x, y, roofZ],
            roll: Math.PI / 2,
          });
        }
      }
    }
    // Purlins on every slope of every span, one per bay.
    const lift = h(p.rafter) / 2 + h(p.purlin) / 2;
    for (const bounds of spanBounds) {
      for (const { side, lowX, lowZ, highX } of slopesOf(bounds)) {
        const slopeLength = Math.abs(highX - lowX) / Math.cos(pitch);
        const purlinCount = Math.max(1, Math.ceil(slopeLength / purlinSpacing));
        for (let index = 0; index <= purlinCount; index++) {
          const t = (index * slopeLength) / purlinCount;
          const x = lowX - side * t * Math.cos(pitch) + side * lift * Math.sin(pitch);
          const z = lowZ + t * Math.sin(pitch) + lift * Math.cos(pitch);
          for (let j = 0; j < bays; j++) {
            specs.push({
              role: 'purlin',
              profile: p.purlin.name,
              start: [x, ys[j] as number, z],
              end: [x, ys[j + 1] as number, z],
              roll: side === -1 ? pitch : -pitch,
            });
          }
        }
      }
    }
    // Side rails, outboard of the outer columns, up to the eaves of their own column line.
    const railOffset = h(p.column) / 2 + h(p.rail) / 2;
    const railSides = [
      [x0 - railOffset, Math.PI / 2, columnTop(x0)],
      [x1 + railOffset, -Math.PI / 2, columnTop(x1)],
    ] as const;
    const railTop = Math.max(...railSides.map(([, , top]) => top));
    for (let z = railSpacing; z < railTop - railSpacing / 3; z += railSpacing) {
      for (const [x, roll, top] of railSides) {
        if (z >= top - railSpacing / 3) continue;
        for (let j = 0; j < bays; j++) {
          specs.push({
            role: 'rail',
            profile: p.rail.name,
            start: [x, ys[j] as number, z],
            end: [x, ys[j + 1] as number, z],
            roll,
          });
        }
      }
    }
    // X-bracing in the end bays: every roof slope and both outer walls.
    const endBays = bays >= 3 ? [0, bays - 1] : [0];
    for (const j of endBays) {
      const [ya, yb] = [ys[j] as number, ys[j + 1] as number];
      for (const bounds of spanBounds) {
        for (const { lowX, lowZ, highX, highZ } of slopesOf(bounds)) {
          specs.push(
            {
              role: 'brace',
              profile: p.brace.name,
              start: [lowX, ya, lowZ],
              end: [highX, yb, highZ],
            },
            {
              role: 'brace',
              profile: p.brace.name,
              start: [lowX, yb, lowZ],
              end: [highX, ya, highZ],
            },
          );
        }
      }
      for (const fromX of [x0, x1]) {
        const top = columnTop(fromX);
        specs.push(
          { role: 'brace', profile: p.brace.name, start: [fromX, ya, 0], end: [fromX, yb, top] },
          { role: 'brace', profile: p.brace.name, start: [fromX, yb, 0], end: [fromX, ya, top] },
        );
      }
    }
    const ids: string[] = [];
    // Structural grid: column lines (letters) along the hall, frame lines (numbers) across it.
    let building = resolution.building;
    const used = new Set(gridLabels(building));
    const overrun = mm(1500);
    for (const x of columnLines) {
      const label = nextFreeLabel(used, false);
      used.add(label);
      building = addGrid(building, label, [x, y0 - overrun], [x, yEnd + overrun]);
      ids.push(building.elementOrder[building.elementOrder.length - 1] as string);
    }
    for (const y of ys) {
      const label = nextFreeLabel(used, true);
      used.add(label);
      building = addGrid(building, label, [x0 - overrun, y], [x1 + overrun, y]);
      ids.push(building.elementOrder[building.elementOrder.length - 1] as string);
    }
    const membersAdded = appendMembers(building, levelId, specs);
    if ('reason' in membersAdded)
      return noChange(doc, `add_portal_frame_building failed: ${membersAdded.reason}.`);
    building = membersAdded.building;
    ids.push(...membersAdded.ids);
    if (params.connections !== false) {
      const connections = appendConnections(
        doc,
        building,
        levelId,
        findMomentJoints(building, levelId, new Set(membersAdded.ids), mm(10)),
        {},
      );
      building = connections.building;
      ids.push(...connections.ids);
    }
    if (params.basePlates !== false) {
      const unplated = columnsWithoutPlates(building, null, new Set(membersAdded.ids));
      // Fixed bases apply to frame columns only: gable wind posts (rolled about the vertical axis) stay pinned.
      const groups =
        columnBase === 'fixed'
          ? ([
              [unplated.filter((column) => column.roll === 0), 'fixed'],
              [unplated.filter((column) => column.roll !== 0), 'pinned'],
            ] as const)
          : ([[unplated, 'pinned']] as const);
      for (const [columns, fixity] of groups) {
        const plates = appendBasePlates(doc, building, columns, { fixity });
        building = plates.building;
        ids.push(...plates.ids);
      }
    }
    // Crane runway on both sides, inboard of the columns.
    if (params.crane) {
      const craneProfile = findProfile(params.crane.profile ?? 'HEB300');
      const bracket = findProfile('HEB200') as SteelProfile;
      if (!craneProfile)
        return noChange(
          doc,
          `add_portal_frame_building failed: unknown crane profile '${params.crane.profile ?? ''}'.`,
        );
      const inset = h(p.column) / 2 + mm(500);
      const runway: MemberSpec[] = [];
      for (const x of spanBounds.flatMap(([a, b]) => [a + inset, b - inset])) {
        runway.push(
          ...runwayMembers(doc, building, levelId, {
            start: [x, y0],
            end: [x, yEnd],
            railHeight: params.crane.railHeight,
            profile: craneProfile,
            supports: ys.map((y) => y - y0),
            bracket,
            note: `Crane ${params.crane.capacity ?? 10} t, rail top ${params.crane.railHeight}`,
          }),
        );
      }
      const craneAdded = appendMembers(building, levelId, runway);
      if ('reason' in craneAdded)
        return noChange(doc, `add_portal_frame_building failed: ${craneAdded.reason}.`);
      building = craneAdded.building;
      ids.push(...craneAdded.ids);
    }
    if (params.footings !== false) {
      const footings = appendFootings(
        doc,
        building,
        levelId,
        withoutFootings(
          building,
          levelId,
          columnFeet(building, levelId, mm(10), new Set(membersAdded.ids)),
          mm(10),
        ),
        {},
      );
      building = footings.building;
      ids.push(...footings.ids);
    }
    if (params.floorSlab !== false) {
      const inner = h(p.column) / 2;
      const slab: SlabElement = {
        id: nextElementId(building, 'slab'),
        category: 'slab',
        mark: nextMark(building, 'slab'),
        entityIds: [],
        levelId,
        boundary: [
          [x0 - inner, y0 - inner],
          [x1 + inner, y0 - inner],
          [x1 + inner, yEnd + inner],
          [x0 - inner, yEnd + inner],
        ],
        thickness: mm(200),
        offset: 0,
        role: 'floor',
        material: 'concrete',
      };
      building = withElement(building, slab);
      ids.push(slab.id);
    }
    if (params.cladding !== false) {
      const wallX0 = x0 - railOffset - h(p.rail) / 2;
      const wallX1 = x1 + railOffset + h(p.rail) / 2;
      const roofLift = h(p.rafter) / 2 + h(p.purlin);
      const roofZ = (x: number): number => roofLine(x) + roofLift / Math.cos(pitch);
      const edge = mm(200);
      const [ya, yb] = [y0 - edge, yEnd + edge];
      const panels: Array<{ corners: Vec3[]; role: 'roof' | 'wall'; outward: Vec3 }> = [];
      const profileLine: Vec2[] = [];
      spanBounds.forEach(([a, b], index) => {
        const left = index === 0 ? wallX0 : a;
        const right = index === spanBounds.length - 1 ? wallX1 : b;
        const breaks = monopitch ? [left, right] : [left, (a + b) / 2, right];
        profileLine.push(...breaks.slice(0, -1).map((x): Vec2 => [x, roofZ(x)]));
        if (index === spanBounds.length - 1) profileLine.push([right, roofZ(right)]);
        breaks.slice(1).forEach((to, panel) => {
          const from = breaks[panel] as number;
          const rising = monopitch ? roofZ(to) >= roofZ(from) : panel === 0;
          panels.push({
            role: 'roof',
            outward: [rising ? -Math.sin(pitch) : Math.sin(pitch), 0, Math.cos(pitch)],
            corners: [
              [from, ya, roofZ(from)],
              [from, yb, roofZ(from)],
              [to, yb, roofZ(to)],
              [to, ya, roofZ(to)],
            ],
          });
        });
      });
      for (const [x, outward] of [
        [wallX0, -1],
        [wallX1, 1],
      ] as const) {
        panels.push({
          role: 'wall',
          outward: [outward, 0, 0],
          corners: [
            [x, ya, 0],
            [x, yb, 0],
            [x, yb, roofZ(x)],
            [x, ya, roofZ(x)],
          ],
        });
      }
      for (const [y, outward] of [
        [ya, -1],
        [yb, 1],
      ] as const) {
        panels.push({
          role: 'wall',
          outward: [0, outward, 0],
          corners: [
            [wallX0, y, 0],
            [wallX1, y, 0],
            ...[...profileLine].reverse().map(([x, z]): Vec3 => [x, y, z]),
          ],
        });
      }
      for (const panel of panels) {
        const added = appendPanel(doc, building, levelId, {
          role: panel.role,
          corners: facing(panel.corners, panel.outward),
          material: 'sandwich-panel',
        });
        if (added) {
          building = added.building;
          ids.push(added.id);
        }
      }
    }
    const document = regenerateBuilding(doc, building);
    const tonnes = steelMass(doc, building, ids) / 1000;
    const memberCount = ids.filter((id) => id.startsWith('member-')).length;
    const gridCount = ids.filter((id) => id.startsWith('grid-')).length;
    return {
      document,
      summary:
        `Added portal-frame hall ${toMetres(doc, totalWidth).toFixed(1)} × ${toMetres(doc, hallLength).toFixed(1)} m` +
        `${spanWidths.length > 1 ? ` (${spanWidths.length} spans)` : ''}, ` +
        `${bays + 1} frames at ${toMetres(doc, bay).toFixed(2)} m, eaves ${toMetres(doc, eave).toFixed(2)} m, ${monopitch ? 'high eaves' : 'ridge'} ${toMetres(doc, ridge).toFixed(2)} m: ` +
        `${memberCount} steel members (${tonnes.toFixed(1)} t)` +
        `${monopitch ? ', monopitch roof' : ''}${columnBase === 'fixed' ? ', fixed column bases' : ''}` +
        `${params.crane ? `, crane runway ${params.crane.capacity ?? 10} t` : ''}, ${gridCount} grid lines, ${ids.length - memberCount - gridCount} other element(s).`,
      affected: elementAffected(document, ids),
      data: {
        elementIds: ids,
        steelTonnes: tonnes,
        frames: bays + 1,
        baySpacing: bay,
        spans: spanWidths.length,
      },
    };
  },
};

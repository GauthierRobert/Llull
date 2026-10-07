/**
 * Pre-engineered steel hall generator (portal frames) and crane runways.
 * @layer domain-aec
 */
import type { CadDocument, Vec2 } from '@core/model/types';
import type { BuildingModel, SlabElement } from '@core/model/building';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, vec2, z } from '@core/commands/schema';
import {
  elementAffected,
  fromMm,
  getBuilding,
  nextElementId,
  nextMark,
  resolveLevel,
  toMetres,
  withElement,
} from '../model';
import { noop } from '@core/commands/noop';
import { regenerateBuilding } from '../evaluateElements';
import { findProfile, type SteelProfile } from '../steel/profiles';
import { appendMembers, type MemberSpec } from './memberSupport';
import {
  appendFootings,
  appendPanel,
  columnFeet,
  MAX_GENERATED_MEMBERS,
  withoutFootings,
} from './footingPanelSupport';
import { portalInputs } from './portalInputs';
import { buildHallGeometry } from './portalGeometry';
import { portalFrameParams } from './portalParams';
import { hallMemberSpecs } from './portalMembers';
import { claddingPanels, facing } from './portalCladding';
import { appendBasePlates, columnsWithoutPlates } from './plateSupport';
import { appendConnections, findMomentJoints } from './connectionSupport';
import { memberMass } from '../takeoffCompute';
import { addGrid, gridLabels, nextFreeLabel } from '../grid';
import { levelIdParam } from '../levelParams';

/** Steel mass of members created by a generator, kg. */
function steelMass(doc: CadDocument, building: BuildingModel, ids: ReadonlyArray<string>): number {
  return ids.reduce((sum, id) => {
    const element = building.elements[id];
    return element?.category === 'member' ? sum + memberMass(doc, element) : sum;
  }, 0);
}

/**
 * @command add_crane_runway
 * @pure
 * @affects creates runway beam segments + brackets to nearby steel columns
 * @failure bad points / railHeight <= 0 / unknown profile -> no-op
 */
export const addCraneRunway = defineCommand({
  name: 'add_crane_runway',
  description:
    'Add an overhead-crane runway: crane beams along a plan line with their top at railHeight, split at ' +
    'supports every supportSpacing, each support carried by a bracket cantilevered from the nearest steel ' +
    'column (within 2 m). Capacity (t) is noted on the members for schedules.',
  params: z.object({
    start: vec2('Runway start [x, y].'),
    end: vec2('Runway end [x, y].'),
    railHeight: z.number().describe('Top of the runway beam above the level (> 0).'),
    profile: z.string().optional().describe('Runway beam section. Default HEB300.'),
    capacity: z.number().optional().describe('Crane capacity in tonnes (for notes). Default 10.'),
    supportSpacing: z.number().optional().describe('Distance between supports. Default 6000 mm.'),
    bracketProfile: z.string().optional().describe('Bracket section. Default HEB200.'),
    levelId: levelIdParam,
  }),
  run: (doc, params): CommandResult => {
    const length = Math.hypot(params.end[0] - params.start[0], params.end[1] - params.start[1]);
    const spacing = params.supportSpacing ?? fromMm(doc, 6000);
    if (!(length > 0) || !(params.railHeight > 0) || !(spacing > 0)) {
      return noop(
        doc,
        'add_crane_runway failed: distinct points, railHeight > 0 and supportSpacing > 0 required.',
      );
    }
    const profile = findProfile(params.profile ?? 'HEB300');
    const bracket = findProfile(params.bracketProfile ?? 'HEB200');
    if (!profile || !bracket) return noop(doc, 'add_crane_runway failed: unknown steel profile.');
    if (params.railHeight <= fromMm(doc, profile.h + bracket.h)) {
      return noop(
        doc,
        `add_crane_runway failed: railHeight must exceed the runway beam + bracket depth (${profile.h + bracket.h} mm).`,
      );
    }
    if (length / spacing > MAX_GENERATED_MEMBERS) {
      return noop(
        doc,
        `add_crane_runway failed: supportSpacing too small (over ${MAX_GENERATED_MEMBERS} segments).`,
      );
    }
    const resolution = resolveLevel(doc, getBuilding(doc), params.levelId);
    if (!resolution.ok) return noop(doc, `add_crane_runway failed: ${resolution.reason}.`);
    const supports: number[] = [];
    for (let distance = spacing; distance < length; distance += spacing) supports.push(distance);
    const capacity = params.capacity ?? 10;
    const specs = runwayMembers(doc, resolution.building, resolution.level.id, {
      start: params.start,
      end: params.end,
      railHeight: params.railHeight,
      profile,
      supports,
      bracket,
      note: `Crane ${capacity} t, rail top ${params.railHeight}`,
    });
    const added = appendMembers(resolution.building, resolution.level.id, specs);
    if ('reason' in added) return noop(doc, `add_crane_runway failed: ${added.reason}.`);
    const document = regenerateBuilding(doc, added.building);
    return {
      document,
      summary: `Added crane runway (${capacity} t): ${specs.filter((spec) => spec.role === 'crane').length} beam segment(s) ${profile.name}, ${specs.filter((spec) => spec.role !== 'crane').length} bracket(s).`,
      affected: elementAffected(document, added.ids),
      data: { elementIds: added.ids },
    };
  },
});

/**
 * @command add_portal_frame_building
 * @pure
 * @affects creates a complete steel hall (members, footings, cladding, slab) — all-or-nothing
 * @failure invalid dimensions / unknown profiles / crane above eaves -> no-op
 */
export const addPortalFrameBuilding = defineCommand({
  name: 'add_portal_frame_building',
  description:
    'Generate a pre-engineered steel hall (factory / warehouse) in one step: portal frames every baySpacing ' +
    'along Y (columns + pitched rafters spanning X; several spans side by side with spans: [...]), gable posts, purlins and side rails, X-bracing in the ' +
    'end bays (roof and walls), pad footings under every column, roof / wall / gable cladding, a ground ' +
    'slab and optionally an overhead crane runway on brackets. All sizes in document units, roofPitch in ' +
    'degrees. Defaults: 24 m span, 48 m long, 6 m bays, 7 m eaves, 6° roof, HEA400 columns, IPE450 rafters.',
  params: portalFrameParams,
  run: (doc, params): CommandResult => {
    const inputs = portalInputs(doc, params);
    if ('reason' in inputs) return noop(doc, inputs.reason);
    const {
      mm,
      origin,
      span,
      spanCount,
      hallLength,
      targetBay,
      eave,
      pitchDegrees,
      purlinSpacing,
      railSpacing,
      roofType,
      columnBase,
      profiles: p,
    } = inputs;
    const resolution = resolveLevel(doc, getBuilding(doc), params.levelId);
    if (!resolution.ok) return noop(doc, `add_portal_frame_building failed: ${resolution.reason}.`);
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
      return noop(
        doc,
        `add_portal_frame_building failed: about ${estimatedMembers} members — over the ${MAX_GENERATED_MEMBERS} limit; increase baySpacing, purlinSpacing or railSpacing.`,
      );
    }
    const spanWidths = params.spans ?? [span];
    const geometry = buildHallGeometry({
      originX: origin[0],
      originY: origin[1],
      spanWidths,
      bays,
      bay,
      pitch,
      eave,
      monopitch: roofType === 'monopitch',
      mm,
    });
    const { columnLines, spanBounds, x0, x1, totalWidth, ys, y0, yEnd, ridge, monopitch, h } =
      geometry;
    const specs = hallMemberSpecs({ geometry, profiles: p, purlinSpacing, railSpacing });
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
      return noop(doc, `add_portal_frame_building failed: ${membersAdded.reason}.`);
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
        return noop(
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
        return noop(doc, `add_portal_frame_building failed: ${craneAdded.reason}.`);
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
      for (const panel of claddingPanels(geometry, p)) {
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
});

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

/** Clash detection between structure, equipment and pipes (oriented-box separating-axis test). */

import { clamp01 } from '@lib/clamp';
import type { CadDocument, Vec3 } from '@core/model/types';
import type { BimCategory, BuildingElement, BuildingModel } from '@aec/building/types';
import type { CommandResult } from '@core/commands/types';
import { unknownLevelFailure } from '../../building/levelLookup';
import { defineCommand, z } from '@core/commands/schema';
import { fromMm, toMm } from '@core/model/units';
import { getBuilding } from '../../building/model';
import { noop, report } from '@core/commands/noop';
import { dot3, scale3, sub3 } from '@lib/vec3';
import { atLevel } from '../evaluate';
import { briefList } from '../../shared/briefList';
import { type OrientedBox, boxOverlap, elementBoxes } from './clashBoxes';
import { externalClashes } from './clashPlant';
import { externalBodies } from './clashSources';
import { STAIR_HEADROOM_MM, slabPenetrations, stairPenetrations } from './clashSlabs';
import { columnsInOpening } from '../../building/geometry/openingColumns';

const CLEARANCE_OBSTACLES: ReadonlySet<BimCategory> = new Set(['equipment', 'member', 'column', 'wall', 'curvedWall', 'stair']);

type Solid = { readonly elementId: string; readonly category: BimCategory; readonly box: OrientedBox };

const STAIR_OBSTACLES: ReadonlySet<BimCategory> = new Set(['beam', 'column', 'wall', 'curvedWall']);

/**
 * Category pairs that are checked: anything involving services / equipment, a steel member against concrete, and a stair against
 * concrete structure (beam / column / wall). Other structure–structure joints are intentional and skipped; a beam against a wall is
 * decided per pair in `connected`.
 */
function relevant(a: BimCategory, b: BimCategory): boolean {
  const active = (category: BimCategory): boolean =>
    category === 'pipe' || category === 'tray' || category === 'equipment' || category === 'pipeSupport';
  if (a === 'pipeSupport' && b === 'pipeSupport') return false;
  if (active(a) || active(b)) return true;
  if ((a === 'stair' && STAIR_OBSTACLES.has(b)) || (b === 'stair' && STAIR_OBSTACLES.has(a))) return true;
  if ((a === 'beam' && (b === 'wall' || b === 'curvedWall')) || (b === 'beam' && (a === 'wall' || a === 'curvedWall'))) return true;
  return (a === 'member') !== (b === 'member');
}

export interface Clash {
  readonly a: string;
  readonly b: string;
  /** `insulation`: a pipe's insulation envelope (OD + 2 x thickness) penetrates a body that its bare pipe clears. */
  readonly kind: 'hard' | 'clearance' | 'insulation';
  /** Penetration depth in document units. */
  readonly depth: number;
}

/** World-space centreline of a pipe or cable tray (empty when its level is missing). */
function pipeWorldPoints(building: BuildingModel, pipe: BuildingElement): Vec3[] {
  if (pipe.category !== 'pipe' && pipe.category !== 'tray') return [];
  const level = building.levels[pipe.levelId];
  return level ? pipe.points.map((point) => atLevel(level, point)) : [];
}

function pipeEnds(points: ReadonlyArray<Vec3>): Vec3[] {
  const [first, last] = [points[0], points[points.length - 1]];
  return first && last ? [first, last] : [];
}

function pointInBox(point: Vec3, box: OrientedBox, margin: number): boolean {
  const offset = sub3(point, box.center);
  return box.axes.every((axis, index) => Math.abs(dot3(offset, axis)) <= (box.half[index] as number) + margin);
}

function distanceToPolyline(point: Vec3, polyline: ReadonlyArray<Vec3>): number {
  let best = Infinity;
  for (let index = 0; index + 1 < polyline.length; index++) {
    const [a, b] = [polyline[index] as Vec3, polyline[index + 1] as Vec3];
    const ab = sub3(b, a);
    const ap = sub3(point, a);
    const t = clamp01(dot3(ap, ab) / (dot3(ab, ab) || 1));
    best = Math.min(best, Math.hypot(...sub3(ap, scale3(ab, t))));
  }
  return best;
}

/** A pipe support touches its own pipe and the steel it bears on by design. */
function bearsOn(support: BuildingElement, other: BuildingElement): boolean {
  return support.category === 'pipeSupport' && (support.pipeId === other.id || support.memberId === other.id);
}

/** Intentional connections: a pipe ending on another pipe (tee / joint) or inside equipment, a support on its pipe / steel. */
function connected(
  doc: CadDocument,
  building: BuildingModel,
  a: BuildingElement,
  b: BuildingElement,
  boxA: OrientedBox,
  boxB: OrientedBox,
): boolean {
  if (bearsOn(a, b) || bearsOn(b, a)) return true;
  const runSize = (run: BuildingElement): number => (run.category === 'pipe' ? run.diameter : run.category === 'tray' ? run.width : 0);
  if (a.category === b.category && (a.category === 'pipe' || a.category === 'tray')) {
    const [pointsA, pointsB] = [pipeWorldPoints(building, a), pipeWorldPoints(building, b)];
    const tolerance = Math.max(runSize(a), runSize(b));
    return (
      pipeEnds(pointsA).some((point) => distanceToPolyline(point, pointsB) <= tolerance) ||
      pipeEnds(pointsB).some((point) => distanceToPolyline(point, pointsA) <= tolerance)
    );
  }
  const margin = fromMm(doc, 1);
  const framesInto = (beam: BuildingElement, other: BuildingElement, beamBox: OrientedBox, box: OrientedBox): boolean =>
    beam.category === 'beam' &&
    (other.category === 'wall' || other.category === 'curvedWall') &&
    [beam.start, beam.end].some((end) => pointInBox([end[0], end[1], beamBox.center[2]], box, margin));
  if (framesInto(a, b, boxA, boxB) || framesInto(b, a, boxB, boxA)) return true;
  const endsIn = (pipe: BuildingElement, other: BuildingElement, box: OrientedBox): boolean =>
    pipe.category === 'pipe' &&
    other.category === 'equipment' &&
    pipeEnds(pipeWorldPoints(building, pipe)).some((point) => pointInBox(point, box, margin));
  return endsIn(a, b, boxB) || endsIn(b, a, boxA);
}

/** Whole mm from 1 mm up; two decimals below, so a sub-millimetre penetration never reads "0 mm". */
function formatDepthMm(depthMm: number): string {
  return depthMm >= 1 ? String(Math.round(depthMm)) : depthMm.toFixed(2);
}

/** All clashes on the given levels (or every level). @pure */
function findClashes(doc: CadDocument, levelIds: ReadonlySet<string> | null, tolerance: number): Clash[] {
  const building = getBuilding(doc);
  const solids: Solid[] = [];
  for (const element of Object.values(building.elements)) {
    if (levelIds && !('levelId' in element && levelIds.has(element.levelId))) continue;
    for (const box of elementBoxes(doc, building, element)) solids.push({ elementId: element.id, category: element.category, box });
  }
  const found = new Map<string, Clash>();
  const record = (clash: Clash): void => {
    const key = `${clash.kind}:${[clash.a, clash.b].sort().join(':')}`;
    const existing = found.get(key);
    if (!existing || existing.depth < clash.depth) found.set(key, clash);
  };
  for (let i = 0; i < solids.length; i++) {
    for (let j = i + 1; j < solids.length; j++) {
      const [first, second] = [solids[i] as Solid, solids[j] as Solid];
      if (first.elementId === second.elementId || !relevant(first.category, second.category)) continue;
      const [a, b] = [building.elements[first.elementId] as BuildingElement, building.elements[second.elementId] as BuildingElement];
      if (connected(doc, building, a, b, first.box, second.box)) continue;
      const depth = boxOverlap(first.box, second.box);
      const [low, high] = first.elementId < second.elementId ? [first, second] : [second, first];
      if (depth > tolerance) record({ a: low.elementId, b: high.elementId, kind: 'hard', depth });
    }
  }
  for (const clash of externalClashes(externalBodies(doc), solids, tolerance)) record(clash);
  const inScope = (levelId: string): boolean => levelIds === null || levelIds.has(levelId);
  const penetrations = [
    ...slabPenetrations(building, inScope, tolerance),
    ...stairPenetrations(building, inScope, fromMm(doc, STAIR_HEADROOM_MM), tolerance),
  ];
  for (const penetration of penetrations) {
    const [a, b] = [penetration.elementId, penetration.slabId].sort() as [string, string];
    record({ a, b, kind: 'hard', depth: penetration.depth });
  }
  for (const opening of Object.values(building.elements)) {
    if (opening.category !== 'door' && opening.category !== 'window') continue;
    const wall = building.elements[opening.hostId];
    if (wall?.category !== 'wall' || !inScope(wall.levelId)) continue;
    for (const { column, depth } of columnsInOpening(building, wall, opening, tolerance)) {
      const [a, b] = [opening.id, column.id].sort() as [string, string];
      record({ a, b, kind: 'hard', depth });
    }
  }
  for (const solid of solids) {
    const equipment = building.elements[solid.elementId];
    if (equipment?.category !== 'equipment' || equipment.clearance <= 0) continue;
    const zone: OrientedBox = {
      ...solid.box,
      half: [solid.box.half[0] + equipment.clearance, solid.box.half[1] + equipment.clearance, solid.box.half[2]],
    };
    for (const other of solids) {
      if (other.elementId === solid.elementId || !CLEARANCE_OBSTACLES.has(other.category)) continue;
      const depth = boxOverlap(zone, other.box);
      if (depth > tolerance && !found.has(`hard:${[solid.elementId, other.elementId].sort().join(':')}`)) {
        record({ a: solid.elementId, b: other.elementId, kind: 'clearance', depth });
      }
    }
  }
  const rank = { hard: 0, insulation: 1, clearance: 2 } as const;
  return [...found.values()].sort((x, y) => (x.kind === y.kind ? y.depth - x.depth : rank[x.kind] - rank[y.kind]));
}

/**
 * @affects none; data = { clashes: Clash[] }
 * @failure unknown level / negative tolerance -> no data
 */
export const checkClashes = defineCommand({
  name: 'check_clashes',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Read-only clash detection (like Navisworks / Plant 3D): hard clashes between pipes, cable trays, equipment, steel members, walls, ' +
    'concrete columns, beams and stairs (a beam or column through a stair flight, a beam crossing a wall it does not frame into), equipment passing through a floor / grating that has no opening around it (add_slab_opening), ' +
    'a stair whose headroom (2 m above its treads) runs into a slab without a well (add_slab_opening stairId), a door / window opening ' +
    'that overlaps a column in its wall line, ' +
    'plus equipment maintenance-clearance violations. Steel-to-steel joints, a beam ending in the wall or column it frames into, run connections (a pipe end inside equipment, a pipe / tray ' +
    'ending on another) and a pipe support touching its own pipe and the steel it bears on are not reported. Spec-driven pipe runs (route_pipe) ' +
    'take part with their pipe pieces and elbows (valves, flanges and tees are not modelled yet; boxes of the pipe outside diameter): a hit is a ' +
    'hard clash with the part id, e.g. "run-4/pipe-2"; the insulation of an insulated line (create_pipeline insulation, OD + 2 x thickness) is ' +
    'checked too and a hit that the bare pipe clears is kind "insulation"; a run is not checked against the runs attached to it or the equipment ' +
    'its nozzles sit on. Returns element ids, kind ("hard", "insulation" or "clearance") and penetration depth (document units; summary in mm).',
  params: z.object({
    levelId: z.string().optional().describe('Only this level. Default: the whole building.'),
    tolerance: z.number().optional().describe('Ignore penetrations up to this depth, in document units (>= 0). Default 5 mm.'),
  }),
  run: (doc, { levelId, tolerance }): CommandResult => {
    const building = getBuilding(doc);
    const unknownLevel = unknownLevelFailure(doc, 'check_clashes', levelId);
    if (unknownLevel) return unknownLevel;
    const resolvedTolerance = tolerance ?? fromMm(doc, 5);
    if (!(resolvedTolerance >= 0)) return noop(doc, 'check_clashes failed: tolerance must be >= 0.');
    const clashes = findClashes(doc, levelId !== undefined ? new Set([levelId]) : null, resolvedTolerance);
    const describe = (clash: Clash): string => {
      const [a, b] = [building.elements[clash.a], building.elements[clash.b]];
      return `${clash.kind} ${a?.mark ?? clash.a} × ${b?.mark ?? clash.b} (${formatDepthMm(toMm(doc, clash.depth))} mm)`;
    };
    const count = (kind: Clash['kind']): number => clashes.filter((clash) => clash.kind === kind).length;
    return report(
      doc,
      clashes.length === 0
        ? 'No clashes found.'
        : `${count('hard')} hard clash(es), ${count('insulation') === 0 ? '' : `${count('insulation')} insulation clash(es), `}${count('clearance')} clearance violation(s): ${briefList(clashes, describe, 10, '; ')}.`,
      { clashes },
    );
  },
});

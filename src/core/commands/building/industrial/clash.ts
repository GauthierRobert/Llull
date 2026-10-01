/**
 * Clash detection between structure, equipment and pipes (oriented-box separating-axis test).
 * @layer core/commands/building/industrial
 */

import type { CadDocument, Vec3 } from '../../../model/types';
import type { BimCategory, BuildingElement, BuildingModel } from '../../../model/building';
import type { CommandDefinition, CommandResult } from '../../types';
import { fromMm, getBuilding, isFiniteNumber, noChange, toMetres } from '../model';
import { sweepFrame } from '../mesh';
import { findProfile } from '../steel/profiles';
import { atLevel } from './evaluate';

/** Oriented box: centre, orthonormal axes and half sizes along them. */
export interface OrientedBox {
  readonly center: Vec3;
  readonly axes: readonly [Vec3, Vec3, Vec3];
  readonly half: Vec3;
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/**
 * Penetration depth of two oriented boxes along their best separating axis (≤ 0 when apart).
 * @pure
 */
export function boxOverlap(a: OrientedBox, b: OrientedBox): number {
  const axes: Vec3[] = [...a.axes, ...b.axes];
  for (const u of a.axes)
    for (const v of b.axes) {
      const axis = cross(u, v);
      const length = Math.hypot(...axis);
      if (length > 1e-9) axes.push([axis[0] / length, axis[1] / length, axis[2] / length]);
    }
  const delta: Vec3 = [
    b.center[0] - a.center[0],
    b.center[1] - a.center[1],
    b.center[2] - a.center[2],
  ];
  const radius = (box: OrientedBox, axis: Vec3): number =>
    box.half[0] * Math.abs(dot(box.axes[0], axis)) +
    box.half[1] * Math.abs(dot(box.axes[1], axis)) +
    box.half[2] * Math.abs(dot(box.axes[2], axis));
  let depth = Infinity;
  for (const axis of axes) {
    const overlap = radius(a, axis) + radius(b, axis) - Math.abs(dot(delta, axis));
    if (overlap <= 0) return overlap;
    depth = Math.min(depth, overlap);
  }
  return depth;
}

function zRotated(angle: number): readonly [Vec3, Vec3, Vec3] {
  const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
  return [
    [cos, sin, 0],
    [-sin, cos, 0],
    [0, 0, 1],
  ];
}

interface Solid {
  readonly elementId: string;
  readonly category: BimCategory;
  readonly box: OrientedBox;
}

/** Oriented boxes of an element's solid parts (empty for categories not checked). */
export function elementBoxes(
  doc: CadDocument,
  building: BuildingModel,
  element: BuildingElement,
): OrientedBox[] {
  const level = 'levelId' in element ? building.levels[element.levelId] : undefined;
  switch (element.category) {
    case 'member': {
      const profile = findProfile(element.profile);
      if (!level || !profile) return [];
      const [start, end] = [atLevel(level, element.start), atLevel(level, element.end)];
      const frame = sweepFrame(start, end, element.roll);
      if (!frame) return [];
      return [
        {
          center: [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2, (start[2] + end[2]) / 2],
          axes: [frame.u, frame.v, frame.d],
          half: [fromMm(doc, profile.b) / 2, fromMm(doc, profile.h) / 2, frame.length / 2],
        },
      ];
    }
    case 'pipe': {
      if (!level) return [];
      const boxes: OrientedBox[] = [];
      for (let index = 0; index + 1 < element.points.length; index++) {
        const start = atLevel(level, element.points[index] as Vec3);
        const end = atLevel(level, element.points[index + 1] as Vec3);
        const frame = sweepFrame(start, end);
        if (!frame) continue;
        boxes.push({
          center: [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2, (start[2] + end[2]) / 2],
          axes: [frame.u, frame.v, frame.d],
          half: [element.diameter / 2, element.diameter / 2, frame.length / 2],
        });
      }
      return boxes;
    }
    case 'equipment': {
      if (!level) return [];
      const [length, width, height] = element.size;
      return [
        {
          center: [element.location[0], element.location[1], level.elevation + height / 2],
          axes: zRotated(element.angle),
          half: [length / 2, width / 2, height / 2],
        },
      ];
    }
    case 'wall':
    case 'column':
    case 'beam':
    case 'stair':
      return element.entityIds.flatMap((id) => {
        const entity = doc.entities[id];
        if (entity?.kind === 'box') {
          return [
            {
              center: entity.position,
              axes: zRotated(entity.rotation[2]),
              half: [entity.size[0] / 2, entity.size[1] / 2, entity.size[2] / 2] as Vec3,
            },
          ];
        }
        if (entity?.kind === 'cylinder') {
          return [
            {
              center: entity.position,
              axes: zRotated(0),
              half: [entity.radius, entity.radius, entity.height / 2] as Vec3,
            },
          ];
        }
        return [];
      });
    default:
      return [];
  }
}

/** Category pairs that are checked (structure–structure joints are intentional and skipped). */
function relevant(a: BimCategory, b: BimCategory): boolean {
  const active = (category: BimCategory): boolean =>
    category === 'pipe' || category === 'equipment';
  if (active(a) || active(b)) return true;
  return (a === 'member') !== (b === 'member');
}

export interface Clash {
  readonly a: string;
  readonly b: string;
  readonly kind: 'hard' | 'clearance';
  /** Penetration depth in document units. */
  readonly depth: number;
}

/** World-space centreline of a pipe (empty when its level is missing). */
function pipeWorldPoints(building: BuildingModel, pipe: BuildingElement): Vec3[] {
  if (pipe.category !== 'pipe') return [];
  const level = building.levels[pipe.levelId];
  return level ? pipe.points.map((point) => atLevel(level, point)) : [];
}

function pipeEnds(points: ReadonlyArray<Vec3>): Vec3[] {
  const [first, last] = [points[0], points[points.length - 1]];
  return first && last ? [first, last] : [];
}

function pointInBox(point: Vec3, box: OrientedBox, margin: number): boolean {
  const offset: Vec3 = [
    point[0] - box.center[0],
    point[1] - box.center[1],
    point[2] - box.center[2],
  ];
  return box.axes.every(
    (axis, index) => Math.abs(dot(offset, axis)) <= (box.half[index] as number) + margin,
  );
}

function distanceToPolyline(point: Vec3, polyline: ReadonlyArray<Vec3>): number {
  let best = Infinity;
  for (let index = 0; index + 1 < polyline.length; index++) {
    const [a, b] = [polyline[index] as Vec3, polyline[index + 1] as Vec3];
    const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ap: Vec3 = [point[0] - a[0], point[1] - a[1], point[2] - a[2]];
    const t = Math.max(0, Math.min(1, dot(ap, ab) / (dot(ab, ab) || 1)));
    best = Math.min(best, Math.hypot(ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t));
  }
  return best;
}

/** Intentional connections: a pipe ending on another pipe (tee / joint) or inside equipment. */
function connected(
  doc: CadDocument,
  building: BuildingModel,
  a: BuildingElement,
  b: BuildingElement,
  boxA: OrientedBox,
  boxB: OrientedBox,
): boolean {
  if (a.category === 'pipe' && b.category === 'pipe') {
    const [pointsA, pointsB] = [pipeWorldPoints(building, a), pipeWorldPoints(building, b)];
    const tolerance = Math.max(a.diameter, b.diameter);
    return (
      pipeEnds(pointsA).some((point) => distanceToPolyline(point, pointsB) <= tolerance) ||
      pipeEnds(pointsB).some((point) => distanceToPolyline(point, pointsA) <= tolerance)
    );
  }
  const margin = fromMm(doc, 1);
  const endsIn = (pipe: BuildingElement, other: BuildingElement, box: OrientedBox): boolean =>
    pipe.category === 'pipe' &&
    other.category === 'equipment' &&
    pipeEnds(pipeWorldPoints(building, pipe)).some((point) => pointInBox(point, box, margin));
  return endsIn(a, b, boxB) || endsIn(b, a, boxA);
}

/** All clashes on the given levels (or every level). @pure */
export function findClashes(
  doc: CadDocument,
  levelIds: ReadonlySet<string> | null,
  tolerance: number,
): Clash[] {
  const building = getBuilding(doc);
  const solids: Solid[] = [];
  for (const element of Object.values(building.elements)) {
    if (levelIds && !('levelId' in element && levelIds.has(element.levelId))) continue;
    for (const box of elementBoxes(doc, building, element))
      solids.push({ elementId: element.id, category: element.category, box });
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
      if (first.elementId === second.elementId || !relevant(first.category, second.category))
        continue;
      const [a, b] = [
        building.elements[first.elementId] as BuildingElement,
        building.elements[second.elementId] as BuildingElement,
      ];
      if (connected(doc, building, a, b, first.box, second.box)) continue;
      const depth = boxOverlap(first.box, second.box);
      const [low, high] = first.elementId < second.elementId ? [first, second] : [second, first];
      if (depth > tolerance) record({ a: low.elementId, b: high.elementId, kind: 'hard', depth });
    }
  }
  for (const solid of solids) {
    const equipment = building.elements[solid.elementId];
    if (equipment?.category !== 'equipment' || equipment.clearance <= 0) continue;
    const zone: OrientedBox = {
      ...solid.box,
      half: [
        solid.box.half[0] + equipment.clearance,
        solid.box.half[1] + equipment.clearance,
        solid.box.half[2],
      ],
    };
    for (const other of solids) {
      if (other.elementId === solid.elementId || other.category === 'pipe') continue;
      if (
        other.category !== 'equipment' &&
        other.category !== 'member' &&
        other.category !== 'column' &&
        other.category !== 'wall' &&
        other.category !== 'stair'
      )
        continue;
      const depth = boxOverlap(zone, other.box);
      if (
        depth > tolerance &&
        !found.has(`hard:${[solid.elementId, other.elementId].sort().join(':')}`)
      ) {
        record({ a: solid.elementId, b: other.elementId, kind: 'clearance', depth });
      }
    }
  }
  return [...found.values()].sort((x, y) =>
    x.kind === y.kind ? y.depth - x.depth : x.kind === 'hard' ? -1 : 1,
  );
}

interface CheckClashesParams {
  levelId?: string;
  tolerance?: number;
}

/**
 * @command check_clashes
 * @pure read-only
 * @affects none; data = { clashes: Clash[] }
 * @failure unknown level / negative tolerance -> no data
 */
export const checkClashes: CommandDefinition<CheckClashesParams> = {
  name: 'check_clashes',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Read-only clash detection (like Navisworks / Plant 3D): hard clashes between pipes, equipment, steel ' +
    'members, walls, concrete columns, beams and stairs, plus equipment maintenance-clearance violations. ' +
    'Steel-to-steel joints and pipe connections (a pipe end inside equipment, or on another pipe) are not ' +
    'reported. Returns element ids, kind and penetration depth (document units; summary in mm).',
  paramsSchema: {
    type: 'object',
    properties: {
      levelId: { type: 'string', description: 'Only this level. Default: the whole building.' },
      tolerance: {
        type: 'number',
        description: 'Ignore penetrations up to this depth. Default 5 mm.',
      },
    },
    required: [],
  },
  run: (doc, { levelId, tolerance }): CommandResult => {
    const building = getBuilding(doc);
    if (levelId !== undefined && !building.levels[levelId])
      return noChange(doc, `check_clashes failed: no level '${levelId}'.`);
    const resolvedTolerance = tolerance ?? fromMm(doc, 5);
    if (!(isFiniteNumber(resolvedTolerance) && resolvedTolerance >= 0)) {
      return noChange(doc, 'check_clashes failed: tolerance must be >= 0.');
    }
    const clashes = findClashes(
      doc,
      levelId !== undefined ? new Set([levelId]) : null,
      resolvedTolerance,
    );
    const describe = (clash: Clash): string => {
      const [a, b] = [building.elements[clash.a], building.elements[clash.b]];
      return `${clash.kind} ${a?.mark ?? clash.a} × ${b?.mark ?? clash.b} (${Math.round(toMetres(doc, clash.depth) * 1000)} mm)`;
    };
    const hard = clashes.filter((clash) => clash.kind === 'hard').length;
    return {
      document: doc,
      summary:
        clashes.length === 0
          ? 'No clashes found.'
          : `${hard} hard clash(es), ${clashes.length - hard} clearance violation(s): ${clashes.slice(0, 10).map(describe).join('; ')}${clashes.length > 10 ? '; …' : ''}.`,
      affected: [],
      data: { clashes },
    };
  },
};

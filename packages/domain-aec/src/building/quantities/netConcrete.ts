/** Net (measured) concrete volumes: slab > column > beam; each solid is counted once where members overlap. */

import type { Vec2 } from '@core/model/types';
import type { BuildingElement, BuildingModel } from '@aec/building/types';
import { distance, polygonArea, toCounterClockwise } from '@lib/polygon';
import { columnSectionArea } from './takeoffBasics';
import { elementsOf } from '../model';

type Slab = Extract<BuildingElement, { category: 'slab' }>;
type Column = Extract<BuildingElement, { category: 'column' }>;
type Beam = Extract<BuildingElement, { category: 'beam' }>;
type Poly = ReadonlyArray<Vec2>;
type ZRange = readonly [bottom: number, top: number];

const CIRCLE_SEGMENTS = 32;

/** Sutherland-Hodgman: `subject` clipped by a convex counter-clockwise `clip` polygon. */
function clipConvex(subject: Poly, clip: Poly): Vec2[] {
  let output: Vec2[] = [...subject];
  for (let edge = 0; edge < clip.length && output.length > 0; edge++) {
    const [a, b] = [clip[edge] as Vec2, clip[(edge + 1) % clip.length] as Vec2];
    const side = (p: Vec2): number => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    const input = output;
    output = [];
    input.forEach((current, index) => {
      const previous = input[(index + input.length - 1) % input.length] as Vec2;
      const [sideCurrent, sidePrevious] = [side(current), side(previous)];
      if (sideCurrent >= 0 !== sidePrevious >= 0) {
        const t = sidePrevious / (sidePrevious - sideCurrent);
        output.push([previous[0] + t * (current[0] - previous[0]), previous[1] + t * (current[1] - previous[1])]);
      }
      if (sideCurrent >= 0) output.push(current);
    });
  }
  return output;
}

/** Plan area of `slab` (minus its openings) inside the intersection of the convex polygons `within`. */
function slabAreaWithin(slab: Slab, within: ReadonlyArray<Poly>): number {
  const inside = (polygon: Poly): number =>
    polygonArea(within.reduce<Poly>((subject, clip) => clipConvex(subject, toCounterClockwise(clip)), polygon));
  return (slab.openings ?? []).reduce((area, opening) => area - inside(opening), inside(slab.boundary));
}

const overlapLength = (a: ZRange, b: ZRange, ...rest: ZRange[]): number => {
  const ranges = [a, b, ...rest];
  return Math.max(0, Math.min(...ranges.map((range) => range[1])) - Math.max(...ranges.map((range) => range[0])));
};

const columnFootprint = (column: Column): Vec2[] => {
  const [x, y] = column.location;
  if (column.shape === 'circular') {
    return Array.from({ length: CIRCLE_SEGMENTS }, (_, index): Vec2 => {
      const angle = (2 * Math.PI * index) / CIRCLE_SEGMENTS;
      return [x + (column.width / 2) * Math.cos(angle), y + (column.width / 2) * Math.sin(angle)];
    });
  }
  const [hw, hd] = [column.width / 2, column.depth / 2];
  return [
    [x - hw, y - hd],
    [x + hw, y - hd],
    [x + hw, y + hd],
    [x - hw, y + hd],
  ];
};

const beamFootprint = (beam: Beam): Vec2[] => {
  const length = distance(beam.start, beam.end);
  if (length === 0) return [];
  const [nx, ny] = [
    (-(beam.end[1] - beam.start[1]) / length) * (beam.width / 2),
    ((beam.end[0] - beam.start[0]) / length) * (beam.width / 2),
  ];
  return [
    [beam.start[0] + nx, beam.start[1] + ny],
    [beam.start[0] - nx, beam.start[1] - ny],
    [beam.end[0] - nx, beam.end[1] - ny],
    [beam.end[0] + nx, beam.end[1] + ny],
  ];
};

interface NetVolumes {
  readonly column: ReadonlyMap<string, number>;
  readonly beam: ReadonlyMap<string, number>;
}

/** Net volume (document units³) per column / beam id: columns lose slab overlap; beams lose slab and column overlap (joints go to the column). */
export function netConcreteVolumes(building: BuildingModel): NetVolumes {
  const levelBase = (levelId: string): number | undefined => building.levels[levelId]?.elevation;
  const slabs = elementsOf(building, 'slab').flatMap((slab) => {
    const base = levelBase(slab.levelId);
    return base === undefined ? [] : [{ slab, z: [base + slab.offset - slab.thickness, base + slab.offset] as ZRange }];
  });
  const columns = elementsOf(building, 'column').flatMap((column) => {
    const base = levelBase(column.levelId);
    return base === undefined ? [] : [{ column, footprint: columnFootprint(column), z: [base, base + column.height] as ZRange }];
  });
  const column = new Map<string, number>();
  for (const entry of columns) {
    const section = polygonArea(entry.footprint);
    const slabOverlap = slabs.reduce((sum, { slab, z }) => sum + slabAreaWithin(slab, [entry.footprint]) * overlapLength(entry.z, z), 0);
    const gross = columnSectionArea(entry.column) * entry.column.height;
    column.set(entry.column.id, gross - (slabOverlap / section) * columnSectionArea(entry.column));
  }
  const beam = new Map<string, number>();
  for (const element of elementsOf(building, 'beam')) {
    const base = levelBase(element.levelId);
    const level = building.levels[element.levelId];
    const rect = beamFootprint(element);
    if (base === undefined || !level || rect.length === 0) continue;
    const top = base + level.height + element.topOffset;
    const z: ZRange = [top - element.depth, top];
    let removed = 0;
    for (const { slab, z: slabZ } of slabs) removed += slabAreaWithin(slab, [rect]) * overlapLength(z, slabZ);
    for (const entry of columns) {
      const shared = polygonArea(clipConvex(rect, toCounterClockwise(entry.footprint)));
      if (shared <= 0) continue;
      removed += shared * overlapLength(z, entry.z);
      for (const { slab, z: slabZ } of slabs) removed -= slabAreaWithin(slab, [rect, entry.footprint]) * overlapLength(z, entry.z, slabZ);
    }
    beam.set(element.id, Math.max(0, distance(element.start, element.end) * element.width * element.depth - removed));
  }
  return { column, beam };
}

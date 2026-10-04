import type { CadDocument, Vec2, Vec3 } from '@core/model/types';
import type {
  BuildingElement,
  BuildingLevel,
  BuildingModel,
  EquipmentElement,
} from '@core/model/building';

/**
 * @layer tests/production/oracle
 *
 * Plain-maths geometry over the building model (absolute coordinates, document units = mm).
 * Criteria compare the model with the design intent through these helpers only.
 */

export interface Box3 {
  min: Vec3;
  max: Vec3;
}

const EMPTY_BUILDING: BuildingModel = {
  project: {
    name: '',
    client: '',
    address: '',
    author: '',
    drawingNumber: '',
    revision: '',
    date: '',
  },
  levels: {},
  levelOrder: [],
  activeLevelId: null,
  elements: {},
  elementOrder: [],
};

export function buildingOf(doc: CadDocument): BuildingModel {
  return doc.building ?? EMPTY_BUILDING;
}

export function elementsOf<C extends BuildingElement['category']>(
  doc: CadDocument,
  category: C,
): Extract<BuildingElement, { category: C }>[] {
  const building = buildingOf(doc);
  return building.elementOrder
    .map((id) => building.elements[id])
    .filter((element): element is Extract<BuildingElement, { category: C }> => {
      return element?.category === category;
    });
}

export function levelsByElevation(doc: CadDocument): BuildingLevel[] {
  const building = buildingOf(doc);
  return Object.values(building.levels).sort((a, b) => a.elevation - b.elevation);
}

export function elevationOf(doc: CadDocument, levelId: string): number {
  return buildingOf(doc).levels[levelId]?.elevation ?? 0;
}

/** Element-relative point (z above its level) → absolute point. */
export function absolute(doc: CadDocument, levelId: string, point: Vec3): Vec3 {
  return [point[0], point[1], point[2] + elevationOf(doc, levelId)];
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function polylineLength(points: Vec3[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a && b) length += distance(a, b);
  }
  return length;
}

/** Absolute axis-aligned box of an equipment block (rotated footprint → its plan bounds). */
export function equipmentBox(doc: CadDocument, equipment: EquipmentElement): Box3 {
  const [length, width, height] = equipment.size;
  const cos = Math.abs(Math.cos(equipment.angle));
  const sin = Math.abs(Math.sin(equipment.angle));
  const halfX = (length * cos + width * sin) / 2;
  const halfY = (length * sin + width * cos) / 2;
  const base = elevationOf(doc, equipment.levelId);
  return {
    min: [equipment.location[0] - halfX, equipment.location[1] - halfY, base],
    max: [equipment.location[0] + halfX, equipment.location[1] + halfY, base + height],
  };
}

export function insideBox(point: Vec3, box: Box3, tolerance = 0): boolean {
  return [0, 1, 2].every(
    (axis) =>
      (point[axis] ?? 0) >= (box.min[axis] ?? 0) - tolerance &&
      (point[axis] ?? 0) <= (box.max[axis] ?? 0) + tolerance,
  );
}

/** Even-odd point-in-polygon (plan). Points on an edge count as inside. */
export function insidePolygon(point: Vec2, polygon: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i] ?? [0, 0];
    const [xj, yj] = polygon[j] ?? [0, 0];
    if (onSegment(point, [xi, yi], [xj, yj])) return true;
    if (yi > point[1] !== yj > point[1]) {
      const x = ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi;
      if (point[0] < x) inside = !inside;
    }
  }
  return inside;
}

function onSegment(p: Vec2, a: Vec2, b: Vec2): boolean {
  const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  if (Math.abs(cross) > 1e-6 * Math.max(1, Math.hypot(b[0] - a[0], b[1] - a[1]))) return false;
  return (
    p[0] >= Math.min(a[0], b[0]) - 1e-6 &&
    p[0] <= Math.max(a[0], b[0]) + 1e-6 &&
    p[1] >= Math.min(a[1], b[1]) - 1e-6 &&
    p[1] <= Math.max(a[1], b[1]) + 1e-6
  );
}

/** Plan corners of a box. */
export function planCorners(box: Box3): Vec2[] {
  return [
    [box.min[0], box.min[1]],
    [box.max[0], box.min[1]],
    [box.max[0], box.max[1]],
    [box.min[0], box.max[1]],
  ];
}

/** True when the plan rectangle of `box` overlaps the polygon's bounding rectangle. */
export function planOverlaps(box: Box3, polygon: Vec2[]): boolean {
  const xs = polygon.map((p) => p[0]);
  const ys = polygon.map((p) => p[1]);
  return (
    box.min[0] < Math.max(...xs) &&
    box.max[0] > Math.min(...xs) &&
    box.min[1] < Math.max(...ys) &&
    box.max[1] > Math.min(...ys)
  );
}

export const round = (value: number, digits = 1): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

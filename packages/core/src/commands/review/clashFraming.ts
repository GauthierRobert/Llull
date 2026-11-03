/** Clash framing (plant 09 VIS §5.8, TR-VIS-40): the box a viewpoint frames for a clash and the iso camera that fits it; the clash records read from a source command. */

import { entityBoundsInDoc, mergeBounds, type Bounds } from '../../geometry/bounds';
import { fitFraming } from '../../geometry/viewFraming';
import { VIEWPORT_FOV_DEGREES } from '../../model/viewport';
import { toMm } from '../../model/units';
import type { ViewpointCamera } from '../../model/review';
import type { CadDocument, Vec3 } from '../../model/types';
import { isRecord } from '../../lib/isRecord';

export interface ClashRecord {
  readonly a: string;
  readonly b: string;
  readonly kind: string;
  /** Penetration depth in millimetres (0 when the source gives none). */
  readonly depthMm: number;
}

const ISO: Vec3 = [1 / Math.sqrt(3), -1 / Math.sqrt(3), 1 / Math.sqrt(3)];

/** `clash:` + sorted(a, b) + `|` + kind. */
export const clashKeyOf = (clash: ClashRecord): string => `clash:${[clash.a, clash.b].sort().join(',')}|${clash.kind}`;

/** The intersection of two boxes when they overlap, else (per axis) the gap between their closest faces. */
export function clashBox(a: Bounds, b: Bounds): Bounds {
  const lo: number[] = [];
  const hi: number[] = [];
  for (let axis = 0; axis < 3; axis++) {
    const low = Math.max(a.min[axis] ?? 0, b.min[axis] ?? 0);
    const high = Math.min(a.max[axis] ?? 0, b.max[axis] ?? 0);
    lo.push(Math.min(low, high));
    hi.push(Math.max(low, high));
  }
  return { min: [lo[0] ?? 0, lo[1] ?? 0, lo[2] ?? 0], max: [hi[0] ?? 0, hi[1] ?? 0, hi[2] ?? 0] };
}

/** The perspective 45° iso camera (1, -1, 1) that fits `box` grown by `margin` (document units) on every side. */
export function clashCamera(box: Bounds, margin: number): ViewpointCamera {
  const grown: Bounds = {
    min: [box.min[0] - margin, box.min[1] - margin, box.min[2] - margin],
    max: [box.max[0] + margin, box.max[1] + margin, box.max[2] + margin],
  };
  const { center, distance } = fitFraming(grown, 1, 1.2);
  const eye: Vec3 = [center[0] + ISO[0] * distance, center[1] + ISO[1] * distance, center[2] + ISO[2] * distance];
  return { projection: 'perspective', eye, direction: [-ISO[0], -ISO[1], -ISO[2]], up: [0, 0, 1], fovDeg: VIEWPORT_FOV_DEGREES };
}

/** The entity ids behind a clash id: the entity itself, or the entities of the building element of that id. */
export function clashEntityIds(doc: CadDocument, id: string): string[] {
  if (Object.hasOwn(doc.entities, id)) return [id];
  const building: unknown = (doc as { building?: unknown }).building;
  const elements = isRecord(building) ? building['elements'] : undefined;
  const element = isRecord(elements) && Object.hasOwn(elements, id) ? elements[id] : undefined;
  const ids = isRecord(element) ? element['entityIds'] : undefined;
  return Array.isArray(ids) ? ids.filter((entry): entry is string => typeof entry === 'string' && Object.hasOwn(doc.entities, entry)) : [];
}

/** The union box of entities, or null when none has bounds. */
export function unionBounds(doc: CadDocument, entityIds: readonly string[]): Bounds | null {
  const boxes = entityIds.flatMap((id) => {
    const entity = doc.entities[id];
    return entity === undefined ? [] : [entityBoundsInDoc(doc, entity)];
  });
  const [first, ...rest] = boxes;
  return first === undefined ? null : rest.reduce(mergeBounds, first);
}

const ASSEMBLY_KINDS: Readonly<Record<string, string>> = { FPR_PAIR_HARD: 'hard', FPR_PAIR_CONTAINED: 'contained' };

/** The clash records of a source command's data (`clashes[]` of check_clashes; the pair items of a check_assembly envelope), or null when it has none. */
export function clashesOf(doc: CadDocument, source: string, data: unknown): ClashRecord[] | null {
  if (!isRecord(data)) return null;
  const clashes = data['clashes'];
  if (Array.isArray(clashes)) {
    const records: ClashRecord[] = [];
    for (const entry of clashes) {
      if (!isRecord(entry) || typeof entry['a'] !== 'string' || typeof entry['b'] !== 'string' || typeof entry['kind'] !== 'string')
        return null;
      const depth = typeof entry['depth'] === 'number' && Number.isFinite(entry['depth']) ? entry['depth'] : 0;
      records.push({ a: entry['a'], b: entry['b'], kind: entry['kind'], depthMm: toMm(doc, depth) });
    }
    return records;
  }
  const items = data['items'];
  if (source !== 'check_assembly' || !Array.isArray(items)) return null;
  const records: ClashRecord[] = [];
  for (const item of items) {
    if (!isRecord(item) || typeof item['code'] !== 'string') continue;
    const kind = ASSEMBLY_KINDS[item['code']];
    const ids = item['ids'];
    if (kind === undefined || !Array.isArray(ids) || ids.length !== 2 || ids.some((id) => typeof id !== 'string')) continue;
    const values = item['values'];
    const depth = isRecord(values) ? values['penetrationEstimateMm'] : undefined;
    records.push({ a: String(ids[0]), b: String(ids[1]), kind, depthMm: typeof depth === 'number' && Number.isFinite(depth) ? depth : 0 });
  }
  return records;
}

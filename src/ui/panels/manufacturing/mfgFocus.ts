// Pure builder of the model highlight for the Manufacturing panel: the checked part is selected and a beacon carries the finding (code,
// value against limit) or the part name. A finding that names bends / flats of the part is beaconed ON them (bend line midpoint, flat
// centroid, from the part's sheet-metal tree); a part-level finding marks the part centre.

import type { CadDocument, Vec3 } from '@core/model/types';
import type { Vec2 } from '@core/model/vectors';
import { boundsCenter, entityBoundsInDoc } from '@core/geometry/bounds';
import type { PanelFocus } from '@ui/store/focusStore';

export const FINDING_COLORS = { fail: '#ff4d4f', warn: '#ffb300', info: '#40c4ff' } as const;
const PART_COLOR = '#40c4ff';

interface Frame {
  readonly origin: Vec3;
  readonly xDir: Vec3;
  readonly normal: Vec3;
}

/** A point of a flat's 2D frame in part coordinates (y = normal × xDir). */
function onFrame(frame: Frame, [x, y]: Vec2): Vec3 {
  const [nx, ny, nz] = frame.normal;
  const [ux, uy, uz] = frame.xDir;
  const v: Vec3 = [ny * uz - nz * uy, nz * ux - nx * uz, nx * uy - ny * ux];
  return [frame.origin[0] + x * ux + y * v[0], frame.origin[1] + x * uy + y * v[1], frame.origin[2] + x * uz + y * v[2]];
}

/**
 * World points of the bends / flats among `ids` (part entity translation applied; a rotated part falls back to none).
 * @pure
 */
export function featurePoints(doc: CadDocument, partId: string, ids: readonly string[]): Vec3[] {
  const part = doc.sheetMetal?.parts[partId];
  const entity = doc.entities[partId];
  if (part === undefined || entity === undefined || entity.rotation.some((angle) => angle !== 0)) return [];
  const flatFrame = (id: string): Frame | null => {
    const node = part.nodes[id];
    return node?.type === 'flat' ? node.frame : null;
  };
  const points: Vec3[] = [];
  for (const id of ids) {
    const node = Object.hasOwn(part.nodes, id) ? part.nodes[id] : undefined;
    let local: Vec3 | null = null;
    if (node?.type === 'bend') {
      const frame = flatFrame(node.from);
      const [p, q] = node.lineInFrom;
      if (frame !== null) local = onFrame(frame, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]);
    } else if (node?.type === 'flat' && node.outline.length > 0) {
      const sum = node.outline.reduce<Vec2>((acc, point) => [acc[0] + point[0], acc[1] + point[1]], [0, 0]);
      local = onFrame(node.frame, [sum[0] / node.outline.length, sum[1] / node.outline.length]);
    }
    if (local !== null) points.push([local[0] + entity.position[0], local[1] + entity.position[1], local[2] + entity.position[2]]);
  }
  return points;
}

export function partFocus(
  doc: CadDocument,
  partId: string,
  key: string,
  label: string,
  color: string = PART_COLOR,
  featureIds: readonly string[] = [],
): PanelFocus {
  const entity = doc.entities[partId];
  const onFeatures = featurePoints(doc, partId, featureIds);
  const markers =
    entity === undefined
      ? []
      : onFeatures.length > 0
        ? onFeatures.map((position) => ({ position, label }))
        : [{ position: boundsCenter(entityBoundsInDoc(doc, entity)), label }];
  return { key: `manufacturing:${key}`, label, color, entityIds: entity === undefined ? [] : [partId], markers };
}

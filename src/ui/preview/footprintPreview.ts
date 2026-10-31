// The footprint preview of the wrap commands (03 WRP, spec §14.17), presentation only: which commands have one, and the mapping of the answer of their read-only
// preview query (world polylines) to the lines a ghost draws. Every point comes from the query; nothing is derived from the document here.

import type { Vec3 } from '@core/model/types';

/** The read-only preview command of a command, or null when it has none. */
export function footprintPreviewCommand(name: string): 'preview_emboss_on_face' | 'preview_add_knurl' | null {
  return name === 'emboss_on_face' ? 'preview_emboss_on_face' : name === 'add_knurl' ? 'preview_add_knurl' : null;
}

export interface FootprintView {
  readonly kind: 'footprint' | 'knurl';
  /** Closed loops of the sketch on the face (a footprint) or groove lines (a knurl). */
  readonly outlines: ReadonlyArray<ReadonlyArray<Vec3>>;
  /** The holes among the footprint loops (drawn in another colour); empty for a knurl. */
  readonly holes: ReadonlyArray<ReadonlyArray<Vec3>>;
}

const isVec3 = (value: unknown): value is Vec3 =>
  Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === 'number' && Number.isFinite(v));
const pointsOf = (value: unknown): Vec3[] | null => (Array.isArray(value) && value.every(isVec3) ? (value as Vec3[]) : null);

/** The view of the answer of preview_emboss_on_face / preview_add_knurl; null when the data is not one. */
export function parseFootprint(command: string, data: unknown): FootprintView | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (command === 'preview_emboss_on_face' && Array.isArray(d['footprint'])) {
    const loops = (d['footprint'] as unknown[]).flatMap((entry) => {
      const loop = (entry ?? {}) as Record<string, unknown>;
      const points = pointsOf(loop['points']);
      return points === null ? [] : [{ hole: loop['hole'] === true, points }];
    });
    return {
      kind: 'footprint',
      outlines: loops.filter((loop) => !loop.hole).map((loop) => loop.points),
      holes: loops.filter((loop) => loop.hole).map((loop) => loop.points),
    };
  }
  if (command === 'preview_add_knurl' && Array.isArray(d['lines'])) {
    const lines = (d['lines'] as unknown[]).flatMap((entry) => {
      const points = pointsOf(((entry ?? {}) as Record<string, unknown>)['points']);
      return points === null ? [] : [points];
    });
    return { kind: 'knurl', outlines: lines, holes: [] };
  }
  return null;
}

/** Line-segment pairs (x y z x y z) of polylines; `closed` joins the last point to the first. */
export function polylineSegments(polylines: ReadonlyArray<ReadonlyArray<Vec3>>, closed: boolean): Float32Array {
  const out: number[] = [];
  for (const line of polylines) {
    const count = closed ? line.length : line.length - 1;
    for (let k = 0; k < count; k++) {
      const a = line[k] as Vec3;
      const b = line[(k + 1) % line.length] as Vec3;
      out.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    }
  }
  return Float32Array.from(out);
}

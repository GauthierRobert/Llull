/**
 * Support marks of an isometric (plant 05 ISO M5, §5.8): a support is a point on the centreline, drawn at the same fraction along the drawn segment as in 3D,
 * with a symbol by type (shoe: stem and base bar; guide: shoe with side stops; anchor: filled triangle; hanger: stem up to a bar; unnamed type: a circle) and its mark.
 * Pure; positions come from the sheet-frame layout.
 */

import type { Vec2 } from '@core/model/vectors';
import { distance3, dot3, lerp3, sub3 } from '@lib/vec3';
import type { LineSupport } from '../supports';
import type { IsoGraph } from './isoGraph';
import type { IsoLayout } from './isoLayout';
import type { IsoPrimitive } from './isoRender';

/** A support within this distance of a drawn segment is on it (mm). */
const ON_SEGMENT_MM = 1.5;

export interface PlacedSupport {
  readonly support: LineSupport;
  readonly at: Vec2;
  readonly primitives: readonly IsoPrimitive[];
}

const stroke = (a: Vec2, b: Vec2): IsoPrimitive => ({ t: 'line', layer: 'ISO-SYMB', a, b });

function symbol(type: string, at: Vec2): IsoPrimitive[] {
  const [x, y] = at;
  const base = [stroke(at, [x, y - 3]), stroke([x - 2, y - 3], [x + 2, y - 3])];
  switch (type) {
    case 'shoe':
      return base;
    case 'guide':
      return [...base, stroke([x - 2, y - 3], [x - 2, y - 1.2]), stroke([x + 2, y - 3], [x + 2, y - 1.2])];
    case 'anchor':
      return [{ t: 'poly', layer: 'ISO-SYMB', points: [at, [x - 2, y - 3.5], [x + 2, y - 3.5]], closed: true, fill: true }];
    case 'hanger':
      return [stroke(at, [x, y + 3.5]), stroke([x - 2, y + 3.5], [x + 2, y + 3.5])];
    default:
      return [{ t: 'circle', layer: 'ISO-SYMB', c: at, r: 1.6 }];
  }
}

/** The supports that lie on a drawn segment (the nearest one wins), with their symbols; a support on no drawn segment is not drawn on this sheet. */
export function supportMarks(supports: readonly LineSupport[], graph: IsoGraph, layout: IsoLayout): PlacedSupport[] {
  const out: PlacedSupport[] = [];
  for (const support of supports) {
    let best: { index: number; t: number; distance: number } | null = null;
    graph.steps.forEach((step, index) => {
      const direction = sub3(step.end, step.start);
      const lengthSquared = dot3(direction, direction);
      if (lengthSquared === 0) return;
      const t = Math.min(1, Math.max(0, dot3(sub3(support.xyz, step.start), direction) / lengthSquared));
      const distance = distance3(support.xyz, lerp3(step.start, step.end, t));
      if (distance <= ON_SEGMENT_MM && (best === null || distance < best.distance)) best = { index, t, distance };
    });
    const hit = best as { index: number; t: number } | null;
    if (hit === null) continue;
    const [a, b] = [layout.starts[hit.index] as Vec2, layout.ends[hit.index] as Vec2];
    const at: Vec2 = [a[0] + (b[0] - a[0]) * hit.t, a[1] + (b[1] - a[1]) * hit.t];
    out.push({ support, at, primitives: symbol(support.type, at) });
  }
  return out;
}

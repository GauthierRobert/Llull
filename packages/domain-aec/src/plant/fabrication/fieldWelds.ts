/**
 * Field welds applied to a network (plant 05 ISO §4 `add_field_weld`): each stored weld splits the PIPE it lies on into two pieces with a WELD component between them
 * (SKEY WS site / WF field-fit, ERECTION-ITEM). The base line (routed, legacy or imported) is never edited: the split is derived every time, so a weld that no longer
 * lies on a pipe is reported as stale instead of corrupting the line. Pure; world mm.
 */

import type { Vec3 } from '@core/model/vectors';
import { distance3, dot3, lerp3, sub3 } from '@lib/vec3';
import type { FieldWeldRecord, NetworkComponent, NetworkPoint } from './model';

/** A point within this distance of a pipe centreline lies on it (mm, spec §7 ISO_WELD_NOT_ON_PIPE). */
export const ON_PIPE_TOLERANCE_MM = 1;

export interface PipeHit {
  readonly component: NetworkComponent;
  readonly index: number;
  /** Parameter 0..1 along the centreline. */
  readonly t: number;
  readonly point: Vec3;
  readonly distanceMm: number;
}

/** The PIPE whose centreline is nearest to `point` within the tolerance, or null. */
export function nearestPipe(components: readonly NetworkComponent[], point: Vec3): PipeHit | null {
  let best: PipeHit | null = null;
  components.forEach((component, index) => {
    const [start, end] = component.ends;
    if (component.type !== 'PIPE' || start === undefined || end === undefined) return;
    const direction = sub3(end.xyz, start.xyz);
    const lengthSquared = dot3(direction, direction);
    if (lengthSquared === 0) return;
    const t = Math.min(1, Math.max(0, dot3(sub3(point, start.xyz), direction) / lengthSquared));
    const closest = lerp3(start.xyz, end.xyz, t);
    const distanceMm = distance3(point, closest);
    if (distanceMm <= ON_PIPE_TOLERANCE_MM && (best === null || distanceMm < best.distanceMm))
      best = { component, index, t, point: closest, distanceMm };
  });
  return best;
}

export interface SplitResult {
  readonly components: readonly NetworkComponent[];
  /** Weld id -> the ids of the pipe piece before and after it. */
  readonly pieces: Readonly<Record<string, readonly [string, string]>>;
  /** Welds that lie on no pipe of the line any more. */
  readonly stale: readonly string[];
}

const round1 = (value: number): number => Math.round(value * 10) / 10 + 0;

const round1Point = (point: Vec3): Vec3 => [round1(point[0]), round1(point[1]), round1(point[2])];

const pointAt = (point: NetworkPoint, xyz: Vec3): NetworkPoint => ({ ...point, xyz });

/** `welds` (of one line) applied to `components`. Welds on the same pipe are cut in order along it; piece ids are `<pipeId>.s<k>`. */
export function splitComponents(components: readonly NetworkComponent[], welds: readonly FieldWeldRecord[]): SplitResult {
  if (welds.length === 0) return { components, pieces: {}, stale: [] };
  const byPipe = new Map<number, Array<{ weld: FieldWeldRecord; hit: PipeHit }>>();
  const stale: string[] = [];
  for (const weld of [...welds].sort((a, b) => a.id.localeCompare(b.id))) {
    const hit = nearestPipe(components, weld.xyz);
    if (hit === null) stale.push(weld.id);
    else byPipe.set(hit.index, [...(byPipe.get(hit.index) ?? []), { weld, hit }]);
  }
  const pieces: Record<string, readonly [string, string]> = {};
  const out = components.flatMap((component, index): NetworkComponent[] => {
    const cuts = byPipe.get(index);
    const [start, end] = component.ends;
    if (cuts === undefined || start === undefined || end === undefined) return [component];
    const ordered = [...cuts].sort((a, b) => a.hit.t - b.hit.t);
    const stops = [0, ...ordered.map((cut) => cut.hit.t), 1];
    const { weight, ...rest } = component;
    const result: NetworkComponent[] = [];
    for (let k = 0; k < stops.length - 1; k++) {
      const from = stops[k] as number;
      const to = stops[k + 1] as number;
      const a = k === 0 ? start.xyz : round1Point(lerp3(start.xyz, end.xyz, from));
      const b = k === stops.length - 2 ? end.xyz : round1Point(lerp3(start.xyz, end.xyz, to));
      result.push({
        ...rest,
        id: `${component.id}.s${k + 1}`,
        ends: [pointAt(start, a), pointAt(end, b)],
        ...(weight === undefined ? {} : { weight: weight * (to - from) }),
      });
      const cut = ordered[k];
      if (cut !== undefined) {
        const at = round1Point(lerp3(start.xyz, end.xyz, cut.hit.t));
        const field = cut.weld.type === 'field_fit';
        result.push({
          id: cut.weld.id,
          type: 'WELD',
          ends: [pointAt(start, at), pointAt(start, at)],
          skey: field ? 'WF' : 'WS',
          category: 'erection',
          weldKind: cut.weld.type,
        });
        pieces[cut.weld.id] = [`${component.id}.s${k + 1}`, `${component.id}.s${k + 2}`];
      }
    }
    return result;
  });
  return { components: out, pieces, stale };
}

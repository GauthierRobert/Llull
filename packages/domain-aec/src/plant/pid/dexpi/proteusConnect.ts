/** Resolution of a DEXPI `Connection` end (id + node index) to a `PidEndpoint` (plant 04 PID §6.1, DEXPI_DANGLING_REFERENCE). */

import type { XmlElement } from '@lib/xmlRead';
import type { Vec2 } from '@core/model/vectors';
import type { PidEndpoint } from '../model';
import { warn, type ImportContext, type Ref } from './proteusContext';

const dist2 = (a: Vec2, b: Vec2): number => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;

/** Index of the port nearest to `to` (the first allowed one when `to` is unknown), never `exclude`. */
export function nearestPort(ports: readonly Vec2[], to: Vec2 | undefined, exclude?: number): number {
  let best = -1;
  let bestDistance = Infinity;
  ports.forEach((port, index) => {
    if (index === exclude) return;
    const distance = to === undefined ? 0 : dist2(port, to);
    if (best === -1 || distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return Math.max(best, 0);
}

/** The ref an id stands for, following aliases (at most four hops). */
function resolve(ctx: ImportContext, id: string): Ref | undefined {
  let ref = ctx.refs.get(id);
  for (let hops = 0; ref?.type === 'alias' && hops < 4; hops++) ref = ctx.refs.get(ref.target);
  return ref;
}

/** The end named by (`id`, DEXPI `node`); a free end at `fallback` when `id` is absent, unknown or cannot take a connection (with a warning for the last two). */
export function endpointOf(
  ctx: ImportContext,
  id: string | undefined,
  node: number | undefined,
  fallback: Vec2,
  at: XmlElement,
): PidEndpoint {
  if (id === undefined || id === '') return { type: 'free', at: fallback };
  const ref = resolve(ctx, id);
  switch (ref?.type) {
    case 'nozzle':
      return { type: 'nozzle', itemId: ref.id };
    case 'opc':
      return { type: 'opc', itemId: ref.id };
    case 'instrument':
      return { type: 'instrument', itemId: ref.id };
    case 'segment':
      return { type: 'branch', segmentId: ref.id, at: fallback };
    case 'inline': {
      const mapped = node === undefined ? undefined : ref.nodePort[node];
      return { type: 'inline', itemId: ref.id, node: mapped !== undefined && mapped >= 0 ? mapped : nearestPort(ref.ports, fallback) };
    }
    default:
      warn(
        ctx,
        'DEXPI_DANGLING_REFERENCE',
        'warning',
        ctx.allIds.has(id)
          ? `"${id}" cannot take a connection; the end was imported as free`
          : `"${id}" names no object; the end was imported as free`,
        at,
        [id],
      );
      return { type: 'free', at: fallback };
  }
}

/** Sheet position of an end (mm). */
export function pointOfEndpoint(ctx: ImportContext, end: PidEndpoint): Vec2 {
  switch (end.type) {
    case 'free':
    case 'branch':
      return end.at;
    case 'inline': {
      const item = ctx.items[end.itemId];
      return item?.kind === 'inline' ? (item.ports[end.node] ?? item.at) : [0, 0];
    }
    case 'nozzle': {
      const item = ctx.items[end.itemId];
      return item?.kind === 'nozzle' ? item.port : [0, 0];
    }
    default:
      return ctx.items[end.itemId]?.at ?? [0, 0];
  }
}

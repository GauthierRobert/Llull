/** Railing paths from the edges of a host slab or grating panel (06 STA M3). */

import type { Vec2, Vec3 } from '@core/model/types';
import type { BuildingElement, RailingHost } from '@aec/building/types';

export type EdgeSelection = 'all' | ReadonlyArray<number>;

export type HostPaths =
  | { readonly ok: true; readonly levelId: string; readonly paths: Array<{ path: Vec3[]; host: RailingHost }> }
  | { readonly ok: false; readonly reason: string };

/** Ring of the host and the walking-surface height (level-relative) its edges stand at. */
function hostRing(host: BuildingElement, opening: number | undefined): { ring: Vec2[]; z: number; levelId: string } | string {
  if (host.category === 'slab') {
    const ring = opening === undefined ? host.boundary : host.openings?.[opening];
    return ring === undefined ? `slab ${host.id} has no opening ${opening}` : { ring, z: host.offset, levelId: host.levelId };
  }
  if (host.category === 'grating') {
    return opening === undefined
      ? { ring: host.boundary, z: host.topOffset, levelId: host.levelId }
      : `a grating has no openings (got opening ${opening})`;
  }
  return `${host.id} is a ${host.category}; railings follow slabs and gratings`;
}

/** Runs of consecutive edge indices (cyclic) of a ring with `count` edges. */
function edgeRuns(count: number, selected: ReadonlySet<number>): number[][] {
  if (selected.size === count) return [Array.from({ length: count }, (_, index) => index)];
  const starts = [...selected].filter((index) => !selected.has((index - 1 + count) % count)).sort((a, b) => a - b);
  return starts.map((start) => {
    const run = [start];
    while (selected.has(((run[run.length - 1] as number) + 1) % count)) run.push(((run[run.length - 1] as number) + 1) % count);
    return run;
  });
}

/**
 * One path per run of consecutive selected edges of the host ring (one closed path when every edge is selected). Edge i runs from point i to
 * point i + 1 of the ring.
 */
export function hostPaths(host: BuildingElement, edges: EdgeSelection, opening: number | undefined): HostPaths {
  const found = hostRing(host, opening);
  if (typeof found === 'string') return { ok: false, reason: found };
  const { ring, z, levelId } = found;
  const count = ring.length;
  const selected = edges === 'all' ? new Set(Array.from({ length: count }, (_, index) => index)) : new Set(edges);
  const outside = [...selected].filter((index) => !Number.isInteger(index) || index < 0 || index >= count);
  if (outside.length > 0)
    return { ok: false, reason: `edge index ${outside.join(', ')} is outside 0..${count - 1} (the ring has ${count} edges)` };
  const point = (index: number): Vec3 => {
    const [x, y] = ring[index % count] as Vec2;
    return [x, y, z];
  };
  const ringName: RailingHost['ring'] = opening === undefined ? 'boundary' : opening;
  const paths = edgeRuns(count, selected).map((run) => ({
    path: [...run.map(point), point((run[run.length - 1] as number) + 1)],
    host: { hostId: host.id, ring: ringName, edges: [...run].sort((a, b) => a - b) },
  }));
  return { ok: true, levelId, paths };
}

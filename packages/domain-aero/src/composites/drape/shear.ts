/** Shear statistics and over-lock regions of a drape net (06 CMP FR-CMP-41 / 42). */

import type { Vec3 } from '@core/model/types';
import { add3, scale3 } from '@lib/vec3';
import { type DrapeNet, type DrapeNode, nodeKey } from './net';

export interface ShearLimits {
  readonly warning?: number | undefined;
  readonly lock?: number | undefined;
}

export interface OverLockRegion {
  readonly id: string;
  readonly nodeCount: number;
  readonly maxShearDeg: number;
  readonly centroid: Vec3;
}

export interface ShearSummary {
  /** Nodes with a measured shear (generator nodes excluded). */
  readonly measuredNodes: number;
  readonly maxShearDeg: number;
  readonly maxShearNode: { readonly i: number; readonly j: number; readonly point: Vec3 } | null;
  readonly nodesOverWarning: number | null;
  readonly nodesOverLock: number | null;
  /** Area of the cells ending at over-lock nodes, d^2 cos(shear) each, document units^2. */
  readonly areaOverLock: number | null;
  readonly overLockRegions: readonly OverLockRegion[];
}

const MAX_REGIONS = 20;

/** Connected components (4-neighbourhood in net indices) of the nodes over `lock`, largest first. */
function regionsOver(net: DrapeNet, lock: number, include: (node: DrapeNode) => boolean): OverLockRegion[] {
  const over = [...net.nodes.values()].filter((node) => node.shear > lock && include(node));
  const seen = new Set<number>();
  const regions: Omit<OverLockRegion, 'id'>[] = [];
  for (const start of over) {
    if (seen.has(nodeKey(start.i, start.j))) continue;
    const members: DrapeNode[] = [];
    const queue = [start];
    seen.add(nodeKey(start.i, start.j));
    while (queue.length > 0) {
      const node = queue.pop() as DrapeNode;
      members.push(node);
      for (const [di, dj] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const next = net.get(node.i + di, node.j + dj);
        if (next === undefined || next.shear <= lock || !include(next) || seen.has(nodeKey(next.i, next.j))) continue;
        seen.add(nodeKey(next.i, next.j));
        queue.push(next);
      }
    }
    const sum = members.reduce<Vec3>((total, node) => add3(total, node.hit.point), [0, 0, 0]);
    regions.push({
      nodeCount: members.length,
      maxShearDeg: Math.max(...members.map((node) => node.shear)),
      centroid: scale3(sum, 1 / members.length),
    });
  }
  return regions
    .sort((a, b) => b.nodeCount - a.nodeCount || b.maxShearDeg - a.maxShearDeg)
    .slice(0, MAX_REGIONS)
    .map((region, index) => ({ id: `R${index + 1}`, ...region }));
}

export function summarizeShear(net: DrapeNet, limits: ShearLimits, include: (node: DrapeNode) => boolean = () => true): ShearSummary {
  const measured = [...net.nodes.values()].filter((node) => node.i !== 0 && node.j !== 0 && include(node));
  let max: DrapeNode | null = null;
  for (const node of measured) if (max === null || node.shear > max.shear) max = node;
  const count = (limit: number | undefined): number | null =>
    limit === undefined ? null : measured.filter((node) => node.shear > limit).length;
  const { lock } = limits;
  return {
    measuredNodes: measured.length,
    maxShearDeg: max === null ? 0 : max.shear,
    maxShearNode: max === null ? null : { i: max.i, j: max.j, point: max.hit.point },
    nodesOverWarning: count(limits.warning),
    nodesOverLock: count(lock),
    areaOverLock:
      lock === undefined
        ? null
        : measured
            .filter((node) => node.shear > lock)
            .reduce((sum, node) => sum + net.d * net.d * Math.cos((node.shear * Math.PI) / 180), 0),
    overLockRegions: lock === undefined ? [] : regionsOver(net, lock, include),
  };
}

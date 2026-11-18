/** compute_margins groups and applied stress: the node groups margins are taken over, and the largest criterion value over a group. */

import type { AnalysisCase, FeMeshArtifact } from '@core/model/analysis';
import { nodeEntities, vonMises, type stepOfLoadCase } from '../results/fields';
import { appliedOverFibres, type Applied } from './fibreStress';

export const CRITERIA = ['von_mises', 's_xx', 's_yy', 's_zz'] as const;
export type Criterion = (typeof CRITERIA)[number];
const COMPONENT: Readonly<Record<Exclude<Criterion, 'von_mises'>, number>> = { s_xx: 0, s_yy: 1, s_zz: 2 };

interface Group {
  readonly entityId: string;
  readonly region: string;
  readonly nodes: readonly number[];
}

/** Part groups (every node of the part's elements) or target groups (the nodes of each constraint / load target, split by owning part). */
export function groupsOf(analysis: AnalysisCase, mesh: FeMeshArtifact, groupBy: 'part' | 'target'): Group[] {
  if (groupBy === 'part') {
    const byPart = new Map<string, Set<number>>();
    for (const block of mesh.blocks) {
      const nodes = byPart.get(block.entityId) ?? new Set<number>();
      for (const element of block.elements) for (const node of element.slice(1)) nodes.add(node);
      byPart.set(block.entityId, nodes);
    }
    return Object.keys(analysis.parts).flatMap((entityId) => {
      const nodes = byPart.get(entityId);
      return nodes === undefined ? [] : [{ entityId, region: 'part', nodes: [...nodes] }];
    });
  }
  const owner = nodeEntities(mesh);
  const groups: Group[] = [];
  for (const key of Object.keys(mesh.nodeSets).sort()) {
    if (!key.startsWith('C_') && !key.startsWith('L_')) continue;
    const split = new Map<string, number[]>();
    for (const node of mesh.nodeSets[key] ?? []) {
      const entityId = owner.get(node) ?? '';
      split.set(entityId, [...(split.get(entityId) ?? []), node]);
    }
    for (const [entityId, nodes] of split) groups.push({ entityId, region: key, nodes });
  }
  return groups;
}

/** Largest criterion value over `nodes` of the step's STRESS (and shell fibre) fields; component criteria: largest magnitude. */
export function appliedOver(
  fields: NonNullable<ReturnType<typeof stepOfLoadCase>>['fields'],
  nodes: readonly number[],
  criterion: Criterion,
): Applied | null {
  const scalar = (values: readonly number[]): number =>
    criterion === 'von_mises' ? vonMises(values) : Math.abs(values[COMPONENT[criterion]] ?? Number.NaN);
  return appliedOverFibres(fields, nodes, scalar);
}

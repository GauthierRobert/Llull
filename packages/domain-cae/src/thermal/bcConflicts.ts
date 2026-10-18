/** Prescribed-temperature BCs that fix the same mesh nodes to different values (CalculiX silently keeps the last one), or that override film / radiation BCs. */

import type { FeMeshArtifact, ThermalSetup } from '@core/model/analysis';
import type { DeckRefusal } from '../decks/context';
import { remediationOf } from './codes';
import { faceNodes, indexMesh } from './meshGeometry';

export interface BcConflict {
  readonly first: string;
  readonly second: string;
  readonly sharedNodes: number;
}

/** A prescribed temperature that overrides the film / radiation BC `flow` on `sharedNodes` nodes (the flow's heat is not applied there). */
export interface FlowOverride {
  readonly temperature: string;
  readonly flow: string;
  readonly kind: 'film' | 'radiation';
  readonly sharedNodes: number;
}

function nodesOf(mesh: FeMeshArtifact, key: string, index: ReturnType<typeof indexMesh>): Set<number> {
  const nodes = new Set(Object.hasOwn(mesh.nodeSets, key) ? (mesh.nodeSets[key] ?? []) : []);
  for (const [elementId, label] of Object.hasOwn(mesh.faceSets, key) ? (mesh.faceSets[key] ?? []) : []) {
    const element = index.elements.get(elementId);
    for (const node of element === undefined ? [] : (faceNodes(element, label) ?? [])) nodes.add(node);
  }
  return nodes;
}

/**
 * Pairs of temperature BCs (in bcOrder) whose meshed node sets intersect while their value, unit or amplitude differ.
 * @pure
 */
export function temperatureBcConflicts(thermal: ThermalSetup, mesh: FeMeshArtifact): BcConflict[] {
  const index = indexMesh(mesh);
  const fixed = thermal.bcOrder.flatMap((id) => {
    const record = Object.hasOwn(thermal.bcs, id) ? thermal.bcs[id] : undefined;
    return record?.bc.kind === 'temperature' ? [{ record, nodes: nodesOf(mesh, `B_${id}`, index) }] : [];
  });
  const conflicts: BcConflict[] = [];
  fixed.forEach((a, i) => {
    for (const b of fixed.slice(i + 1)) {
      const bcA = a.record.bc;
      const bcB = b.record.bc;
      if (bcA.kind !== 'temperature' || bcB.kind !== 'temperature') continue;
      if (bcA.value.value === bcB.value.value && bcA.value.unit === bcB.value.unit && a.record.amplitude === b.record.amplitude) continue;
      const sharedNodes = [...a.nodes].filter((node) => b.nodes.has(node)).length;
      if (sharedNodes > 0) conflicts.push({ first: a.record.id, second: b.record.id, sharedNodes });
    }
  });
  return conflicts;
}

/**
 * Deck refusal for the first conflicting pair of temperature BCs (shared by the thermal and the coupled deck), or null.
 * @failure different temperatures on shared mesh nodes -> THM_BC_CONFLICT naming both BC ids
 */
export function temperatureConflictRefusal(thermal: ThermalSetup, mesh: FeMeshArtifact): DeckRefusal | null {
  const conflict = temperatureBcConflicts(thermal, mesh)[0];
  if (conflict === undefined) return null;
  return {
    code: 'THM_BC_CONFLICT',
    message: `temperature BCs '${conflict.first}' and '${conflict.second}' prescribe different values on ${conflict.sharedNodes} shared node(s), so the deck would be ambiguous (the solver keeps only the last one). ${remediationOf('THM_BC_CONFLICT')}`,
    ids: [conflict.first, conflict.second],
  };
}

/**
 * Film / radiation BCs (in bcOrder) whose meshed node sets intersect a prescribed-temperature BC, whatever its value: the temperature wins there.
 * @pure
 */
export function temperatureOverridesFlows(thermal: ThermalSetup, mesh: FeMeshArtifact): FlowOverride[] {
  const index = indexMesh(mesh);
  const records = thermal.bcOrder.flatMap((id) =>
    Object.hasOwn(thermal.bcs, id) && thermal.bcs[id] !== undefined ? [thermal.bcs[id]] : [],
  );
  const fixed = records
    .filter((record) => record.bc.kind === 'temperature')
    .map((record) => ({ record, nodes: nodesOf(mesh, `B_${record.id}`, index) }));
  const overrides: FlowOverride[] = [];
  for (const record of records) {
    const kind = record.bc.kind;
    if (kind !== 'film' && kind !== 'radiation') continue;
    const nodes = nodesOf(mesh, `B_${record.id}`, index);
    for (const other of fixed) {
      const sharedNodes = [...nodes].filter((node) => other.nodes.has(node)).length;
      if (sharedNodes > 0) overrides.push({ temperature: other.record.id, flow: record.id, kind, sharedNodes });
    }
  }
  return overrides;
}

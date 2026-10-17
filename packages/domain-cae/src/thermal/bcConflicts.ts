/** Prescribed-temperature BCs that fix the same mesh nodes to different values (CalculiX silently keeps the last one). */

import type { FeMeshArtifact, ThermalSetup } from '@core/model/analysis';
import { faceNodes, indexMesh } from './meshGeometry';

export interface BcConflict {
  readonly first: string;
  readonly second: string;
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

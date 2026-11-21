/**
 * Frames of instance parts for the symmetry reduction and the pair cache (TR-ASC-09 / 10): a unit-scale instance gets its rigid placement and
 * the key of its component-local recipe (the instance at the origin), shared by every instance of that component.
 * @invariant parts that are not unit-scale instances come back unchanged (they are keyed by their world recipe)
 */

import type { CadDocument, InstanceEntity } from '../../model/types';
import type { GeometryKernel } from '../kernel';
import { recipeOfPart } from '../assemblyParts';
import { recipeKey } from '../shapeRecipe';
import { hashText } from '../../lib/hash';
import type { AssemblyPart } from './partTypes';
import { frameOfInstance } from './rigidFrame';

export interface FramedParts {
  readonly parts: AssemblyPart[];
  /** Instance sets (one component, one pattern seed or none) with at least two framed members. */
  readonly patterns: number;
}

export function withFrames(doc: CadDocument, kernel: GeometryKernel, parts: readonly AssemblyPart[]): FramedParts {
  const localKeys = new Map<string, string | null>();
  const sets = new Map<string, number>();
  const framed = parts.map((part): AssemblyPart => {
    const entity = doc.entities[part.id];
    if (entity === undefined || entity.kind !== 'instance') return part;
    const instance = entity as InstanceEntity;
    const frame = frameOfInstance(instance);
    if (frame === null) return part;
    if (!localKeys.has(instance.componentId)) {
      const recipe = recipeOfPart(doc, kernel, { ...instance, position: [0, 0, 0], rotation: [0, 0, 0] });
      localKeys.set(instance.componentId, recipe === 'unbuildable' ? null : hashText(recipeKey(recipe)));
    }
    const localKey = localKeys.get(instance.componentId);
    if (localKey === null || localKey === undefined) return part;
    const set = `${instance.componentId}|${instance.patternSourceId ?? ''}`;
    sets.set(set, (sets.get(set) ?? 0) + 1);
    return { ...part, frame, localKey };
  });
  return { parts: framed, patterns: [...sets.values()].filter((count) => count >= 2).length };
}

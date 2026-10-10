/**
 * @layer tests/helpers
 * Shared setup for component tests that dispatch a command through the store and inspect
 * the resulting entity. USE IN TESTS ONLY.
 */

import * as THREE from 'three';
import { createEmptyDocument, type Entity } from '@core/model/types';
import { useStore } from '@ui/store';
import { localDispatch } from './storeTestHelpers';

export function resetStore(): void {
  useStore.setState({ document: createEmptyDocument(), lastSummary: null });
}

export interface DispatchedEntity {
  id: string;
  entity: Entity;
  affected: readonly string[];
}

/** Dispatch a command and return the first affected entity (throws when it is missing). */
export function dispatchEntity(name: string, params: unknown): DispatchedEntity {
  const { affected } = localDispatch(name, params);
  const id = affected[0]!;
  const entity = useStore.getState().document.entities[id];
  if (!entity) throw new Error(`${name} did not create an entity`);
  return { id, entity, affected };
}

/** Closed THREE.Shape from a 2D point list. */
export function shapeFromProfile(profile: ReadonlyArray<readonly [number, number]>): THREE.Shape {
  const shape = new THREE.Shape();
  const first = profile[0]!;
  shape.moveTo(first[0], first[1]);
  for (let i = 1; i < profile.length; i++) shape.lineTo(profile[i]![0], profile[i]![1]);
  shape.closePath();
  return shape;
}

import { expect } from 'vitest';
import { type CadDocument, type Entity, DEFAULT_LAYER_ID, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';

/** Doc holding raw fixture entities (test setup only); each shape needs an `id` and a `kind`. */
export function docWith(...shapes: Array<Record<string, unknown>>): CadDocument {
  const entities = Object.fromEntries(
    shapes.map((shape) => [
      shape['id'] as string,
      { position: [0, 0, 0], rotation: [0, 0, 0], layerId: DEFAULT_LAYER_ID, color: '#ffffff', ...shape } as unknown as Entity,
    ]),
  );
  return { ...createEmptyDocument(), entities, order: Object.keys(entities) };
}

/** Runs a command that must create exactly one entity and returns it. */
export function createdEntity<T extends Entity>(doc: CadDocument, name: string, params: object): T {
  const result = execute(doc, name, params as Record<string, unknown>);
  expect(result.affected, result.summary).toHaveLength(1);
  return result.document.entities[result.affected[0] as string] as T;
}

/** Runs a command that must create exactly one entity; returns the new document and that entity. */
export function createdIn<T extends Entity>(doc: CadDocument, name: string, params: object): { doc: CadDocument; e: T } {
  const result = execute(doc, name, params as Record<string, unknown>);
  expect(result.affected, result.summary).toHaveLength(1);
  return { doc: result.document, e: result.document.entities[result.affected[0] as string] as T };
}

/** `mass_properties` volume of `entityId` in `doc`, or of a lone entity. */
export function volumeOf(docOrEntity: CadDocument | Entity, entityId?: string): number {
  const doc =
    'entities' in docOrEntity
      ? docOrEntity
      : { ...createEmptyDocument(), entities: { [docOrEntity.id]: docOrEntity }, order: [docOrEntity.id] };
  const id = entityId ?? ('entities' in docOrEntity ? '' : docOrEntity.id);
  return (execute(doc, 'mass_properties', { entityId: id }).data as { volume: number }).volume;
}

/** Every undirected edge of a closed triangle soup is shared by exactly two triangles. */
export function isWatertight(triangles: ReadonlyArray<ReadonlyArray<readonly number[]>>, digits = 7): boolean {
  const key = (p: readonly number[]): string => p.map((v) => v.toFixed(digits)).join(',');
  const edges = new Map<string, number>();
  for (const triangle of triangles) {
    for (let k = 0; k < 3; k++) {
      const [a, b] = [key(triangle[k] as number[]), key(triangle[(k + 1) % 3] as number[])];
      const edge = a < b ? `${a}|${b}` : `${b}|${a}`;
      edges.set(edge, (edges.get(edge) ?? 0) + 1);
    }
  }
  return [...edges.values()].every((count) => count === 2);
}

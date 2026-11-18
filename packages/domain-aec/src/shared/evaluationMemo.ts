/**
 * Reuse of generated entities across regenerations: an owner (building element, ...) whose evaluation inputs are unchanged keeps the entity
 * objects of the previous regeneration instead of being re-evaluated.
 * Each evaluated entity is registered with the inputs it was evaluated from (a WeakMap, so an entity the document no longer holds is
 * forgotten). Reuse needs every entity of the owner's previous `entityIds` to still be the registered evaluation output (an entity edited
 * or reloaded is a different object and is re-evaluated) and the inputs to be deeply equal to the current ones.
 */

import type { CadDocument, Entity } from '@core/model/types';

interface Provenance {
  /** What the evaluation read: the owner, every other element / level / carrier it consulted. */
  readonly inputs: readonly unknown[];
  readonly units: CadDocument['units'];
  /** Number of entities the evaluation produced (all share this record). */
  readonly count: number;
}

const provenance = new WeakMap<Entity, Provenance>();

/** Deep equality of plain data (strict: key sets, -0 vs 0 and undefined-valued keys all matter); `skipKey` is ignored at the top level. */
function sameValue(a: unknown, b: unknown, skipKey: string | null): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => sameValue(item, b[index], null));
  }
  if (Object.getPrototypeOf(a) !== Object.prototype || Object.getPrototypeOf(b) !== Object.prototype) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left).filter((key) => key !== skipKey);
  if (keys.length !== Object.keys(right).filter((key) => key !== skipKey).length) return false;
  return keys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key], null));
}

function sameInputs(recorded: readonly unknown[], current: readonly unknown[]): boolean {
  return recorded.length === current.length && recorded.every((value, index) => sameValue(value, current[index], 'entityIds'));
}

/**
 * The entities of an owner: those of `previousEntityIds` in `doc` when they were evaluated from `inputs` (deep equality, `entityIds` of
 * every input ignored) under the same units, else `evaluate()` (registered for the next regeneration).
 * @invariant `inputs` must list everything `evaluate` reads apart from `doc.units`; a missing dependency is a stale-geometry bug
 */
export function memoizedEvaluation(
  doc: Pick<CadDocument, 'entities' | 'units'>,
  previousEntityIds: readonly string[] | undefined,
  inputs: readonly unknown[],
  evaluate: () => Entity[],
): Entity[] {
  const reused = reusable(doc, previousEntityIds, inputs);
  if (reused) return reused;
  const generated = evaluate();
  if (generated.length === 0) return generated;
  const record: Provenance = { inputs, units: doc.units, count: generated.length };
  for (const entity of generated) provenance.set(entity, record);
  return generated;
}

function reusable(
  doc: Pick<CadDocument, 'entities' | 'units'>,
  previousEntityIds: readonly string[] | undefined,
  inputs: readonly unknown[],
): Entity[] | null {
  if (previousEntityIds === undefined || previousEntityIds.length === 0) return null;
  const entities = previousEntityIds.map((id) => doc.entities[id]);
  const first = entities[0];
  const record = first === undefined ? undefined : provenance.get(first);
  if (record === undefined || record.count !== entities.length || record.units !== doc.units) return null;
  if (!entities.every((entity) => entity !== undefined && provenance.get(entity) === record)) return null;
  if (!sameInputs(record.inputs, inputs)) return null;
  return entities as Entity[];
}

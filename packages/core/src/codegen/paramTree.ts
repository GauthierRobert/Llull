/**
 * The params of a recorded sweep / loft step as a value tree whose numbers are Terms (bound to the `=expr` parameters that produced them),
 * so generated code can record the very command that built the solid.
 * @failure params that name other entities (a path curve, rails, section sketches, a surface) -> null: those entities are not in the code
 */

import type { ParamTree, Term, TracedCall } from './program';

/** Keys of the style params the generated helper takes as its own arguments (colour, name); an explicit id and layer travel with the params. */
const STYLE_KEYS: ReadonlySet<string> = new Set(['color', 'name']);

/** A param naming another entity: `pathId`, `guideIds`, `sectionIds`, `entityId`, ... */
const REFERENCE_KEY = /(^|[a-z])(Id|Ids)$/;

const child = (raw: unknown, key: string | number): unknown =>
  raw !== null && typeof raw === 'object' ? (raw as Record<string | number, unknown>)[key] : undefined;

function tree(value: unknown, raw: unknown, bind: (value: number, raw: unknown) => Term): ParamTree | null {
  if (typeof value === 'number') return Number.isFinite(value) ? { kind: 'term', term: bind(value, raw) } : null;
  if (typeof value === 'string') return { kind: 'text', value };
  if (typeof value === 'boolean' || value === null) return { kind: 'flag', value };
  if (Array.isArray(value)) {
    const items = value.map((item, i) => tree(item, child(raw, i), bind));
    return items.every((item): item is ParamTree => item !== null) ? { kind: 'list', items } : null;
  }
  if (typeof value !== 'object') return null;
  const entries: Array<readonly [string, ParamTree]> = [];
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === undefined) continue;
    if (REFERENCE_KEY.test(key) || key === 'entityId') return null;
    const made = tree(item, child(raw, key), bind);
    if (made === null) return null;
    entries.push([key, made]);
  }
  return { kind: 'map', entries };
}

/** The traced call of a `sweep_profile` / `loft_sections` step, or null when it cannot be replayed from the code alone. */
export function tracedCall(
  command: TracedCall['command'],
  params: unknown,
  raw: unknown,
  bind: (value: number, raw: unknown) => Term,
): TracedCall | null {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return null;
  const entries: Array<readonly [string, ParamTree]> = [];
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (value === undefined || STYLE_KEYS.has(key)) continue;
    if (key !== 'layerId' && REFERENCE_KEY.test(key)) return null;
    const made = tree(value, child(raw, key), bind);
    if (made === null) return null;
    entries.push([key, made]);
  }
  return { command, params: entries };
}

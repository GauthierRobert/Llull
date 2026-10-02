/**
 * Golden normalizer: serialize -> parse -> replace every generated id with a stable
 * token by order of first appearance, round numbers to 9 significant digits.
 * Independent of the exact id format: generated ids are discovered structurally
 * (map keys + `id` fields) AND via the current `nextId` pattern.
 */
import type { CadDocument } from '@core/model/types';
import { serializeDocument } from '@core/commands/persistence';

/** Legacy `prefix-<time36>-<counter36>` ids, step-scoped `prefix-<n>.<k>` ids, and `step-<n>`. */
const NEXT_ID_PATTERN =
  /[A-Za-z][A-Za-z0-9_]*-[0-9a-z]{6,}-[0-9a-z]+|[A-Za-z][A-Za-z0-9_]*-\d+\.\d+|step-\d+/;

function collectStructuralIds(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectStructuralIds(item, into);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  const ownId = record['id'];
  if (typeof ownId === 'string' && NEXT_ID_PATTERN.test(ownId)) into.add(ownId);
  for (const [key, child] of Object.entries(record)) {
    if (
      child !== null &&
      typeof child === 'object' &&
      !Array.isArray(child) &&
      (child as Record<string, unknown>)['id'] === key
    ) {
      into.add(key);
    }
    collectStructuralIds(child, into);
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function roundNumber(n: number): number {
  if (!Number.isFinite(n)) return n;
  const rounded = Number(n.toPrecision(9));
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function normalizeJson(parsed: unknown): unknown {
  const known = new Set<string>();
  collectStructuralIds(parsed, known);
  const alternatives = [...known].sort((a, b) => b.length - a.length).map(escapeRegExp);
  const pattern = new RegExp([...alternatives, NEXT_ID_PATTERN.source].join('|'), 'g');
  const tokens = new Map<string, string>();
  const tokenFor = (id: string): string => {
    let token = tokens.get(id);
    if (token === undefined) {
      token = `#${tokens.size + 1}`;
      tokens.set(id, token);
    }
    return token;
  };
  const replaceIds = (text: string): string => text.replace(pattern, (m) => tokenFor(m));

  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return replaceIds(value);
    if (typeof value === 'number') return roundNumber(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value)) {
        out[replaceIds(key)] = walk(child);
      }
      return out;
    }
    return value;
  };
  return walk(parsed);
}

export function normalize(doc: CadDocument): unknown {
  return normalizeJson(JSON.parse(serializeDocument(doc)));
}

/** Entities + draw order only — the part that must survive `replay_history`. */
export function normalizeGeometry(doc: CadDocument): unknown {
  return normalizeJson({ entities: doc.entities, order: doc.order });
}

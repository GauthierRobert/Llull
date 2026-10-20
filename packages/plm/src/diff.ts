/** Revision diff (FR-PLM-13, §5.4): per-category comparison of two frozen definitions (llull-document envelopes). */

import { canonicalJson } from '@lib/canonicalJson';
import { isRecord } from '@lib/isRecord';

type Table = Record<string, unknown>;

const table = (value: unknown): Table => (isRecord(value) ? value : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

interface IdDiff {
  readonly added: string[];
  readonly removed: string[];
  readonly changed: string[];
}

/** Keys present on one side only, and keys whose canonical values differ. */
function keyedDiff(from: Table, to: Table): IdDiff {
  return {
    added: Object.keys(to).filter((key) => !Object.hasOwn(from, key)),
    removed: Object.keys(from).filter((key) => !Object.hasOwn(to, key)),
    changed: Object.keys(to).filter((key) => Object.hasOwn(from, key) && canonicalJson(from[key]) !== canonicalJson(to[key])),
  };
}

const expressionOf = (parameter: unknown): string => String(table(parameter)['expression'] ?? '');

function parameterDiff(
  from: Table,
  to: Table,
): { added: string[]; removed: string[]; changed: { name: string; from: string; to: string }[] } {
  const diff = keyedDiff(from, to);
  return {
    added: diff.added,
    removed: diff.removed,
    changed: diff.changed.flatMap((name) =>
      expressionOf(from[name]) === expressionOf(to[name]) ? [] : [{ name, from: expressionOf(from[name]), to: expressionOf(to[name]) }],
    ),
  };
}

function historyDiff(
  from: unknown[],
  to: unknown[],
): { added: number; removed: number; edited: number; suppressed: number; steps: { id: string; change: string }[] } {
  const before = new Map(from.map((step) => [String(table(step)['id']), table(step)]));
  const after = new Map(to.map((step) => [String(table(step)['id']), table(step)]));
  const steps: { id: string; change: string }[] = [];
  for (const [id, step] of after) {
    const old = before.get(id);
    if (old === undefined) steps.push({ id, change: 'added' });
    else if (Boolean(old['suppressed']) !== Boolean(step['suppressed'])) steps.push({ id, change: 'suppressed' });
    else if (old['name'] !== step['name'] || canonicalJson(old['params']) !== canonicalJson(step['params']))
      steps.push({ id, change: 'edited' });
  }
  for (const id of before.keys()) if (!after.has(id)) steps.push({ id, change: 'removed' });
  const count = (change: string): number => steps.filter((step) => step.change === change).length;
  return { added: count('added'), removed: count('removed'), edited: count('edited'), suppressed: count('suppressed'), steps };
}

const titleBlocks = (sheets: Table): Table =>
  Object.fromEntries(Object.entries(sheets).map(([id, sheet]) => [id, table(sheet)['titleBlock']]));

/** What changed between the definitions of two envelopes `{ format, version, document }` (JSON as data). */
export function diffDocuments(from: unknown, to: unknown): Record<string, unknown> {
  const a = table(table(from)['document']);
  const b = table(table(to)['document']);
  const sheetsA = table(table(a['drawings'])['sheets']);
  const sheetsB = table(table(b['drawings'])['sheets']);
  const entities = keyedDiff(table(a['entities']), table(b['entities']));
  return {
    parameters: parameterDiff(table(a['parameters']), table(b['parameters'])),
    featureHistory: historyDiff(list(a['featureHistory']), list(b['featureHistory'])),
    entities: {
      ...entities,
      kinds: Object.fromEntries(
        [...entities.added, ...entities.changed].map((id) => [id, table(table(b['entities'])[id])['kind'] ?? null]),
      ),
    },
    materials: keyedDiff(table(a['materials']), table(b['materials'])),
    drawings: { titleBlocks: keyedDiff(titleBlocks(sheetsA), titleBlocks(sheetsB)) },
  };
}

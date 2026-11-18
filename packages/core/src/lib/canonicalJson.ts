/**
 * JSON text with object keys sorted at every depth, so equal data hashes equally whatever its key order.
 * The text is the contract of every content hash in llull: it is byte-identical to
 * `JSON.stringify(value, (k, v) => plain object ? Object.fromEntries(sorted entries) : v)` (pinned against that reference in
 * tests/unit/lib/canonicalJson.test.ts), written without a replacer call per value so a mesh-sized artifact costs one native pass.
 */

const ARRAY_INDEX = /^(?:0|[1-9]\d{0,9})$/;
const MAX_ARRAY_INDEX = 4294967294;

/** Integer-like keys enumerate first, ascending, on a JavaScript object, whatever order they were inserted in. */
const isArrayIndex = (key: string): boolean => ARRAY_INDEX.test(key) && Number(key) <= MAX_ARRAY_INDEX;

/** True when `value` holds no object whose keys could need sorting (and no `toJSON`), so the native serializer writes it as is. */
function needsNoSorting(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const entry: unknown = value[index];
    if (entry !== null && typeof entry === 'object' && !needsNoSorting(entry)) return false;
  }
  return true;
}

function sortedKeys(record: object): string[] {
  const keys = Object.keys(record);
  const indices: string[] = [];
  const names: string[] = [];
  for (const key of keys) (isArrayIndex(key) ? indices : names).push(key);
  if (indices.length === 0) return names.sort();
  indices.sort((a, b) => Number(a) - Number(b));
  return names.length === 0 ? indices : indices.concat(names.sort());
}

/** The JSON text of `value`, or undefined where JSON.stringify writes nothing (undefined, a function, a symbol). */
function write(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const converted: unknown =
    typeof (value as { toJSON?: unknown }).toJSON === 'function' ? (value as { toJSON: (key: string) => unknown }).toJSON(key) : value;
  if (converted === null || typeof converted !== 'object') return JSON.stringify(converted);
  if (Array.isArray(converted)) {
    if (needsNoSorting(converted)) return JSON.stringify(converted);
    const parts: string[] = [];
    for (let index = 0; index < converted.length; index += 1) parts.push(write(converted[index], String(index)) ?? 'null');
    return `[${parts.join(',')}]`;
  }
  const parts: string[] = [];
  for (const name of sortedKeys(converted)) {
    const text = write((converted as Record<string, unknown>)[name], name);
    if (text !== undefined) parts.push(`${JSON.stringify(name)}:${text}`);
  }
  return `{${parts.join(',')}}`;
}

export function canonicalJson(value: unknown): string {
  return write(value, '') as string;
}

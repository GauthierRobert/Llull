/**
 * Strict RFC 8785 canonical JSON (`jcsJson`: PLM release hash, manifests, audit chain, signed payloads; `canonicalJson` keeps the legacy key order of
 * every stored hash): object keys sorted by UTF-16 code units at every depth, no whitespace, ECMAScript string and number
 * serialization, `-0` written as `0`, `undefined` / function properties omitted. Equal data serializes (and hashes) equally whatever its
 * key order, including integer-like keys (which a plain object would reorder numerically).
 * @invariant a non-finite number serializes as `null`, as in `JSON.stringify` (llull validation rejects non-finite values before they reach a hash)
 */
export function jcsJson(value: unknown): string {
  return serialize(value) ?? 'null';
}

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function serialize(value: unknown): string | undefined {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
    case 'number':
      return JSON.stringify(value);
    case 'bigint':
      return JSON.stringify(value.toString());
    case 'object':
      break;
    default:
      return undefined;
  }
  const json = (value as { toJSON?: unknown }).toJSON;
  if (typeof json === 'function') return serialize((json as () => unknown).call(value));
  if (Array.isArray(value)) return `[${value.map((entry) => serialize(entry) ?? 'null').join(',')}]`;
  const parts: string[] = [];
  for (const key of Object.keys(value).sort(compareCodeUnits)) {
    const entry = serialize((value as Record<string, unknown>)[key]);
    if (entry !== undefined) parts.push(`${JSON.stringify(key)}:${entry}`);
  }
  return `{${parts.join(',')}}`;
}

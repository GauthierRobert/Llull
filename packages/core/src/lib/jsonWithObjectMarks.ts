/**
 * `JSON.stringify(value, replacer)` for a replacer that only ever substitutes a string for some nested objects, without the replacer call
 * per number that makes the native form crawl on mesh-sized arrays: an array holding no object is written in one native pass.
 * Byte-identical to `JSON.stringify(value, (key, entry) => key !== '' && typeof entry === 'object' && entry !== null &&
 * mark(entry) !== undefined ? mark(entry) : entry)` (pinned in tests/unit/lib/jsonWithObjectMarks.test.ts).
 */

/** True when `value` holds no non-array object at any depth, so no mark can apply inside it. */
function holdsNoObject(value: readonly unknown[]): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const entry: unknown = value[index];
    if (entry === null || typeof entry !== 'object') continue;
    if (!Array.isArray(entry) || !holdsNoObject(entry)) return false;
  }
  return true;
}

function write(value: unknown, key: string, mark: (entry: object) => string | undefined): string | undefined {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const converted: unknown =
    typeof (value as { toJSON?: unknown }).toJSON === 'function' ? (value as { toJSON: (key: string) => unknown }).toJSON(key) : value;
  if (converted === null || typeof converted !== 'object') return JSON.stringify(converted);
  const substitute = key === '' ? undefined : mark(converted);
  if (substitute !== undefined) return JSON.stringify(substitute);
  if (Array.isArray(converted)) {
    if (holdsNoObject(converted)) return JSON.stringify(converted);
    const parts: string[] = [];
    for (let index = 0; index < converted.length; index += 1) parts.push(write(converted[index], String(index), mark) ?? 'null');
    return `[${parts.join(',')}]`;
  }
  const parts: string[] = [];
  for (const name of Object.keys(converted)) {
    const text = write((converted as Record<string, unknown>)[name], name, mark);
    if (text !== undefined) parts.push(`${JSON.stringify(name)}:${text}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * @param mark the string that stands for a nested object (undefined = write the object itself); never asked for the root value or
 *   for the value of a property named ''
 */
export function jsonWithObjectMarks(value: unknown, mark: (entry: object) => string | undefined): string {
  return write(value, '', mark) as string;
}

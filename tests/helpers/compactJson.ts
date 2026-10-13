/** JSON with nesting broken onto lines only down to `depth`; deeper values are one line each. */
export function compactJson(value: unknown, depth: number, indent = ''): string {
  if (depth <= 0 || value === null || typeof value !== 'object') return JSON.stringify(value);
  const inner = indent + '  ';
  const entries = Array.isArray(value)
    ? value.map((item) => inner + compactJson(item, depth - 1, inner))
    : Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => `${inner}${JSON.stringify(key)}: ${compactJson(item, depth - 1, inner)}`);
  if (entries.length === 0) return Array.isArray(value) ? '[]' : '{}';
  const [open, close] = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
  return `${open}\n${entries.join(',\n')}\n${indent}${close}`;
}

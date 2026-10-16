/** JSON text with object keys sorted at every depth, so equal data hashes equally whatever its key order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry !== null && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : entry,
  );
}

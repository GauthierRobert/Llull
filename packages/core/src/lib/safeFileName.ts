/**
 * @layer lib
 * @pure
 */

/** Reduce a user string to a safe download basename: [A-Za-z0-9._-], max 64 chars, no leading dot. */
export function safeFileName(raw: unknown, fallback = 'llull'): string {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+/, '')
    .slice(0, 64);
  return cleaned.length > 0 ? cleaned : fallback;
}

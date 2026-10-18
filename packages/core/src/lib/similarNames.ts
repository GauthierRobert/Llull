/** "Did you mean" ranking for snake_case names: typo distance first, then shared `_`-separated words. */

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current.push(Math.min(substitution, (previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

const words = (name: string): string[] =>
  name
    .toLowerCase()
    .split(/[_\s-]+/)
    .filter(Boolean);

/**
 * Up to `limit` of `candidates` closest to `name`: names within typo distance (closest first), then names sharing the most words
 * (`draw_circle` -> `draw_arc`, `add_circle`), ties by distance then name. @pure
 */
export function similarNames(name: string, candidates: readonly string[], limit = 3): string[] {
  const wanted = name.toLowerCase();
  const maxDistance = Math.max(2, Math.floor(wanted.length / 3));
  const wantedWords = new Set(words(wanted));
  const scored = candidates.map((candidate) => ({
    candidate,
    distance: editDistance(wanted, candidate.toLowerCase()),
    shared: words(candidate).filter((word) => wantedWords.has(word)).length,
  }));
  const byName = (a: { candidate: string }, b: { candidate: string }): number => a.candidate.localeCompare(b.candidate);
  const typos = scored.filter((s) => s.distance <= maxDistance).sort((a, b) => a.distance - b.distance || byName(a, b));
  const overlap = scored
    .filter((s) => s.distance > maxDistance && s.shared > 0)
    .sort((a, b) => b.shared - a.shared || a.distance - b.distance || byName(a, b));
  return [...typos, ...overlap].slice(0, limit).map((s) => s.candidate);
}

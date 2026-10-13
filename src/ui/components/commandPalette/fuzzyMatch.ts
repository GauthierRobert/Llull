// Palette ranking: every token must match (substring, else in-order subsequence); prefix / word-start hits rank higher.

/** 0 = no match. */
function scoreToken(token: string, text: string): number {
  const index = text.indexOf(token);
  if (index === 0) return 100;
  if (index > 0) {
    const previous = text[index - 1] ?? '';
    return /[\s_\-/.(]/.test(previous) ? 80 : 50;
  }
  let cursor = 0;
  let gaps = 0;
  for (const char of token) {
    const found = text.indexOf(char, cursor);
    if (found === -1) return 0;
    gaps += found - cursor;
    cursor = found + 1;
  }
  return Math.max(1, 30 - gaps);
}

/** @invariant blank query -> 1 @failure a token unmatched in label and keywords -> 0 */
export function fuzzyScore(query: string, label: string, keywords = ''): number {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 1;
  const primary = label.toLowerCase();
  const secondary = keywords.toLowerCase();
  let total = 0;
  for (const token of tokens) {
    const labelScore = scoreToken(token, primary);
    // Keyword hits count, but less than label hits; scattered subsequences only count on the label.
    const keywordScore = secondary.includes(token) ? scoreToken(token, secondary) * 0.6 : 0;
    const best = Math.max(labelScore * 1.2, keywordScore);
    if (best === 0) return 0;
    total += best;
  }
  return total;
}

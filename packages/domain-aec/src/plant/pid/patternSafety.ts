/**
 * Safety of a stored tag pattern (`plant.pid.tagFormats.*.pattern`, plant 04 PID): it comes from a file and will be run against tags by `check_pid` /
 * `add_pid_*` (M3 / M4), and the JS regex engine backtracks. M1 refuses the shapes that can blow up: long patterns, backreferences, lookarounds, and a
 * quantified group that itself contains a quantifier (`(a+)+`, `(\d*)*`, `(x{2,})*`).
 * M4 must still (1) match only against tags of at most 64 characters (so any residual polynomial backtracking is bounded), and (2) prefer the bounded tag
 * grammar of TECHNICAL_SPEC §5.1 over a free pattern; alternations that overlap under a quantifier (`(a|a)*`) are NOT detected here.
 */

export const MAX_TAG_PATTERN_LENGTH = 200;

const BACKREFERENCE = /\\[1-9k]/;
const LOOKAROUND = /\(\?<?[=!]/;
/** A group whose body has a quantifier and which is itself quantified (`*`, `+`, `{n,}`; `?` and `{n}` / `{n,m}` stay bounded enough). */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*(?:[*+]|\{\d+,\d*\})(?:[^()\\]|\\.)*\)(?:[*+]|\{\d+,\d*\})/;

/** Errors for `pattern` (empty when it compiles and passes the shape checks). */
export function tagPatternErrors(pattern: string, path: string): string[] {
  if (pattern.length > MAX_TAG_PATTERN_LENGTH) return [`${path} is longer than ${MAX_TAG_PATTERN_LENGTH} characters`];
  if (BACKREFERENCE.test(pattern)) return [`${path} must not use backreferences`];
  if (LOOKAROUND.test(pattern)) return [`${path} must not use lookahead or lookbehind`];
  if (NESTED_QUANTIFIER.test(pattern)) return [`${path} has a quantified group that contains a quantifier (catastrophic backtracking)`];
  try {
    new RegExp(pattern);
  } catch {
    return [`${path} must be a regular expression`];
  }
  return [];
}

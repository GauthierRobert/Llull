/**
 * Safety of a stored tag pattern (`plant.pid.tagFormats.*.pattern`, plant 04 PID): it comes from a file and will be run against tags by `check_pid` /
 * `add_pid_*` (M3 / M4), and the JS regex engine backtracks. M1 refuses the shapes that can blow up: long patterns, backreferences, lookarounds, and a
 * repeated group (`*`, `+`, `{n,}`, `{n,m}`) that contains a quantifier at any depth (`(a+)+`, `((a)+)+`, `(?:(a+))+`, `(x{2,})*`, `(a{1,30})+`; `?` counts
 * as a quantifier inside, a fixed `{n}` does not).
 * M4 must still (1) match only against tags of at most 64 characters (so any residual polynomial backtracking is bounded), and (2) prefer the bounded tag
 * grammar of TECHNICAL_SPEC §5.1 over a free pattern; alternations that overlap under a quantifier (`(a|a)*`) are NOT detected here.
 */

export const MAX_TAG_PATTERN_LENGTH = 200;

const BACKREFERENCE = /\\[1-9k]/;
const LOOKAROUND = /\(\?<?[=!]/;
const BOUNDED_BRACES = /^\{\d+(,\d*)?\}/;

/** Length of a `{n}` / `{n,}` / `{n,m}` quantifier at `at` (0 when the brace is a literal) and whether it repeats without a fixed count. */
function braces(pattern: string, at: number): { length: number; open: boolean } {
  const match = BOUNDED_BRACES.exec(pattern.slice(at, at + 24));
  return match ? { length: match[0].length, open: match[1] !== undefined } : { length: 0, open: false };
}

/** True when the character at `at` starts a quantifier that can repeat more than once (`*`, `+`, `{n,}`, `{n,m}`). */
const repeatsAt = (pattern: string, at: number): boolean => {
  const char = pattern[at];
  return char === '*' || char === '+' || (char === '{' && braces(pattern, at).open);
};

/**
 * Linear scan for a quantified group that contains a quantifier at any depth (`(a+)+`, `((a)+)+`, `(?:(a+))+`, `(a{1,30})+`): escapes and
 * [...] classes are skipped, each open group carries a "contains a quantifier" flag that is passed to its parent when it closes. `{n}` alone is not a quantifier.
 */
function hasNestedQuantifier(pattern: string): boolean {
  const groups: boolean[] = [];
  const mark = (): void => {
    if (groups.length > 0) groups[groups.length - 1] = true;
  };
  for (let at = 0; at < pattern.length; at++) {
    const char = pattern[at];
    if (char === '\\') at++;
    else if (char === '[') {
      for (at++; at < pattern.length && pattern[at] !== ']'; at++) if (pattern[at] === '\\') at++;
    } else if (char === '(') {
      groups.push(false);
      if (pattern[at + 1] === '?') {
        at++;
        if (pattern[at + 1] === ':') at++;
        else if (pattern[at + 1] === '<') at = pattern.indexOf('>', at) < 0 ? pattern.length : pattern.indexOf('>', at);
      }
    } else if (char === ')') {
      const inner = groups.pop() ?? false;
      if (inner) {
        if (repeatsAt(pattern, at + 1)) return true;
        mark();
      }
    } else if (char === '*' || char === '+' || char === '?') mark();
    else if (char === '{') {
      const { length, open } = braces(pattern, at);
      if (length > 0) {
        if (open) mark();
        at += length - 1;
      }
    }
  }
  return false;
}

/** Errors for `pattern` (empty when it compiles and passes the shape checks). */
export function tagPatternErrors(pattern: string, path: string): string[] {
  if (pattern.length > MAX_TAG_PATTERN_LENGTH) return [`${path} is longer than ${MAX_TAG_PATTERN_LENGTH} characters`];
  if (BACKREFERENCE.test(pattern)) return [`${path} must not use backreferences`];
  if (LOOKAROUND.test(pattern)) return [`${path} must not use lookahead or lookbehind`];
  if (hasNestedQuantifier(pattern)) return [`${path} has a quantified group that contains a quantifier (catastrophic backtracking)`];
  try {
    new RegExp(pattern);
  } catch {
    return [`${path} must be a regular expression`];
  }
  return [];
}

/**
 * @layer server
 * argv parsing for the `llull` CLI. No I/O.
 * @pure
 */

/** Flags that never take a value (`--json`, not `--json yes`). */
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  'json',
  'dry-run',
  'validate',
  'continue',
  'force',
  'help',
  'quiet',
  'app',
]);

export interface ParsedArgv {
  /** Non-flag arguments in order (the subcommand first). */
  readonly positionals: readonly string[];
  /** `--name value`, `--name=value`, or `true` for a boolean flag. */
  readonly flags: Readonly<Record<string, string | true>>;
}

/**
 * Split argv into positionals and flags. `--` ends flag parsing; `-h` is `--help`.
 * @failure a value flag at the end of argv (no value) -> recorded as `true`; `missingValueFlag` finds it
 */
export function parseArgv(argv: readonly string[]): ParsedArgv {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? '';
    if (arg === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (arg === '-h') {
      flags['help'] = true;
      continue;
    }
    if (!arg.startsWith('--') || arg.length === 2) {
      positionals.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const equals = body.indexOf('=');
    if (equals >= 0) {
      flags[body.slice(0, equals)] = body.slice(equals + 1);
      continue;
    }
    const next = argv[index + 1];
    if (BOOLEAN_FLAGS.has(body) || next === undefined || next.startsWith('--')) {
      flags[body] = true;
      continue;
    }
    flags[body] = next;
    index++;
  }
  return { positionals, flags };
}

/** Flags that need a value; `--save` alone is a mistake, never "on". */
const VALUE_FLAGS = ['doc', 'server', 'token', 'save', 'kernel', 'toolset', 'limit'] as const;

/** The first value flag given without a value, or undefined. */
export function missingValueFlag(parsed: ParsedArgv): string | undefined {
  return VALUE_FLAGS.find((name) => parsed.flags[name] === true);
}

/** A value flag as a string; `undefined` when absent or given without a value. */
export function stringFlag(parsed: ParsedArgv, name: string): string | undefined {
  const value = parsed.flags[name];
  return typeof value === 'string' ? value : undefined;
}

/** A boolean flag: present (with no value, or any value but `false`/`0`). */
export function booleanFlag(parsed: ParsedArgv, name: string): boolean {
  const value = parsed.flags[name];
  if (value === undefined) return false;
  return value === true || (value !== 'false' && value !== '0');
}

/** A JSON-looking token: object, array, quoted string. */
function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"');
}

/** `value` as JSON when it parses (numbers, booleans, arrays, objects, null), else the raw string. */
function scalarValue(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export type ParamsSource =
  | { readonly kind: 'json'; readonly text: string }
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'stdin' }
  | { readonly kind: 'pairs'; readonly params: Record<string, unknown> };

/**
 * Where a command's params come from: one JSON literal, `@file.json`, `-` (stdin), or
 * `key=value` pairs (each value parsed as JSON when it can be: `width=10 position=[0,0,5]`, except
 * keys in `stringKeys` — string-typed params — which stay raw: `name=123` is the string "123").
 * @failure a token that is none of these -> Error naming it
 */
export function paramsSource(
  tokens: readonly string[],
  stringKeys: ReadonlySet<string> = new Set(),
): ParamsSource {
  const first = tokens[0];
  if (first === undefined) return { kind: 'pairs', params: {} };
  if (tokens.length === 1) {
    if (first === '-') return { kind: 'stdin' };
    if (first.startsWith('@')) return { kind: 'file', path: first.slice(1) };
    if (looksLikeJson(first)) return { kind: 'json', text: first };
  }
  const params: Record<string, unknown> = {};
  for (const token of tokens) {
    const equals = token.indexOf('=');
    if (equals <= 0) {
      throw new Error(
        `"${token}" is not key=value; pass params as key=value pairs, one JSON object, @file.json or - (stdin).`,
      );
    }
    const key = token.slice(0, equals);
    const raw = token.slice(equals + 1);
    params[key] = stringKeys.has(key) ? raw : scalarValue(raw);
  }
  return { kind: 'pairs', params };
}

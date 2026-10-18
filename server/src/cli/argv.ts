/** argv parsing for the `llull` CLI. No I/O. */

import { DEFAULT_DOCUMENT_PATH } from '@mcp/documentFiles';

/** Flags that never take a value (`--json`, not `--json yes`). */
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set('json dry-run validate continue force help quiet progress app no-fit'.split(' '));

export interface ParsedArgv {
  readonly positionals: readonly string[]; // the subcommand first
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
const VALUE_FLAGS = ['doc', 'server', 'token', 'save', 'kernel', 'toolset', 'limit', 'timeout'] as const;

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
  return value !== undefined && value !== 'false' && value !== '0';
}

const looksLikeJson = (text: string): boolean => /^[{["]/.test(text.trim());

/** `value` as JSON when it parses, else the raw string. */
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
 * Params from one JSON literal, `@file.json`, `-` (stdin), or `key=value` pairs (values JSON-parsed when they can be,
 * except `stringKeys`: `name=123` stays "123").
 * @failure a token that is none of these -> Error naming it
 */
export function paramsSource(tokens: readonly string[], stringKeys: ReadonlySet<string> = new Set()): ParamsSource {
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
      throw new Error(`"${token}" is not key=value; pass params as key=value pairs, one JSON object, @file.json or - (stdin).`);
    }
    const key = token.slice(0, equals);
    params[key] = stringKeys.has(key) ? token.slice(equals + 1) : scalarValue(token.slice(equals + 1));
  }
  return { kind: 'pairs', params };
}

/** `--app` / `--server app`: the running desktop app, resolved from its discovery file. */
export const APP_SERVER = 'app';

export interface CliTarget {
  readonly server: string | undefined; // URL, `APP_SERVER`, or undefined = local doc file
  readonly doc: string;
}

/** The one target resolution: `--app` > `--server` > `$LLULL_SERVER`; doc: `--doc` > `$LLULL_DOC` > default. */
export function cliTarget(parsed: ParsedArgv, env: Readonly<Record<string, string | undefined>>): CliTarget {
  return {
    server: booleanFlag(parsed, 'app') ? APP_SERVER : (stringFlag(parsed, 'server') ?? env['LLULL_SERVER']),
    doc: stringFlag(parsed, 'doc') ?? env['LLULL_DOC'] ?? DEFAULT_DOCUMENT_PATH,
  };
}

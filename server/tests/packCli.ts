/**
 * Replays the machine-readable validation cases of the aerospace packs (`validation/expected_results.json`, AF-23) through the real `llull` CLI
 * entry (`runCli`, `--json`): fresh `--doc` per case, plan first, then the CLI lines, then the assertions of the pack (path / op / value / tol).
 * The pack's conventions: `<alias:NAME>` = first id of plan alias NAME, `<first:PATH>` = value at PATH of the previous call.
 */

import { expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setGeometryKernel, type GeometryKernel } from '@core/geometry/kernel';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { createNativeTestKernel } from './kernelTestSupport';
import { runCli, type CliIo } from '../src/cli/main';

/** Every `approx` assertion checked so far; `LLULL_PACK_MEASURE=<file>` makes packReplay07 write them (the numbers behind RESULTS.json). */
export interface Measurement {
  readonly label: string;
  readonly path: string;
  readonly actual: number;
  readonly expected: number;
  readonly error: number;
  readonly allowed: number;
}
export const measurements: Measurement[] = [];

export const REPO_ROOT = path.resolve(__dirname, '../..');

export interface PackAssertion {
  readonly path?: string;
  readonly op: string;
  readonly value?: unknown;
  readonly tol?: number;
  readonly tolKind?: 'abs' | 'rel';
  readonly on?: number;
  readonly unitWords?: readonly string[];
}

export interface PackCase {
  readonly vc?: string;
  readonly id?: string;
  readonly case?: string;
  readonly plan?: unknown;
  readonly plan_file?: string;
  readonly plan_validate_only?: unknown;
  readonly flags?: readonly string[];
  readonly cli?: readonly string[];
  readonly assert?: readonly PackAssertion[];
}

export interface CliCall {
  readonly code: number;
  readonly json: unknown;
  readonly stdout: string;
  readonly stderr: string;
  readonly ms: number;
}

const kernels: { manifold?: GeometryKernel; occt?: GeometryKernel } = {};
async function kernelFor(name: 'manifold' | 'occt'): Promise<GeometryKernel> {
  if (name === 'manifold') return (kernels.manifold ??= await createManifoldKernel());
  return (kernels.occt ??= createNativeTestKernel());
}

/** Shell-like split of a pack CLI line: single / double quotes group, a trailing `# comment` is dropped. */
export function splitWords(line: string): string[] {
  const words: string[] = [];
  let current = '';
  let quote: string | null = null;
  let started = false;
  for (const ch of line) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started || current !== '') words.push(current);
      current = '';
      started = false;
    } else if (ch === '#' && current === '' && !started) {
      break;
    } else {
      current += ch;
    }
  }
  if (started || current !== '') words.push(current);
  return words;
}

export interface Session {
  readonly dir: string;
  readonly doc: string;
  aliases: Record<string, string[]>;
  last: CliCall | null;
  /** index in `calls` of the first CLI line (the plan run, if any, comes before it; the pack's `on` counts CLI lines) */
  cliStart: number;
  readonly calls: CliCall[];
}

export const newSession = (): Session => {
  const dir = mkdtempSync(path.join(tmpdir(), 'llull-pack-'));
  return { dir, doc: path.join(dir, 'case.llull.json'), aliases: {}, last: null, cliStart: 0, calls: [] };
};

/** One `llull …` invocation (argv without the program name) against the session document; `--json` is added. */
export async function cliCall(session: Session, argv: readonly string[], stdin = ''): Promise<CliCall> {
  const kernelFlag = argv.indexOf('--kernel');
  const kernelName = kernelFlag >= 0 && argv[kernelFlag + 1] === 'occt' ? 'occt' : 'manifold';
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    readStdin: () => Promise.resolve(stdin),
    env: {},
    prepareKernel: async () => setGeometryKernel(await kernelFor(kernelName)),
  };
  const args = argv.map((word, index) => (argv[index - 1] === '--save' && !path.isAbsolute(word) ? path.join(session.dir, word) : word));
  const started = performance.now();
  const code = await runCli([...args, '--json', '--doc', session.doc], io);
  const stdout = out.join('\n');
  const json = ((): unknown => {
    try {
      return JSON.parse(stdout);
    } catch {
      return null;
    }
  })();
  const call: CliCall = { code, json, stdout, stderr: err.join('\n'), ms: performance.now() - started };
  session.last = call;
  session.calls.push(call);
  return call;
}

function substitute(word: string, session: Session): string {
  let result = word
    .replace(/^file=(docs\/)/, `file=${REPO_ROOT}/$1`)
    .replace(/<alias:(\w+)>/g, (_m, name: string) => session.aliases[name]?.[0] ?? `<unresolved alias ${name}>`);
  result = result.replace(/<first:([^>]+)>/g, (_m, pathText: string) => {
    const previous = session.calls.at(-1);
    const found = previous === undefined ? undefined : select(previous.json, pathText);
    return found === undefined ? `<unresolved ${pathText}>` : String(found);
  });
  return result;
}

const planArgs = (flags: readonly string[] | undefined): string[] => [...(flags ?? [])];

/** Runs the case plan (`plan`, `plan_file` or `plan_validate_only`) and records its aliases. */
export async function runPlan(session: Session, packCase: PackCase, extra: readonly string[] = []): Promise<CliCall | null> {
  const flags = planArgs(packCase.flags);
  let call: CliCall | null = null;
  if (packCase.plan_validate_only !== undefined) {
    call = await cliCall(session, ['run', '-', '--validate', ...flags, ...extra], JSON.stringify(packCase.plan_validate_only));
  } else if (packCase.plan !== undefined) {
    call = await cliCall(session, ['run', '-', ...flags, ...extra], JSON.stringify(packCase.plan));
  } else if (packCase.plan_file !== undefined) {
    call = await cliCall(session, ['run', path.resolve(REPO_ROOT, packCase.plan_file), ...flags, ...extra]);
  }
  const aliases = (call?.json as { aliases?: Record<string, string[]> } | null)?.aliases;
  if (aliases !== undefined) session.aliases = aliases;
  return call;
}

export async function runCliLines(session: Session, packCase: PackCase): Promise<void> {
  session.cliStart = session.calls.length;
  for (const line of packCase.cli ?? []) {
    const words = splitWords(line.replaceAll('<ctc-dir>', process.env['LLULL_QUALITY_DIR'] ?? '')).map((word) => substitute(word, session));
    expect(words[0], line).toBe('llull');
    await cliCall(session, words.slice(1));
  }
}

type Token =
  | { kind: 'key'; key: string }
  | { kind: 'index'; index: number }
  | { kind: 'all' }
  | { kind: 'filter'; field: string; value: string };

function tokens(pathText: string): Token[] {
  const found: Token[] = [];
  const pattern = /([^.[\]]+)|\[(\*|\d+|\?[^\]]+)\]/g;
  for (const match of pathText.matchAll(pattern)) {
    if (match[1] !== undefined) found.push({ kind: 'key', key: match[1] });
    else if (match[2] === '*') found.push({ kind: 'all' });
    else if (match[2]?.startsWith('?')) {
      const [field = '', value = ''] = match[2].slice(1).split('==');
      found.push({ kind: 'filter', field, value });
    } else found.push({ kind: 'index', index: Number(match[2]) });
  }
  return found;
}

/** Value at a pack path; arrays when the path fans out (`[*]`, `[?f==v]`). */
export function select(root: unknown, pathText: string): unknown {
  let current: unknown[] = [root];
  let fanned = false;
  for (const token of tokens(pathText)) {
    const next: unknown[] = [];
    for (const item of current) {
      if (token.kind === 'key') next.push((item as Record<string, unknown> | null | undefined)?.[token.key]);
      else if (token.kind === 'index') next.push((item as unknown[] | null | undefined)?.[token.index]);
      else if (Array.isArray(item)) {
        if (token.kind === 'all') next.push(...item);
        else next.push(...item.filter((element) => String((element as Record<string, unknown>)[token.field]) === token.value));
      }
    }
    if (token.kind === 'all' || token.kind === 'filter') fanned = true;
    current = next;
  }
  return fanned ? current : current[0];
}

const resolveValue = (call: CliCall, pathText: string): unknown => select(call.json, pathText);

export function checkAssertion(session: Session, assertion: PackAssertion, label: string): void {
  const call = assertion.on !== undefined ? session.calls[session.cliStart + assertion.on] : session.calls.at(-1);
  expect(call, `${label}: call ${String(assertion.on ?? 'last')} missing`).toBeDefined();
  const target = call as CliCall;
  const where = `${label} ${assertion.path ?? assertion.op}`;
  if (assertion.op === 'exit') return expect(target.code, `${where} (stdout: ${target.stdout.slice(0, 400)})`).toBe(assertion.value);
  if (assertion.op === 'durationBelowMs') return expect(target.ms, where).toBeLessThan(assertion.value as number);
  const actual = resolveValue(target, assertion.path ?? '');
  const expected = assertion.value;
  switch (assertion.op) {
    case 'eq':
      return expect(actual, where).toEqual(expected);
    case 'approx': {
      const value = Array.isArray(actual) && actual.length === 1 ? actual[0] : actual;
      expect(typeof value, `${where} is a number (got ${JSON.stringify(actual)})`).toBe('number');
      const tol = assertion.tol ?? 0;
      const error = Math.abs((value as number) - (expected as number));
      const allowed = assertion.tolKind === 'rel' ? tol * Math.abs(expected as number) : tol;
      measurements.push({ label, path: assertion.path ?? '', actual: value as number, expected: expected as number, error, allowed });
      return expect(error, `${where}: ${String(value)} vs ${String(expected)}`).toBeLessThanOrEqual(allowed);
    }
    case 'len':
      return expect((actual as unknown[] | undefined)?.length, where).toBe(expected);
    case 'exists':
      return expect(actual, where).not.toBeUndefined();
    case 'contains':
      if (typeof actual === 'string') return expect(actual, where).toContain(expected as string);
      return expect(actual as unknown[], where).toContainEqual(expected);
    case 'notContains':
      return expect(actual as unknown[], where).not.toContainEqual(expected);
    default:
      throw new Error(`${where}: unknown pack op ${assertion.op}`);
  }
}

const writeTemp = (session: Session, name: string, content: string): string => {
  const file = path.join(session.dir, name);
  writeFileSync(file, content);
  return file;
};

let paramFileCounter = 0;
/** One registry command through the CLI with its params in a `@file` (JSON); `flags` follow it (e.g. `--kernel occt-native`). */
export async function cliExec(session: Session, name: string, params: unknown, flags: readonly string[] = []): Promise<CliCall> {
  const file = writeTemp(session, `params-${paramFileCounter++}.json`, JSON.stringify(params));
  return cliCall(session, [name, `@${file}`, ...flags]);
}

/** A build_project plan (`actions`) through `llull run -`; its aliases are added to the session. */
export async function cliPlan(session: Session, actions: unknown, flags: readonly string[] = []): Promise<CliCall> {
  const call = await cliCall(session, ['run', '-', ...flags], JSON.stringify(actions));
  const aliases = (call.json as { aliases?: Record<string, string[]> } | null)?.aliases;
  if (aliases !== undefined) session.aliases = { ...session.aliases, ...aliases };
  return call;
}

/** Replay one pack case end to end: plan, CLI lines, then the plain assertions (specials are handled by the caller). */
export async function replayCase(
  packCase: PackCase,
  label: string,
  special?: (session: Session, assertion: PackAssertion) => boolean,
): Promise<Session> {
  const session = newSession();
  await runPlan(session, packCase);
  await runCliLines(session, packCase);
  for (const assertion of packCase.assert ?? []) {
    if (special?.(session, assertion) === true) continue;
    checkAssertion(session, assertion, label);
  }
  return session;
}

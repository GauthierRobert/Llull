/**
 * `llull run_benchmarks` (PHY-00 FR-VNV-11): host transport that discovers every physics pack's `expected_results.json` (plus the
 * aerospace files listed in quality/physics-benchmarks.json, read through the 05 adapter), runs each case's harness recipe in-process or
 * takes the value a pack's unit test measured (`.cache/quality-physics/unit-measurements.jsonl`), and judges it with the core judge.
 * No V&V arithmetic here: the judge and the schema are core (`@cae/vnv`).
 */
import fs from 'fs';
import path from 'path';
import { execute, getCommand } from '@core/commands/registry';
import { adaptLegacyCase, expectedResultsFileSchema, normaliseGrade, type ExpectedCase, type JsonValue } from '@cae/vnv/expected';
import { judgeCase, type Measured, type Verdict } from '@cae/vnv/judge';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { paramsSource } from './argv';

interface BenchmarkRow {
  readonly pack: string;
  readonly caseId: string;
  readonly grade: string;
  readonly verdict: Verdict;
  readonly code?: string;
  readonly quantity: string;
  readonly expected: JsonValue;
  readonly unit: string;
  readonly measured?: Measured;
  readonly relError?: number;
  readonly absError?: number;
  readonly durationMs: number;
}

export interface BenchmarkReport {
  readonly rows: readonly BenchmarkRow[];
  readonly counts: Readonly<Record<Verdict, number>>;
  readonly gate: 'pass' | 'fail';
  readonly toolchain: Readonly<Record<string, string>>;
}

export interface BenchmarkOptions {
  readonly root: string;
  readonly packs?: readonly string[];
  readonly grades?: readonly string[];
  readonly caseIds?: readonly string[];
  readonly measurementsFile?: string;
}

interface PackFile {
  readonly pack: string;
  readonly dir: string;
  readonly cases: readonly unknown[];
  readonly invalid?: string;
}

interface ExtraFile {
  readonly pack: string;
  readonly file: string;
  readonly adapter: 'fea-legacy';
  readonly proves?: Readonly<Record<string, readonly string[]>>;
}

const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;

function discover(root: string): PackFile[] {
  const physics = path.join(root, 'docs', 'physics');
  const packs: PackFile[] = [];
  for (const pack of fs.readdirSync(physics).sort()) {
    const file = path.join(physics, pack, 'validation', 'expected_results.json');
    if (!fs.existsSync(file)) continue;
    const parsed = expectedResultsFileSchema.safeParse(readJson(file));
    packs.push(
      parsed.success
        ? { pack, dir: path.dirname(file), cases: (readJson(file) as { cases: unknown[] }).cases }
        : { pack, dir: path.dirname(file), cases: [], invalid: parsed.error.issues[0]?.path.join('.') ?? '' },
    );
  }
  const extras = path.join(root, 'quality', 'physics-benchmarks.json');
  if (fs.existsSync(extras)) {
    for (const extra of (readJson(extras) as { files: ExtraFile[] }).files) {
      const file = path.join(root, extra.file);
      const raw = readJson(file) as { cases: unknown[] };
      const cases = raw.cases.map((c) => {
        const id = (c as { id?: unknown }).id;
        return adaptLegacyCase(c, typeof id === 'string' ? (extra.proves?.[id] ?? []) : []) ?? c;
      });
      packs.push({ pack: extra.pack, dir: path.dirname(file), cases });
    }
  }
  return packs;
}

/** `{ pack, caseId, measured }` lines written by the packs' unit tests; the last line per case wins. */
function readMeasurements(file: string | undefined): Map<string, Measured> {
  const measurements = new Map<string, Measured>();
  if (file === undefined || !fs.existsSync(file)) return measurements;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const entry = JSON.parse(line) as { pack: string; caseId: string; measured: Measured };
    measurements.set(`${entry.pack}/${entry.caseId}`, entry.measured);
  }
  return measurements;
}

const pointerGet = (value: unknown, pointer: string): unknown =>
  pointer
    .split('/')
    .slice(1)
    .map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce<unknown>(
      (node, key) => (node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined),
      value,
    );

/** Run a harness recipe: optional plan (build_project), then each `command k=v` call; the pointer reads the last result. */
function runHarness(dir: string, expected: ExpectedCase): Measured | { readonly error: string } {
  const harness = expected.harness;
  if (harness === undefined) return { error: 'VNV_NO_HARNESS' };
  let doc: CadDocument = createEmptyDocument();
  let last: unknown = undefined;
  if (harness.plan !== undefined) {
    const planned = execute(doc, 'build_project', { actions: readJson(path.join(dir, harness.plan)) });
    if (planned.rejected === true) return { error: 'VNV_LEVEL_FAILED' };
    doc = planned.document;
    last = planned;
  }
  for (const call of harness.calls) {
    const [name, ...tokens] = call.trim().split(/\s+/);
    if (name === undefined || tokens.some((token) => token.includes('$'))) return { error: 'VNV_HARNESS_UNSUPPORTED' };
    const properties = getCommand(name)?.paramsSchema.properties ?? {};
    const stringKeys = new Set(Object.keys(properties).filter((key) => properties[key]?.type === 'string'));
    const source = paramsSource(tokens, stringKeys);
    const result = execute(doc, name, source.kind === 'pairs' ? source.params : JSON.parse(source.kind === 'json' ? source.text : '{}'));
    if (result.rejected === true) return { error: 'VNV_LEVEL_FAILED' };
    doc = result.document;
    last = result;
  }
  const value = pointerGet(last, harness.pointer);
  return value === undefined ? { error: 'VNV_RESULT_MISSING' } : { value: value as JsonValue, unit: expected.unit };
}

const selected = (list: readonly string[] | undefined, value: string): boolean => list === undefined || list.includes(value);

/** Run and judge every selected case. Gate fails on any grade-A `fail` or `error` (and on an invalid pack file). */
export function runBenchmarks(options: BenchmarkOptions): BenchmarkReport {
  const measurements = readMeasurements(options.measurementsFile);
  const rows: BenchmarkRow[] = [];
  for (const file of discover(options.root)) {
    if (!selected(options.packs, file.pack)) continue;
    if (file.invalid !== undefined) {
      rows.push({
        pack: file.pack,
        caseId: '*',
        grade: 'A',
        verdict: 'error',
        code: 'VNV_EXPECTED_INVALID',
        quantity: `file invalid at '${file.invalid}'`,
        expected: null,
        unit: '-',
        durationMs: 0,
      });
      continue;
    }
    for (const raw of file.cases) {
      const started = Date.now();
      const parsed = expectedResultsFileSchema.shape.cases.element.safeParse(raw);
      if (!parsed.success) {
        const id = (raw as { id?: unknown }).id;
        rows.push({
          pack: file.pack,
          caseId: typeof id === 'string' ? id : '?',
          grade: 'A',
          verdict: 'error',
          code: 'VNV_EXPECTED_INVALID',
          quantity: '',
          expected: null,
          unit: '-',
          durationMs: 0,
        });
        continue;
      }
      const expected = parsed.data;
      const grade = normaliseGrade(expected.grade) ?? expected.grade;
      if (!selected(options.caseIds, expected.id) || !selected(options.grades, grade)) continue;
      const base = {
        pack: file.pack,
        caseId: expected.id,
        grade,
        quantity: expected.quantity,
        expected: expected.value,
        unit: expected.unit,
      };
      const untestable = judgeCase(expected, null);
      if (untestable.verdict === 'skip') {
        rows.push({ ...base, verdict: 'skip', code: 'VNV_EXPECTED_TBD', durationMs: 0 });
        continue;
      }
      const measured = expected.harness !== undefined ? runHarness(file.dir, expected) : measurements.get(`${file.pack}/${expected.id}`);
      const durationMs = Date.now() - started;
      if (measured === undefined) {
        rows.push({ ...base, verdict: 'skip', code: 'VNV_NO_HARNESS', durationMs });
        continue;
      }
      if ('error' in measured) {
        rows.push({ ...base, verdict: 'error', code: measured.error, durationMs });
        continue;
      }
      const judgement = judgeCase(expected, measured);
      rows.push({
        ...base,
        verdict: judgement.verdict,
        ...(judgement.code !== undefined ? { code: judgement.code } : {}),
        measured,
        ...(judgement.relError !== undefined ? { relError: judgement.relError } : {}),
        ...(judgement.absError !== undefined ? { absError: judgement.absError } : {}),
        durationMs,
      });
    }
  }
  rows.sort((a, b) => (a.pack === b.pack ? a.caseId.localeCompare(b.caseId) : a.pack.localeCompare(b.pack)));
  const counts: Record<Verdict, number> = { pass: 0, fail: 0, warn: 0, skip: 0, error: 0 };
  for (const row of rows) counts[row.verdict] += 1;
  const gate = rows.some((row) => row.grade === 'A' && (row.verdict === 'fail' || row.verdict === 'error')) ? 'fail' : 'pass';
  return { rows, counts, gate, toolchain: { node: process.version } };
}

function benchmarkMarkdown(report: BenchmarkReport): string {
  const lines = [
    '# Physics benchmarks',
    '',
    `Gate: **${report.gate}** — ${Object.entries(report.counts)
      .map(([verdict, n]) => `${n} ${verdict}`)
      .join(', ')}`,
    '',
    '| Pack | Case | Grade | Verdict | Code | Measured | Expected | Rel. error |',
    '| ---- | ---- | ----- | ------- | ---- | -------- | -------- | ---------- |',
  ];
  for (const row of report.rows) {
    if (row.verdict === 'skip') continue;
    const measured = row.measured === undefined ? '' : `${JSON.stringify(row.measured.value)} ${row.measured.unit}`;
    lines.push(
      `| ${row.pack} | ${row.caseId} | ${row.grade} | ${row.verdict} | ${row.code ?? ''} | ${measured} | ${JSON.stringify(row.expected)} ${row.unit} | ${row.relError?.toExponential(2) ?? ''} |`,
    );
  }
  lines.push('', `Skipped (TBD / grade C / no harness yet): ${report.counts.skip}`, '');
  return lines.join('\n');
}

const listParam = (params: Readonly<Record<string, unknown>>, key: string): string[] | undefined => {
  const value = params[key];
  if (value === undefined) return undefined;
  return (Array.isArray(value) ? value.map(String) : String(value).split(',')).map((part) => part.trim()).filter((part) => part !== '');
};

/** Walk up from `start` to the folder that holds docs/physics. */
function repoRootFrom(start: string): string | undefined {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'docs', 'physics'))) return dir;
    if (path.dirname(dir) === dir) return undefined;
  }
}

/**
 * `llull run_benchmarks [packs=a,b] [grades=A,B] [caseIds=…] [measurements=FILE] [root=DIR] [--save OUT.json] [--json]`.
 * @failure no docs/physics above the working directory -> usage text, exit 2; gate fail -> exit 1
 */
export function benchmarkCli(
  tokens: readonly string[],
  flags: { readonly json: boolean; readonly save?: string },
  io: { readonly stdout: (text: string) => void; readonly cwd: string },
): number {
  const source = paramsSource(tokens);
  const params = source.kind === 'pairs' ? source.params : {};
  const root = typeof params['root'] === 'string' ? path.resolve(io.cwd, params['root']) : repoRootFrom(io.cwd);
  if (root === undefined) {
    io.stdout('llull run_benchmarks: no docs/physics folder above the working directory; pass root=<repo>.');
    return 2;
  }
  const packs = listParam(params, 'packs');
  const grades = listParam(params, 'grades');
  const caseIds = listParam(params, 'caseIds');
  const measurements = params['measurements'];
  const report = runBenchmarks({
    root,
    ...(packs !== undefined ? { packs } : {}),
    ...(grades !== undefined ? { grades } : {}),
    ...(caseIds !== undefined ? { caseIds } : {}),
    measurementsFile:
      typeof measurements === 'string'
        ? path.resolve(io.cwd, measurements)
        : path.join(root, '.cache', 'quality-physics', 'unit-measurements.jsonl'),
  });
  if (flags.save !== undefined) {
    fs.mkdirSync(path.dirname(path.resolve(io.cwd, flags.save)), { recursive: true });
    fs.writeFileSync(path.resolve(io.cwd, flags.save), `${JSON.stringify(report, null, 1)}\n`);
    fs.writeFileSync(path.resolve(io.cwd, flags.save).replace(/\.json$/, '') + '.md', benchmarkMarkdown(report));
  }
  const counts = Object.entries(report.counts)
    .map(([verdict, n]) => `${n} ${verdict}`)
    .join(', ');
  io.stdout(
    flags.json
      ? JSON.stringify({ ok: report.gate === 'pass', summary: `run_benchmarks: gate ${report.gate} (${counts})`, data: report })
      : [
          `run_benchmarks: gate ${report.gate} (${counts})`,
          ...report.rows
            .filter((r) => r.verdict === 'fail' || r.verdict === 'error' || r.verdict === 'warn')
            .map((r) => `  ${r.verdict} ${r.pack} ${r.caseId} ${r.code ?? ''}`),
        ].join('\n'),
  );
  return report.gate === 'pass' ? 0 : 1;
}

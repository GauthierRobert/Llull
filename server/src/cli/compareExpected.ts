/**
 * `llull compare_expected` (PHY-00 harness, PHY-11 validation README "CLI harness"): judge ONE value of a saved `--json` answer (e.g. `llull creep_report
 * … --json > report.json`) against one case of a pack's `expected_results.json`, with the case's own tolerance and grade. No V&V arithmetic here: the
 * judge is core (`@cae/vnv`); this file only reads the two files and the pointer.
 */
import fs from 'fs';
import path from 'path';
import { expectedResultsFileSchema, judgeCase, type JsonValue, type Measured } from '@cae/index';
import { paramsSource } from './argv';
import { pointerGet } from './benchmarks';

const USAGE =
  'usage: llull compare_expected ANSWER.json EXPECTED_RESULTS.json CASE_ID [pointer=/data/...] [unit=U] [--json] ' +
  '(pointer: JSON pointer into the answer, -1 = last array item; default the case harness pointer)';

interface CompareIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly cwd: string;
}

/** A pointed value: a bare JSON value, or a `{ value, unit }` object whose unit wins over the case unit. */
function measuredOf(found: unknown, unit: string): Measured {
  if (found !== null && typeof found === 'object' && !Array.isArray(found) && 'value' in found) {
    const entry = found as { value: unknown; unit?: unknown };
    return { value: entry.value as JsonValue, unit: typeof entry.unit === 'string' ? entry.unit : unit };
  }
  return { value: found as JsonValue, unit };
}

const OPTION_KEYS: ReadonlySet<string> = new Set(['pointer', 'unit']);

const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;

/**
 * Exit 0 on pass / warn / skip, 1 on fail / error, 2 on a usage problem (missing argument, unreadable file, unknown case, no pointer).
 * @failure a pointer that reaches nothing -> the judge's verdict for no measurement (error VNV_RESULT_MISSING, exit 1; skip for a TBD / grade-C case)
 */
export function compareExpectedCli(tokens: readonly string[], flags: { readonly json: boolean }, io: CompareIo): number {
  const positional = tokens.filter((token) => !token.includes('='));
  const pairs = tokens.filter((token) => token.includes('='));
  const usage = (why: string): number => {
    io.stderr(`llull compare_expected: ${why}\n${USAGE}`);
    return 2;
  };
  const malformed = pairs.find((token) => token.startsWith('='));
  if (malformed !== undefined) return usage(`"${malformed}" is not key=value`);
  const unknown = pairs.map((token) => token.slice(0, token.indexOf('='))).filter((key) => !OPTION_KEYS.has(key));
  if (unknown.length > 0) return usage(`unknown option ${unknown.join(', ')} (only pointer= and unit=)`);
  const source = paramsSource(pairs, OPTION_KEYS);
  const params = source.kind === 'pairs' ? source.params : {};
  const [answerFile, expectedFile, caseId] = positional;
  if (answerFile === undefined || expectedFile === undefined || caseId === undefined) return usage('three arguments are required');
  let answer: unknown;
  let expectedRaw: unknown;
  try {
    answer = readJson(path.resolve(io.cwd, answerFile));
    expectedRaw = readJson(path.resolve(io.cwd, expectedFile));
  } catch (error) {
    return usage(`cannot read the files (${error instanceof Error ? error.message : String(error)})`);
  }
  const parsed = expectedResultsFileSchema.safeParse(expectedRaw);
  if (!parsed.success)
    return usage(`${expectedFile} is not an expected_results file (at '${parsed.error.issues[0]?.path.join('.') ?? ''}')`);
  const expected = parsed.data.cases.find((entry) => entry.id === caseId);
  if (expected === undefined) return usage(`no case '${caseId}' in ${expectedFile}`);
  const pointer = typeof params['pointer'] === 'string' ? params['pointer'] : expected.harness?.pointer;
  if (pointer === undefined) return usage(`case '${caseId}' has no harness pointer: pass pointer=/data/...`);
  const found = pointerGet(answer, pointer);
  const unit = typeof params['unit'] === 'string' ? params['unit'] : expected.unit;
  const measured = found === undefined ? null : measuredOf(found, unit);
  const judgement = judgeCase(expected, measured);
  const summary = `compare_expected ${parsed.data.pack} ${caseId}: ${judgement.verdict}${judgement.code !== undefined ? ` ${judgement.code}` : ''} — ${judgement.message}`;
  io.stdout(
    flags.json
      ? JSON.stringify({
          ok: judgement.verdict !== 'fail' && judgement.verdict !== 'error',
          summary,
          data: {
            pack: parsed.data.pack,
            caseId,
            pointer,
            expected: { value: expected.value, unit: expected.unit, tolerance: expected.tolerance, grade: expected.grade },
            measured,
            ...judgement,
          },
        })
      : summary,
  );
  return judgement.verdict === 'fail' || judgement.verdict === 'error' ? 1 : 0;
}

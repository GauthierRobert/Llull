/** Vitest globalSetup: counts the skips recorded by `requireTool`, prints them by tool, and fails the run when a required tool caused one. */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SKIP_RUN_ENV, TOOL_FAMILIES, skipRoot, type SkipRecord, type ToolFamily } from './requireTool';

const STALE_RUN_MS = 24 * 60 * 60 * 1000;
const ID_FAMILIES: readonly ToolFamily[] = ['python', 'native', 'oracle'];

/**
 * LLULL_REQUIRE_TOOLS is a comma list of tool families (`calculix`, `python`, `native`, `oracle`) or of exact tool ids a suite declared
 * (`python:ocp`, `native:llull-kernel`, `oracle:xmllint`). Anything else is reported in `unknown` (typo, wrong case, `calculix:x`).
 */
export function parseRequired(env: string | undefined): { entries: string[]; unknown: string[] } {
  const names = (env ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  const valid = (name: string): boolean => {
    if ((TOOL_FAMILIES as readonly string[]).includes(name)) return true;
    const [family, ...rest] = name.split(':');
    return (ID_FAMILIES as readonly string[]).includes(family ?? '') && rest.join(':') !== '';
  };
  return { entries: [...new Set(names.filter(valid))], unknown: names.filter((name) => !valid(name)) };
}

export function summarize(records: readonly SkipRecord[], required: readonly string[]): { line: string; failure: string | null } {
  const counts = new Map<ToolFamily, number>(TOOL_FAMILIES.map((family) => [family, 0]));
  for (const record of records) counts.set(record.family, (counts.get(record.family) ?? 0) + 1);
  const shown = TOOL_FAMILIES.filter((family) => family !== 'oracle' || (counts.get(family) ?? 0) > 0);
  const line = `skipped by tool: ${shown.map((family) => `${family} ${counts.get(family) ?? 0}`).join(', ')}`;
  const hits = (entry: string): SkipRecord[] => records.filter((record) => record.tool === entry || record.family === entry);
  const offenders = required.filter((entry) => hits(entry).length > 0);
  if (offenders.length === 0) return { line, failure: null };
  const names = [...new Set(offenders.flatMap((entry) => hits(entry).map((record) => record.tool)))].sort();
  return {
    line,
    failure: `TST_REQUIRED_TOOL_SKIPPED: LLULL_REQUIRE_TOOLS requires ${offenders.join(', ')} but suites were skipped for lack of ${names.join(', ')}`,
  };
}

function readRecords(directory: string): SkipRecord[] {
  let files: string[] = [];
  try {
    files = readdirSync(directory);
  } catch {
    return [];
  }
  return files.flatMap((file) =>
    readFileSync(join(directory, file), 'utf8')
      .split('\n')
      .filter((text) => text !== '')
      .map((text) => JSON.parse(text) as SkipRecord),
  );
}

function pruneStaleRuns(now: number): void {
  try {
    for (const name of readdirSync(skipRoot())) {
      const path = join(skipRoot(), name);
      if (now - statSync(path).mtimeMs > STALE_RUN_MS) rmSync(path, { recursive: true, force: true });
    }
  } catch {
    // No skip root yet, or a concurrent run removed an entry: nothing to prune.
  }
}

export default function setup(): () => void {
  const { entries, unknown } = parseRequired(process.env['LLULL_REQUIRE_TOOLS']);
  if (unknown.length > 0) {
    throw new Error(
      `TST_REQUIRE_TOOLS_UNKNOWN: LLULL_REQUIRE_TOOLS names ${unknown.join(', ')}; use calculix, python, native, oracle or an exact id (python:<capability>, native:<binary>, oracle:<program>)`,
    );
  }
  pruneStaleRuns(Date.now());
  const run = `${process.pid}-${Date.now()}`;
  process.env[SKIP_RUN_ENV] = run;
  const directory = join(skipRoot(), run);
  mkdirSync(directory, { recursive: true });
  return () => {
    const { line, failure } = summarize(readRecords(directory), entries);
    rmSync(directory, { recursive: true, force: true });
    process.stdout.write(`\n${line}\n`);
    if (failure !== null) {
      process.stderr.write(`${failure}\n`);
      process.exitCode = 1;
    }
  };
}

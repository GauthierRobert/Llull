/** Vitest globalSetup: counts the skips recorded by `requireTool`, prints them by tool, and fails the run when a required tool caused one. */
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SKIP_RUN_ENV, TOOL_FAMILIES, skipRoot, type SkipRecord, type ToolFamily } from './requireTool';

export function requiredFamilies(env: string | undefined): ToolFamily[] {
  const wanted = (env ?? '').split(',').map((name) => name.trim());
  return TOOL_FAMILIES.filter((family) => wanted.includes(family));
}

export function summarize(records: readonly SkipRecord[], required: readonly ToolFamily[]): { line: string; failure: string | null } {
  const counts = new Map<ToolFamily, number>(TOOL_FAMILIES.map((family) => [family, 0]));
  for (const record of records) counts.set(record.family, (counts.get(record.family) ?? 0) + 1);
  const shown = TOOL_FAMILIES.filter((family) => family !== 'oracle' || (counts.get(family) ?? 0) > 0);
  const line = `skipped by tool: ${shown.map((family) => `${family} ${counts.get(family) ?? 0}`).join(', ')}`;
  const offenders = required.filter((family) => (counts.get(family) ?? 0) > 0);
  if (offenders.length === 0) return { line, failure: null };
  const names = [...new Set(records.filter((record) => offenders.includes(record.family)).map((record) => record.tool))].sort();
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

export default function setup(): () => void {
  const run = `${process.pid}-${Date.now()}`;
  process.env[SKIP_RUN_ENV] = run;
  const directory = join(skipRoot(), run);
  mkdirSync(directory, { recursive: true });
  return () => {
    const { line, failure } = summarize(readRecords(directory), requiredFamilies(process.env['LLULL_REQUIRE_TOOLS']));
    rmSync(directory, { recursive: true, force: true });
    process.stdout.write(`\n${line}\n`);
    if (failure !== null) {
      process.stderr.write(`${failure}\n`);
      process.exitCode = 1;
    }
  };
}

/**
 * Optional schema oracle for IFC files (plant 08 DAT VC-DAT-06): `python -I -m ifcopenshell.validate --rules --json <file>` checks the file against the
 * compiled IFC schema and its EXPRESS WHERE rules. Python and IfcOpenShell are not part of llull: when either is absent, or the run fails to start or times
 * out, the answer is `skipped` with the reason and the caller skips its test; it never fails. Local process only, no network; the interpreter runs isolated
 * (`-I`) in a fresh empty directory that holds only the file under test.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export type IfcRulesResult =
  | { readonly status: 'skipped'; readonly reason: string }
  | { readonly status: 'ran'; readonly interpreter: string; readonly errors: readonly string[] };

export interface ProcessAnswer {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly failedToStart: boolean;
}

/** Runs `command args` in `cwd`; injectable so the skip logic is testable without Python. */
export type ProcessRunner = (command: string, args: readonly string[], cwd: string) => ProcessAnswer;

const INTERPRETERS = ['python3', 'python'] as const;
const TIMEOUT_MS = 120_000;

export const localRunner: ProcessRunner = (command, args, cwd) => {
  const answer = spawnSync(command, [...args], { cwd, encoding: 'utf8', timeout: TIMEOUT_MS, windowsHide: true });
  return { status: answer.status, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '', failedToStart: answer.error !== undefined };
};

/** The first interpreter that imports `ifcopenshell.validate`, or the reason none does. */
export function findValidator(run: ProcessRunner, cwd: string): { interpreter: string } | { reason: string } {
  const reasons: string[] = [];
  for (const interpreter of INTERPRETERS) {
    const probe = run(interpreter, ['-I', '-c', 'import ifcopenshell, ifcopenshell.validate'], cwd);
    if (probe.failedToStart) reasons.push(`${interpreter} not found`);
    else if (probe.status !== 0) reasons.push(`${interpreter} cannot import ifcopenshell.validate`);
    else return { interpreter };
  }
  return { reason: `IfcOpenShell is not available (${reasons.join('; ')})` };
}

/** The `attribute` (rule name) or message of every error line of `ifcopenshell.validate --json`. */
export function errorsOf(stdout: string): string[] {
  const errors: string[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const entry = JSON.parse(line) as { level?: unknown; attribute?: unknown; message?: unknown };
      if (entry.level === 'error') errors.push(String(entry.attribute ?? entry.message));
    } catch {
      errors.push(`unreadable validator line: ${line.slice(0, 80)}`);
    }
  }
  return errors;
}

/** Validates the IFC text against its schema and rules with IfcOpenShell when it is installed. */
export function validateIfcRules(ifc: string, run: ProcessRunner = localRunner): IfcRulesResult {
  const directory = mkdtempSync(path.join(tmpdir(), 'llull-ifc-'));
  try {
    const found = findValidator(run, directory);
    if ('reason' in found) return { status: 'skipped', reason: found.reason };
    const file = path.join(directory, 'model.ifc');
    writeFileSync(file, ifc, 'utf8');
    const answer = run(found.interpreter, ['-I', '-m', 'ifcopenshell.validate', '--rules', '--json', file], directory);
    if (answer.failedToStart || (answer.status === null && answer.stdout === ''))
      return { status: 'skipped', reason: 'the validator did not finish' };
    return { status: 'ran', interpreter: found.interpreter, errors: errorsOf(answer.stdout) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

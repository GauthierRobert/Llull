/**
 * Plant 08 DAT-M3, VC-DAT-06: the optional IfcOpenShell oracle (`tests/production/oracle/ifcRules.ts`). The skip logic and the output reader run against a fake
 * process runner; the real validation of the SC-DAT-01 export and of the pack's negative file runs only when Python with IfcOpenShell is installed (skipped
 * with the reason otherwise, never failed).
 */

import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import {
  errorsOf,
  findValidator,
  localRunner,
  validateIfcRules,
  type ProcessAnswer,
  type ProcessRunner,
} from '../../../production/oracle/ifcRules';
import { referenceIfc, scDat01, stamp } from './ifcFixtures';

const answer = (status: number | null, stdout = '', failedToStart = false): ProcessAnswer => ({
  status,
  stdout,
  stderr: '',
  failedToStart,
});

describe('IfcOpenShell oracle hook (fake runner)', () => {
  it('skips with the reason when no interpreter starts', () => {
    const result = validateIfcRules('ISO-10303-21;', () => answer(null, '', true));
    expect(result).toEqual({ status: 'skipped', reason: 'IfcOpenShell is not available (python3 not found; python not found)' });
  });

  it('skips when the interpreter cannot import ifcopenshell.validate', () => {
    const result = validateIfcRules('x', () => answer(1));
    expect(result.status).toBe('skipped');
    expect(result.status === 'skipped' && result.reason).toContain('cannot import ifcopenshell.validate');
  });

  it('falls back to the second interpreter name', () => {
    const run: ProcessRunner = (command) => (command === 'python3' ? answer(null, '', true) : answer(0));
    expect(findValidator(run, tmpdir())).toEqual({ interpreter: 'python' });
  });

  it('skips when the validation itself does not start or time out', () => {
    let calls = 0;
    const run: ProcessRunner = () => (++calls === 1 ? answer(0) : answer(null, '', false));
    expect(validateIfcRules('x', run)).toEqual({ status: 'skipped', reason: 'the validator did not finish' });
  });

  it('collects the rule names of the error lines and ignores warnings and plain lines', () => {
    const output = [
      'Validating model.ifc',
      JSON.stringify({ level: 'error', attribute: 'IfcValve.CorrectPredefinedType', message: 'm' }),
      JSON.stringify({ level: 'warning', attribute: 'ignored' }),
      JSON.stringify({ level: 'error', message: 'no attribute' }),
      '{broken',
    ].join('\n');
    expect(errorsOf(output)).toEqual(['IfcValve.CorrectPredefinedType', 'no attribute', 'unreadable validator line: {broken']);
    const run: ProcessRunner = (_command, args) => (args.includes('--rules') ? answer(1, output) : answer(0));
    const result = validateIfcRules('x', run);
    expect(result).toMatchObject({ status: 'ran', interpreter: 'python3' });
    expect(result.status === 'ran' && result.errors).toHaveLength(3);
  });

  it('reports a clean run as no errors', () => {
    const run: ProcessRunner = () => answer(0, 'Validating model.ifc\n');
    expect(validateIfcRules('x', run)).toEqual({ status: 'ran', interpreter: 'python3', errors: [] });
  });
});

const probe = findValidator(localRunner, tmpdir());
const available = 'interpreter' in probe;
const reason = 'reason' in probe ? probe.reason : '';

describe.skipIf(!available)(`IfcOpenShell schema and rule validation${available ? '' : ` (skipped: ${reason})`}`, () => {
  it('finds no error in the IFC4X3_ADD2 export of SC-DAT-01 (VC-DAT-06)', () => {
    const exported = execute(scDat01(), 'export_ifc', { timestamp: stamp, schema: 'IFC4X3_ADD2' }).data as { ifc: string };
    const result = validateIfcRules(exported.ifc);
    expect(result).toMatchObject({ status: 'ran' });
    expect(result.status === 'ran' && result.errors).toEqual([]);
  });

  it('finds the two seeded rule violations of the pack negative file (VC-DAT-08)', () => {
    const result = validateIfcRules(referenceIfc('sc-dat-02-negative.ifc'));
    expect(result.status === 'ran' && [...result.errors].sort()).toEqual([
      'IfcRelConnectsPorts.NoSelfReference',
      'IfcValve.CorrectPredefinedType',
    ]);
  });
});

describe('IfcOpenShell availability on this machine', () => {
  it('is reported, not required', () => {
    expect(typeof available).toBe('boolean');
  });
});

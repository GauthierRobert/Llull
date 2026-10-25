/** export_step: a sweep / loft the generated code cannot build (SWG_CODEGEN_UNSUPPORTED) falls back to the exact OCC kernel's STEP. */

import { afterEach, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument } from '@core/model/types';
import { exportStepFile, type CadExchangePort } from '@protocol/exchangeTools';
import { fakeKernel } from '../../helpers/fakeKernel';

afterEach(() => setGeometryKernel(null));

const doc = execute(createEmptyDocument(), 'sweep_profile', {
  path: [
    [0, 0, 0],
    [0, 0, 40],
  ],
  radius: 3,
}).document;

const failing = (message: string): CadExchangePort => ({
  runProgram: () => Promise.reject(new Error(message)),
  importStep: () => Promise.reject(new Error('unused')),
});

describe('export_step failure isolation', () => {
  it('SWG_CODEGEN_UNSUPPORTED in the generated code -> the native kernel writes the STEP, and the summary says so', async () => {
    setGeometryKernel(fakeKernel({ step: 'ISO-10303-21;\nEND-ISO-10303-21;\n' }));
    const file = await exportStepFile(
      () => doc,
      failing('program failed:\nValueError: SWG_CODEGEN_UNSUPPORTED: sweep swp-1.1: the faces did not sew'),
      { name: 'part' },
    );
    expect('error' in file).toBe(false);
    if ('error' in file) return;
    expect(file.fileName).toBe('part.step');
    expect(file.summary).toContain('exact B-rep via the OCC kernel');
    expect(file.summary).toContain('SWG_CODEGEN_UNSUPPORTED');
    expect(Buffer.from(file.stepBase64, 'base64').toString()).toContain('ISO-10303-21');
  });

  it('honours save: the fallback STEP is written next to the others and savedTo is returned', async () => {
    setGeometryKernel(fakeKernel({ step: 'ISO-10303-21;\nEND-ISO-10303-21;\n' }));
    const written: string[] = [];
    const port: CadExchangePort = {
      ...failing('ValueError: SWG_CODEGEN_UNSUPPORTED: sweep swp-1.1: invalid'),
      writeExchangeFile: (fileName) => {
        written.push(fileName);
        return Promise.resolve(`/exchange/${fileName}`);
      },
    };
    const saved = await exportStepFile(() => doc, port, { name: 'part' });
    expect('error' in saved).toBe(false);
    if ('error' in saved) return;
    expect(saved.savedTo).toBe('/exchange/part.step');
    expect(saved.summary).toContain('saved to /exchange/part.step.');
    expect(saved.summary).not.toContain('returned as data.stepBase64');
    expect(written).toEqual(['part.step']);
    const unsaved = await exportStepFile(() => doc, port, { name: 'part', save: false });
    expect('error' in unsaved ? 'error' : unsaved.savedTo).toBeUndefined();
    expect(written).toHaveLength(1);
  });

  it('only the raised error counts: an earlier mention of the code does not trigger the fallback', async () => {
    const message = 'warning: SWG_CODEGEN_UNSUPPORTED mentioned\nValueError: something else';
    await expect(exportStepFile(() => doc, failing(message), {})).rejects.toThrow('something else');
  });

  it('without a kernel the error names both failures', async () => {
    const file = await exportStepFile(() => doc, failing('ValueError: SWG_CODEGEN_UNSUPPORTED: sweep swp-1.1: invalid'), {});
    expect('error' in file && file.error).toContain('code failed first');
    expect('error' in file && file.error).toContain('SWG_CODEGEN_UNSUPPORTED: sweep swp-1.1: invalid');
  });

  it('any other bridge failure still propagates', async () => {
    await expect(exportStepFile(() => doc, failing('python exited with status 1'), {})).rejects.toThrow('python exited');
  });
});

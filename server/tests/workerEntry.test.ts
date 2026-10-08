import { describe, expect, it } from 'vitest';
import { defaultWorkerEntry } from '../src/isolatedKernel';

describe('defaultWorkerEntry', () => {
  it('resolves the worker entry next to the server modules', () => {
    expect(defaultWorkerEntry()).toMatch(/occtWorker\.(ts|js)$/);
  });
});

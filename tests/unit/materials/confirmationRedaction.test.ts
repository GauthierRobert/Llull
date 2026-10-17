/** TR-MAT-51: a human signature (`confirmation`) is checked by the command and never stored, at any depth of the params. */
import { describe, expect, it } from 'vitest';
import { withoutConfirmations } from '@lib/withoutConfirmations';
import { call, mmDocument } from './support';

const SIGNATURE = { signatureId: 'sig-1', nonce: 'n-1', signature: 'SECRET-SIGNATURE-BYTES' };

describe('withoutConfirmations', () => {
  it('replaces a confirmation object at the top, in arrays and in nested plan steps; other values are untouched', () => {
    const params = {
      a: 1,
      confirmation: SIGNATURE,
      actions: [
        { command: 'x', params: { confirmation: SIGNATURE, keep: 'k' } },
        { command: 'y', params: { z: 1 } },
      ],
    };
    const redacted = withoutConfirmations(params);
    expect(JSON.stringify(redacted)).not.toContain('SECRET-SIGNATURE-BYTES');
    expect(redacted).toEqual({
      a: 1,
      confirmation: { verified: true },
      actions: [
        { command: 'x', params: { confirmation: { verified: true }, keep: 'k' } },
        { command: 'y', params: { z: 1 } },
      ],
    });
    expect(JSON.stringify(params)).toContain('SECRET-SIGNATURE-BYTES');
  });

  it('returns the same reference when there is nothing to redact, and leaves a non-object confirmation alone', () => {
    const plain = { a: [1, { b: 2 }], c: 'text' };
    expect(withoutConfirmations(plain)).toBe(plain);
    expect(withoutConfirmations(3)).toBe(3);
    expect(withoutConfirmations(null)).toBeNull();
    const flag = { confirmation: true };
    expect(withoutConfirmations(flag)).toBe(flag);
  });
});

describe('execute stores no signature in the feature history', () => {
  it('a build_project step that carries a confirmation keeps only { verified: true }', () => {
    const result = call(mmDocument(), 'build_project', {
      actions: [
        {
          command: 'define_material_record',
          params: { id: 'r', designation: 'x', specs: [], licence: 'company-proprietary', exportMarking: { regime: 'none' } },
        },
        { command: 'set_export_marking', params: { material: 'r', marking: { regime: 'ITAR' }, confirmation: SIGNATURE } },
      ],
    });
    expect(JSON.stringify(result.document.featureHistory)).not.toContain('SECRET-SIGNATURE-BYTES');
    expect(JSON.stringify(result)).not.toContain('SECRET-SIGNATURE-BYTES');
  });

  it('a recorded plan loop keeps no signature either', () => {
    const base = call(mmDocument(), 'define_material_record', {
      id: 'r',
      designation: 'x',
      specs: [],
      licence: 'company-proprietary',
      exportMarking: { regime: 'none' },
    }).document;
    const result = call(base, 'build_project', {
      actions: [
        {
          repeat: { count: 1 },
          step: { command: 'set_export_marking', params: { material: 'r', marking: { regime: 'ITAR' }, confirmation: SIGNATURE } },
        },
      ],
    });
    expect(result.document.featureHistory.length).toBeGreaterThan(base.featureHistory.length);
    expect(JSON.stringify(result.document.featureHistory)).not.toContain('SECRET-SIGNATURE-BYTES');
  });
});

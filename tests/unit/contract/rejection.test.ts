import { describe, expect, it } from 'vitest';
import { codedRejection } from '@core/commands/noop';
import { createEmptyDocument } from '@core/model/types';

describe('codedRejection', () => {
  it('returns the document unchanged with the coded summary and error', () => {
    const doc = createEmptyDocument();
    const result = codedRejection(doc, 'do_thing', 'X_BAD', 'it is bad', 'make it good', ['e1'], ['params.a']);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(result.rejected).toBe(true);
    expect(result.summary).toBe('do_thing: X_BAD — it is bad; no-op.');
    expect(result.error).toEqual({ code: 'X_BAD', ids: ['e1'], paths: ['params.a'], remediation: 'make it good' });
  });

  it('defaults ids and paths to none', () => {
    const result = codedRejection(createEmptyDocument(), 'do_thing', 'X_BAD', 'why', 'fix');
    expect(result.error).toEqual({ code: 'X_BAD', ids: [], paths: [], remediation: 'fix' });
  });
});

/**
 * BLD M5, partial fillet (FR-BLD-11, TECHNICAL_SPEC 13.25): `fillet_edge` with `partial` is refused by name with the measured reason; a bad range is BLD_LAW_INVALID; the document is unchanged and `partial` absent changes nothing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setGeometryKernel } from '@core/geometry/kernel';
import { fakeWrapKernel } from '../helpers/fakeWrapKernel';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { expectPure } from '../helpers/expectNoOp';

const doc = execute(createEmptyDocument(), 'add_box', { size: [20, 20, 20] });
const id = doc.affected[0] as string;

describe('fillet_edge partial', () => {
  beforeEach(() => setGeometryKernel(fakeWrapKernel()));
  afterEach(() => setGeometryKernel(null));

  it('a valid range is refused with BLD_PARTIAL_UNSUPPORTED, the reason and the alternatives; the document is unchanged', () => {
    const result = execute(doc.document, 'fillet_edge', { id, edgesNear: [[0, 10, 10]], radius: 2, partial: { start: 0.25, end: 0.75 } });
    expect(result.rejected).toBe(true);
    expect(result.error?.code).toBe('BLD_PARTIAL_UNSUPPORTED');
    expect(result.error?.paths).toEqual(['partial']);
    expect(result.summary).toContain('7 faces instead of 6');
    expect(result.error?.remediation).toContain('sizes');
    expect(result.document).toBe(doc.document);
    expect(result.affected).toEqual([]);
    expectPure(doc.document, () =>
      execute(doc.document, 'fillet_edge', { id, edgesNear: [[0, 10, 10]], radius: 2, partial: { start: 0.25, end: 0.75 } }),
    );
  });

  it.each([[{ start: 0.5, end: 0.5 }], [{ start: 0.8, end: 0.2 }], [{ start: -0.1, end: 0.5 }], [{ start: 0.1, end: 1.5 }]])(
    'a bad range %j is BLD_LAW_INVALID',
    (partial) => {
      const result = execute(doc.document, 'fillet_edge', { id, edgesNear: [[0, 10, 10]], radius: 2, partial });
      expect(result.error?.code).toBe('BLD_LAW_INVALID');
      expect(result.error?.paths).toEqual(['partial']);
      expect(result.document).toBe(doc.document);
    },
  );

  it('without partial the command is as before (the usual answer, never a partial refusal)', () => {
    const result = execute(doc.document, 'fillet_edge', { id, edgesNear: [[0, 10, 10]], radius: 2 });
    expect(result.error?.code).not.toBe('BLD_PARTIAL_UNSUPPORTED');
  });
});

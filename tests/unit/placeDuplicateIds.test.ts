import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';

function boxesAtX(xs: number[]): { doc: ReturnType<typeof createEmptyDocument>; ids: string[] } {
  let doc = createEmptyDocument();
  const ids: string[] = [];
  for (const x of xs) {
    const r = execute(doc, 'add_box', { size: [2, 2, 2], position: [x, 0, 0] });
    doc = r.document;
    ids.push(r.affected[0]!);
  }
  return { doc, ids };
}

describe('align / distribute with repeated target ids', () => {
  it('align reports each moved entity once', () => {
    const { doc, ids } = boxesAtX([0, 7]);
    const result = execute(doc, 'align', {
      targetIds: [ids[1]!, ids[1]!],
      edge: 'center-x',
      referenceId: ids[0]!,
    });
    expect(result.affected).toEqual([ids[1]]);
    expect(result.document.entities[ids[1]!]!.position[0]).toBeCloseTo(0);
  });

  it('distribute treats repeated ids as one entity', () => {
    const { doc, ids } = boxesAtX([0, 5, 20]);
    const result = execute(doc, 'distribute', {
      targetIds: [ids[0]!, ids[1]!, ids[1]!, ids[2]!],
      axis: 'x',
    });
    expect(result.affected).toEqual([ids[1]]);
    expect(result.document.entities[ids[1]!]!.position[0]).toBeCloseTo(10);
  });

  it('distribute with one distinct id is a no-op', () => {
    const { doc, ids } = boxesAtX([0, 5]);
    const result = execute(doc, 'distribute', { targetIds: [ids[0]!, ids[0]!], axis: 'x' });
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('at least 2 distinct');
  });
});

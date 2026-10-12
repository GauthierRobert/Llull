import { describe, it, expect } from 'vitest';
import { contentKey } from '@ui/contentKey';

describe('contentKey', () => {
  it('is equal for equal content and changes when the content changes', () => {
    const wall = { id: 'w1', height: 3 };
    expect(contentKey(wall)).toBe(contentKey({ id: 'w1', height: 3 }));
    expect(contentKey(wall)).toBe(contentKey(wall));
    expect(contentKey({ ...wall, height: 4 })).not.toBe(contentKey(wall));
  });
});

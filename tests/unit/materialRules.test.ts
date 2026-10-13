import { describe, expect, it } from 'vitest';
import { materialDraftOf, type MaterialForm } from '@ui/panels/materialRules';

const valid: MaterialForm = { name: ' steel ', density: '0.00785', color: '#b0b0b0', metalness: '0.08', roughness: '0.45' };

describe('materialDraftOf', () => {
  it('parses and trims a valid form', () => {
    expect(materialDraftOf(valid)).toEqual({ name: 'steel', density: 0.00785, color: '#b0b0b0', metalness: 0.08, roughness: 0.45 });
  });
  it.each([{ name: '  ' }, { density: '' }, { density: '0' }, { color: 'red' }, { metalness: '1.5' }, { roughness: 'x' }])(
    'rejects %j',
    (patch) => {
      expect(materialDraftOf({ ...valid, ...patch })).toBeNull();
    },
  );
});

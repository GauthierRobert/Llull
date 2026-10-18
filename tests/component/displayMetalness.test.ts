import { describe, expect, it } from 'vitest';
import { displayMetalness } from '@ui/viewport/3d/displayMetalness';

describe('displayMetalness', () => {
  it('caps full metals so the base colour stays visible', () => {
    expect(displayMetalness(1)).toBeLessThan(0.7);
    expect(displayMetalness(0.95)).toBe(displayMetalness(1));
  });
  it('keeps dielectrics unchanged and clamps negatives', () => {
    expect(displayMetalness(0.08)).toBe(0.08);
    expect(displayMetalness(-1)).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import { arrowQuaternion, glyphLength, parsePortGlyphs } from '@ui/viewport/3d/ports/portGlyphs';
import { runQuery } from '@ui/services/localQuery';
import { useStore } from '@ui/store';
import { separatorDocument } from './plant/equipment/equipmentFixtures';

/** Rotates `v` by the quaternion [x, y, z, w]. */
function rotate(q: readonly number[], v: readonly number[]): number[] {
  const [x, y, z, w] = q as [number, number, number, number];
  const [vx, vy, vz] = v as [number, number, number];
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
}

describe('portGlyphs', () => {
  it('orients +Y onto every unit direction, including +Y and -Y', () => {
    const directions: Array<[number, number, number]> = [
      [0, 1, 0],
      [0, -1, 0],
      [1, 0, 0],
      [0, 0, 1],
      [0, 0, -1],
      [Math.SQRT1_2, Math.SQRT1_2, 0],
    ];
    for (const direction of directions) {
      const rotated = rotate(arrowQuaternion(direction), [0, 1, 0]);
      direction.forEach((component, index) => expect(rotated[index]).toBeCloseTo(component, 9));
    }
  });

  it('sizes the arrow from the DN with a minimum, in document units', () => {
    expect(glyphLength(50, 1)).toBe(120);
    expect(glyphLength(300, 1)).toBe(300);
    expect(glyphLength(300, 1000)).toBeCloseTo(0.3, 12);
  });

  it('parses equipment_ports in order and skips malformed entries', () => {
    const glyphs = parsePortGlyphs({
      order: ['A:N1', 'A:N2', 'A:N3', 7],
      ports: {
        'A:N1': { position: [1, 2, 3], direction: [0, 0, 1], dn: 100 },
        'A:N2': { position: [1, 2], direction: [0, 0, 1], dn: 100 },
        'A:N3': { position: [0, 0, 0], direction: [1, 0, 0] },
      },
    });
    expect(glyphs).toEqual([
      { id: 'A:N1', position: [1, 2, 3], direction: [0, 0, 1], dn: 100 },
      { id: 'A:N3', position: [0, 0, 0], direction: [1, 0, 0], dn: 0 },
    ]);
    expect(parsePortGlyphs(null)).toEqual([]);
    expect(parsePortGlyphs({ ports: {}, order: 'x' })).toEqual([]);
  });

  it('reads the real equipment_ports answer: one unit-direction glyph per nozzle', () => {
    useStore.getState().setDocument(separatorDocument());
    const glyphs = parsePortGlyphs(runQuery('equipment_ports').data);
    expect(glyphs.length).toBeGreaterThan(0);
    for (const glyph of glyphs) expect(Math.hypot(...glyph.direction)).toBeCloseTo(1, 9);
  });
});

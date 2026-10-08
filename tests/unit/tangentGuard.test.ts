import { describe, expect, it } from 'vitest';
import type { Entity, Vec3 } from '@core/model/types';
import { clearTangentContact, TANGENT_GAP } from '@kernel-occt/tangentGuard';

const common = { layerId: 'layer-default', color: '#888888' };
const sphere = (position: Vec3, radius: number): Entity =>
  ({ id: 's', kind: 'sphere', position, rotation: [0, 0, 0], radius, ...common }) as Entity;
const box = (position: Vec3, size: Vec3, rotation: Vec3 = [0, 0, 0]): Entity =>
  ({ id: 'b', kind: 'box', position, rotation, size, ...common }) as Entity;

const radiusOf = (entity: Entity): number => (entity.kind === 'sphere' ? entity.radius : NaN);

describe('clearTangentContact', () => {
  it('shrinks a sphere resting on a box face and opens a gap on the order of TANGENT_GAP', () => {
    // box top face z = 2; sphere centre at z = 5 with r = 3 touches it at one point
    const [clear] = clearTangentContact(sphere([0, 0, 5], 3), box([0, 0, 0], [4, 4, 4]));
    const gap = 5 - 2 - radiusOf(clear);
    expect(gap).toBeGreaterThan(0);
    expect(gap).toBeLessThanOrEqual(3 * TANGENT_GAP * 3);
  });

  it('detects tangency with the far face of a box the centre sits inside the slab of', () => {
    // Centre z=0 is 1 below the box centre; the top face z=3 is exactly r=3 away (the crash case).
    const [clear] = clearTangentContact(sphere([1, 1, 0], 3), box([2, 1, 1], [5, 3, 4]));
    expect(radiusOf(clear)).toBeLessThan(3);
  });

  it('works whichever operand comes first', () => {
    const [first, second] = clearTangentContact(box([0, 0, 0], [4, 4, 4]), sphere([0, 0, 5], 3));
    expect(first.kind).toBe('box');
    expect(radiusOf(second)).toBeLessThan(3);
  });

  it('shrinks a sphere inscribed in a box (inside tangency)', () => {
    const [clear] = clearTangentContact(sphere([0, 0, 0], 2), box([0, 0, 0], [4, 4, 4]));
    expect(radiusOf(clear)).toBeLessThan(2);
    expect(radiusOf(clear)).toBeGreaterThan(2 - 1e-3);
  });

  it('follows a rotated, translated box', () => {
    // Local +X face of an 8-long box turned 90 degrees about Z sits at world y = 1 + 4.
    const turned = box([0, 1, 0], [8, 2, 2], [0, 0, Math.PI / 2]);
    expect(radiusOf(clearTangentContact(sphere([0, 8, 0], 3), turned)[0])).toBeLessThan(3);
    // The same sphere is only tangent in the turned frame, not at the unturned x = 4 face.
    const unturned = box([0, 1, 0], [8, 2, 2]);
    expect(clearTangentContact(sphere([0, 8, 0], 3), unturned)[0].kind).toBe('sphere');
    expect(radiusOf(clearTangentContact(sphere([0, 8, 0], 3), unturned)[0])).toBe(3);
    const translated = clearTangentContact(sphere([6, 1, 1], 3), box([1, 1, 1], [4, 4, 4]))[0];
    expect(radiusOf(translated)).toBeLessThan(3);
  });

  it('leaves a sphere tangent to the face plane but outside the face bounds unchanged', () => {
    // Plane z = 2 is exactly r = 3 below the centre, but the centre's foot (x = 10) is off the face.
    const offFace = sphere([10, 0, 5], 3);
    expect(clearTangentContact(offFace, box([0, 0, 0], [4, 4, 4]))[0]).toBe(offFace);
    const offFaceY = sphere([0, -9, 5], 3);
    expect(clearTangentContact(offFaceY, box([0, 0, 0], [4, 4, 4]))[0]).toBe(offFaceY);
  });

  it('leaves non-tangent spheres, other kinds and sphere-sphere pairs untouched', () => {
    const away = sphere([0, 0, 6], 3);
    expect(clearTangentContact(away, box([0, 0, 0], [4, 4, 4]))[0]).toBe(away);
    const overlapping = sphere([0, 0, 3], 3);
    expect(clearTangentContact(overlapping, box([0, 0, 0], [4, 4, 4]))[0]).toBe(overlapping);
    const other = sphere([0, 0, 0], 1);
    const [a, b] = clearTangentContact(other, sphere([2, 0, 0], 1));
    expect([a, b]).toEqual([other, sphere([2, 0, 0], 1)]);
  });
});

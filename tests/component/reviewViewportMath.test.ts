import { describe, expect, it } from 'vitest';
import type { SectionBox } from '@core/model/review';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { profileTints } from '@ui/viewport/3d/review/profileTints';
import { arrowBarbs, cloudPath, markupPoints, toNormalised } from '@ui/viewport/3d/review/markupDraw';
import { resizeSectionFace, sectionClipPlanes, sectionFaces, sectionHalfSpaces } from '@ui/viewport/3d/review/sectionBoxMath';
import { useTintStore } from '@ui/store/tintStore';

const box = (extra: Partial<SectionBox> = {}): SectionBox => ({ id: 'sb-1', name: 'Box', min: [0, 0, 0], max: [4, 2, 2], ...extra });
const kept = (planes: ReturnType<typeof sectionClipPlanes>, p: [number, number, number]): boolean =>
  planes.every(({ normal, constant }) => normal[0] * p[0] + normal[1] * p[1] + normal[2] * p[2] + constant >= -1e-9);

describe('sectionClipPlanes', () => {
  it('keeps the inside of an axis-aligned box and clips the outside', () => {
    const planes = sectionClipPlanes(box(), [0, 0, 0]);
    expect(planes).toHaveLength(6);
    expect(kept(planes, [2, 1, 1])).toBe(true);
    expect(kept(planes, [5, 1, 1])).toBe(false);
    expect(kept(planes, [2, -0.1, 1])).toBe(false);
    expect(kept(planes, [2, 1, 2.5])).toBe(false);
  });

  it('works in render space: a point is kept by its render position (world - origin)', () => {
    const origin: [number, number, number] = [1000, 0, 0];
    const planes = sectionClipPlanes(box({ min: [1000, 0, 0], max: [1004, 2, 2] }), origin);
    expect(kept(planes, [2, 1, 1])).toBe(true);
    expect(kept(planes, [5, 1, 1])).toBe(false);
  });

  it('turns with rotationZ about the box centre', () => {
    const planes = sectionClipPlanes(box({ min: [-2, -0.5, 0], max: [2, 0.5, 1], rotationZ: Math.PI / 2 }), [0, 0, 0]);
    // The long side now lies along Y.
    expect(kept(planes, [0, 1.5, 0.5])).toBe(true);
    expect(kept(planes, [1.5, 0, 0.5])).toBe(false);
  });

  it('uses the planes of a plane-form box as given', () => {
    const planes = sectionClipPlanes({ id: 'sb-2', name: 'Cut', planes: [{ normal: [1, 0, 0], offset: 3 }] }, [0, 0, 0]);
    expect(planes).toEqual([{ normal: [-1, -0, -0], constant: 3 }]);
    expect(sectionHalfSpaces({ id: 'sb-3', name: 'none' })).toEqual([]);
  });
});

describe('sectionFaces / resizeSectionFace', () => {
  it('has six faces centred on the box sides, none for a plane-form box', () => {
    const faces = sectionFaces(box());
    expect(faces).toHaveLength(6);
    expect(faces.find((f) => f.axis === 0 && f.sign === 1)?.centre).toEqual([4, 1, 1]);
    expect(sectionFaces({ id: 'sb-2', name: 'Cut', planes: [{ normal: [1, 0, 0], offset: 3 }] })).toEqual([]);
  });

  it('moves one face and keeps the opposite one', () => {
    expect(resizeSectionFace(box(), 0, 1, 3)).toEqual({ min: [0, 0, 0], max: [5, 2, 2] });
    const moved = resizeSectionFace(box(), 1, -1, 3);
    expect(moved?.min[1]).toBeCloseTo(-2);
    expect(moved?.max[1]).toBeCloseTo(2);
  });

  it('moves the face along the rotated normal', () => {
    const turned = box({ min: [-2, -1, 0], max: [2, 1, 2], rotationZ: Math.PI / 2 });
    // The +X face now points along +Y; pulling it 1 further out grows the box along world Y by 1 and shifts the centre by 0.5.
    const moved = resizeSectionFace(turned, 0, 1, 3);
    expect(moved?.min[1]).toBeCloseTo(-0.5);
    expect(((moved?.max[1] ?? 0) + (moved?.min[1] ?? 0)) / 2).toBeCloseTo(0.5);
    expect((moved?.max[0] ?? 0) - (moved?.min[0] ?? 0)).toBeCloseTo(5);
  });

  it('refuses a collapse or a non-finite drag', () => {
    expect(resizeSectionFace(box(), 0, 1, -2)).toBeNull();
    expect(resizeSectionFace(box(), 0, 1, Number.NaN)).toBeNull();
    expect(resizeSectionFace({ id: 'sb-2', name: 'Cut', planes: [] }, 0, 1, 1)).toBeNull();
  });
});

describe('profileTints', () => {
  it('colours entities by the first matching rule and leaves the rest alone', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { position: [0, 0, 0], size: [1, 1, 1] }).document;
    doc = execute(doc, 'add_sphere', { position: [5, 0, 0], radius: 1 }).document;
    doc = execute(doc, 'define_colour_profile', {
      id: 'by-name',
      name: 'By name',
      rules: [{ id: 'r1', when: { property: 'kind', equals: 'box' }, colour: '#ff0000', legend: 'Pumps' }],
    }).document;
    expect(profileTints(doc, []).size).toBe(0);
    doc = execute(doc, 'set_active_colour_profile', { profileId: 'by-name' }).document;
    const tints = profileTints(doc, []);
    expect([...tints.values()]).toEqual(['#ff0000']);
    expect(tints.get(doc.order[0] ?? '')).toBe('#ff0000');
  });
});

describe('tintStore layers', () => {
  it('lets an overlay tint win over the profile tint', () => {
    const { setTints, setProfileTints } = useTintStore.getState();
    setProfileTints(
      new Map([
        ['a', '#111111'],
        ['b', '#222222'],
      ]),
    );
    setTints(new Map([['a', '#999999']]));
    expect(useTintStore.getState().tints.get('a')).toBe('#999999');
    expect(useTintStore.getState().tints.get('b')).toBe('#222222');
    setTints(new Map());
    expect(useTintStore.getState().tints.get('a')).toBe('#111111');
    setProfileTints(new Map());
    expect(useTintStore.getState().tints.size).toBe(0);
  });
});

describe('markupDraw', () => {
  const rect = { left: 100, top: 50, width: 400, height: 200 };
  it('normalises a pointer to the viewport rectangle, clamped, null for an empty one', () => {
    expect(toNormalised(300, 150, rect)).toEqual([0.5, 0.5]);
    expect(toNormalised(0, 1000, rect)).toEqual([0, 1]);
    expect(toNormalised(1, 1, { ...rect, width: 0 })).toBeNull();
  });

  it('makes the points each tool needs, nothing for a click-sized drag', () => {
    expect(markupPoints('line', [0.1, 0.1], [0.5, 0.5])).toEqual([
      [0.1, 0.1],
      [0.5, 0.5],
    ]);
    expect(markupPoints('cloud', [0.1, 0.1], [0.5, 0.4])).toHaveLength(4);
    expect(markupPoints('line', [0.1, 0.1], [0.1, 0.105])).toBeNull();
    expect(markupPoints('text', [0.2, 0.2], [0.2, 0.2])).toEqual([[0.2, 0.2]]);
  });

  it('draws a closed scalloped cloud whatever the winding, and arrow barbs behind the head', () => {
    const square: [number, number][] = [
      [0.1, 0.1],
      [0.5, 0.1],
      [0.5, 0.5],
      [0.1, 0.5],
    ];
    const path = cloudPath(square, 400, 200);
    expect(path.startsWith('M40,20')).toBe(true);
    expect(path.endsWith('Z')).toBe(true);
    expect((path.match(/A/g) ?? []).length).toBeGreaterThanOrEqual(8);
    expect(cloudPath([...square].reverse(), 400, 200)).toContain(' 0 0 0 ');
    expect(path).toContain(' 0 0 1 ');
    expect(
      cloudPath(
        [
          [0, 0],
          [1, 1],
        ],
        10,
        10,
      ),
    ).toBe('');
    const [left, right] = arrowBarbs([0, 0.5], [1, 0.5], 100, 100);
    expect(left[0]).toBeLessThan(100);
    expect(right[0]).toBeLessThan(100);
  });
});

describe('activeClipPlanes (picking)', () => {
  it('rejects a hit on the clipped-away side of the active planes only', async () => {
    const { isClippedAway, setActiveClipPlanes } = await import('@ui/viewport/3d/review/activeClipPlanes');
    setActiveClipPlanes(sectionClipPlanes(box(), [0, 0, 0]));
    expect(isClippedAway({ x: 2, y: 1, z: 1 })).toBe(false);
    expect(isClippedAway({ x: 5, y: 1, z: 1 })).toBe(true);
    setActiveClipPlanes([]);
    expect(isClippedAway({ x: 5, y: 1, z: 1 })).toBe(false);
  });
});

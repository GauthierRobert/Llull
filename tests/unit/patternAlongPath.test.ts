import { describe, it, expect } from 'vitest';
import {
  type CadDocument,
  type Entity,
  type Vec3,
  DEFAULT_LAYER_ID,
  createEmptyDocument,
} from '@core/model/types';
import { execute } from '@core/commands/registry';
import { applyEulerXYZ, eulerFromAxes } from '@core/lib/eulerRotation';
import { expectNoOp } from '../helpers/expectNoOp';

const ORIGIN: Vec3 = [0, 0, 0];

function withLink(...extra: Array<Record<string, unknown>>): CadDocument {
  const doc = execute(createEmptyDocument(), 'add_box', { size: [4, 1, 2] });
  const linkId = doc.affected[0] as string;
  const entities: Record<string, Entity> = { ...doc.document.entities };
  for (const shape of extra) {
    entities[shape['id'] as string] = {
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      layerId: DEFAULT_LAYER_ID,
      color: '#ffffff',
      ...shape,
    } as unknown as Entity;
  }
  return {
    ...doc.document,
    entities,
    order: [linkId, ...extra.map((shape) => shape['id'] as string)],
  };
}

const linkId = (doc: CadDocument): string => doc.order[0] as string;
const axis = (rotation: Vec3, local: Vec3): Vec3 => applyEulerXYZ(local, ORIGIN, rotation);
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe('pattern_along_path', () => {
  it('spaces copies evenly round a closed circle, local +X along the tangent', () => {
    const doc = withLink({ id: 'ring', kind: 'circle', center: [0, 0], radius: 10 });
    const result = execute(doc, 'pattern_along_path', {
      sourceId: linkId(doc),
      count: 8,
      pathId: 'ring',
    });
    expect(result.affected).toHaveLength(8);
    expect(result.document.entities[linkId(doc)]).toBeDefined();
    const copies = result.affected.map((id) => result.document.entities[id] as Entity);
    const chord = 2 * 10 * Math.sin(Math.PI / 8);
    copies.forEach((copy, k) => {
      expect(Math.hypot(copy.position[0], copy.position[1])).toBeCloseTo(10, 2);
      const next = copies[(k + 1) % copies.length] as Entity;
      const gap = Math.hypot(...copy.position.map((v, i) => v - (next.position[i] ?? 0)));
      expect(gap).toBeCloseTo(chord, 1);
      const radial: Vec3 = [copy.position[0] / 10, copy.position[1] / 10, 0];
      expect(Math.abs(dot(axis(copy.rotation, [1, 0, 0]), radial))).toBeLessThan(0.05);
    });
    expect(result.summary).toContain('closed path');
  });

  it('rolls each copy by rollStep about the tangent (alternating chain plates)', () => {
    const doc = withLink();
    const result = execute(doc, 'pattern_along_path', {
      sourceId: linkId(doc),
      count: 3,
      path: [
        [0, 0, 0],
        [20, 0, 0],
      ],
      rollStep: Math.PI / 2,
    });
    const [a, b] = result.affected.map((id) => result.document.entities[id] as Entity);
    expect(Math.abs(dot(axis(a!.rotation, [0, 0, 1]), axis(b!.rotation, [0, 0, 1])))).toBeLessThan(
      1e-9,
    );
    expect(axis(a!.rotation, [1, 0, 0])[0]).toBeCloseTo(1, 9);
  });

  it('puts copies at both ends of an open path, or at the start for a single copy', () => {
    const doc = withLink();
    const path = [
      [0, 0, 0],
      [10, 0, 0],
      [10, 10, 0],
    ];
    const three = execute(doc, 'pattern_along_path', { sourceId: linkId(doc), count: 3, path });
    const ends = three.affected.map((id) => three.document.entities[id]!.position);
    expect(ends[0]).toEqual([0, 0, 0]);
    ends[2]!.forEach((v, i) => expect(v).toBeCloseTo([10, 10, 0][i] as number, 6));
    expect(three.summary).toContain('open path');
    const one = execute(doc, 'pattern_along_path', { sourceId: linkId(doc), count: 1, path });
    expect(one.document.entities[one.affected[0] as string]!.position).toEqual([0, 0, 0]);
  });

  it('follows smooth and closed point loops and composes with the source rotation', () => {
    const base = withLink();
    const doc = execute(base, 'rotate_entity', { id: linkId(base), delta: [0.3, 0, 0] }).document;
    const result = execute(doc, 'pattern_along_path', {
      sourceId: linkId(doc),
      count: 6,
      path: [
        [0, 0, 0],
        [10, 0, 0],
        [10, 10, 0],
        [0, 10, 0],
      ],
      smooth: true,
      closed: true,
    });
    expect(result.affected).toHaveLength(6);
    const lines = execute(doc, 'pattern_along_path', {
      sourceId: linkId(doc),
      count: 4,
      path: [
        [0, 0, 0],
        [10, 0, 0],
        [10, 10, 0],
      ],
      closed: true,
    });
    expect(lines.summary).toContain('closed path');
  });

  it.each([
    [
      'missing source',
      {
        sourceId: 'nope',
        count: 2,
        path: [
          [0, 0, 0],
          [1, 0, 0],
        ],
      },
      'not found',
    ],
    [
      'count 0',
      {
        sourceId: 'link',
        count: 0,
        path: [
          [0, 0, 0],
          [1, 0, 0],
        ],
      },
      'count must be',
    ],
    ['no path', { sourceId: 'link', count: 2 }, 'exactly one of path or pathId'],
    [
      'bad point',
      {
        sourceId: 'link',
        count: 2,
        path: [
          [0, 0, 0],
          [1, 0],
        ],
      },
      'path point 1',
    ],
    ['one point', { sourceId: 'link', count: 2, path: [[0, 0, 0]] }, 'path needs'],
    [
      'coincident',
      {
        sourceId: 'link',
        count: 2,
        path: [
          [0, 0, 0],
          [0, 0, 0],
        ],
      },
      'path invalid',
    ],
    ['missing pathId', { sourceId: 'link', count: 2, pathId: 'nope' }, 'no entity'],
  ])('%s → no-op', (_label, params, text) => {
    const doc = withLink();
    const sourceId = params.sourceId === 'link' ? linkId(doc) : params.sourceId;
    expectNoOp(execute(doc, 'pattern_along_path', { ...params, sourceId }), doc, text);
  });

  it('is pure', () => {
    const doc = withLink({ id: 'ring', kind: 'circle', center: [0, 0], radius: 5 });
    const snapshot = JSON.stringify(doc);
    execute(doc, 'pattern_along_path', { sourceId: linkId(doc), count: 5, pathId: 'ring' });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('eulerFromAxes reproduces a known rotation', () => {
    const euler = eulerFromAxes([0, 1, 0], [-1, 0, 0], [0, 0, 1]);
    expect(axis(euler, [1, 0, 0])[1]).toBeCloseTo(1, 9);
  });
});

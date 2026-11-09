import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from "@core/commands/context";
import { tsSpatialIndex } from '@core/geometry/spatialIndex';
import type { ContactPair } from '@core/geometry/contacts';

/** VC-COR-01 (validation/expected_results.json): plate 100 x 50 x 10 from the origin, blocks of 60 x 30 x 5. */
const PLATE = { size: [100, 50, 10], anchor: 'min', position: [0, 0, 0] };
const block = (position: number[]): Record<string, unknown> => ({ size: [60, 30, 5], anchor: 'min', position });

function scene(blockPosition: number[], extra: Record<string, unknown> = {}): { doc: CadDocument; plate: string; block: string } {
  const first = execute(createEmptyDocument(), 'add_box', { ...PLATE, ...extra });
  const second = execute(first.document, 'add_box', block(blockPosition));
  return { doc: second.document, plate: first.affected[0] ?? '', block: second.affected[0] ?? '' };
}

interface Found {
  pairs: ContactPair[];
  nearMisses: { gap: number }[];
  counts: Record<string, number>;
  tolerance: Record<string, unknown>;
}
const find = (doc: CadDocument, params: Record<string, unknown> = {}): Found => execute(doc, 'find_contacts', params).data as Found;

const TOL = { tolerance: { value: 0.1, unit: 'mm' } };

describe('find_contacts closed form (VC-COR-01)', () => {
  it('01.1 block on the plate: face, 1800 mm^2, normal +z from a toward b', () => {
    const { doc, plate, block: blockId } = scene([20, 10, 10]);
    const [pair] = find(doc, TOL).pairs;
    expect(pair).toMatchObject({
      a: plate,
      b: blockId,
      kind: 'face',
      gap: 0,
      volume: 0,
      normal: [0, 0, 1],
      source: 'closed_form',
      approximate: false,
    });
    expect(pair?.area).toBeCloseTo(1800, 9);
  });

  it('01.2 block 0.5 mm into the plate: interference, 900 mm^3, no area', () => {
    const [pair] = find(scene([20, 10, 9.5]).doc, TOL).pairs;
    expect(pair?.kind).toBe('interference');
    expect(pair?.volume).toBeCloseTo(900, 9);
    expect(pair?.area).toBeNull();
  });

  it('01.3 gap 0.05 mm within tolerance 0.1 mm: still a face with the gap reported', () => {
    const [pair] = find(scene([20, 10, 10.05]).doc, TOL).pairs;
    expect(pair).toMatchObject({ kind: 'face' });
    expect(pair?.gap).toBeCloseTo(0.05, 9);
    expect(pair?.area).toBeCloseTo(1800, 9);
  });

  it('01.4 gap 0.2 mm outside tolerance 0.1 mm: no contact', () => {
    expect(find(scene([20, 10, 10.2]).doc, TOL).pairs).toEqual([]);
  });

  it('01.5 corner-to-corner along an edge: edge, area 0', () => {
    const [pair] = find(scene([100, 10, 5]).doc, TOL).pairs;
    expect(pair?.kind).toBe('face');
    const edge = find(scene([100, 50, 7.5]).doc, TOL).pairs[0];
    expect(edge).toMatchObject({ kind: 'edge', area: 0, volume: 0 });
  });

  it('01.6 side face partially covered: face 100 mm^2, normal along x', () => {
    const [pair] = find(scene([100, 30, 5]).doc, TOL).pairs;
    expect(pair?.kind).toBe('face');
    expect(pair?.area).toBeCloseTo(100, 9);
    expect(pair?.normal).toEqual([1, 0, 0]);
  });

  it('a corner-to-corner touch is a vertex and the normal flips when b lies below a', () => {
    expect(find(scene([100, 50, 10]).doc, TOL).pairs[0]?.kind).toBe('vertex');
    expect(find(scene([20, 10, -5]).doc, TOL).pairs[0]?.normal).toEqual([0, 0, -1]);
  });

  it('reports the default tolerance as defaulted and the explicit one as the callers', () => {
    const { doc } = scene([20, 10, 10]);
    expect(find(doc).tolerance).toMatchObject({ value: 0.0025, unit: 'mm', defaulted: true });
    expect(find(doc, TOL).tolerance).toMatchObject({ value: 0.1, unit: 'mm', defaulted: false, source: 'caller' });
  });

  it('converts a tolerance unit: 0.0039 in (0.099 mm) counts a 0.05 mm gap in a mm document, 0.0019 in does not', () => {
    const { doc } = scene([20, 10, 10.05]);
    expect(find(doc, { tolerance: { value: 0.0039, unit: 'in' } }).pairs).toHaveLength(1);
    expect(find(doc, { tolerance: { value: 0.0019, unit: 'in' } }).pairs).toHaveLength(0);
  });

  it('lists near misses between the tolerance and tolerance * nearMissFactor', () => {
    const { doc } = scene([20, 10, 10.3]);
    const result = find(doc, { ...TOL, nearMissFactor: 5 });
    expect(result.pairs).toEqual([]);
    expect(result.nearMisses).toHaveLength(1);
    expect(result.nearMisses[0]?.gap).toBeCloseTo(0.3, 9);
    expect(find(doc, { ...TOL, nearMissFactor: 2 }).nearMisses).toEqual([]);
  });
});

describe('find_contacts classification and scope', () => {
  it('a rotated box or a non-box solid is an AABB possible contact, approximate, without area or volume', () => {
    const [pair] = find(scene([20, 10, 10], { rotation: [0, 0, Math.PI / 4] }).doc, TOL).pairs;
    expect(pair).toMatchObject({ kind: 'possible', area: null, volume: null, source: 'aabb', approximate: true });
    const sphere = execute(createEmptyDocument(), 'add_sphere', { radius: 5, position: [0, 0, 0] });
    const withBox = execute(sphere.document, 'add_box', { size: [2, 2, 2], position: [5, 0, 0] });
    expect(find(withBox.document, TOL).pairs[0]?.kind).toBe('possible');
  });

  it('only the named solids are tested and 2D shapes are skipped when nothing is named', () => {
    const { doc, plate } = scene([20, 10, 10]);
    const third = execute(doc, 'add_box', { size: [1, 1, 1], position: [500, 500, 500] });
    const line = execute(third.document, 'draw_polyline', {
      points: [
        [0, 0],
        [5, 5],
      ],
    });
    expect(find(line.document, TOL).pairs).toHaveLength(1);
    expect(find(line.document, { ...TOL, entityIds: [plate, third.affected[0]] }).pairs).toEqual([]);
  });

  it('carries each solid material in the pair', () => {
    const { doc, plate } = scene([20, 10, 10]);
    let next = execute(doc, 'create_material', { name: 'alu', density: 0.0028, color: '#cccccc', metalness: 1, roughness: 0.3 }).document;
    next = execute(next, 'assign_material', { materialName: 'alu', entityIds: [plate] }).document;
    expect(find(next, TOL).pairs[0]?.materials).toEqual(['alu', null]);
  });

  it('expands an assembly instance into children `<instance>/<child>` and tests them against solids', () => {
    const base = execute(createEmptyDocument(), 'add_box', { size: [10, 10, 10], position: [0, 0, 0] });
    const unit = execute(base.document, 'add_box', { size: [10, 10, 10], position: [100, 0, 0] });
    const component = execute(unit.document, 'create_component', { name: 'Unit', entityIds: [unit.affected[0]] });
    const instanceId = component.affected.find((id) => component.document.entities[id]?.kind === 'instance') ?? '';
    expect(instanceId).not.toBe('');
    const moved = execute(component.document, 'move_entities', { ids: [instanceId], delta: [-100, 0, 10] });
    const pairs = find(moved.document, TOL).pairs;
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.kind).toBe('face');
    expect(pairs[0]?.a).toBe(base.affected[0]);
    expect(pairs[0]?.b.startsWith(`${instanceId}/`)).toBe(true);
  });

  it('is deterministic, read-only and pure', () => {
    const { doc } = scene([20, 10, 10]);
    const before = structuredClone(doc);
    const first = execute(doc, 'find_contacts', TOL);
    expect(first.document).toBe(doc);
    expect(first.affected).toEqual([]);
    expect(doc).toEqual(before);
    expect(execute(doc, 'find_contacts', TOL).data).toEqual(first.data);
  });

  it('uses the injected spatial index for the broad phase', () => {
    const { doc } = scene([20, 10, 10]);
    let builds = 0;
    const spatialIndex = {
      build: (boxes: Float64Array) => {
        builds++;
        return tsSpatialIndex.build(boxes);
      },
    };
    const result = execute(doc, "find_contacts", TOL, { ...defaultContext(), spatialIndex });
    expect(builds).toBe(1);
    expect((result.data as Found).pairs).toHaveLength(1);
  });
});

describe('find_contacts refusals', () => {
  const { doc, plate } = scene([20, 10, 10]);
  const refused = (params: Record<string, unknown>, code: string): void => {
    const result = execute(doc, 'find_contacts', params);
    expect(result.error?.code).toBe(code);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
  };

  it('an unknown id', () => refused({ entityIds: [plate, 'nope'] }, 'COR_ENTITY_NOT_FOUND'));
  it('a 2D shape', () => {
    const line = execute(doc, 'draw_polyline', {
      points: [
        [0, 0],
        [5, 5],
      ],
    });
    expect(execute(line.document, 'find_contacts', { entityIds: [line.affected[0]] }).error?.code).toBe('COR_ENTITY_NOT_SOLID');
  });
  it('a non-positive tolerance', () => refused({ tolerance: { value: 0, unit: 'mm' } }, 'COR_TOLERANCE_INVALID'));
  it('a negative tolerance', () => refused({ tolerance: { value: -1, unit: 'mm' } }, 'COR_TOLERANCE_INVALID'));
  it('a near-miss factor below 1', () => refused({ nearMissFactor: 0.5 }, 'COR_TOLERANCE_INVALID'));
});

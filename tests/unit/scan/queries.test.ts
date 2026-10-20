/** describe_point_cloud, query_cloud_points, nearest_cloud_point, measure_cloud on an in-memory port (plant 10 §4.2, TR-SCN-02). */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { expectPure } from '../../helpers/expectNoOp';
import { fixturePort, KEY_A, withPort } from './fixturePort';

const grid: Vec3[] = [];
for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) grid.push([i * 0.1, j * 0.1, 0]);
const port = fixturePort([{ key: KEY_A, points: grid, attributes: ['intensity'] }]);
const ctx = withPort(port);

/** A document in metres-scale mm units with the cloud moved +1 m in x. */
function setup(): { doc: CadDocument; cloudId: string } {
  const result = execute(
    createEmptyDocument(),
    'attach_point_cloud',
    { assetKey: KEY_A, transform: [1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
    ctx,
  );
  return { doc: result.document, cloudId: result.affected[0] ?? '' };
}

const answer = (doc: CadDocument, name: string, params: unknown): Record<string, unknown> => {
  const result = execute(doc, name, params, ctx);
  expect(result.rejected, result.summary).toBeUndefined();
  expect(result.document).toBe(doc);
  return result.data as Record<string, unknown>;
};

describe('scan queries', () => {
  it('describe_point_cloud reports manifest facts in document units and frame', () => {
    const { doc, cloudId } = setup();
    const data = answer(doc, 'describe_point_cloud', { cloudId });
    expect(data).toMatchObject({ pointCount: 25, unit: 'mm', attributes: ['intensity'], registration: null });
    expect(data['bounds']).toEqual({ min: [1000, 0, 0], max: [1400, 400, 0] });
    expect((data['quantum'] as number[])[0]).toBeCloseTo(1e-4, 12);
  });

  it('query_cloud_points returns points in mm in the document frame, capped and flagged', () => {
    const { doc, cloudId } = setup();
    const all = answer(doc, 'query_cloud_points', { cloudId });
    expect(all['count']).toBe(25);
    expect((all['points'] as number[]).slice(0, 3)).toEqual([1000, 0, 0]);
    const box = answer(doc, 'query_cloud_points', { cloudId, region: { kind: 'box', min: [1050, -1, -1], max: [1150, 1000, 1] } });
    expect(box['count']).toBe(5);
    expect(box['indices']).toEqual([5, 6, 7, 8, 9]);
    const seed = answer(doc, 'query_cloud_points', { cloudId, region: { kind: 'seed', point: [1000, 0, 0], radius: 150 } });
    expect(seed['count']).toBe(4);
    const capped = answer(doc, 'query_cloud_points', { cloudId, maxPoints: 3 });
    expect(capped).toMatchObject({ count: 3, truncated: true });
    expect(JSON.stringify(capped['warnings'])).toContain('SCN_QUERY_LIMIT');
    expect(answer(doc, 'query_cloud_points', { cloudId, lod: 'budget', budget: 7 })['count']).toBe(7);
  });

  it('nearest_cloud_point and measure_cloud snap to scan points', () => {
    const { doc, cloudId } = setup();
    const near = answer(doc, 'nearest_cloud_point', { cloudId, point: [1210, 190, 0], maxDistance: 50 });
    expect(near).toMatchObject({ found: true, recordIndex: 12, point: [1200, 200, 0] });
    expect(near['distance'] as number).toBeCloseTo(Math.hypot(10, 10), 9);
    expect(near['secondNearestDistance'] as number).toBeCloseTo(Math.hypot(90, 10), 9);
    expect(answer(doc, 'nearest_cloud_point', { cloudId, point: [5000, 0, 0], maxDistance: 10 })['found']).toBe(false);
    const measured = answer(doc, 'measure_cloud', { cloudId, from: { nearest: [1001, 1, 0] }, to: [1300, 400, 0] });
    expect(measured['distance'] as number).toBeCloseTo(500, 9);
    (measured['delta'] as number[]).forEach((v, i) => expect(v).toBeCloseTo([300, 400, 0][i] ?? 0, 9));
  });

  it('refuse with stable codes: no port, unknown cloud, missing asset, bad params (VC-SCN-50)', () => {
    const { doc, cloudId } = setup();
    const code = (name: string, params: unknown, context = ctx): string | undefined => execute(doc, name, params, context).error?.code;
    expect(code('describe_point_cloud', { cloudId }, withPort(null))).toBe('SCN_ASSET_UNAVAILABLE');
    expect(code('query_cloud_points', { cloudId: 'cloud-7.7' })).toBe('SCN_CLOUD_NOT_FOUND');
    expect(code('nearest_cloud_point', { cloudId, point: [0, 0, 0], maxDistance: 1 }, withPort(fixturePort([])))).toBe('SCN_ASSET_MISSING');
    expect(code('nearest_cloud_point', { cloudId, point: [0, 0, 0], maxDistance: 0 })).toBe('SCN_PARAM_INVALID');
    expect(code('query_cloud_points', { cloudId, region: { kind: 'box', min: [1, 1, 1], max: [0, 0, 0] } })).toBe('SCN_CROP_INVALID');
    expect(code('query_cloud_points', { cloudId, region: { kind: 'crop', cropId: 'crop-1.1' } })).toBe('SCN_CROP_NOT_FOUND');
    expect(code('query_cloud_points', { cloudId, region: { kind: 'seed', point: [0, 0, 0], radius: -1 } })).toBe('SCN_PARAM_INVALID');
    expect(code('measure_cloud', { cloudId, from: { nearest: [9000, 0, 0] }, to: [0, 0, 0] })).toBe('SCN_PARAM_INVALID');
  });

  it('use an inside crop as a region and refuse an outside one', () => {
    const { doc, cloudId } = setup();
    const inside = execute(doc, 'set_scan_crop', { name: 'in', min: [990, -1, -1], max: [1010, 1000, 1] });
    const outside = execute(inside.document, 'set_scan_crop', { name: 'out', min: [990, -1, -1], max: [1010, 1000, 1], keep: 'outside' });
    const data = answer(outside.document, 'query_cloud_points', { cloudId, region: { kind: 'crop', cropId: inside.affected[0] } });
    expect(data['count']).toBe(5);
    expect(
      execute(outside.document, 'query_cloud_points', { cloudId, region: { kind: 'crop', cropId: outside.affected[0] } }, ctx).error?.code,
    ).toBe('SCN_CROP_INVALID');
  });

  it('are read-only and pure', () => {
    const { doc, cloudId } = setup();
    expectPure(doc, () => execute(doc, 'query_cloud_points', { cloudId }, ctx));
    expectPure(doc, () => execute(doc, 'describe_point_cloud', { cloudId }, ctx));
  });
});

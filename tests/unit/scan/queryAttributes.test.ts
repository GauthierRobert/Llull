/** query_cloud_points per-point attributes (rgb / intensity / classification) on the in-memory port (plant 10 §13.6 gap 1). */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { expectPure } from '../../helpers/expectNoOp';
import { fixturePort, KEY_A, KEY_B, withPort } from './fixturePort';

const points: Vec3[] = Array.from({ length: 6 }, (_, i) => [i * 0.1, 0, 0]);
const columns = {
  intensity: [0, 100, 200, 300, 65535, 7],
  rgb: [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [10, 20, 30],
    [40, 50, 60],
    [70, 80, 90],
  ],
  classification: [2, 2, 6, 6, 9, 1],
};
const ctx = withPort(
  fixturePort([
    { key: KEY_A, points, attributes: ['intensity', 'rgb', 'classification'], columns },
    { key: KEY_B, points, attributes: ['rgb'], columns },
  ]),
);

function attach(key: string): { doc: CadDocument; cloudId: string } {
  const result = execute(createEmptyDocument(), 'attach_point_cloud', { assetKey: key }, ctx);
  return { doc: result.document, cloudId: result.affected[0] ?? '' };
}

const query = (doc: CadDocument, params: Record<string, unknown>): Record<string, unknown> => {
  const result = execute(doc, 'query_cloud_points', params, ctx);
  expect(result.rejected, result.summary).toBeUndefined();
  return result.data as Record<string, unknown>;
};

describe('query_cloud_points attributes', () => {
  it('returns each requested column, one entry per point, in point order', () => {
    const { doc, cloudId } = attach(KEY_A);
    const data = query(doc, { cloudId, attributes: ['rgb', 'intensity', 'classification'] });
    expect(data['count']).toBe(6);
    expect(data['rgb']).toEqual(columns.rgb.flat());
    expect(data['intensity']).toEqual(columns.intensity);
    expect(data['classification']).toEqual(columns.classification);
    expect(data['missingAttributes']).toEqual([]);
  });

  it('keeps the columns aligned with the points when a region and maxPoints filter them', () => {
    const { doc, cloudId } = attach(KEY_A);
    const box = query(doc, {
      cloudId,
      region: { kind: 'box', min: [150, -1, -1], max: [450, 1, 1] },
      attributes: ['classification', 'rgb'],
    });
    expect(box['indices']).toEqual([2, 3, 4]);
    expect(box['classification']).toEqual([6, 6, 9]);
    expect(box['rgb']).toEqual([0, 0, 255, 10, 20, 30, 40, 50, 60]);
    expect(box).not.toHaveProperty('intensity');
    const capped = query(doc, { cloudId, maxPoints: 2, attributes: ['intensity'] });
    expect(capped).toMatchObject({ count: 2, truncated: true, intensity: [0, 100] });
  });

  it('reports attributes the cloud lacks in missingAttributes and omits their keys', () => {
    const { doc, cloudId } = attach(KEY_B);
    const data = query(doc, { cloudId, attributes: ['intensity', 'rgb', 'classification', 'rgb'] });
    expect(data['rgb']).toEqual(columns.rgb.flat());
    expect(data['missingAttributes']).toEqual(['intensity', 'classification']);
    expect(data).not.toHaveProperty('intensity');
    expect(data).not.toHaveProperty('classification');
  });

  it('answers without attribute keys when none are requested', () => {
    const { doc, cloudId } = attach(KEY_A);
    const data = query(doc, { cloudId });
    for (const key of ['rgb', 'intensity', 'classification', 'missingAttributes']) expect(data).not.toHaveProperty(key);
  });

  it('rejects an unknown attribute name with unchanged document', () => {
    const { doc, cloudId } = attach(KEY_A);
    const result = execute(doc, 'query_cloud_points', { cloudId, attributes: ['normal'] }, ctx);
    expect(result.rejected).toBeDefined();
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('attributes');
  });

  it('is deterministic and pure', () => {
    const { doc, cloudId } = attach(KEY_A);
    const params = { cloudId, attributes: ['rgb', 'intensity', 'classification'] };
    expect(execute(doc, 'query_cloud_points', params, ctx).data).toEqual(execute(doc, 'query_cloud_points', params, ctx).data);
    expectPure(doc, () => execute(doc, 'query_cloud_points', params, ctx));
  });
});

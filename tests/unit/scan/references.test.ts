/** attach / update / detach_point_cloud and set / clear_scan_crop: numbers only, step-scoped ids, stable SCN_* refusals (plant 10 §4.1). */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { ExecutionContext } from '@core/commands/types';
import { expectPure } from '../../helpers/expectNoOp';
import { fixturePort, KEY_A, KEY_B, withPort } from './fixturePort';

const port = fixturePort([
  {
    key: KEY_A,
    points: [
      [0, 0, 0],
      [1, 2, 3],
    ],
    attributes: ['rgb'],
  },
]);
const ctx = withPort(port);

function refused(doc: CadDocument, name: string, params: unknown, code: string, context?: ExecutionContext): void {
  const result = execute(doc, name, params, context);
  expect(result.rejected, result.summary).toBe(true);
  expect(result.document).toBe(doc);
  expect(result.error?.code).toBe(code);
  expect(result.error?.remediation.length).toBeGreaterThan(0);
}

const attached = (): { doc: CadDocument; cloudId: string } => {
  const result = execute(createEmptyDocument(), 'attach_point_cloud', { assetKey: KEY_A }, ctx);
  return { doc: result.document, cloudId: result.affected[0] ?? '' };
};

describe('attach_point_cloud', () => {
  it('stores a reference with a step-scoped id and no point, checked against the port', () => {
    const result = execute(createEmptyDocument(), 'attach_point_cloud', { assetKey: KEY_A, name: 'st01' }, ctx);
    expect(result.rejected).toBeUndefined();
    const id = result.affected[0] ?? '';
    expect(id).toMatch(/^cloud-\d+\.1$/);
    const cloud = result.document.scan?.clouds[id];
    expect(cloud).toMatchObject({ name: 'st01', assetKey: KEY_A, placement: 'local', registrationId: null, display: { colorBy: 'rgb' } });
    expect(cloud?.transform).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    expect(result.document.scan?.cloudOrder).toEqual([id]);
    expect(result.summary).toContain('2 points');
    expect(JSON.stringify(result.document)).not.toContain('positions');
  });

  it('records the reference without a port (replay without the asset), saying it was not checked', () => {
    const result = execute(createEmptyDocument(), 'attach_point_cloud', { assetKey: KEY_B });
    expect(result.affected).toHaveLength(1);
    expect(result.summary).toContain('not checked');
    expect(result.document.scan?.clouds[result.affected[0] ?? '']?.name).toBe('scan bbbbbbbb');
  });

  it('places a grid cloud through the site calibration', () => {
    const calibrated = execute(createEmptyDocument(), 'set_site_calibration', {
      localOrigin: [0, 0],
      gridOrigin: [1000, 2000],
      rotationDeg: 90,
    }).document;
    const result = execute(calibrated, 'attach_point_cloud', { assetKey: KEY_A, placement: 'grid' }, ctx);
    const transform = result.document.scan?.clouds[result.affected[0] ?? '']?.transform ?? [];
    // grid (1 m, 2 m) is local (0, 0) in metres when gridOrigin is (1000, 2000) mm.
    const at = (x: number, y: number): number[] =>
      [0, 1].map((r) => (transform[r * 4] ?? 0) * x + (transform[r * 4 + 1] ?? 0) * y + (transform[r * 4 + 3] ?? 0));
    const origin = at(1, 2);
    expect(Math.abs(origin[0] ?? 1)).toBeLessThan(1e-12);
    expect(Math.abs(origin[1] ?? 1)).toBeLessThan(1e-12);
  });

  it('refuses bad keys, duplicates, unknown assets, grid without calibration and bad transforms', () => {
    const { doc } = attached();
    refused(createEmptyDocument(), 'attach_point_cloud', { assetKey: 'xyz' }, 'SCN_PARAM_INVALID', ctx);
    refused(doc, 'attach_point_cloud', { assetKey: KEY_A }, 'SCN_CLOUD_DUPLICATE', ctx);
    refused(createEmptyDocument(), 'attach_point_cloud', { assetKey: KEY_B }, 'SCN_ASSET_MISSING', ctx);
    refused(createEmptyDocument(), 'attach_point_cloud', { assetKey: KEY_A, placement: 'grid' }, 'SCN_CRS_NO_CALIBRATION', ctx);
    refused(
      createEmptyDocument(),
      'attach_point_cloud',
      { assetKey: KEY_A, transform: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1] },
      'SCN_PARAM_INVALID',
      ctx,
    );
    refused(createEmptyDocument(), 'attach_point_cloud', { assetKey: KEY_A, sourceSha256: 'd'.repeat(64) }, 'SCN_PARAM_INVALID', ctx);
  });

  it('is pure', () => {
    const doc = createEmptyDocument();
    expectPure(doc, () => execute(doc, 'attach_point_cloud', { assetKey: KEY_A }, ctx));
  });
});

describe('update_point_cloud / detach_point_cloud', () => {
  it('changes display settings and clears the registration link when the transform moves', () => {
    const { doc, cloudId } = attached();
    const moved = [1, 0, 0, 0.5, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const result = execute(
      doc,
      'update_point_cloud',
      { cloudId, name: 'renamed', visible: false, pointSize: 4, colorBy: 'intensity', transform: moved },
      ctx,
    );
    expect(result.affected).toEqual([cloudId]);
    expect(result.summary).toContain('stale');
    expect(result.document.scan?.clouds[cloudId]).toMatchObject({
      name: 'renamed',
      transform: moved,
      display: { visible: false, pointSize: 4, colorBy: 'intensity' },
    });
    const detached = execute(result.document, 'detach_point_cloud', { cloudId }, ctx);
    expect(detached.document.scan?.cloudOrder).toEqual([]);
    expect(detached.document.scan?.clouds[cloudId]).toBeUndefined();
  });

  it('refuses unknown clouds and empty or invalid changes', () => {
    const { doc, cloudId } = attached();
    refused(doc, 'update_point_cloud', { cloudId: 'cloud-9.9', visible: true }, 'SCN_CLOUD_NOT_FOUND');
    refused(doc, 'update_point_cloud', { cloudId }, 'SCN_PARAM_INVALID');
    refused(doc, 'update_point_cloud', { cloudId, pointSize: 0 }, 'SCN_PARAM_INVALID');
    refused(doc, 'update_point_cloud', { cloudId, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1] }, 'SCN_PARAM_INVALID');
    refused(doc, 'detach_point_cloud', { cloudId: 'nope' }, 'SCN_CLOUD_NOT_FOUND');
  });

  it('are pure', () => {
    const { doc, cloudId } = attached();
    expectPure(doc, () => execute(doc, 'update_point_cloud', { cloudId, visible: false }));
    expectPure(doc, () => execute(doc, 'detach_point_cloud', { cloudId }));
  });
});

describe('set_scan_crop / clear_scan_crop', () => {
  it('creates and removes a crop box (VC-SCN-50: an inverted box is SCN_CROP_INVALID)', () => {
    const { doc, cloudId } = attached();
    const result = execute(doc, 'set_scan_crop', { name: 'tie-in', min: [0, 0, 0], max: [1000, 1000, 1000], cloudIds: [cloudId] });
    const cropId = result.affected[0] ?? '';
    expect(result.document.scan?.crops[cropId]).toMatchObject({ name: 'tie-in', keep: 'inside', cloudIds: [cloudId] });
    expect(execute(result.document, 'clear_scan_crop', { cropId }).document.scan?.crops).toEqual({});
    const inverted = execute(doc, 'set_scan_crop', { name: 'bad', min: [0, 5, 0], max: [1, 1, 1] });
    expect(inverted.error?.code).toBe('SCN_CROP_INVALID');
    expect(inverted.error?.paths).toEqual(['min.1']);
    refused(doc, 'set_scan_crop', { name: 'x', min: [0, 0, 0], max: [1, 1, 1], cloudIds: ['cloud-0.0'] }, 'SCN_CLOUD_NOT_FOUND');
    refused(doc, 'clear_scan_crop', { cropId: 'crop-0.0' }, 'SCN_CROP_NOT_FOUND');
  });

  it('are pure', () => {
    const { doc } = attached();
    expectPure(doc, () => execute(doc, 'set_scan_crop', { name: 'a', min: [0, 0, 0], max: [1, 1, 1] }));
  });
});

describe('document slice', () => {
  it('validates the scan slice on load and clears it with clear_document', async () => {
    const { scanErrors } = await import('@aec/scan/document');
    const { doc } = attached();
    expect(scanErrors(JSON.parse(JSON.stringify(doc)) as Record<string, unknown>)).toEqual([]);
    expect(scanErrors({ scan: 3 })).toEqual(['scan must be an object']);
    expect(
      scanErrors({ scan: { clouds: { a: { id: 'a' } }, cloudOrder: ['a'], registrations: {}, extractions: {}, crops: {} } }).join(),
    ).toContain('needs assetKey');
    expect(
      scanErrors({ scan: { clouds: {}, cloudOrder: ['x'], registrations: {}, extractions: {}, crops: { c: { id: 'c' } } } }),
    ).toHaveLength(2);
    expect(scanErrors({})).toEqual([]);
    const cleared = execute(doc, 'clear_document', {});
    expect(cleared.document.scan).toBeUndefined();
  });
});

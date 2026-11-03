import { describe, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { apply, expectRefusal } from '../../../helpers/commandAssertions';
import { synRackDocument } from '../../../helpers/synRack';

describe('render_stats camera validation', () => {
  const doc = synRackDocument(8);
  const size = { width: 100, height: 100 };

  it('refuses a target or direction that is not three finite numbers, at its own path', () => {
    expectRefusal(doc, 'render_stats', { target: [1], ...size }, 'VIS_CAMERA_INVALID', 'target');
    expectRefusal(doc, 'render_stats', { view: 'custom', direction: [1, 2], ...size }, 'VIS_CAMERA_INVALID', 'direction');
    expectRefusal(doc, 'render_stats', { target: [1, 2, 3, 4], ...size }, 'VIS_CAMERA_INVALID', 'target');
  });

  it('refuses a stored viewpoint with a zero view height or NaN fov', () => {
    const base = apply(doc, 'save_viewpoint', {
      name: 'v',
      camera: { projection: 'perspective', eye: [0, -5000, 5000], direction: [0, 1, 0], up: [0, 0, 1], fovDeg: 45 },
    });
    const review = base.review;
    const id = Object.keys(review?.viewpoints ?? {})[0] ?? '';
    const viewpoint = review?.viewpoints[id];
    if (review === undefined || viewpoint === undefined) throw new Error('no viewpoint');
    const withCamera = (camera: unknown): CadDocument =>
      ({ ...base, review: { ...review, viewpoints: { [id]: { ...viewpoint, camera } } } }) as CadDocument;
    const common = { eye: viewpoint.camera.eye, direction: [0, 1, 0], up: [0, 0, 1] };
    const params = { viewpointId: id, ...size };
    expectRefusal(
      withCamera({ ...common, projection: 'orthographic', viewHeight: 0 }),
      'render_stats',
      params,
      'VIS_CAMERA_INVALID',
      'viewpointId',
    );
    expectRefusal(
      withCamera({ ...common, projection: 'perspective', fovDeg: Number.NaN }),
      'render_stats',
      params,
      'VIS_CAMERA_INVALID',
      'viewpointId',
    );
  });
});

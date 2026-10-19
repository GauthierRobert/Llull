import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { validateDocumentValues } from '@core/commands/persistence/validation';
import { reviewProblems } from '@core/commands/persistence/reviewValidation';
import { documentCameraViewpoint, interpolateViewpointCamera, normalizeViewpointCamera } from '@core/geometry/viewpointCamera';
import type { ViewpointCamera } from '@core/model/review';
import { nameUuid } from '@lib/nameUuid';

const PERSPECTIVE = { projection: 'perspective', eye: [0, -50, 10], direction: [0, 1, 0], up: [0, 0, 1], fovDeg: 60 } as const;
const ORTHO = { projection: 'orthographic', eye: [0, 0, 100], direction: [0, 0, -1], up: [0, 1, 0], viewHeight: 40 } as const;

function withBox(): CadDocument {
  return execute(createEmptyDocument(), 'add_box', { size: [10, 10, 10] }).document;
}

function withViewpoints(doc = withBox()): CadDocument {
  const first = execute(doc, 'save_viewpoint', { name: 'south', camera: PERSPECTIVE }).document;
  return execute(first, 'save_viewpoint', { name: 'east', camera: { ...PERSPECTIVE, eye: [50, 0, 10], direction: [-1, 0, 0] } }).document;
}

describe('save_viewpoint / list_viewpoints / delete_viewpoint', () => {
  it('saves a normalised camera with a stable id and guid, without a feature step', () => {
    const doc = withBox();
    const result = execute(doc, 'save_viewpoint', { name: 'skid', camera: { ...PERSPECTIVE, direction: [0, 5, 0], up: [0, 1, 1] } });
    expect(result.affected).toEqual(['vp-1']);
    expect(result.summary).toContain('Saved viewpoint vp-1 "skid"');
    const viewpoint = result.document.review?.viewpoints['vp-1'];
    expect(viewpoint?.camera).toEqual({ projection: 'perspective', eye: [0, -50, 10], direction: [0, 1, 0], up: [0, 0, 1], fovDeg: 60 });
    expect(viewpoint?.guid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(result.document.featureHistory).toEqual(doc.featureHistory);
    const again = execute(doc, 'save_viewpoint', { name: 'skid', camera: { ...PERSPECTIVE, direction: [0, 5, 0], up: [0, 1, 1] } });
    expect(again.document.review?.viewpoints['vp-1']?.guid).toBe(viewpoint?.guid);
  });

  it('saves the document camera when no camera is given, and orthographic cameras with a view height', () => {
    const doc = execute(withBox(), 'save_viewpoint', { name: 'current', fromDocumentCamera: true }).document;
    expect(execute(doc, 'save_viewpoint', { name: 'both', camera: ORTHO, fromDocumentCamera: true }).error?.code).toBe(
      'VIS_CAMERA_INVALID',
    );
    expect(doc.review?.viewpoints['vp-1']?.camera.projection).toBe('perspective');
    const ortho = execute(doc, 'save_viewpoint', { name: 'plan', camera: ORTHO });
    expect(ortho.affected).toEqual(['vp-2']);
    expect(ortho.document.review?.viewpoints['vp-2']?.camera).toMatchObject({ projection: 'orthographic', viewHeight: 40 });
  });

  it('refuses invalid cameras with VIS_CAMERA_INVALID', () => {
    const doc = withBox();
    for (const camera of [
      { ...PERSPECTIVE, direction: [0, 0, 0] },
      { ...PERSPECTIVE, up: [0, 2, 0] },
      { ...PERSPECTIVE, fovDeg: 180 },
      { ...ORTHO, viewHeight: 0 },
      { projection: 'orthographic', eye: [0, 0, 1], direction: [0, 0, -1] },
    ]) {
      const result = execute(doc, 'save_viewpoint', { name: 'bad', camera });
      expect(result.error?.code).toBe('VIS_CAMERA_INVALID');
      expect(result.document).toBe(doc);
    }
  });

  it('lists viewpoints in creation order and honours limit', () => {
    const doc = withViewpoints();
    const all = execute(doc, 'list_viewpoints', {});
    expect((all.data as { viewpoints: { id: string }[] }).viewpoints.map((v) => v.id)).toEqual(['vp-1', 'vp-2']);
    expect((execute(doc, 'list_viewpoints', { limit: 1 }).data as { viewpoints: unknown[] }).viewpoints).toHaveLength(1);
    expect((execute(createEmptyDocument(), 'list_viewpoints', {}).data as { viewpoints: unknown[] }).viewpoints).toEqual([]);
  });

  it('deletes a viewpoint, refusing unknown ids and viewpoints in use', () => {
    const doc = withViewpoints();
    const deleted = execute(doc, 'delete_viewpoint', { id: 'vp-2' });
    expect(deleted.affected).toEqual(['vp-2']);
    expect(deleted.document.review?.viewpointOrder).toEqual(['vp-1']);
    expect(execute(doc, 'delete_viewpoint', { id: 'vp-9' }).error?.code).toBe('VIS_VIEWPOINT_NOT_FOUND');
    const walked = execute(doc, 'create_walkthrough', {
      name: 'tour',
      keys: [
        { viewpointId: 'vp-1', seconds: 2 },
        { viewpointId: 'vp-2', seconds: 1 },
      ],
    }).document;
    const inUse = execute(walked, 'delete_viewpoint', { id: 'vp-1' });
    expect(inUse.error).toMatchObject({ code: 'VIS_VIEWPOINT_IN_USE', ids: ['wt-3'] });
    const issued = execute(doc, 'create_review_issue', { title: 'gap', viewpointIds: ['vp-2'] }).document;
    expect(execute(issued, 'delete_viewpoint', { id: 'vp-2' }).error?.ids).toEqual(['iss-3']);
  });

  it('is pure', () => {
    const doc = withViewpoints();
    const before = JSON.stringify(doc);
    execute(doc, 'save_viewpoint', { name: 'x', camera: ORTHO });
    execute(doc, 'delete_viewpoint', { id: 'vp-1' });
    execute(doc, 'create_walkthrough', {
      name: 'w',
      keys: [
        { viewpointId: 'vp-1', seconds: 1 },
        { viewpointId: 'vp-2', seconds: 1 },
      ],
    });
    execute(doc, 'create_review_issue', { title: 't' });
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe('create_walkthrough / delete_walkthrough', () => {
  const keys = [
    { viewpointId: 'vp-1', seconds: 2 },
    { viewpointId: 'vp-2', seconds: 9 },
  ];

  it('creates a walkthrough with its duration (last key seconds ignored)', () => {
    const result = execute(withViewpoints(), 'create_walkthrough', { name: 'tour', keys });
    expect(result.affected).toEqual(['wt-3']);
    expect(result.data).toEqual({ id: 'wt-3', durationS: 2 });
    expect(result.document.review?.walkthroughs['wt-3']?.keys).toEqual(keys);
  });

  it('refuses short, unknown, non-positive and mixed-projection keys', () => {
    const doc = withViewpoints();
    const code = (params: unknown): string | undefined => execute(doc, 'create_walkthrough', params as Record<string, unknown>).error?.code;
    expect(code({ name: 'a', keys: keys.slice(0, 1) })).toBe('VIS_WALKTHROUGH_INVALID');
    expect(code({ name: 'a', keys: [...keys, { viewpointId: 'vp-7', seconds: 1 }] })).toBe('VIS_VIEWPOINT_NOT_FOUND');
    expect(code({ name: 'a', keys: [{ viewpointId: 'vp-1', seconds: 0 }, keys[1]] })).toBe('VIS_WALKTHROUGH_INVALID');
    const mixed = execute(doc, 'save_viewpoint', { name: 'plan', camera: ORTHO }).document;
    const result = execute(mixed, 'create_walkthrough', { name: 'a', keys: [keys[0], { viewpointId: 'vp-3', seconds: 1 }] });
    expect(result.error?.code).toBe('VIS_WALKTHROUGH_INVALID');
    expect(result.summary).toContain('mix perspective and orthographic');
  });

  it('deletes a walkthrough and refuses an unknown one', () => {
    const doc = execute(withViewpoints(), 'create_walkthrough', { name: 'tour', keys }).document;
    const result = execute(doc, 'delete_walkthrough', { id: 'wt-3' });
    expect(result.affected).toEqual(['wt-3']);
    expect(result.document.review?.walkthroughs).toEqual({});
    expect(execute(doc, 'delete_walkthrough', { id: 'wt-1' }).error?.code).toBe('VIS_WALKTHROUGH_NOT_FOUND');
  });
});

describe('create_review_issue', () => {
  it('opens an issue with defaults', () => {
    const doc = withViewpoints();
    const boxId = doc.order[0] ?? '';
    const result = execute(doc, 'create_review_issue', {
      title: '  Clash at rack  ',
      viewpointIds: ['vp-1'],
      entityIds: [boxId],
      labels: ['piping'],
      description: 'line 102',
    });
    expect(result.affected).toEqual(['iss-3']);
    expect(result.document.review?.issues['iss-3']).toMatchObject({
      title: 'Clash at rack',
      type: 'Issue',
      priority: 'normal',
      status: 'open',
      labels: ['piping'],
      description: 'line 102',
      entityIds: [boxId],
    });
    expect(result.document.review?.issueOrder).toEqual(['iss-3']);
  });

  it('refuses an empty title, unknown viewpoints and unknown entities', () => {
    const doc = withViewpoints();
    expect(execute(doc, 'create_review_issue', { title: ' ' }).error?.code).toBe('VIS_ISSUE_INVALID');
    expect(execute(doc, 'create_review_issue', { title: 'a', viewpointIds: ['vp-5'] }).error?.code).toBe('VIS_VIEWPOINT_NOT_FOUND');
    expect(execute(doc, 'create_review_issue', { title: 'a', entityIds: ['nope'] }).error?.code).toBe('VIS_ENTITY_NOT_FOUND');
  });
});

describe('review persistence validation', () => {
  it('accepts a document with review data and rejects malformed sections', () => {
    let doc = withViewpoints();
    doc = execute(doc, 'create_walkthrough', {
      name: 't',
      keys: [
        { viewpointId: 'vp-1', seconds: 1 },
        { viewpointId: 'vp-2', seconds: 1 },
      ],
    }).document;
    doc = execute(doc, 'create_review_issue', { title: 'x', viewpointIds: ['vp-1'] }).document;
    expect(validateDocumentValues(JSON.parse(JSON.stringify(doc)) as Record<string, unknown>)).toEqual([]);
    expect(reviewProblems(undefined)).toEqual([]);
    expect(reviewProblems({})).toHaveLength(1);
    const review = JSON.parse(JSON.stringify(doc.review)) as Record<string, Record<string, Record<string, unknown>>>;
    const broken = {
      ...review,
      viewpoints: {
        ...review['viewpoints'],
        'vp-1': {
          ...review['viewpoints']?.['vp-1'],
          camera: { projection: 'fisheye', eye: [0, 0, 0], direction: [1, 0, 0], up: [0, 0, 1] },
        },
        'vp-2': { ...review['viewpoints']?.['vp-2'], camera: { ...PERSPECTIVE, fovDeg: 0 } },
        'vp-x': { id: 'other' },
        bad: { id: 'bad', guid: 1 },
        ortho: { id: 'ortho', guid: 'g', name: 'n', camera: { ...ORTHO, viewHeight: -1 } },
        flat: { id: 'flat', guid: 'g', name: 'n', camera: { projection: 'perspective', eye: [0, 0] } },
      },
      walkthroughs: {
        'wt-3': { id: 'wt-3', keys: [{ viewpointId: 'vp-1', seconds: 1 }] },
        w2: { id: 'w2', keys: [{ viewpointId: 'zz' }, {}] },
        w3: {
          id: 'w3',
          keys: [
            { viewpointId: 'vp-1', seconds: 0 },
            { viewpointId: 'vp-1', seconds: 1 },
          ],
        },
      },
      issues: {
        'iss-4': { id: 'iss-4', guid: 'g', title: 't', labels: [], viewpointIds: ['vp-9'], entityIds: [] },
        i2: { id: 'i2', guid: 'g', title: 't', labels: 'x' },
        i3: { id: 'i3' },
      },
      viewpointOrder: ['vp-1', 'ghost'],
      issueOrder: ['iss-4', 'ghost'],
    };
    const problems = reviewProblems(broken);
    for (const fragment of [
      "camera.projection must be 'perspective' or 'orthographic'",
      'perspective camera needs fovDeg',
      "must be an object whose id is 'vp-x'",
      'guid and name must be strings',
      'orthographic camera needs viewHeight > 0',
      'camera needs eye, direction and up',
      'keys must list at least 2 viewpoints',
      'every key must reference a known viewpointId',
      'every key needs seconds > 0',
      "viewpoint 'vp-9' does not exist",
      'labels, viewpointIds and entityIds must be string arrays',
      'guid and title must be strings',
      "unknown viewpoint 'ghost'",
      "unknown issue 'ghost'",
    ])
      expect(problems.some((problem) => problem.includes(fragment))).toBe(true);
    expect(reviewProblems({ ...review, viewpoints: { __proto__x: 1, constructor: {} } }).some((p) => p.includes('reserved'))).toBe(true);
  });
});

describe('viewpoint camera maths', () => {
  const a = normalizeViewpointCamera(PERSPECTIVE as unknown as ViewpointCamera) as ViewpointCamera;
  const b = normalizeViewpointCamera({
    ...PERSPECTIVE,
    eye: [50, 0, 10],
    direction: [-1, 0, 0],
    fovDeg: 40,
  } as unknown as ViewpointCamera) as ViewpointCamera;

  it('interpolates eye linearly and direction spherically, keeping an orthonormal frame', () => {
    const mid = interpolateViewpointCamera(a, b, 0.5);
    expect(mid.eye).toEqual([25, -25, 10]);
    expect(mid.direction[0]).toBeCloseTo(-Math.SQRT1_2, 12);
    expect(mid.direction[1]).toBeCloseTo(Math.SQRT1_2, 12);
    expect(mid.projection === 'perspective' ? mid.fovDeg : 0).toBe(50);
    expect(Math.abs(mid.direction[0] * mid.up[0] + mid.direction[1] * mid.up[1] + mid.direction[2] * mid.up[2])).toBeLessThan(1e-12);
    expect(interpolateViewpointCamera(a, a, 0.3).direction).toEqual(a.direction);
  });

  it('turns about a perpendicular axis between opposite directions and interpolates orthographic heights', () => {
    const back = normalizeViewpointCamera({ ...PERSPECTIVE, direction: [0, -1, 0] } as unknown as ViewpointCamera) as ViewpointCamera;
    const half = interpolateViewpointCamera(a, back, 0.5);
    expect(Math.hypot(...half.direction)).toBeCloseTo(1, 12);
    expect(Math.abs(half.direction[1])).toBeLessThan(1e-9);
    const o1 = normalizeViewpointCamera(ORTHO as unknown as ViewpointCamera) as ViewpointCamera;
    const o2 = { ...o1, viewHeight: 80 } as ViewpointCamera;
    const mid = interpolateViewpointCamera(o1, o2, 0.25);
    expect(mid.projection === 'orthographic' ? mid.viewHeight : 0).toBe(50);
  });

  it('maps the document orbit camera to a perspective viewpoint', () => {
    const camera = documentCameraViewpoint({ target: [0, 0, 0], azimuth: 0, polar: Math.PI / 2, distance: 10 });
    expect(camera.eye[1]).toBeCloseTo(10, 12);
    expect(camera.direction[1]).toBeCloseTo(-1, 12);
    expect(camera.up[2]).toBeCloseTo(1, 12);
    const top = documentCameraViewpoint({ target: [0, 0, 0], azimuth: 0, polar: 0, distance: 10 });
    expect(top.up).toEqual([0, 1, 0]);
  });

  it('refuses non-finite cameras', () => {
    expect(normalizeViewpointCamera({ ...a, eye: [Number.NaN, 0, 0] })).toBe('eye, direction and up must be finite');
  });

  it('name UUIDs are deterministic version-8 UUIDs', () => {
    expect(nameUuid('a')).toBe(nameUuid('a'));
    expect(nameUuid('a')).not.toBe(nameUuid('b'));
  });
});

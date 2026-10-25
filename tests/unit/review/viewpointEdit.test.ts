/** VIS-M2: get / update / apply_viewpoint and the section box, profile, visibility and selection a viewpoint carries (VC-VIS-10 / 11). */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { documentCameraViewpoint, viewpointDocumentCamera } from '@core/geometry/viewpointCamera';

const PERSPECTIVE = { projection: 'perspective', eye: [0, -50, 10], direction: [0, 1, 0], up: [0, 0, 1], fovDeg: 60 } as const;

function scene(): CadDocument {
  let doc = createEmptyDocument();
  doc = execute(doc, 'add_box', { size: [10, 10, 10] }).document;
  doc = execute(doc, 'add_box', { size: [4, 4, 4], position: [30, 0, 0] }).document;
  doc = execute(doc, 'define_colour_profile', {
    id: 'by-kind',
    name: 'By kind',
    rules: [{ id: 'boxes', when: { property: 'kind', equals: 'box' }, colour: '#336699', legend: 'Boxes' }],
  }).document;
  return execute(doc, 'set_section_box', { name: 'cut', min: [-10, -10, -10], max: [10, 10, 10] }).document;
}

describe('save_viewpoint with display state', () => {
  it('stores the section box, profile, deduplicated visibility and selection', () => {
    const doc = scene();
    const [first, second] = doc.order;
    const result = execute(doc, 'save_viewpoint', {
      name: 'full',
      camera: PERSPECTIVE,
      sectionBoxId: 'sb-1',
      colourProfileId: 'by-kind',
      visibility: { defaultVisible: false, exceptions: [first, first] },
      selection: [second, second],
    });
    expect(result.error).toBeUndefined();
    expect(result.document.review?.viewpoints['vp-2']).toMatchObject({
      sectionBoxId: 'sb-1',
      colourProfileId: 'by-kind',
      visibility: { defaultVisible: false, exceptions: [first] },
      selection: [second],
    });
  });

  it('refuses dangling references with coded no-ops', () => {
    const doc = scene();
    const base = { name: 'bad', camera: PERSPECTIVE };
    for (const [patch, code] of [
      [{ sectionBoxId: 'sb-9' }, 'VIS_SECTION_BOX_NOT_FOUND'],
      [{ colourProfileId: 'nope' }, 'VIS_PROFILE_NOT_FOUND'],
      [{ selection: ['ghost'] }, 'VIS_ENTITY_NOT_FOUND'],
      [{ visibility: { defaultVisible: true, exceptions: ['ghost'] } }, 'VIS_ENTITY_NOT_FOUND'],
    ] as const) {
      const result = execute(doc, 'save_viewpoint', { ...base, ...patch });
      expect(result.error?.code).toBe(code);
      expect(result.document).toBe(doc);
    }
  });
});

describe('get_viewpoint', () => {
  it('returns the viewpoint with its markups, and refuses an unknown id', () => {
    let doc = execute(scene(), 'save_viewpoint', { name: 'v', camera: PERSPECTIVE }).document;
    doc = execute(doc, 'add_markup', {
      viewpointId: 'vp-2',
      shape: 'line',
      space: 'screen',
      points: [
        [0, 0],
        [1, 1],
      ],
      colour: '#112233',
    }).document;
    const result = execute(doc, 'get_viewpoint', { id: 'vp-2' });
    const data = result.data as { name: string; camera: { projection: string }; markups: { id: string }[] };
    expect(data.name).toBe('v');
    expect(data.camera.projection).toBe('perspective');
    expect(data.markups.map((m) => m.id)).toEqual(['mk-3']);
    expect(result.document).toBe(doc);
    expect(execute(doc, 'get_viewpoint', { id: 'vp-9' }).error?.code).toBe('VIS_VIEWPOINT_NOT_FOUND');
  });
});

describe('update_viewpoint', () => {
  const saved = (): CadDocument =>
    execute(scene(), 'save_viewpoint', { name: 'v', camera: PERSPECTIVE, sectionBoxId: 'sb-1', colourProfileId: 'by-kind' }).document;

  it('renames, re-normalises a new camera, keeps id and guid, and clears fields with null', () => {
    const doc = saved();
    const before = doc.review?.viewpoints['vp-2'];
    const result = execute(doc, 'update_viewpoint', {
      id: 'vp-2',
      name: 'renamed',
      camera: { projection: 'orthographic', eye: [0, 0, 100], direction: [0, 0, -5], up: [0, 1, 0], viewHeight: 40 },
      sectionBoxId: null,
    });
    expect(result.affected).toEqual(['vp-2']);
    const after = result.document.review?.viewpoints['vp-2'];
    expect(after).toMatchObject({ id: 'vp-2', guid: before?.guid, name: 'renamed', colourProfileId: 'by-kind' });
    expect(after).not.toHaveProperty('sectionBoxId');
    expect(after?.camera).toMatchObject({ projection: 'orthographic', direction: [0, 0, -1], viewHeight: 40 });
    const cleared = execute(result.document, 'update_viewpoint', { id: 'vp-2', colourProfileId: null, visibility: null, selection: null });
    expect(cleared.document.review?.viewpoints['vp-2']).not.toHaveProperty('colourProfileId');
  });

  it('sets a selection, and refuses unknown ids, bad cameras, dangling references and no-op updates', () => {
    const doc = saved();
    const target = doc.order[0] ?? '';
    expect(execute(doc, 'update_viewpoint', { id: 'vp-2', selection: [target] }).document.review?.viewpoints['vp-2']?.selection).toEqual([
      target,
    ]);
    expect(execute(doc, 'update_viewpoint', { id: 'vp-9', name: 'x' }).error?.code).toBe('VIS_VIEWPOINT_NOT_FOUND');
    expect(execute(doc, 'update_viewpoint', { id: 'vp-2', camera: { ...PERSPECTIVE, fovDeg: 200 } }).error?.code).toBe(
      'VIS_CAMERA_INVALID',
    );
    expect(execute(doc, 'update_viewpoint', { id: 'vp-2', sectionBoxId: 'sb-9' }).error?.code).toBe('VIS_SECTION_BOX_NOT_FOUND');
    expect(execute(doc, 'update_viewpoint', { id: 'vp-2', colourProfileId: 'nope' }).error?.code).toBe('VIS_PROFILE_NOT_FOUND');
    const same = execute(doc, 'update_viewpoint', { id: 'vp-2', name: 'v' });
    expect(same.document).toBe(doc);
    expect(same.summary).toContain('already has these values');
  });

  it('is pure', () => {
    const doc = saved();
    const before = JSON.stringify(doc);
    execute(doc, 'update_viewpoint', { id: 'vp-2', name: 'z', sectionBoxId: null });
    execute(doc, 'apply_viewpoint', { id: 'vp-2' });
    execute(doc, 'get_viewpoint', { id: 'vp-2' });
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe('apply_viewpoint', () => {
  it('writes the document camera so the view looks the way the viewpoint does (closed form)', () => {
    const doc = scene();
    const saved = execute(doc, 'save_viewpoint', { name: 'v', camera: PERSPECTIVE }).document;
    const applied = execute(saved, 'apply_viewpoint', { id: 'vp-2' });
    expect(applied.affected).toEqual([]);
    expect(applied.document.featureHistory).toEqual(saved.featureHistory);
    const camera = applied.document.camera;
    expect(camera.polar).toBeCloseTo(Math.PI / 2, 12);
    expect(camera.azimuth).toBeCloseTo(Math.PI, 12);
    expect(camera.distance).toBeGreaterThan(0);
    // The eye the camera produces is the viewpoint eye: target = eye + direction · distance.
    expect(camera.target[0]).toBeCloseTo(0, 9);
    expect(camera.target[1]).toBeCloseTo(-50 + camera.distance, 9);
    expect(camera.target[2]).toBeCloseTo(10, 9);
  });

  it('inverts documentCameraViewpoint and reproduces the BCF example angles (VC-VIS-11)', () => {
    const start = { target: [3, 4, 5], azimuth: 0.7, polar: 1.1, distance: 25 } as const;
    expect(viewpointDocumentCamera(documentCameraViewpoint(start), [3, 4, 5], 1)).toMatchObject({ azimuth: 0.7, polar: 1.1 });
    const bcf = {
      projection: 'orthographic',
      eye: [18674.638207107783, -19548.05982455614, 10538.476791232824],
      direction: [-0.8050867319107056, 0.5154458284378052, -0.29351478815078735],
      up: [-0.24719256162643433, 0.15826167166233063, 0.9559545516967773],
      viewHeight: 9673.289179801941,
    } as const;
    const saved = execute(createEmptyDocument(), 'save_viewpoint', { name: 'bcf', camera: bcf }).document;
    const camera = execute(saved, 'apply_viewpoint', { id: 'vp-1' }).document.camera;
    expect(Math.abs(camera.polar - 1.2728948190113956)).toBeLessThan(1e-9);
    expect(Math.abs(camera.azimuth - 2.1402772048541396)).toBeLessThan(1e-9);
  });

  it('keeps the polar angle off the poles and falls back to the current distance when the scene is behind the eye', () => {
    const top = viewpointDocumentCamera(
      { projection: 'perspective', eye: [0, 0, 10], direction: [0, 0, -1], up: [0, 1, 0], fovDeg: 45 },
      [0, 0, 20],
      7,
    );
    expect(top.polar).toBeCloseTo(0.01, 12);
    expect(top.distance).toBe(7);
  });

  it('activates the viewpoint colour profile and section box; resetDisplay clears what it does not carry', () => {
    const doc = scene();
    const withDisplay = execute(doc, 'save_viewpoint', {
      name: 'd',
      camera: PERSPECTIVE,
      sectionBoxId: 'sb-1',
      colourProfileId: 'by-kind',
    }).document;
    const plain = execute(withDisplay, 'save_viewpoint', { name: 'p', camera: PERSPECTIVE }).document;
    const applied = execute(plain, 'apply_viewpoint', { id: 'vp-2' });
    expect(applied.document.display?.activeProfileId).toBe('by-kind');
    expect(applied.document.review?.activeSectionBoxId).toBe('sb-1');
    expect(applied.data).toMatchObject({ activeProfileId: 'by-kind', activeSectionBoxId: 'sb-1' });
    const camerasOnly = execute(applied.document, 'apply_viewpoint', { id: 'vp-3' });
    expect(camerasOnly.document.display?.activeProfileId).toBe('by-kind');
    expect(camerasOnly.document.review?.activeSectionBoxId).toBe('sb-1');
    const reset = execute(applied.document, 'apply_viewpoint', { id: 'vp-3', resetDisplay: true });
    expect(reset.document.display?.activeProfileId).toBeUndefined();
    expect(reset.document.review?.activeSectionBoxId).toBeUndefined();
    expect(reset.data).toMatchObject({ activeProfileId: null, activeSectionBoxId: null });
  });

  it('refuses an unknown viewpoint and does not create a display section on an empty document', () => {
    const doc = execute(createEmptyDocument(), 'save_viewpoint', { name: 'v', fromDocumentCamera: true }).document;
    expect(execute(doc, 'apply_viewpoint', { id: 'vp-9' }).error?.code).toBe('VIS_VIEWPOINT_NOT_FOUND');
    expect(execute(doc, 'apply_viewpoint', { id: 'vp-1' }).document.display).toBeUndefined();
  });
});

/** 09 VIS-M4b: render_view applies a colour profile, a section box and review shading; visible_entity_ids; VIS_RENDER_BUDGET. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { renderFrustum, renderSamples, MAX_RENDER_SAMPLES } from '@core/commands/render/viewVisibility';
import { sectionBoxCut } from '@core/commands/render/reviewStyle';
import { classifyAgainstSection } from '@core/geometry/sectionBox';
import { apply, data, expectRefusal, ok } from '../../helpers/commandAssertions';
import { expectPure } from '../../helpers/expectNoOp';
import { renderView } from '@core/commands/render/renderView';

/** Three 1000 mm boxes in a row along x (a at 0, b at 3000, c at 6000), named a / b / c. */
function scene(): CadDocument {
  let doc = createEmptyDocument();
  for (const [name, x] of [
    ['a', 0],
    ['b', 3000],
    ['c', 6000],
  ] as const) {
    const added = ok(doc, 'add_box', { size: [1000, 1000, 1000], position: [x, 0, 500], color: '#808080' });
    doc = apply(added.document, 'set_entity_name', { id: added.affected[0], name });
  }
  return doc;
}

const PROFILE = {
  id: 'by-name',
  name: 'By name',
  rules: [
    { id: 'red', when: { property: 'name', equals: 'a' }, colour: '#ff0000', legend: 'Alpha' },
    { id: 'gone', when: { property: 'name', equals: 'c' }, colour: '#00ff00', legend: 'Gamma', hidden: true },
    { id: 'unused', when: { property: 'name', equals: 'zzz' }, colour: '#0000ff', legend: 'None' },
  ],
};

const withProfile = (doc: CadDocument): CadDocument => apply(doc, 'define_colour_profile', PROFILE);
const view = (doc: CadDocument, extra: Record<string, unknown> = {}): ReturnType<typeof execute> =>
  execute(doc, 'render_view', { view: 'top', mode: 'vector', width: 400, height: 300, ...extra });
const dataOf = (result: ReturnType<typeof execute>): Record<string, unknown> => result.data as Record<string, unknown>;
const svgOf = (result: ReturnType<typeof execute>): string => dataOf(result)['svg'] as string;

describe('render_view colour profile', () => {
  it('recolours matched entities, hides hidden-rule ones and reports a legend with counts (colour in the SVG)', () => {
    const doc = withProfile(scene());
    const result = view(doc, { colourProfileId: 'by-name' });
    expect(result.rejected).toBeUndefined();
    const svg = svgOf(result);
    expect(svg).toMatch(/fill="#[0-9a-f]{6}"/);
    const plain = svgOf(view(doc, { colourProfileId: 'by-name', sectionBoxId: undefined }));
    expect(plain).toBe(svg);
    expect(dataOf(result)['legend']).toEqual([
      { ruleId: 'red', legend: 'Alpha', colour: '#ff0000', count: 1 },
      { ruleId: 'gone', legend: 'Gamma', colour: '#00ff00', count: 0 },
      { ruleId: 'unused', legend: 'None', colour: '#0000ff', count: 0 },
    ]);
    expect(dataOf(result)['colourProfileId']).toBe('by-name');
    expect(dataOf(result)['entityCount']).toBe(2);
    expect(dataOf(result)['hiddenEntityIds']).toEqual([doc.order[2]]);
    expect(result.summary).toContain('profile by-name: 1 coloured, 1 hidden');
  });

  it('draws the profile colour and differs from the unstyled picture', () => {
    const doc = scene();
    const base = svgOf(view(doc));
    const coloured = svgOf(view(withProfile(doc), { colourProfileId: 'by-name' }));
    expect(coloured).not.toBe(base);
    expect(coloured).toContain('rgb(206,0,0)');
    expect(base).not.toContain('rgb(206,0,0)');
  });

  it('uses the profile of the viewpoint, then the active profile; a parameter wins', () => {
    const doc = withProfile(scene());
    const withViewpoint = ok(doc, 'save_viewpoint', { name: 'v', colourProfileId: 'by-name' }).document;
    expect(dataOf(view(withViewpoint, { viewpointId: 'vp-1', mode: 'raster', width: 64, height: 64 }))['colourProfileId']).toBe('by-name');
    const active = apply(doc, 'set_active_colour_profile', { profileId: 'by-name' });
    expect(dataOf(view(active))['colourProfileId']).toBe('by-name');
    expect(dataOf(view(doc))['colourProfileId']).toBeUndefined();
  });

  it('refuses an unknown profile (VIS_PROFILE_NOT_FOUND) and stays pure', () => {
    const doc = scene();
    expectRefusal(doc, 'render_view', { colourProfileId: 'nope' }, 'VIS_PROFILE_NOT_FOUND', 'colourProfileId');
    expectPure(doc, () => view(withProfile(doc), { colourProfileId: 'by-name' }));
  });

  it('applies defaultColour to unmatched 3D entities and keeps instance-free 2D shapes alone', () => {
    let doc = apply(scene(), 'define_colour_profile', { ...PROFILE, id: 'dflt', defaultColour: '#123456' });
    doc = apply(doc, 'draw_polyline', {
      points: [
        [0, 0],
        [100, 0],
      ],
    });
    const result = view(doc, { colourProfileId: 'dflt' });
    expect(svgOf(result)).toContain('#');
    expect((dataOf(result)['legend'] as { count: number }[])[0]?.count).toBe(1);
  });
});

describe('render_view section box', () => {
  const BOX = { name: 'left half', min: [-1000, -1000, 0], max: [3500, 1000, 2000] };

  it('clips the solids outside the box (cut entities reported) and names the box in the data and summary', () => {
    const doc = apply(scene(), 'set_section_box', BOX);
    const result = view(doc, { sectionBoxId: 'sb-1' });
    expect(dataOf(result)['sectionBoxId']).toBe('sb-1');
    expect(result.summary).toContain('Section box sb-1 applied');
    expect(svgOf(result)).not.toBe(svgOf(view(doc)));
    expect(dataOf(result)['visibleEntityIds']).toEqual([doc.order[0], doc.order[1]]);
    expect(dataOf(result)['visibleEntityCount']).toBe(2);
  });

  it('uses the active box by default and ignores it when cut is given', () => {
    const doc = apply(scene(), 'set_section_box', { ...BOX, activate: true });
    expect(dataOf(view(doc))['sectionBoxId']).toBe('sb-1');
    const cut = view(doc, { cut: { planes: [{ normal: [1, 0, 0], offset: 100000 }] } });
    expect(dataOf(cut)['sectionBoxId']).toBeUndefined();
    expect(cut.summary).toContain('section box is ignored');
  });

  it('supports plane boxes and rotated boxes', () => {
    const planes = apply(scene(), 'set_section_box', { name: 'p', planes: [{ normal: [1, 0, 0], offset: 3500 }] });
    expect(dataOf(view(planes, { sectionBoxId: 'sb-1' }))['visibleEntityCount']).toBe(2);
    const rotated = apply(scene(), 'set_section_box', { ...BOX, rotationZ: Math.PI / 2 });
    const box = rotated.review?.sectionBoxes['sb-1'];
    expect(box).toBeDefined();
    expect(sectionBoxCut(box as NonNullable<typeof box>).planes).toHaveLength(6);
    expect(dataOf(view(rotated, { sectionBoxId: 'sb-1' }))['visibleEntityCount']).toBeLessThan(3);
  });

  it('box planes remove exactly the outside: every AABB corner test agrees with classifyAgainstSection', () => {
    const doc = apply(scene(), 'set_section_box', { ...BOX, rotationZ: 0.3 });
    const box = doc.review?.sectionBoxes['sb-1'];
    const cut = sectionBoxCut(box as NonNullable<typeof box>);
    for (const point of [
      [0, 0, 500],
      [6000, 0, 500],
      [-900, 900, 100],
      [3400, 0, 1900],
      [0, 0, 2500],
    ] as const) {
      const removed = cut.planes.some((p) => p.normal[0] * point[0] + p.normal[1] * point[1] + p.normal[2] * point[2] > p.offset);
      const verdict = classifyAgainstSection(box as NonNullable<typeof box>, { min: [...point], max: [...point] });
      expect(removed, `${point}`).toBe(verdict === 'outside');
    }
  });

  it('refuses an unknown box, and a box together with cut', () => {
    const doc = scene();
    expectRefusal(doc, 'render_view', { sectionBoxId: 'sb-9' }, 'VIS_SECTION_BOX_NOT_FOUND', 'sectionBoxId');
    const boxed = apply(doc, 'set_section_box', BOX);
    expectRefusal(
      boxed,
      'render_view',
      { sectionBoxId: 'sb-1', cut: { planes: [{ normal: [1, 0, 0], offset: 0 }] } },
      'VIS_RENDER_INVALID',
      'sectionBoxId',
    );
  });
});

describe('render_view review shading', () => {
  it('keeps the selection at full colour and dims the rest', () => {
    const doc = scene();
    const flat = svgOf(view(doc));
    const result = view(doc, { shading: 'review', highlightEntityIds: [doc.order[0], 'ghost'] });
    expect(dataOf(result)['shading']).toBe('review');
    expect(svgOf(result)).not.toBe(flat);
    expect(svgOf(result)).toContain('rgb(104,104,104)');
    expect(svgOf(result)).toContain('rgb(46,46,57)');
    expect(result.summary).toContain('1 highlighted');
    expect(result.summary).toContain('unknown highlight id');
  });

  it('highlights the viewpoint selection and the entities of an issue', () => {
    const doc = scene();
    const [a, b] = doc.order as [string, string];
    const withViewpoint = ok(doc, 'save_viewpoint', { name: 'v', selection: [a] }).document;
    expect(view(withViewpoint, { viewpointId: 'vp-1', shading: 'review', mode: 'raster', width: 64, height: 64 }).summary).toContain(
      '1 highlighted',
    );
    const withIssue = ok(doc, 'create_review_issue', { title: 'x', entityIds: [a, b] }).document;
    const result = view(withIssue, { shading: 'review', issueId: 'iss-1' });
    expect(result.summary).toContain('2 highlighted');
  });

  it('draws flat and says so with nothing to highlight; ignores highlight params in flat shading', () => {
    const doc = scene();
    const empty = view(doc, { shading: 'review' });
    expect(dataOf(empty)['shading']).toBe('flat');
    expect(empty.summary).toContain('nothing to highlight');
    expect(view(doc, { highlightEntityIds: [doc.order[0]] }).summary).toContain('shading "review" only');
  });

  it('refuses an unknown issue', () => {
    expectRefusal(scene(), 'render_view', { shading: 'review', issueId: 'iss-9' }, 'VIS_ISSUE_NOT_FOUND', 'issueId');
  });

  it('is available in perspective renders too', () => {
    const doc = scene();
    const result = execute(doc, 'render_view', {
      projection: 'perspective',
      width: 200,
      height: 150,
      shading: 'review',
      highlightEntityIds: [doc.order[0]],
    });
    expect(result.rejected).toBeUndefined();
    expect(dataOf(result)['shading']).toBe('review');
  });
});

describe('visibleEntityIds of render_view and visible_entity_ids', () => {
  it('applies viewpoint visibility (default + exceptions) before the frustum', () => {
    const doc = scene();
    const [a, b, c] = doc.order as [string, string, string];
    const hideB = ok(doc, 'save_viewpoint', {
      name: 'v',
      camera: { projection: 'orthographic', eye: [3000, 0, 10000], direction: [0, 0, -1], up: [0, 1, 0], viewHeight: 20000 },
      visibility: { defaultVisible: true, exceptions: [b] },
    }).document;
    const out = data<Record<string, unknown>>(hideB, 'visible_entity_ids', { viewpointId: 'vp-1' });
    expect(out['visibleEntityIds']).toEqual([a, c]);
    expect(out['hiddenEntityIds']).toEqual([b]);
    expect(out['frustum']).toBe(true);
    const only = apply(doc, 'save_viewpoint', {
      name: 'o',
      camera: { projection: 'orthographic', eye: [0, 0, 10000], direction: [0, 0, -1], up: [0, 1, 0], viewHeight: 20000 },
      visibility: { defaultVisible: false, exceptions: [a, c] },
    });
    expect(data<Record<string, unknown>>(only, 'visible_entity_ids', { viewpointId: 'vp-1' })['visibleEntityIds']).toEqual([a, c]);
    const rendered = dataOf(view(hideB, { viewpointId: 'vp-1' }));
    expect(rendered['visibleEntityIds']).toEqual([a, c]);
  });

  it('stops box-filtering once the active section box is deactivated', () => {
    const camera = { projection: 'orthographic', eye: [3000, 0, 10000], direction: [0, 0, -1], up: [0, 1, 0], viewHeight: 20000 };
    let doc = apply(scene(), 'set_section_box', { name: 'left', min: [-1000, -1000, 0], max: [3500, 1000, 2000], activate: true });
    doc = apply(doc, 'save_viewpoint', { name: 'v', camera });
    const [a, b, c] = doc.order as [string, string, string];
    const ids = (d: CadDocument): unknown =>
      data<Record<string, unknown>>(d, 'visible_entity_ids', { viewpointId: 'vp-2' })['visibleEntityIds'];
    expect(ids(doc)).toEqual([a, b]);
    expect(ids(apply(doc, 'set_active_section_box', { id: null }))).toEqual([a, b, c]);
  });

  it('culls entities outside the view frustum', () => {
    const doc = ok(scene(), 'save_viewpoint', {
      name: 'narrow',
      camera: { projection: 'orthographic', eye: [0, 0, 10000], direction: [0, 0, -1], up: [0, 1, 0], viewHeight: 2000 },
    }).document;
    const out = data<Record<string, unknown>>(doc, 'visible_entity_ids', { viewpointId: 'vp-1', width: 1000, height: 1000 });
    expect(out['visibleEntityIds']).toEqual([doc.order[0]]);
    expect(out['visibleEntityCount']).toBe(1);
  });

  it('applies the profile hidden rules and the section box, and limits the list while counting everything', () => {
    let doc = withProfile(scene());
    doc = apply(doc, 'set_section_box', { name: 'b', min: [-1000, -1000, 0], max: [3500, 1000, 2000] });
    const out = data<Record<string, unknown>>(doc, 'visible_entity_ids', { colourProfileId: 'by-name', sectionBoxId: 'sb-1', limit: 1 });
    expect(out['visibleEntityIds']).toEqual([doc.order[0]]);
    expect(out['visibleEntityCount']).toBe(2);
    expect(out['frustum']).toBe(false);
    expect(out['sectionBoxId']).toBe('sb-1');
    expect(ok(doc, 'visible_entity_ids', { limit: 1 }).summary).toContain('first 1 listed');
  });

  it('refuses unknown viewpoint, profile and section box; is pure and read-only', () => {
    const doc = scene();
    expectRefusal(doc, 'visible_entity_ids', { viewpointId: 'vp-9' }, 'VIS_VIEWPOINT_NOT_FOUND', 'viewpointId');
    expectRefusal(doc, 'visible_entity_ids', { colourProfileId: 'x' }, 'VIS_PROFILE_NOT_FOUND');
    expectRefusal(doc, 'visible_entity_ids', { sectionBoxId: 'x' }, 'VIS_SECTION_BOX_NOT_FOUND');
    expectPure(doc, () => execute(doc, 'visible_entity_ids', {}));
    expect(ok(doc, 'visible_entity_ids', {}).document).toBe(doc);
  });

  it('bounds visibleEntityIds of render_view at 500 with the full count', () => {
    let doc = createEmptyDocument();
    for (let i = 0; i < 510; i++) doc = apply(doc, 'add_box', { size: [1, 1, 1], position: [i * 2, 0, 0] });
    const result = view(doc, { maxPolygons: 500 });
    expect((dataOf(result)['visibleEntityIds'] as string[]).length).toBe(500);
    expect(dataOf(result)['visibleEntityCount']).toBe(510);
  });

  it('renderFrustum matches the picture: the ortho frustum of a top view keeps what the camera frames', () => {
    const planes = renderFrustum({ position: [0, 0, 100], target: [0, 0, 0], up: [0, 1, 0] }, 10, 400, 400);
    expect(planes).toHaveLength(5);
    const perspective = renderFrustum({ position: [0, 0, 100], target: [0, 0, 0], up: [0, 1, 0], fovDeg: 45 }, 10, 400, 300);
    expect(perspective).toHaveLength(5);
  });
});

describe('VIS_RENDER_BUDGET', () => {
  it('counts pixels x supersample^2 (a turntable strip counts its pixels once)', () => {
    expect(renderSamples(800, 600)).toBe(800 * 600 * 4);
    expect(renderSamples(2000, 2000)).toBe(4_000_000);
    expect(renderSamples(800 * 12, 600, true)).toBe(800 * 600 * 12);
    expect(renderSamples(2000 * 12, 2000, true)).toBeGreaterThan(MAX_RENDER_SAMPLES);
  });

  it('refuses a turntable strip over the budget before rendering, and accepts the default one', () => {
    const doc = scene();
    const refused = expectRefusal(
      doc,
      'render_view',
      { turntable: { frames: 12 }, width: 2000, height: 2000 },
      'VIS_RENDER_BUDGET',
      'width',
    );
    expect(refused.summary).toContain('exceed');
    expect(execute(doc, 'render_view', { turntable: { frames: 2 }, width: 64, height: 64 }).rejected).toBeUndefined();
  });
});

describe('VIS-M4b review follow-ups', () => {
  const ORTHO = (eye: number[], direction: number[], up: number[], viewHeight = 2000): Record<string, unknown> => ({
    projection: 'orthographic',
    eye,
    direction,
    up,
    viewHeight,
  });

  it('visibility over thousands of entities stays linear and lists hidden ids in document order', () => {
    let doc = createEmptyDocument();
    const ids: string[] = [];
    for (let i = 0; i < 3000; i++) {
      const added = ok(doc, 'add_box', { size: [1, 1, 1], position: [i * 2, 0, 0] });
      doc = added.document;
      ids.push(added.affected[0] as string);
    }
    const hidden = ids.filter((_, i) => i % 3 === 0);
    doc = ok(doc, 'save_viewpoint', {
      name: 'v',
      camera: ORTHO([3000, 0, 100], [0, 0, -1], [0, 1, 0], 100000),
      visibility: { defaultVisible: true, exceptions: [...hidden].reverse() },
    }).document;
    const started = performance.now();
    const out = data<Record<string, unknown>>(doc, 'visible_entity_ids', { viewpointId: 'vp-1', limit: 10000 });
    expect(performance.now() - started).toBeLessThan(5000);
    expect(out['hiddenEntityIds']).toEqual(hidden);
    expect(out['visibleEntityCount']).toBe(3000 - hidden.length);
  });

  it('refuses a viewpoint camera that cannot give a frustum (VIS_CAMERA_INVALID) and skips the frustum in renderFrustum', () => {
    const doc = scene();
    const bad = { ...ok(doc, 'save_viewpoint', { name: 'v' }).document };
    const review = bad.review;
    const broken = {
      ...bad,
      review: {
        ...review!,
        viewpoints: {
          'vp-1': {
            ...review!.viewpoints['vp-1']!,
            camera: { ...review!.viewpoints['vp-1']!.camera, up: [0, 0, 0] as [number, number, number] },
          },
        },
      },
    };
    expectRefusal(broken as CadDocument, 'visible_entity_ids', { viewpointId: 'vp-1' }, 'VIS_CAMERA_INVALID', 'viewpointId');
    const parallel = {
      ...broken,
      review: {
        ...broken.review,
        viewpoints: {
          'vp-1': {
            ...broken.review.viewpoints['vp-1']!,
            camera: {
              ...broken.review.viewpoints['vp-1']!.camera,
              direction: [0, 0, -1] as [number, number, number],
              up: [0, 0, 1] as [number, number, number],
            },
          },
        },
      },
    };
    expectRefusal(parallel as CadDocument, 'visible_entity_ids', { viewpointId: 'vp-1' }, 'VIS_CAMERA_INVALID', 'viewpointId');
    expect(typeof renderFrustum({ position: [0, 0, 5], target: [0, 0, 0], up: [0, 0, 1] }, 10, 100, 100)).toBe('string');
    expect(typeof renderFrustum({ position: [0, 0, 5], target: [0, 0, 5], up: [0, 1, 0] }, 10, 100, 100)).toBe('string');
    expect(typeof renderFrustum({ position: [0, 0, 5], target: [0, 0, 0], up: [0, 0, 0] }, 10, 100, 100)).toBe('string');
  });

  it('applies the active exploded view before the frustum', () => {
    const added = ok(createEmptyDocument(), 'add_box', { size: [100, 100, 100], position: [0, 0, 0] });
    const id = added.affected[0] as string;
    const withViewpoint = ok(added.document, 'save_viewpoint', {
      name: 'v',
      camera: ORTHO([0, 0, 1000], [0, 0, -1], [0, 1, 0], 1000),
    }).document;
    const exploded = ok(withViewpoint, 'create_exploded_view', { name: 'v', offsets: [{ target: id, vector: [50000, 0, 0] }] });
    const active = apply(exploded.document, 'set_active_exploded_view', { id: exploded.affected[0] });
    expect(data<Record<string, unknown>>(exploded.document, 'visible_entity_ids', { viewpointId: 'vp-1' })['visibleEntityIds']).toEqual([
      id,
    ]);
    expect(data<Record<string, unknown>>(active, 'visible_entity_ids', { viewpointId: 'vp-1' })['visibleEntityIds']).toEqual([]);
  });

  it('frames on the whole scene when a profile hides entities; a named missing profile always errors', () => {
    const doc = withProfile(scene());
    const hiddenRun = dataOf(view(doc, { colourProfileId: 'by-name' }));
    const plain = dataOf(view(doc));
    expect(hiddenRun['bounds']).toEqual(plain['bounds']);
    expect(hiddenRun['camera']).toEqual(plain['camera']);
    const active = apply(doc, 'set_active_colour_profile', { profileId: 'by-name' });
    const gone = { ...active, display: { ...active.display!, colourProfiles: {} } } as CadDocument;
    expect(execute(gone, 'render_view', { colourProfileId: 'by-name' }).error?.code).toBe('VIS_PROFILE_NOT_FOUND');
    expect(execute(gone, 'render_view', {}).rejected).toBeUndefined();
  });

  it('refuses a 12-frame 1920x1080 strip and runs render_view with a profile and no context', () => {
    expectRefusal(scene(), 'render_view', { turntable: { frames: 12 }, width: 1920, height: 1080 }, 'VIS_RENDER_BUDGET', 'width');
    const doc = withProfile(scene());
    const result = renderView.run(doc, { colourProfileId: 'by-name', mode: 'vector', width: 100, height: 100 } as never, undefined);
    expect((result.data as { legend: { count: number }[] }).legend[0]?.count).toBe(1);
  });
});

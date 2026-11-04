/** render_view `clouds` (plant 10 SCN-M3c): marks per attached cloud through the port, colour modes, budget, crops / section box, no-port path. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { expectPure } from '../../helpers/expectNoOp';
import { fixturePort, KEY_A, KEY_B, withPort, type FixtureCloud } from './fixturePort';

interface Detail {
  drawn: number;
  maxPoints: number;
  colour: string;
  note: string;
  clouds: Record<string, unknown>[];
}
interface CloudsData {
  clouds?: Detail | undefined;
  svg: string;
  overlays?: Record<string, { entities: string[]; points: number; detail?: Detail }>;
}

/** 10 × 10 grid on a 0.9 m square (mm document: 0-900), z rising with x. */
const grid: Vec3[] = [];
for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) grid.push([i * 0.1, j * 0.1, i * 0.05]);
const full: FixtureCloud = {
  key: KEY_A,
  points: grid,
  attributes: ['rgb', 'intensity', 'classification'],
  columns: {
    rgb: grid.map((_, k) => (k % 2 === 0 ? [255, 0, 0] : [0, 0, 255])),
    intensity: grid.map((_, k) => k * 600),
    classification: grid.map((_, k) => (k % 3 === 0 ? 2 : 6)),
  },
};
const bare: FixtureCloud = { key: KEY_B, points: grid.map((p) => [p[0] + 2, p[1], p[2]] as Vec3) };

const ctxFor = (clouds: FixtureCloud[]): ReturnType<typeof withPort> => withPort(fixturePort(clouds));

function scene(clouds: FixtureCloud[], extra: (doc: CadDocument) => CadDocument = (d) => d): { doc: CadDocument; ids: string[] } {
  const ctx = ctxFor(clouds);
  let doc = execute(createEmptyDocument(), 'add_box', { size: [3000, 1000, 10], position: [1000, 450, 0] }).document;
  const ids: string[] = [];
  for (const cloud of clouds) {
    const result = execute(doc, 'attach_point_cloud', { assetKey: cloud.key }, ctx);
    doc = result.document;
    ids.push(result.affected[0] ?? '');
  }
  return { doc: extra(doc), ids };
}

/** `clouds` in `params` is shorthand for overlay 'clouds' + overlayOptions.clouds. */
const run = (doc: CadDocument, clouds: FixtureCloud[] | null, params: Record<string, unknown>): ReturnType<typeof execute> => {
  const { clouds: options, ...rest } = params;
  const request = options === undefined ? {} : { overlay: 'clouds', overlayOptions: { clouds: options } };
  return execute(
    doc,
    'render_view',
    { view: 'top', showAxes: false, showGrid: false, ...request, ...rest },
    clouds === null ? undefined : ctxFor(clouds),
  );
};

const render = (doc: CadDocument, clouds: FixtureCloud[] | null, params: object = {}): { data: CloudsData; summary: string } => {
  const result = run(doc, clouds, params as Record<string, unknown>);
  const data = result.data as CloudsData;
  return { data: { ...data, clouds: data.overlays?.['clouds']?.detail }, summary: result.summary };
};

const marks = (svg: string, cloudId?: string): number => {
  const groups = [...svg.matchAll(/<g class="cloud-overlay" data-cloud="([^"]*)"[^>]*>([\s\S]*?)<\/g>/g)];
  return groups.filter((g) => cloudId === undefined || g[1] === cloudId).reduce((sum, g) => sum + (g[2]?.match(/h0/g)?.length ?? 0), 0);
};
const strokes = (svg: string): string[] => [...svg.matchAll(/<path stroke="(#[0-9a-f]{6})" d="M/g)].map((m) => m[1] as string);

describe('render_view clouds', () => {
  it('draws one mark per sampled point and reports the counts in data.clouds', () => {
    const { doc, ids } = scene([full]);
    const { data, summary } = render(doc, [full], { clouds: {} });
    expect(marks(data.svg)).toBe(100);
    expect(data.clouds).toMatchObject({ drawn: 100, maxPoints: 20000, colour: 'elevation' });
    expect(data.clouds?.clouds[0]).toMatchObject({ cloudId: ids[0], queried: 100, sampled: 100, drawn: 100, cropped: 0 });
    expect(data.overlays?.['clouds']).toMatchObject({ entities: ids, points: 100 });
    expect(summary).toContain('Overlay clouds: 100 point(s) of 1 cloud(s) drawn');
    expect(strokes(data.svg).length).toBeGreaterThan(1);
  });

  it('colours by rgb, intensity and classification, and falls back to elevation without the column', () => {
    const { doc } = scene([full, bare]);
    const rgb = render(doc, [full, bare], { clouds: { colour: 'rgb' } });
    expect(strokes(rgb.data.svg)).toEqual(expect.arrayContaining(['#ff0000', '#0000ff']));
    expect(rgb.data.clouds?.clouds[1]).toMatchObject({ colour: 'elevation' });
    expect(rgb.summary).toContain('has no rgb column: drawn by elevation');
    const classes = render(doc, [full], { clouds: { colour: 'classification' } });
    expect(strokes(classes.data.svg)).toEqual(expect.arrayContaining(['#a0713c', '#e0584a']));
    const intensity = render(doc, [full], { clouds: { colour: 'intensity', pointSizePx: 3 } });
    expect(strokes(intensity.data.svg).every((c) => c.slice(1, 3) === c.slice(3, 5))).toBe(true);
    expect(intensity.data.svg).toContain('stroke-width="3"');
  });

  it('is cropped by a section box, a cut and a set_scan_crop box (counted in data.clouds)', () => {
    const { doc } = scene([full]);
    const made = execute(doc, 'set_section_box', { name: 'sb', min: [-100, -100, -100], max: [450, 1000, 1000] });
    expect(made.affected, made.summary).toHaveLength(1);
    const boxed = made.document;
    const section = render(boxed, [full], { clouds: {}, sectionBoxId: made.affected[0] });
    // x = 0, 100, 200, 300, 400 mm survive (50 points); the rest is cut
    expect(marks(section.data.svg)).toBe(50);
    expect(section.data.clouds?.clouds[0]).toMatchObject({ cropped: 50, drawn: 50 });
    const cut = render(doc, [full], { clouds: {}, cut: { planes: [{ normal: [1, 0, 0], offset: 450 }] } });
    expect(marks(cut.data.svg)).toBe(50);
    const cutOnEntity = render(doc, [full], {
      clouds: {},
      cut: { planes: [{ normal: [1, 0, 0], offset: 450 }], entityIds: Object.keys(doc.entities) },
    });
    expect(marks(cutOnEntity.data.svg)).toBe(100);
    const cropped = execute(doc, 'set_scan_crop', { name: 'c', min: [-1, -1, -1], max: [250, 1000, 1000], keep: 'outside' }).document;
    expect(marks(render(cropped, [full], { clouds: {} }).data.svg)).toBe(70);
  });

  it('caps the total at maxPoints, shared between clouds, with evenly spaced deterministic picks', () => {
    const { doc, ids } = scene([full, bare]);
    const first = render(doc, [full, bare], { clouds: { maxPoints: 100 } });
    expect(first.data.clouds?.drawn).toBeLessThanOrEqual(100);
    expect(marks(first.data.svg, ids[0])).toBe(50);
    expect(marks(first.data.svg, ids[1])).toBe(50);
    const again = render(doc, [full, bare], { clouds: { maxPoints: 100 } });
    expect(again.data.svg).toBe(first.data.svg);
    expect(render(doc, [full], { clouds: { maxPoints: 1 } }).data.clouds?.maxPoints).toBe(100);
  });

  it('dims the marks under review shading with a selection', () => {
    const { doc } = scene([full]);
    const dim = render(doc, [full], { clouds: {}, shading: 'review', highlightEntityIds: ['nope'] });
    expect(dim.data.svg).toContain('opacity="0.9"');
    const box = Object.keys(doc.entities)[0] ?? '';
    const shaded = render(doc, [full], { clouds: {}, shading: 'review', highlightEntityIds: [box] });
    expect(shaded.data.svg).toContain('opacity="0.3"');
  });

  it('draws nothing and says why without a port, without a cloud, or in perspective', () => {
    const { doc } = scene([full]);
    const noPort = render(doc, null, { clouds: {} });
    expect(marks(noPort.data.svg)).toBe(0);
    expect(noPort.data.clouds).toMatchObject({ drawn: 0 });
    expect(noPort.summary).toContain('no point-cloud port is installed');
    const plain = execute(createEmptyDocument(), 'add_box', { size: [10, 10, 10] }).document;
    expect(render(plain, [full], { clouds: {} }).summary).toContain('no cloud is attached');
    const missing = render(doc, [bare], { clouds: {} });
    expect(missing.summary).toContain('its asset is not in this machine');
    const hidden = execute(doc, 'update_point_cloud', { cloudId: Object.keys(doc.scan?.clouds ?? {})[0], visible: false }, ctxFor([full]));
    expect(render(hidden.document, [full], { clouds: {} }).summary).toContain('hidden');
    const perspective = render(doc, [full], { clouds: {}, projection: 'perspective' });
    expect(marks(perspective.data.svg)).toBe(0);
    expect(perspective.summary).toContain('needs an orthographic view');
  });

  it('is opt-in, notes a turntable, is pure', () => {
    const { doc } = scene([full]);
    expect(marks(render(doc, [full]).data.svg)).toBe(0);
    expect(render(doc, [full], { clouds: {}, turntable: { frames: 2 } }).summary).toContain('Overlay not drawn on a turntable strip');
    expectPure(doc, () => render(doc, [full], { clouds: {} }));
  });

  it('with isolate draws only the clouds the list names by id', () => {
    const { doc, ids } = scene([full, bare]);
    const named = render(doc, [full, bare], { clouds: {}, isolate: [ids[1] ?? ''] });
    expect(marks(named.data.svg, ids[0])).toBe(0);
    expect(marks(named.data.svg, ids[1])).toBe(100);
    const other = render(doc, [full, bare], { clouds: {}, isolate: Object.keys(doc.entities) });
    expect(marks(other.data.svg)).toBe(0);
    expect(other.summary).toContain('outside the isolate list');
  });

  it('refuses invalid overlayOptions, an unknown kind, a kind without options and options for an unrequested kind (CMD_INVALID_PARAMS with a path)', () => {
    const { doc } = scene([full]);
    const bad = run(doc, [full], { overlay: 'clouds', overlayOptions: { clouds: { colour: 'pink', maxPoints: -1 } } });
    expect(bad.error?.code).toBe('CMD_INVALID_PARAMS');
    expect(bad.error?.paths).toEqual(expect.arrayContaining(['overlayOptions.clouds.colour', 'overlayOptions.clouds.maxPoints']));
    expect(bad.document).toBe(doc);
    const unknown = run(doc, [full], { overlay: 'clouds', overlayOptions: { nope: {} } });
    expect(unknown.error).toMatchObject({ code: 'CMD_INVALID_PARAMS', paths: ['overlayOptions.nope'] });
    const noOptions = run(doc, [full], { overlay: 'cage', overlayOptions: { cage: {} } });
    expect(noOptions.error).toMatchObject({ code: 'CMD_INVALID_PARAMS', paths: ['overlayOptions.cage'] });
    const unrequested = run(doc, [full], { overlayOptions: { clouds: {} } });
    expect(unrequested.error).toMatchObject({ code: 'CMD_INVALID_PARAMS', paths: ['overlayOptions.clouds'] });
  });

  it('skips a cloud whose read fails and says so', () => {
    const { doc } = scene([full]);
    const port = fixturePort([full]);
    const failing = withPort({ ...port, query: () => null });
    const result = execute(doc, 'render_view', { view: 'top', overlay: 'clouds' }, failing);
    expect(result.summary).toContain('its asset could not be read');
    expect(marks((result.data as CloudsData).svg)).toBe(0);
  });
});

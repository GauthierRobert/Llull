import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { RasterOutcome, RasterPort, RasterScene } from '@core/model/raster';
import { rasterScenePixels } from '@core/commands/render/raster';
import { REFERENCE_RENDERER_VERSION } from '@core/commands/render/rendererProvenance';
import { setRasterPort, getRasterPort } from '@core/commands/rasterPort';

/** RGBA of the PNG embedded in a render_view svg (encodePng filters None / Up). */
function pixels(svg: string): { width: number; height: number; at: (x: number, y: number) => number[] } {
  const match = /href="data:image\/png;base64,([^"]+)"/.exec(svg);
  const png = Buffer.from(match?.[1] ?? '', 'base64');
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    if (png.toString('latin1', offset + 4, offset + 8) === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * 4;
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x] ?? 0;
      out[y * stride + x] = filter === 2 && y > 0 ? (value + (out[(y - 1) * stride + x] ?? 0)) & 0xff : value;
    }
  }
  return { width, height, at: (x, y) => [...out.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)] };
}

/** Pixels whose colour is dominated by `channel` (0 red, 2 blue). */
function countDominant(svg: string, channel: 0 | 2): number {
  const image = pixels(svg);
  let count = 0;
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++) {
      const p = image.at(x, y);
      if ((p[3] ?? 0) > 200 && (p[channel] ?? 0) > 60 && (p[channel] ?? 0) > 2 * (p[2 - channel] ?? 0)) count++;
    }
  return count;
}

function twoBoxes(): CadDocument {
  let doc = createEmptyDocument();
  doc = execute(doc, 'add_box', { size: [4, 4, 4], position: [0, -10, 0], color: '#ff0000' }).document;
  doc = execute(doc, 'add_box', { size: [4, 4, 4], position: [0, 30, 0], color: '#0000ff' }).document;
  return doc;
}

const svgOf = (data: unknown): string => (data as { svg: string }).svg;

describe('render_view reference provenance', () => {
  it('reports svgSha256 and rendererVersion, identical across runs', () => {
    const doc = twoBoxes();
    const a = execute(doc, 'render_view', { width: 160, height: 120 }).data as Record<string, unknown>;
    const b = execute(doc, 'render_view', { width: 160, height: 120 }).data as Record<string, unknown>;
    expect(a['renderer']).toBe('reference');
    expect(a['rendererVersion']).toBe(REFERENCE_RENDERER_VERSION);
    expect(a['projection']).toBe('orthographic');
    expect(a['svgSha256']).toBe(createHash('sha256').update(svgOf(a)).digest('hex'));
    expect(b['svgSha256']).toBe(a['svgSha256']);
  });
});

describe('render_view perspective and viewpoints', () => {
  it('draws the nearer of two equal boxes larger in perspective, equal in orthographic', () => {
    const doc = twoBoxes();
    const common = { direction: [0, -1, 0.2], width: 200, height: 150, showGrid: false, showAxes: false };
    const ortho = svgOf(execute(doc, 'render_view', common).data);
    const persp = execute(doc, 'render_view', { ...common, projection: 'perspective', fovDeg: 40, zoom: 2 });
    expect(persp.summary).toContain('Rendered custom view');
    const svg = svgOf(persp.data);
    expect(svg).not.toContain('id="grid"');
    expect((persp.data as { projection: string }).projection).toBe('perspective');
    // The red box is nearer the eye (eye on -Y): it hides most of the blue one in orthographic, and covers more pixels in perspective.
    expect(countDominant(svg, 0)).toBeGreaterThan(countDominant(ortho, 0) * 1.2);
  });

  it('renders from a saved perspective viewpoint, including an eye inside the scene (near-plane clipping)', () => {
    let doc = twoBoxes();
    doc = execute(doc, 'add_box', { size: [200, 200, 200], position: [0, 0, 0], color: '#00ff00' }).document;
    doc = execute(doc, 'draw_polyline', {
      points: [
        [-50, -80],
        [50, 60],
      ],
    }).document;
    doc = execute(doc, 'save_viewpoint', {
      name: 'inside',
      camera: { projection: 'perspective', eye: [0, -40, 2], direction: [0, 1, 0], fovDeg: 60 },
    }).document;
    const result = execute(doc, 'render_view', { viewpointId: 'vp-1', width: 120, height: 90 });
    expect(result.error).toBeUndefined();
    const data = result.data as { viewpointId: string; projection: string; svg: string };
    expect(data).toMatchObject({ viewpointId: 'vp-1', projection: 'perspective' });
    const image = pixels(data.svg);
    expect(image.at(60, 45)[0]).toBeGreaterThan(80);
  });

  it('frames an orthographic viewpoint by its view height', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [10, 10, 10], position: [0, 0, 0], color: '#ff0000' }).document;
    doc = execute(doc, 'save_viewpoint', {
      name: 'front',
      camera: { projection: 'orthographic', eye: [0, -100, 0], direction: [0, 1, 0], viewHeight: 20 },
    }).document;
    const svg = svgOf(execute(doc, 'render_view', { viewpointId: 'vp-1', width: 100, height: 100, showGrid: false, showAxes: false }).data);
    const image = pixels(svg);
    expect(image.at(50, 50)[0]).toBeGreaterThan(80);
    expect(image.at(50, 20)[3]).toBe(0);
    expect(image.at(50, 30)[0]).toBeGreaterThan(80);
  });

  it('draws 2D strokes in perspective even without solids, and nothing for an empty document', () => {
    const doc = execute(createEmptyDocument(), 'draw_polyline', {
      points: [
        [-10, 0],
        [10, 0],
      ],
    }).document;
    const svg = svgOf(execute(doc, 'render_view', { projection: 'perspective', view: 'top', width: 100, height: 80 }).data);
    expect(svg).toContain('data:image/png');
    const empty = svgOf(execute(createEmptyDocument(), 'render_view', { projection: 'perspective', width: 100, height: 80 }).data);
    expect(empty).not.toContain('data:image/png');
  });

  it('refuses unknown viewpoints, bad fov, perspective vector / multi-pass renders', () => {
    const doc = twoBoxes();
    const code = (params: Record<string, unknown>): string | undefined => execute(doc, 'render_view', params).error?.code;
    expect(code({ viewpointId: 'vp-4' })).toBe('VIS_VIEWPOINT_NOT_FOUND');
    expect(code({ projection: 'perspective', fovDeg: 200 })).toBe('VIS_CAMERA_INVALID');
    expect(code({ projection: 'perspective', mode: 'vector' })).toBe('VIS_RENDER_INVALID');
    expect(code({ projection: 'perspective', turntable: { frames: 2 } })).toBe('VIS_RENDER_INVALID');
    expect(code({ renderer: 'native', mode: 'vector' })).toBe('VIS_RENDER_INVALID');
  });

  it('is pure', () => {
    const doc = twoBoxes();
    const before = JSON.stringify(doc);
    execute(doc, 'render_view', { projection: 'perspective', width: 100, height: 80 });
    expect(JSON.stringify(doc)).toBe(before);
  });
});

/** A port drawing with the reference stage (what the native CPU twin does) or failing. */
function fakePort(behaviour: 'twin' | 'fail' | 'short'): RasterPort & { calls: RasterScene[] } {
  const calls: RasterScene[] = [];
  return {
    calls,
    render(scene, engine): RasterOutcome {
      calls.push(scene);
      if (behaviour === 'fail') return { ok: false, code: 'NATIVE_TIMEOUT', message: 'llull-compute timed out' };
      const rgba = behaviour === 'short' ? new Uint8Array(4) : rasterScenePixels(scene);
      return {
        ok: true,
        image: { rgba, device: `fake ${engine}`, deterministic: false, engine: 'native-gpu', version: 'llull-compute 0.0.0' },
      };
    },
  };
}

describe('render_view renderer native', () => {
  it('refuses with NATIVE_TOOL_MISSING when the host has no raster port', () => {
    const result = execute(twoBoxes(), 'render_view', { renderer: 'native' });
    expect(result.error?.code).toBe('NATIVE_TOOL_MISSING');
    expect(result.summary).toContain('NATIVE_TOOL_MISSING');
  });

  it('draws through ctx.raster: no digest, deterministic false, device and version reported', () => {
    const doc = twoBoxes();
    const port = fakePort('twin');
    const ctx = { ...defaultContext(), raster: port };
    const native = execute(doc, 'render_view', { renderer: 'native', width: 160, height: 120 }, ctx);
    const reference = execute(doc, 'render_view', { width: 160, height: 120 });
    const data = native.data as Record<string, unknown>;
    expect(data).toMatchObject({ renderer: 'native', deterministic: false, device: 'fake gpu', version: 'llull-compute 0.0.0' });
    expect(data['svgSha256']).toBeUndefined();
    expect(native.summary).toContain('not a reference');
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]?.samples).toBe(2);
    expect(svgOf(data)).toBe(svgOf(reference.data));
  });

  it('draws every turntable frame natively', () => {
    const port = fakePort('twin');
    const result = execute(
      twoBoxes(),
      'render_view',
      { renderer: 'native', turntable: { frames: 3 }, width: 100, height: 80 },
      { ...defaultContext(), raster: port },
    );
    expect(result.error).toBeUndefined();
    expect(port.calls).toHaveLength(4); // the base frame (framing and data) and the 3 strip frames
  });

  it('fails (no silent fallback) when the native job fails or returns the wrong size', () => {
    const doc = twoBoxes();
    const failed = execute(doc, 'render_view', { renderer: 'native' }, { ...defaultContext(), raster: fakePort('fail') });
    expect(failed.error?.code).toBe('NATIVE_TIMEOUT');
    expect(failed.data).toBeUndefined();
    const short = execute(doc, 'render_view', { renderer: 'native' }, { ...defaultContext(), raster: fakePort('short') });
    expect(short.error?.code).toBe('NATIVE_JOB_FAILED');
    const nothing = execute(
      createEmptyDocument(),
      'render_view',
      { renderer: 'native' },
      { ...defaultContext(), raster: fakePort('twin') },
    );
    expect(nothing.error?.code).toBe('NATIVE_JOB_FAILED');
  });

  it('reads the process-installed port through the default context; reference digests ignore it (VC-VIS-60 c)', () => {
    const previous = getRasterPort();
    const before = (execute(twoBoxes(), 'render_view', { width: 80, height: 64 }).data as { svgSha256: string }).svgSha256;
    setRasterPort(fakePort('fail'));
    try {
      expect((execute(twoBoxes(), 'render_view', { width: 80, height: 64 }).data as { svgSha256: string }).svgSha256).toBe(before);
      setRasterPort(fakePort('twin'));
      expect(execute(twoBoxes(), 'render_view', { renderer: 'native', width: 80, height: 64 }).error).toBeUndefined();
    } finally {
      setRasterPort(previous);
    }
  });
});

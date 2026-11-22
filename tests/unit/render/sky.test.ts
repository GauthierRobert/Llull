import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { SKY_DEFAULTS, skyRadiance, skyRgb, skyState } from '@lib/preethamSky';
import { overBackdrop, skyBackdrop } from '@core/commands/render/skyRaster';
import { skyNote, siteLightOf } from '@core/commands/render/siteLight';
import { renderCameraRgba } from '@core/commands/render/frames';
import { normalize3 } from '@lib/vec3';

/** Sky.js's shader (three r18x examples/jsm/objects/Sky.js, clouds off) evaluated line by line in Y-up, an independent transcription. */
function shaderReference(dir: Vec3, sunDir: Vec3, T: number, rayleigh: number, mie: number, g: number): number[] {
  const p = (x: number, y: number): number => Math.exp(Math.log(x) * y);
  const e = Math.E;
  const [dx, dy, dz] = [dir[0], dir[2], dir[1]]; // Z-up -> Sky.js Y-up
  const sun = [sunDir[0], sunDir[2], sunDir[1]];
  const totalRayleigh = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
  const mieConst = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];
  const cutoff = 1.6110731556870734;
  const sunE = 1000 * Math.max(0, 1 - p(e, -((cutoff - Math.acos(Math.min(1, Math.max(-1, sun[1]!)))) / 1.5)));
  const sunfade = 1 - Math.min(1, Math.max(0, 1 - Math.exp((sun[1]! * 450000) / 450000)));
  const rc = rayleigh - 1 * (1 - sunfade);
  const betaR = totalRayleigh.map((t) => t * rc);
  const betaM = mieConst.map((m) => 0.434 * (0.2 * T * 10e-18) * m * mie);
  const zenith = Math.acos(Math.max(0, dy));
  const inverse = 1 / (Math.cos(zenith) + 0.15 * p(93.885 - (zenith * 180) / Math.PI, -1.253));
  const cosTheta = dx * sun[0]! + dy * sun[1]! + dz * sun[2]!;
  const rPhase = (3 / (16 * Math.PI)) * (1 + p(cosTheta * 0.5 + 0.5, 2));
  const mPhase = (1 / (4 * Math.PI)) * ((1 - g * g) / p(1 - 2 * g * cosTheta + g * g, 1.5));
  const mixT = Math.min(1, Math.max(0, p(1 - sun[1]!, 5)));
  const disc = Math.min(1, Math.max(0, (cosTheta - 0.9999566769464484) * 50000));
  return [0, 1, 2].map((k) => {
    const fex = Math.exp(-(betaR[k]! * 8.4e3 * inverse + betaM[k]! * 1.25e3 * inverse));
    const base = sunE * ((betaR[k]! * rPhase + betaM[k]! * mPhase) / (betaR[k]! + betaM[k]!));
    const lin = p(base * (1 - fex), 1.5) * (1 + (p(base * fex, 0.5) - 1) * mixT);
    return (lin + 0.1 * fex) * 0.04 + 760 * disc * Math.min(sunE * fex, 80) + [0, 0.0003, 0.00075][k]!;
  });
}

const elevation = (deg: number): Vec3 => [Math.cos((deg * Math.PI) / 180), 0, Math.sin((deg * Math.PI) / 180)];
const radianceAt = (sun: Vec3, dir: Vec3): Vec3 => skyRadiance(skyState(sun), normalize3(dir));
const luminance = (c: Vec3): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

describe('Preetham sky (Sky.js port)', () => {
  it('keeps the defaults of Sky.js', () => {
    expect(SKY_DEFAULTS).toEqual({ turbidity: 2, rayleigh: 1, mieCoefficient: 0.005, mieDirectionalG: 0.8 });
  });

  it.each([
    [45, [0.3, 0.6, 0.74]],
    [45, [0, 0.999, 0.04]],
    [20, [-0.5, 0.2, 0.3]],
    [75, [0.1, -0.7, 0.2]],
    [2, [0.9, 0.05, 0.1]],
    [-10, [0, 1, 0.5]],
  ] as [number, Vec3][])('matches the shader formulas for sun elevation %f and direction %j', (elev, dir) => {
    const sun = elevation(elev);
    const d = normalize3(dir);
    const expected = shaderReference(d, sun, 2, 1, 0.005, 0.8);
    const got = skyRadiance(skyState(sun), d);
    got.forEach((value, k) =>
      expect(value).toBeCloseTo(expected[k]!, 9 - 2 * Math.max(0, Math.floor(Math.log10(Math.abs(expected[k]!) + 1)))),
    );
  });

  it('follows non-default turbidity, rayleigh, mie and directional G', () => {
    const sun = elevation(30);
    const d = normalize3([0.4, 0.2, 0.5]);
    const params = { turbidity: 10, rayleigh: 3, mieCoefficient: 0.01, mieDirectionalG: 0.7 };
    const expected = shaderReference(d, sun, 10, 3, 0.01, 0.7);
    skyRadiance(skyState(sun, params), d).forEach((value, k) => expect(value).toBeCloseTo(expected[k]!, 6));
    expect(skyRadiance(skyState(sun, params), d)).not.toEqual(skyRadiance(skyState(sun), d));
  });

  it('is bluer than white and brighter at 45 degrees than at the horizon, as the model predicts', () => {
    const sun = elevation(60);
    const high = radianceAt(sun, [-0.3, 0, 1]);
    const horizon = radianceAt(sun, [-1, 0, 0.02]);
    expect(high[2]).toBeGreaterThan(high[0]);
    expect(high[2]).toBeGreaterThan(high[1]);
    const [zr, , zb] = skyRgb(high);
    const [hr, , hb] = skyRgb(horizon);
    expect(zb - zr).toBeGreaterThan(hb - hr);
    expect(luminance(horizon)).toBeGreaterThan(luminance(high));
  });

  it('is dark grey at night (the model floor)', () => {
    const night = radianceAt(elevation(-30), [0, 0, 1]);
    expect(luminance(night)).toBeLessThan(0.005);
    expect(skyRgb(night)[2]).toBeLessThan(40);
  });

  it('is deterministic, and a below-horizon view stays finite', () => {
    const sun = elevation(35);
    const a = radianceAt(sun, [0.2, -0.3, 0.5]);
    expect(radianceAt(sun, [0.2, -0.3, 0.5])).toEqual(a);
    radianceAt(sun, [0.2, -0.3, -0.5]).forEach((value) => expect(Number.isFinite(value)).toBe(true));
  });

  it('draws the sun disc only when asked', () => {
    const sun = elevation(40);
    const withDisc = skyRadiance(skyState(sun), sun);
    const without = skyRadiance(skyState(sun, SKY_DEFAULTS, false), sun);
    expect(luminance(withDisc)).toBeGreaterThan(luminance(without) * 5);
  });
});

const box = execute(createEmptyDocument(), 'add_box', { size: [2, 2, 2] }).document;
const siteDoc = (dateTime: string): typeof box =>
  execute(box, 'set_site_context', { latitudeDeg: 0, longitudeDeg: 0, dateTime, northAngleDeg: 0 }).document;
const NOON = '2026-03-20T12:00:00Z';
const MIDNIGHT = '2026-03-20T00:00:00Z';
const render = (doc: typeof box, params: Record<string, unknown> = {}): { svg: string; summary: string } => {
  const result = execute(doc, 'render_view', { view: 'iso', width: 120, height: 90, ...params });
  return { svg: (result.data as { svg: string }).svg, summary: result.summary };
};

describe('raster sky behind a site context', () => {
  it('keeps documents without a site bit-identical (no sky, no sky sentence, sky:false is a no-op)', () => {
    const plain = render(box);
    expect(render(box, { sky: false }).svg).toBe(plain.svg);
    expect(plain.summary).not.toContain('Sky:');
    expect(skyNote(undefined, true)).toBe('');
  });

  it('fills the background with the sky, and sky:false restores the flat background', () => {
    const doc = siteDoc(NOON);
    const sky = render(doc);
    const off = render(doc, { sky: false });
    expect(sky.summary).toContain('Sky: Preetham');
    expect(off.summary).not.toContain('Sky:');
    expect(sky.svg).not.toBe(off.svg);
    expect(render(doc).svg).toBe(sky.svg);
  });

  it('names the raster-only limit in vector mode', () => {
    expect(render(siteDoc(NOON), { mode: 'vector' }).summary).toContain('The sky is drawn in raster mode only.');
  });

  it('shows one sky colour in an orthographic view and the model gradient in a perspective one', () => {
    const light = siteLightOf(siteDoc(NOON))!.light;
    const ortho = skyBackdrop(light.sky!, { position: [5, -5, 5], target: [0, 0, 0], up: [0, 0, 1] }, 8, 8);
    expect(new Set(Array.from({ length: 64 }, (_, i) => [...ortho.slice(i * 3, i * 3 + 3)].join(','))).size).toBe(1);
    const persp = skyBackdrop(light.sky!, { position: [8, 0, 0], target: [0, 0, 1], up: [0, 0, 1], fovDeg: 70 }, 8, 8);
    const top = [...persp.slice(0, 3)];
    const bottom = [...persp.slice(7 * 8 * 3, 7 * 8 * 3 + 3)];
    expect(top).not.toEqual(bottom);
  });

  it('composites model pixels over the sky by alpha', () => {
    const rgba = Uint8Array.from([10, 20, 30, 255, 200, 200, 200, 0]);
    const out = overBackdrop(rgba, Uint8Array.from([1, 2, 3, 100, 110, 120]));
    expect([...out]).toEqual([10, 20, 30, 255, 100, 110, 120, 255]);
  });

  it('paints the sky into walkthrough / BCF frames too, and night differently from noon', () => {
    const camera = { projection: 'perspective', eye: [6, -6, 5], direction: [-0.6, 0.6, -0.5254], up: [0, 0, 1], fovDeg: 50 } as const;
    const frame = (doc: typeof box): Uint8Array => renderCameraRgba(doc, camera, 32, 32, [26, 26, 46], [0, 0, 0]);
    const noon = frame(siteDoc(NOON));
    expect(noon).not.toEqual(frame(box));
    expect(noon).not.toEqual(frame(siteDoc(MIDNIGHT)));
    expect(frame(siteDoc(NOON))).toEqual(noon);
    expect(frame(box)).toEqual(frame(box));
  });
});

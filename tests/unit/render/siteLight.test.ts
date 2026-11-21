import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { siteLightOf } from '@core/commands/render/siteLight';
import { shade } from '@core/commands/render/camera';

const box = execute(createEmptyDocument(), 'add_box', { size: [2, 2, 2] }).document;
const at = (dateTime: string, northAngleDeg = 0): typeof box =>
  execute(box, 'set_site_context', { latitudeDeg: 0, longitudeDeg: 0, dateTime, northAngleDeg }).document;
const NOON = '2026-03-20T12:00:00Z';
const MIDNIGHT = '2026-03-20T00:00:00Z';

function render(doc: typeof box, params: Record<string, unknown> = {}): { svg: string; summary: string } {
  const result = execute(doc, 'render_view', { view: 'iso', width: 200, height: 200, ...params });
  return { svg: (result.data as { svg: string }).svg, summary: result.summary };
}
const fills = (svg: string): string[] => [...svg.matchAll(/fill="(rgb\([^"]+\))"/g)].map((m) => m[1]!);

describe('render lighting from the site context', () => {
  it('leaves the default light untouched without a site context', () => {
    const plain = render(box, { mode: 'vector' });
    expect(plain.summary).not.toContain('site sun');
    expect(siteLightOf(box)).toBeNull();
    expect(fills(plain.svg).length).toBeGreaterThan(0);
  });
  it('lights the vector render with the computed sun and names it in the summary', () => {
    const plain = render(box, { mode: 'vector', view: 'top' });
    const sunny = render(at(NOON), { mode: 'vector', view: 'top' });
    expect(sunny.summary).toContain('Lit by the site sun');
    expect(sunny.summary).toContain('elevation');
    // sun nearly overhead: the top face is lit at full factor, brighter than the default 45-degree light
    expect(fills(sunny.svg)).not.toEqual(fills(plain.svg));
    expect(shade([0, 0, 1], '#808080', { direction: [0, 0, 1] })).toBe('rgb(128,128,128)');
  });
  it('turns the sun with the north angle', () => {
    const north = render(at('2026-03-20T08:00:00Z', 0), { mode: 'vector' });
    const turned = render(at('2026-03-20T08:00:00Z', 90), { mode: 'vector' });
    expect(fills(turned.svg)).not.toEqual(fills(north.svg));
  });
  it('leaves sky light only when the sun is below the horizon, in vector and raster modes', () => {
    const night = at(MIDNIGHT);
    expect(siteLightOf(night)?.light.direction).toBeNull();
    const vector = render(night, { mode: 'vector', view: 'top' });
    expect(vector.summary).toContain('sky light only');
    expect(shade([0, 0, 1], '#808080', { direction: null })).toBe('rgb(45,45,45)');
    const raster = render(night, { view: 'top' });
    const rasterNoon = render(at(NOON), { view: 'top' });
    expect(raster.summary).toContain('sky light only');
    expect(raster.svg).not.toBe(rasterNoon.svg);
  });
  it('ignores a stored site whose date-time no longer parses', () => {
    const corrupt = { ...box, siteContext: { latitudeDeg: 0, longitudeDeg: 0, dateTime: 'x', northAngleDeg: 0 } };
    expect(siteLightOf(corrupt)).toBeNull();
  });
});

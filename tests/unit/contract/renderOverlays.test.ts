/** The render-overlay extension point (`CadPlugin.renderOverlays`): core accepts a kind only when it or an installed plugin registered it, and draws plugin kinds without importing them. */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { installPlugin, pluginRenderOverlays } from '@core/plugins/host';
import type { CadPlugin } from '@core/plugins/plugin';
import type { RenderOverlay } from '@core/model/renderOverlay';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';

const calls: { docSeen: CadDocument; only: readonly string[] | undefined; point: [number, number] }[] = [];
const overlay = (kind: string): RenderOverlay => ({
  kind,
  draw: (doc, view) => {
    calls.push({ docSeen: doc, only: view.only, point: view.project([0, 0, 0]) });
    return {
      svg: [`  <g class="test-overlay" data-kind="${kind}"/>`],
      stats: { entities: ['e1'], lines: 3, points: 1, detail: { note: 'x' } },
    };
  },
});
const plugin = (name: string, ...kinds: string[]): CadPlugin => ({
  name,
  toolset: 'test',
  commands: [],
  renderOverlays: kinds.map(overlay),
});
const render = (doc: CadDocument, params: object): ReturnType<typeof execute> =>
  execute(doc, 'render_view', { view: 'top', showAxes: false, showGrid: false, mode: 'vector', ...params });
const doc = createEmptyDocument();

describe('CadPlugin.renderOverlays', () => {
  it('a kind no installed plugin registered is refused as invalid params, the document untouched', () => {
    const refused = render(doc, { overlay: 'test_overlay' });
    expectNoOp(refused, doc);
    expect(refused.error?.code).toBe('CMD_INVALID_PARAMS');
    expect(pluginRenderOverlays().map((entry) => entry.kind)).not.toContain('test_overlay');
  });

  it('refuses install of a kind that is built in or taken, and installs nothing then', () => {
    expect(() => installPlugin(plugin('test-overlay-clash', 'cage'))).toThrow(/"cage" is already taken/);
    expect(() => installPlugin(plugin('test-overlay-twice', 'test_twice', 'test_twice'))).toThrow(/"test_twice" is already taken/);
    expect(pluginRenderOverlays().map((entry) => entry.kind)).not.toContain('test_twice');
  });

  it('after install the kind is accepted, drawn with the projector, the document and the isolate list, and reported in data.overlays', () => {
    installPlugin(plugin('test-overlay-ok', 'test_overlay'));
    expect(() => installPlugin(plugin('test-overlay-dup', 'test_overlay'))).toThrow(/already taken/);
    const result = render(doc, { overlay: ['test_overlay', 'cage'], isolate: 'e1' });
    expect(result.error, result.summary).toBeUndefined();
    const out = result.data as {
      svg: string;
      overlays: Record<string, { entities: string[]; lines: number; points: number; detail?: unknown }>;
    };
    expect(out.svg).toContain('<g class="test-overlay" data-kind="test_overlay"/>');
    expect(out.svg).toContain('<!-- test_overlay overlay -->');
    expect(out.overlays['test_overlay']).toEqual({ entities: ['e1'], lines: 3, points: 1, detail: { note: 'x' } });
    expect(Object.keys(out.overlays)).toEqual(['cage', 'test_overlay']);
    const call = calls.at(-1);
    expect(call?.docSeen).toBe(doc);
    expect(call?.only).toEqual(['e1']);
    expect(call?.point.every(Number.isFinite)).toBe(true);
  });

  it('is not called for a perspective render (the summary says so) and leaves the document untouched', () => {
    const before = calls.length;
    const result = render(doc, { overlay: 'test_overlay', projection: 'perspective', mode: 'raster' });
    expect(result.summary).toContain('Overlay test_overlay not drawn: it needs an orthographic view');
    expect(calls.length).toBe(before);
    expect(result.document).toBe(doc);
    expectPure(doc, () => render(doc, { overlay: 'test_overlay' }));
  });
});

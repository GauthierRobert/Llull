/** The render-overlay extension point (`CadPlugin.renderOverlays`): core accepts a kind only when it or an installed plugin registered it, and draws plugin kinds without importing them. */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { installPlugin, pluginRenderOverlays } from '@core/plugins/host';
import type { CadPlugin } from '@core/plugins/plugin';
import type { RenderOverlay } from '@core/model/renderOverlay';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';

const calls: { docSeen: CadDocument; only: readonly string[] | undefined; entityIds: string[]; point: [number, number] }[] = [];
const overlay = (kind: string): RenderOverlay => ({
  kind,
  draw: (doc, view) => {
    calls.push({ docSeen: doc, only: view.only, entityIds: view.entities.map((entity) => entity.id), point: view.project([0, 0, 0]) });
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

const throwing: CadPlugin = {
  name: 'test-overlay-throws',
  toolset: 'test',
  commands: [],
  renderOverlays: [
    {
      kind: 'test_throws',
      draw: () => {
        throw new Error('boom');
      },
    },
  ],
};

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

  it('a plugin overlay that throws does not fail the render: the picture returns, the summary and stats name the kind and the message', () => {
    installPlugin(plugin('test-overlay-ok', 'test_overlay'));
    installPlugin(throwing);
    const result = render(doc, { overlay: ['test_throws', 'test_overlay'] });
    expect(result.error, result.summary).toBeUndefined();
    expect(result.summary).toContain('Overlay test_throws failed: boom');
    const out = result.data as { svg: string; overlays: Record<string, { lines: number; detail?: { failed?: string } }> };
    expect(out.svg).toContain('<svg');
    expect(out.overlays['test_throws']).toMatchObject({ lines: 0, detail: { failed: 'boom' } });
    expect(out.overlays['test_overlay']?.lines).toBe(3);
  });

  it('gives a plugin the same isolate-filtered entity list as the built-ins', () => {
    installPlugin(plugin('test-overlay-ok', 'test_overlay'));
    const first = execute(doc, 'add_box', { size: [1, 1, 1] });
    const second = execute(first.document, 'add_box', { size: [1, 1, 1] });
    const [a, b] = [first.affected[0] as string, second.affected[0] as string];
    render(second.document, { overlay: 'test_overlay' });
    expect(calls.at(-1)?.entityIds).toEqual([a, b]);
    render(second.document, { overlay: 'test_overlay', isolate: b });
    expect(calls.at(-1)?.entityIds).toEqual([b]);
    expect(calls.at(-1)?.only).toEqual([b]);
  });
});

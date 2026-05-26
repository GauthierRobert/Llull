/**
 * @layer server/tests
 *
 * Tests for renderViewEnrich.ts — server-side render_view enrichments.
 *
 * Each enrichment param gets at least one happy-path test:
 *   (A) turntable  — N-frame strip: returns array of N SVG strings; PNG non-empty
 *   (B) isolate    — dim non-highlighted entities; result SVG non-empty; PNG valid
 *   (C) showDimensions — appendDimensionLabels adds W/D/H text to existing SVG
 *   (D) section    — section-plane overlay; result SVG non-empty; PNG valid
 *
 * All tests use a minimal CadDocument with one box entity so rendering is fast
 * and deterministic. PNG magic bytes 0x89PNG are verified where rasterization
 * is involved.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { __resetIdCounter } from '@lib/id';
import type { CadDocument } from '@core/model/types';
import type { RenderViewData } from '@core/commands/render';
import { rasterizeSvg } from '../src/renderImage';
import {
  buildTurntableFrames,
  buildIsolateSvg,
  appendDimensionLabels,
  appendAxesAndGrid,
  buildSectionSvg,
} from '../src/renderViewEnrich';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** PNG magic bytes (first 4 bytes of any valid PNG file). */
const PNG_MAGIC_HEX = '89504e47';

function isPngBase64(base64: string): boolean {
  const buf = Buffer.from(base64, 'base64');
  return buf.slice(0, 4).toString('hex') === PNG_MAGIC_HEX;
}

// ---------------------------------------------------------------------------
// Fixture: minimal document with one box entity
// ---------------------------------------------------------------------------

function makeDocWithBox(): { doc: CadDocument; boxId: string } {
  const empty = createEmptyDocument();
  const result = execute(empty, 'add_box', {
    position: [0, 0, 0],
    size: [2, 2, 2],
    color: '#336699',
  });
  const boxId = result.affected[0] as string;
  return { doc: result.document, boxId };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  __resetIdCounter();
});

// ---------------------------------------------------------------------------
// (A) turntable — N evenly-spaced frames around Z axis
// ---------------------------------------------------------------------------

describe('buildTurntableFrames', () => {
  it('returns an array of N SVG strings for a document with entities', () => {
    const { doc } = makeDocWithBox();
    const frames = buildTurntableFrames(doc, 4, 'iso', 200, 150);
    expect(frames).not.toBeNull();
    expect(frames!.length).toBe(4);
    for (const svg of frames!) {
      expect(typeof svg).toBe('string');
      expect(svg.length).toBeGreaterThan(0);
      expect(svg).toContain('<svg');
      expect(svg).toContain('</svg>');
    }
  });

  it('clamps frames to [1, 12]', () => {
    const { doc } = makeDocWithBox();
    const tooMany = buildTurntableFrames(doc, 99, 'iso', 200, 150);
    expect(tooMany).not.toBeNull();
    expect(tooMany!.length).toBe(12);

    const tooFew = buildTurntableFrames(doc, 0, 'iso', 200, 150);
    expect(tooFew).not.toBeNull();
    expect(tooFew!.length).toBe(1);
  });

  it('produces frames 1 for empty doc (valid empty SVGs)', () => {
    const doc = createEmptyDocument();
    const frames = buildTurntableFrames(doc, 3, 'iso', 200, 150);
    expect(frames).not.toBeNull();
    expect(frames!.length).toBe(3);
  });

  it('each frame SVG rasterizes to a valid PNG', () => {
    const { doc } = makeDocWithBox();
    const frames = buildTurntableFrames(doc, 2, 'front', 200, 150);
    expect(frames).not.toBeNull();
    for (const svg of frames!) {
      const base64 = rasterizeSvg(svg, 200);
      expect(base64).not.toBeNull();
      expect(isPngBase64(base64!)).toBe(true);
    }
  });

  it('different frames produce different SVG content (rotation applied)', () => {
    const { doc } = makeDocWithBox();
    const frames = buildTurntableFrames(doc, 4, 'front', 200, 150);
    expect(frames).not.toBeNull();
    // All 4 frames must not be identical (entity positions differ due to rotation)
    const unique = new Set(frames!);
    expect(unique.size).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// (B) isolate — highlight specific entities
// ---------------------------------------------------------------------------

describe('buildIsolateSvg', () => {
  it('returns a non-empty SVG string when isolating an existing entity', () => {
    const { doc, boxId } = makeDocWithBox();
    const svg = buildIsolateSvg(doc, [boxId], 'iso', 200, 150);
    expect(svg).not.toBeNull();
    expect(svg!.length).toBeGreaterThan(0);
    expect(svg!).toContain('<svg');
    expect(svg!).toContain('</svg>');
  });

  it('SVG includes opacity dimming layer for non-highlighted entities', () => {
    const { doc } = makeDocWithBox();
    // Isolate a non-existent id — all entities should be dimmed
    const svg = buildIsolateSvg(doc, ['nonexistent-id'], 'iso', 200, 150);
    expect(svg).not.toBeNull();
    expect(svg!).toContain('opacity="0.15"');
  });

  it('SVG includes the ISOLATED label', () => {
    const { doc, boxId } = makeDocWithBox();
    const svg = buildIsolateSvg(doc, [boxId], 'iso', 200, 150);
    expect(svg).not.toBeNull();
    expect(svg!).toContain('ISOLATED');
  });

  it('rasterizes to a valid PNG (magic bytes)', () => {
    const { doc, boxId } = makeDocWithBox();
    const svg = buildIsolateSvg(doc, [boxId], 'iso', 200, 150);
    expect(svg).not.toBeNull();
    const base64 = rasterizeSvg(svg!, 200);
    expect(base64).not.toBeNull();
    expect(isPngBase64(base64!)).toBe(true);
  });

  it('accepts an array of multiple entity ids', () => {
    const { doc, boxId } = makeDocWithBox();
    const svg = buildIsolateSvg(doc, [boxId, 'other-id'], 'iso', 200, 150);
    expect(svg).not.toBeNull();
    expect(svg!).toContain('<svg');
  });

  it('works on empty document', () => {
    const doc = createEmptyDocument();
    const svg = buildIsolateSvg(doc, ['nonexistent'], 'iso', 200, 150);
    expect(svg).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (C) showDimensions — appendDimensionLabels
// ---------------------------------------------------------------------------

describe('appendDimensionLabels', () => {
  it('adds W/D/H dimension text labels to the SVG', () => {
    const { doc } = makeDocWithBox();
    const renderResult = execute(doc, 'render_view', { view: 'iso', width: 200, height: 150 });
    const data = renderResult.data as RenderViewData;
    expect(data).toBeDefined();

    const enriched = appendDimensionLabels(data.svg, data);
    expect(enriched).toContain('W:');
    expect(enriched).toContain('D:');
    expect(enriched).toContain('H:');
  });

  it('inserted labels are inside a <g> group element', () => {
    const { doc } = makeDocWithBox();
    const renderResult = execute(doc, 'render_view', { view: 'iso', width: 200, height: 150 });
    const data = renderResult.data as RenderViewData;

    const enriched = appendDimensionLabels(data.svg, data);
    expect(enriched).toContain('bounding box dimensions');
  });

  it('returns the SVG unchanged when bounds is null (empty document)', () => {
    const doc = createEmptyDocument();
    const renderResult = execute(doc, 'render_view', { view: 'iso', width: 200, height: 150 });
    const data = renderResult.data as RenderViewData;
    expect(data.bounds).toBeNull();

    const enriched = appendDimensionLabels(data.svg, data);
    expect(enriched).toBe(data.svg);
  });

  it('still rasterizes to a valid PNG after dimension injection', () => {
    const { doc } = makeDocWithBox();
    const renderResult = execute(doc, 'render_view', { view: 'iso', width: 200, height: 150 });
    const data = renderResult.data as RenderViewData;

    const enriched = appendDimensionLabels(data.svg, data);
    const base64 = rasterizeSvg(enriched, 200);
    expect(base64).not.toBeNull();
    expect(isPngBase64(base64!)).toBe(true);
  });

  it('dimension values match the actual bounding box extents', () => {
    const { doc } = makeDocWithBox();
    const renderResult = execute(doc, 'render_view', { view: 'iso', width: 200, height: 150 });
    const data = renderResult.data as RenderViewData;
    expect(data.bounds).not.toBeNull();

    const enriched = appendDimensionLabels(data.svg, data);

    // The box is 2×2×2, so all three dimension labels should show "2"
    const wMatch = enriched.match(/W:([\d.]+)/);
    const dMatch = enriched.match(/D:([\d.]+)/);
    const hMatch = enriched.match(/H:([\d.]+)/);
    expect(wMatch).not.toBeNull();
    expect(dMatch).not.toBeNull();
    expect(hMatch).not.toBeNull();
    expect(parseFloat(wMatch![1]!)).toBeCloseTo(2, 0);
    expect(parseFloat(dMatch![1]!)).toBeCloseTo(2, 0);
    expect(parseFloat(hMatch![1]!)).toBeCloseTo(2, 0);
  });
});

// ---------------------------------------------------------------------------
// (D) section — section-plane overlay
// ---------------------------------------------------------------------------

describe('buildSectionSvg', () => {
  it('returns a non-empty SVG string for a z-section cut', () => {
    const { doc } = makeDocWithBox();
    const svg = buildSectionSvg(doc, { axis: 'z', offset: 0 }, 'iso', 200, 150);
    expect(svg).not.toBeNull();
    expect(svg!.length).toBeGreaterThan(0);
    expect(svg!).toContain('<svg');
    expect(svg!).toContain('</svg>');
  });

  it('SVG includes the section-plane indicator line', () => {
    const { doc } = makeDocWithBox();
    const svg = buildSectionSvg(doc, { axis: 'z', offset: 0 }, 'iso', 200, 150);
    expect(svg).not.toBeNull();
    expect(svg!).toContain('section-plane');
    expect(svg!).toContain('stroke-dasharray');
  });

  it('SVG includes SECTION label with axis and offset', () => {
    const { doc } = makeDocWithBox();
    const svg = buildSectionSvg(doc, { axis: 'z', offset: 1 }, 'iso', 200, 150);
    expect(svg).not.toBeNull();
    expect(svg!).toContain('SECTION Z=1');
  });

  it('works for x and y axis sections', () => {
    const { doc } = makeDocWithBox();
    const svgX = buildSectionSvg(doc, { axis: 'x', offset: 0 }, 'front', 200, 150);
    const svgY = buildSectionSvg(doc, { axis: 'y', offset: 0 }, 'front', 200, 150);
    expect(svgX).not.toBeNull();
    expect(svgY).not.toBeNull();
    expect(svgX!).toContain('SECTION X=0');
    expect(svgY!).toContain('SECTION Y=0');
  });

  it('includes opacity dimming layer for the negative side of the cut', () => {
    const { doc } = makeDocWithBox();
    // Cut at z=10 — the whole box (at z=0) is on the negative side → dimmed
    const svg = buildSectionSvg(doc, { axis: 'z', offset: 10 }, 'iso', 200, 150);
    expect(svg).not.toBeNull();
    expect(svg!).toContain('opacity="0.25"');
  });

  it('rasterizes to a valid PNG (magic bytes)', () => {
    const { doc } = makeDocWithBox();
    const svg = buildSectionSvg(doc, { axis: 'z', offset: 0 }, 'iso', 200, 150);
    expect(svg).not.toBeNull();
    const base64 = rasterizeSvg(svg!, 200);
    expect(base64).not.toBeNull();
    expect(isPngBase64(base64!)).toBe(true);
  });

  it('works on empty document', () => {
    const doc = createEmptyDocument();
    const svg = buildSectionSvg(doc, { axis: 'z', offset: 0 }, 'iso', 200, 150);
    expect(svg).not.toBeNull();
    expect(svg!).toContain('<svg');
  });
});

// ---------------------------------------------------------------------------
// Back-compat: render_view with no enrichment params still produces a valid SVG
// ---------------------------------------------------------------------------

describe('render_view back-compat (no enrichment)', () => {
  it('base render_view command still works and produces data.svg', () => {
    const { doc } = makeDocWithBox();
    const result = execute(doc, 'render_view', { view: 'iso', width: 200, height: 150 });
    expect(result.data).toBeDefined();
    const data = result.data as RenderViewData;
    expect(typeof data.svg).toBe('string');
    expect(data.svg).toContain('<svg');
    expect(data.entityCount).toBe(1);
  });

  it('base render_view with no params defaults to iso 800x600', () => {
    const { doc } = makeDocWithBox();
    const result = execute(doc, 'render_view', {});
    const data = result.data as RenderViewData;
    expect(data.view).toBe('iso');
    expect(data.width).toBe(800);
    expect(data.height).toBe(600);
  });
});

// ---------------------------------------------------------------------------
// (E) appendAxesAndGrid — world-frame axis triad + ground grid overlay
// ---------------------------------------------------------------------------

describe('appendAxesAndGrid', () => {
  it('inserts world-axes group into the SVG when showAxes=true', () => {
    const { doc } = makeDocWithBox();
    const renderResult = execute(doc, 'render_view', { view: 'iso', width: 200, height: 150 });
    const data = renderResult.data as RenderViewData;

    const enriched = appendAxesAndGrid(data.svg, data, 'mm', true, false);
    expect(enriched).toContain('id="world-axes"');
    expect(enriched).toContain('</svg>');
  });

  it('inserts X/Y/Z labels into the SVG when showAxes=true', () => {
    const { doc } = makeDocWithBox();
    const renderResult = execute(doc, 'render_view', { view: 'iso', width: 200, height: 150 });
    const data = renderResult.data as RenderViewData;

    const enriched = appendAxesAndGrid(data.svg, data, 'mm', true, false);
    // Axis labels X, Y, Z must appear
    expect(enriched).toMatch(/>X</);
    expect(enriched).toMatch(/>Y</);
    expect(enriched).toMatch(/>Z</);
  });

  it('inserts ground-grid group into the SVG when showGrid=true', () => {
    const { doc } = makeDocWithBox();
    const renderResult = execute(doc, 'render_view', { view: 'iso', width: 200, height: 150 });
    const data = renderResult.data as RenderViewData;

    const enriched = appendAxesAndGrid(data.svg, data, 'mm', false, true);
    expect(enriched).toContain('id="ground-grid"');
  });

  it('inserts both axes and grid when both flags are true', () => {
    const { doc } = makeDocWithBox();
    const renderResult = execute(doc, 'render_view', { view: 'iso', width: 200, height: 150 });
    const data = renderResult.data as RenderViewData;

    const enriched = appendAxesAndGrid(data.svg, data, 'mm', true, true);
    expect(enriched).toContain('id="world-axes"');
    expect(enriched).toContain('id="ground-grid"');
  });

  it('does NOT insert axes or grid when both flags are false', () => {
    const { doc } = makeDocWithBox();
    const renderResult = execute(doc, 'render_view', { view: 'iso', width: 200, height: 150 });
    const data = renderResult.data as RenderViewData;

    const enriched = appendAxesAndGrid(data.svg, data, 'mm', false, false);
    expect(enriched).not.toContain('id="world-axes"');
    expect(enriched).not.toContain('id="ground-grid"');
  });

  it('uses X=red, Y=green, Z=blue axis colors', () => {
    const { doc } = makeDocWithBox();
    const renderResult = execute(doc, 'render_view', { view: 'iso', width: 200, height: 150 });
    const data = renderResult.data as RenderViewData;

    const enriched = appendAxesAndGrid(data.svg, data, 'mm', true, false);
    // Red for X, green for Y, blue for Z (stroke colors)
    expect(enriched).toContain('#ff4444');
    expect(enriched).toContain('#44dd44');
    expect(enriched).toContain('#4488ff');
  });

  it('includes a scale label showing the document units', () => {
    const { doc } = makeDocWithBox();
    const renderResult = execute(doc, 'render_view', { view: 'iso', width: 200, height: 150 });
    const data = renderResult.data as RenderViewData;

    const enriched = appendAxesAndGrid(data.svg, data, 'mm', true, false);
    // Scale label mentions "mm" and "px"
    expect(enriched).toContain('mm');
    expect(enriched).toContain('px');
  });

  it('document units appear in scale label for different unit types', () => {
    const { doc } = makeDocWithBox();
    const renderResult = execute(doc, 'render_view', { view: 'iso', width: 200, height: 150 });
    const data = renderResult.data as RenderViewData;

    const enrichedM = appendAxesAndGrid(data.svg, data, 'm', true, false);
    expect(enrichedM).toContain(' m ');
    const enrichedIn = appendAxesAndGrid(data.svg, data, 'in', true, false);
    expect(enrichedIn).toContain('in');
  });

  it('works for top-down view (Z axis degenerates to a point in screen space)', () => {
    const { doc } = makeDocWithBox();
    const renderResult = execute(doc, 'render_view', { view: 'top', width: 200, height: 150 });
    const data = renderResult.data as RenderViewData;
    // Should not throw even when Z projects near the origin
    expect(() => appendAxesAndGrid(data.svg, data, 'mm', true, true)).not.toThrow();
  });

  it('works for front view', () => {
    const { doc } = makeDocWithBox();
    const renderResult = execute(doc, 'render_view', { view: 'front', width: 200, height: 150 });
    const data = renderResult.data as RenderViewData;
    expect(() => appendAxesAndGrid(data.svg, data, 'mm', true, true)).not.toThrow();
  });

  it('works on an empty document (null bounds)', () => {
    const doc = createEmptyDocument();
    const renderResult = execute(doc, 'render_view', { view: 'iso', width: 200, height: 150 });
    const data = renderResult.data as RenderViewData;
    expect(data.bounds).toBeNull();
    // Should still inject axes/grid without throwing
    expect(() => appendAxesAndGrid(data.svg, data, 'mm', true, true)).not.toThrow();
    const enriched = appendAxesAndGrid(data.svg, data, 'mm', true, true);
    expect(enriched).toContain('id="world-axes"');
  });

  it('still rasterizes to a valid PNG after axes+grid injection', () => {
    const { doc } = makeDocWithBox();
    const renderResult = execute(doc, 'render_view', { view: 'iso', width: 200, height: 150 });
    const data = renderResult.data as RenderViewData;

    const enriched = appendAxesAndGrid(data.svg, data, 'mm', true, true);
    const base64 = rasterizeSvg(enriched, 200);
    expect(base64).not.toBeNull();
    expect(isPngBase64(base64!)).toBe(true);
  });
});

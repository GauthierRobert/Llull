/**
 * Tests that render_view honors entity.rotation for 3D solid kinds.
 *
 * Regression guard: tessellate<Kind> in render.ts must apply entity.rotation, matching
 * the live three.js viewport's <mesh rotation={...}/>.
 *
 * Rotation convention confirmed from src/ui/viewport/3d/entities/*Mesh.tsx:
 *   <mesh rotation={[rotation[0], rotation[1], rotation[2]]}>
 * three.js Euler default order is 'XYZ': column-vector composition M = Rx·Ry·Rz,
 * meaning Rz acts on the vector first, then Ry, then Rx (verified in three.js
 * Matrix4.makeRotationFromEuler where M[0][2] = sin(y), matching Rx·Ry·Rz·ẑ).
 * render.ts applies the same Rx·Ry·Rz matrix about entity.position.
 *
 * @layer tests/unit
 */

import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { applyEulerXYZ } from '@core/lib/eulerRotation';

// ---------------------------------------------------------------------------
// SVG bbox helpers
// ---------------------------------------------------------------------------

/**
 * Parse all `points="..."` attributes from SVG polygon/polyline elements and
 * return the union bounding box [minX, minY, maxX, maxY] in SVG screen space.
 * Returns null when no polygon points are found.
 */
function svgPolygonBbox(
  svg: string,
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  // Match all points="..." attributes (polygon and polyline elements)
  const pointsRe = /points="([^"]*)"/g;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  let found = false;

  let m: RegExpExecArray | null;
  while ((m = pointsRe.exec(svg)) !== null) {
    const pairs = m[1]!.trim().split(/\s+/);
    for (const pair of pairs) {
      const [xs, ys] = pair.split(',');
      if (xs === undefined || ys === undefined) continue;
      const x = parseFloat(xs);
      const y = parseFloat(ys);
      if (isNaN(x) || isNaN(y)) continue;
      found = true;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (!found) return null;
  return { minX, minY, maxX, maxY };
}

/** Screen-space width of the union bbox (maxX - minX). */
function bboxWidth(b: { minX: number; maxX: number }): number {
  return b.maxX - b.minX;
}

/** Screen-space height of the union bbox (maxY - minY). */
function bboxHeight(b: { minY: number; maxY: number }): number {
  return b.maxY - b.minY;
}

// ---------------------------------------------------------------------------
// Helper: render a doc and return the SVG string for a named view
// ---------------------------------------------------------------------------

function renderSvg(doc: ReturnType<typeof createEmptyDocument>, view: string): string {
  const result = execute(doc, 'render_view', { view, width: 400, height: 400 });
  return (result.data as { svg: string }).svg;
}

type Bbox = { minX: number; minY: number; maxX: number; maxY: number };

/** Add one solid (optionally rotate it by `delta`) and return the SVG bbox / SVG of `view`. */
function renderSolid(
  addCommand: string,
  params: Record<string, unknown>,
  delta?: [number, number, number],
  view = 'front',
): { svg: string; bbox: Bbox | null } {
  let doc = execute(createEmptyDocument(), addCommand, { ...params, position: [0, 0, 0] }).document;
  if (delta) doc = execute(doc, 'rotate_entity', { id: doc.order[0]!, delta }).document;
  const svg = renderSvg(doc, view);
  return { svg, bbox: svgPolygonBbox(svg) };
}

const QUARTER_X: [number, number, number] = [Math.PI / 2, 0, 0];

/** Unrotated vs rotated front-view bboxes of one solid. */
function frontPair(
  addCommand: string,
  params: Record<string, unknown>,
  delta: [number, number, number] = QUARTER_X,
): { a: Bbox; b: Bbox } {
  const a = renderSolid(addCommand, params).bbox;
  const b = renderSolid(addCommand, params, delta).bbox;
  expect(a).not.toBeNull();
  expect(b).not.toBeNull();
  return { a: a!, b: b! };
}

// ---------------------------------------------------------------------------
// Cylinder rotation test
//
// Unrotated cylinder: axis along Z (Z-up document convention).
// Rotated by [π/2, 0, 0] (90° about X): axis swings to Y-axis.
//
// From the FRONT view (camera looking along +Y, up = +Z):
//   - Unrotated cylinder (Z-axis): appears TALL (extent along screen-Y = height,
//     extent along screen-X = 2*radius).
//   - Rotated cylinder (Y-axis after Rx 90°): the axis is now pointing into the
//     camera (Y-axis), so the silhouette becomes a circle of radius=radius on both
//     screen axes.  Width ≈ Height ≈ 2*radius (< height when height > diameter).
//
// For radius=1, height=4: unrotated front-view height >> width; rotated ≈ square.
// ---------------------------------------------------------------------------

describe('render_view rotation — cylinder', () => {
  const cyl = { radius: 1, height: 4 };

  it('unrotated cylinder front view is taller than wide', () => {
    const { bbox } = renderSolid('add_cylinder', cyl);
    expect(bbox).not.toBeNull();
    // Z-axis cylinder seen from front: taller (Y screen) than wide (X screen)
    expect(bboxHeight(bbox!)).toBeGreaterThan(bboxWidth(bbox!));
  });

  it('cylinder rotated [π/2,0,0] front view becomes nearly square (axis into camera)', () => {
    const { bbox } = renderSolid('add_cylinder', cyl, QUARTER_X);
    expect(bbox).not.toBeNull();
    // Axis now along Y (into camera): silhouette roughly a circle, width ≈ height ≈ 2*radius.
    const ratio = bboxWidth(bbox!) / bboxHeight(bbox!);
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2.0);
  });

  it('rotated bbox differs from unrotated bbox', () => {
    const { a, b } = frontPair('add_cylinder', cyl);
    expect(Math.abs(bboxHeight(a) - bboxHeight(b))).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
// Box rotation test
//
// Unrotated box [1,1,4] (slim Z-tall box): from front view it's tall and narrow.
// Rotated [π/2,0,0]: the tall axis swings to Y (into camera); box looks square-ish.
// ---------------------------------------------------------------------------

describe('render_view rotation — box', () => {
  const slim = { size: [1, 1, 4] };

  it('unrotated box [1,1,4] front view is taller than wide', () => {
    const { bbox } = renderSolid('add_box', slim);
    expect(bbox).not.toBeNull();
    expect(bboxHeight(bbox!)).toBeGreaterThan(bboxWidth(bbox!));
  });

  it('box [1,1,4] rotated [π/2,0,0] front view is no longer taller than wide', () => {
    const { bbox } = renderSolid('add_box', slim, QUARTER_X);
    expect(bbox).not.toBeNull();
    // Long axis is now into the camera; screen shape is ~square.
    expect(bboxWidth(bbox!)).toBeGreaterThan(0);
    expect(bboxHeight(bbox!) / bboxWidth(bbox!)).toBeLessThan(1.5);
  });

  it('rotated bbox differs from unrotated bbox', () => {
    const { a, b } = frontPair('add_box', slim);
    expect(Math.abs(bboxHeight(a) - bboxHeight(b))).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
// Torus rotation test
//
// Unrotated torus: ring in XY plane, from front view it looks like an ellipse.
// Rotated [π/2,0,0]: the ring plane swings to XZ, from front view it looks like
// a circle — the screen height shrinks.
// ---------------------------------------------------------------------------

describe('render_view rotation — torus', () => {
  it('torus rotated [π/2,0,0] produces different bbox from unrotated torus', () => {
    const { a, b } = frontPair('add_torus', { ringRadius: 2, tubeRadius: 0.5 });
    expect(Math.abs(bboxHeight(a) - bboxHeight(b))).toBeGreaterThan(5);
  });
});

// ---------------------------------------------------------------------------
// Cone rotation test
//
// Unrotated cone: base in XY, apex along +Z. From front: tall triangle.
// Rotated [π/2,0,0]: apex points along +Y (into camera from front).
// From front: roughly circular / disc shape.
// ---------------------------------------------------------------------------

describe('render_view rotation — cone', () => {
  it('cone rotated [π/2,0,0] has different front-view height than unrotated', () => {
    const { a, b } = frontPair('add_cone', { radius: 1, height: 4 });
    expect(Math.abs(bboxHeight(a) - bboxHeight(b))).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
// Zero rotation regression — must produce identical SVG
// ---------------------------------------------------------------------------

describe('render_view rotation — zero rotation is a no-op', () => {
  it.each([
    ['cylinder', 'add_cylinder', { radius: 1, height: 2 }],
    ['box', 'add_box', { size: [2, 3, 4] }],
  ])('%s with rotation [0,0,0] produces identical SVG to default', (_kind, command, params) => {
    const plain = renderSolid(command, params, undefined, 'iso').svg;
    const zeroRotated = renderSolid(command, params, [0, 0, 0], 'iso').svg;
    expect(plain).toBe(zeroRotated);
  });
});

// ---------------------------------------------------------------------------
// Pyramid and Wedge rotation tests
// ---------------------------------------------------------------------------

describe('render_view rotation — pyramid', () => {
  it('pyramid rotated [π/2,0,0] has different front-view bbox than unrotated', () => {
    const { a, b } = frontPair('add_pyramid', { baseWidth: 2, baseDepth: 2, height: 4 });
    expect(Math.abs(bboxHeight(a) - bboxHeight(b))).toBeGreaterThan(5);
  });
});

describe('render_view rotation — wedge', () => {
  it('wedge rotated [0,0,π/2] has different front-view bbox than unrotated', () => {
    const { a, b } = frontPair('add_wedge', { size: [1, 4, 1] }, [0, 0, Math.PI / 2]);
    // After rotating about Z, what was along Y now points along X — bboxes differ
    expect(Math.abs(bboxWidth(a) - bboxWidth(b))).toBeGreaterThan(5);
  });
});

// ---------------------------------------------------------------------------
// Compound-rotation tests — these FAIL on the old Rz·Ry·Rx (wrong) order and
// PASS on the corrected Rx·Ry·Rz (three.js XYZ) order.
//
// These are the discriminating tests: single-axis rotations commute trivially,
// so only multi-axis inputs expose the convention difference.
// ---------------------------------------------------------------------------

describe('applyEulerXYZ — compound rotation math (convention discriminator)', () => {
  const EPS = 1e-10;
  const approx = (a: number, b: number): boolean => Math.abs(a - b) < EPS;

  /**
   * For euler = [π/2, π/2, 0], input v = (0,0,1):
   *
   * three.js / correct Rx·Ry·Rz order:
   *   Rz (rz=0): v unchanged → (0, 0, 1)
   *   Ry (ry=π/2): x2 = cos(π/2)*0 + sin(π/2)*1 = 1, z2 = -sin(π/2)*0 + cos(π/2)*1 = 0 → (1, 0, 0)
   *   Rx (rx=π/2): y3 = cos(π/2)*0 - sin(π/2)*0 = 0, z3 = sin(π/2)*0 + cos(π/2)*0 = 0 → (1, 0, 0)
   * Result: (1, 0, 0)
   *
   * Wrong Rx·Ry·Rz order (old code applied Rx first):
   *   Rx (rx=π/2): y1 = -1, z1 = 0 → (0, -1, 0)
   *   Ry (ry=π/2): x2 = 0, z2 = 0 → (0, -1, 0)
   *   Rz (rz=0): unchanged → (0, -1, 0)
   * Result: (0, -1, 0) ← wrong
   */
  it('applyEulerXYZ([0,0,1], [0,0,0], [π/2, π/2, 0]) → (1, 0, 0)', () => {
    const result = applyEulerXYZ([0, 0, 1], [0, 0, 0], [Math.PI / 2, Math.PI / 2, 0]);
    expect(approx(result[0], 1)).toBe(true);
    expect(approx(result[1], 0)).toBe(true);
    expect(approx(result[2], 0)).toBe(true);
  });

  /**
   * For euler = [0, π/2, π/2], input v = (1,0,0):
   *
   * three.js / correct Rx·Ry·Rz order (Rz first):
   *   Rz (rz=π/2): x1 = cos(π/2)*1 - sin(π/2)*0 = 0, y1 = sin(π/2)*1 + cos(π/2)*0 = 1 → (0, 1, 0)
   *   Ry (ry=π/2): x2 = cos(π/2)*0 + sin(π/2)*0 = 0, z2 = -sin(π/2)*0 + cos(π/2)*0 = 0 → (0, 1, 0)
   *   Rx (rx=0): unchanged → (0, 1, 0)
   * Result: (0, 1, 0)
   *
   * Wrong old order (Rx first, then Ry, then Rz):
   *   Rx (rx=0): unchanged → (1, 0, 0)
   *   Ry (ry=π/2): x2 = cos(π/2)*1 + sin(π/2)*0 = 0, z2 = -sin(π/2)*1 + cos(π/2)*0 = -1 → (0, 0, -1)
   *   Rz (rz=π/2): x3 = cos(π/2)*0 - sin(π/2)*0 = 0, y3 = sin(π/2)*0 + cos(π/2)*0 = 0 → (0, 0, -1)
   * Result: (0, 0, -1) ← wrong
   */
  it('applyEulerXYZ([1,0,0], [0,0,0], [0, π/2, π/2]) → (0, 1, 0)', () => {
    const result = applyEulerXYZ([1, 0, 0], [0, 0, 0], [0, Math.PI / 2, Math.PI / 2]);
    expect(approx(result[0], 0)).toBe(true);
    expect(approx(result[1], 1)).toBe(true);
    expect(approx(result[2], 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// End-to-end compound-rotation test: a thin elongated box rotated [π/2, π/2, 0]
//
// Box size [100, 4, 4]. When unrotated, from front view: wide (100 screen-units
// along X), thin (4 units along Z, shown as screen-Y). After rotation [π/2, π/2, 0]:
//
// Using correct Rx·Ry·Rz:
//   The long axis (X=100) after Ry(π/2) becomes the Z axis; after Rx(π/2) Z→Y
//   (which is the depth axis in front view). So from front, the long dimension
//   disappears into depth and the box appears nearly square (4×4).
//   bboxWidth ≈ bboxHeight ≈ 4 (much less than 100 unrotated width).
//
// Using wrong Rz·Ry·Rx:
//   Rx first: +Z corners swing to +Y; then Ry(π/2): X-corners swing to +Z.
//   Long axis ends up along Z (screen-Y in front view): box appears TALL not wide.
//   bboxWidth ≈ 4, bboxHeight ≈ 100 — opposite of the correct result.
// ---------------------------------------------------------------------------

describe('render_view rotation — compound-rotation end-to-end (convention discriminator)', () => {
  it('thin box [100,4,4] rotated [π/2, π/2, 0]: front-view appears nearly square (long axis into depth)', () => {
    const { bbox } = renderSolid('add_box', { size: [100, 4, 4] }, [Math.PI / 2, Math.PI / 2, 0]);
    expect(bbox).not.toBeNull();
    const w = bboxWidth(bbox!);
    const h = bboxHeight(bbox!);
    // Correct Rx·Ry·Rz: long axis (X=100) goes into depth; front face is 4×4 → aspect near 1.
    // Wrong Rz·Ry·Rx order would produce bboxHeight >> bboxWidth (long axis ends up as screen-Y).
    expect(w / h).toBeGreaterThan(0.5);
    expect(w / h).toBeLessThan(2.0);
    // And neither dimension should be anywhere near 100-unit scale
    // (the camera frames to scene bounds, so verify aspect rather than absolute pixels)
  });
});

/**
 * 03 WRP M3 edge cases on the native kernel: a band all the way around (seam), the trimmed top face of a cylinder, a bore, a text deboss and wrapped text.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setFontProvider } from '@core/commands/fontPort';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { createNativeTestKernel, describeNativeWhen } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';
import { createFontProvider } from '../src/fontProvider';

type Doc = CadDocument;

describeNativeWhen({ capabilities: ['emboss'], label: 'WRP native edges' })('WRP M3 edge cases (native OCCT kernel)', () => {
  let kernel: IsolatedKernel;
  beforeAll(() => {
    kernel = createNativeTestKernel();
    setGeometryKernel(kernel);
    setFontProvider(createFontProvider());
  }, 120_000);
  afterAll(() => {
    setGeometryKernel(null);
    setFontProvider(null);
    kernel.dispose();
  });

  const run = (doc: Doc, name: string, params: Record<string, unknown>): ReturnType<typeof execute> => execute(doc, name, params);
  const must = (doc: Doc, name: string, params: Record<string, unknown>): { doc: Doc; id: string; data: Record<string, unknown> } => {
    const result = run(doc, name, params);
    expect(result.rejected, result.summary).toBeUndefined();
    return { doc: result.document, id: result.affected[0] as string, data: (result.data ?? {}) as Record<string, unknown> };
  };
  const volume = (doc: Doc, id: string): number => (run(doc, 'mass_properties', { entityId: id }).data as { volume: number }).volume;
  const relative = (value: number, reference: number): number => Math.abs(value - reference) / Math.abs(reference);

  it('VC-WRP-04: a band 2 pi r wide, 10 high, 1 deep around r 20 (crossing the seam) adds 410 pi mm3', () => {
    const body = must(createEmptyDocument(), 'add_cylinder', { radius: 20, height: 40 });
    const width = 2 * Math.PI * 20;
    const band = must(body.doc, 'draw_rectangle', { width, height: 10, position: [-width / 2, -5, 0] });
    const done = must(band.doc, 'emboss_on_face', {
      id: body.id,
      face: { faceNear: [20, 0, 0] },
      profileIds: [band.id],
      mode: 'emboss',
      depth: 1,
    });
    expect(relative(volume(done.doc, done.id) - 16000 * Math.PI, 410 * Math.PI)).toBeLessThan(1e-6);
  });

  it('a groove around the cylinder (deboss, full turn) removes the closed form volume', () => {
    const body = must(createEmptyDocument(), 'add_cylinder', { radius: 20, height: 40 });
    const width = 2 * Math.PI * 20;
    const band = must(body.doc, 'draw_rectangle', { width, height: 4, position: [-width / 2, -2, 0] });
    const done = must(band.doc, 'emboss_on_face', {
      id: body.id,
      face: { faceNear: [20, 0, 0] },
      profileIds: [band.id],
      mode: 'deboss',
      depth: 2,
    });
    const expected = Math.PI * (20 * 20 - 18 * 18) * 4;
    expect(relative(16000 * Math.PI - volume(done.doc, done.id), expected)).toBeLessThan(1e-6);
  });

  it('the cone full band (annulus between slant 15 and 35, a full turn) adds the Steiner volume', () => {
    const cone = must(createEmptyDocument(), 'add_cone', { radius: 20, height: 40 });
    const alpha = Math.atan2(20, 40);
    const phi = 2 * Math.PI * Math.sin(alpha);
    const rho0 = 25;
    const steps = 360;
    const at = (rho: number, psi: number): [number, number] => [rho * Math.sin(psi), rho * Math.cos(psi) - rho0];
    const points: Array<[number, number]> = [];
    for (let k = 0; k <= steps; k++) points.push(at(35, -phi / 2 + (phi * k) / steps));
    for (let k = steps; k >= 0; k--) points.push(at(15, -phi / 2 + (phi * k) / steps));
    const ring = must(cone.doc, 'draw_polyline', { points, closed: true });
    const on = [25 * Math.sin(alpha), 0, 40 - 25 * Math.cos(alpha)];
    const done = must(ring.doc, 'emboss_on_face', {
      id: cone.id,
      face: { faceNear: on },
      profileIds: [ring.id],
      mode: 'emboss',
      depth: 1,
      placement: { anchor: { chart: [0, 0], on } },
    });
    const area = 0.5 * phi * (35 * 35 - 15 * 15);
    const expected = area + 0.5 * (1 / Math.tan(alpha)) * phi * (35 - 15);
    expect(relative(done.data['volumeDelta'] as number, expected)).toBeLessThan(1e-3);
  });

  it('a profile on the flat top of the cylinder is checked against the circular boundary; inside it embosses, off the disc it is refused', () => {
    const body = must(createEmptyDocument(), 'add_cylinder', { radius: 20, height: 40 });
    const inside = must(body.doc, 'draw_rectangle', { width: 10, height: 6, position: [-5, -3, 20] });
    const placement = { anchor: { chart: [0, 0], on: [0, 0, 20] } };
    const ok = must(inside.doc, 'emboss_on_face', {
      id: body.id,
      face: { faceNear: [0, 0, 20] },
      profileIds: [inside.id],
      mode: 'emboss',
      depth: 2,
      placement,
    });
    expect(relative(ok.data['volumeDelta'] as number, 120)).toBeLessThan(1e-9);
    const outside = must(inside.doc, 'draw_rectangle', { width: 10, height: 6, position: [17, 17, 20] });
    const refused = run(outside.doc, 'emboss_on_face', {
      id: body.id,
      face: { faceNear: [0, 0, 20] },
      profileIds: [outside.id],
      mode: 'emboss',
      depth: 2,
      placement,
    });
    expect(refused.error?.code).toBe('WRP_OUTSIDE_FACE');
  });

  it('text debossed into a cylinder: B8% with holes keeps the closed form A d (1 - d / 2r)', () => {
    const body = must(createEmptyDocument(), 'add_cylinder', { radius: 20, height: 40 });
    const label = must(body.doc, 'add_text', { content: 'B8%', position: [0, 0, 0], height: 10, anchor: 'center', font: 'Fira Sans' });
    const area = (run(label.doc, 'text_outline', { id: label.id }).data as { area: number }).area;
    const done = must(label.doc, 'emboss_on_face', {
      id: body.id,
      face: { faceNear: [20, 0, 0] },
      profileIds: [label.id],
      mode: 'deboss',
      depth: 0.5,
    });
    expect(relative(done.data['volumeDelta'] as number, -area * 0.5 * (1 - 0.5 / 40))).toBeLessThan(1e-5);
  });

  it('wrapped text: every glyph contour becomes a curve of the right total length', () => {
    const body = must(createEmptyDocument(), 'add_cylinder', { radius: 20, height: 40 });
    const label = must(body.doc, 'add_text', { content: 'O', position: [0, 0, 0], height: 10, anchor: 'center', font: 'Fira Sans' });
    const wrapped = must(label.doc, 'wrap_to_face', { id: body.id, face: { faceNear: [20, 0, 0] }, entityIds: [label.id] });
    const curves = wrapped.data['curves'] as Array<{ length3d: number; chartLength: number; role: string }>;
    expect(curves.map((c) => c.role).sort()).toEqual(['hole', 'outer']);
    const outline = (run(label.doc, 'text_outline', { id: label.id }).data as { outlineLength: number }).outlineLength;
    expect(
      relative(
        curves.reduce((sum, c) => sum + c.length3d, 0),
        outline,
      ),
    ).toBeLessThan(1e-6);
  });

  it('a deboss in a bore (concave cylinder) removes A d (1 + d / 2r) and uses the inward normal', () => {
    const block = must(createEmptyDocument(), 'add_box', { size: [60, 60, 40] });
    const hole = must(block.doc, 'add_cylinder', { radius: 10, height: 60 });
    const bored = must(hole.doc, 'boolean', { op: 'subtract', a: block.id, b: hole.id });
    const rect = must(bored.doc, 'draw_rectangle', { width: 6, height: 6, position: [-3, -3, 0] });
    const done = must(rect.doc, 'emboss_on_face', {
      id: bored.id,
      face: { faceNear: [10, 0, 0] },
      profileIds: [rect.id],
      mode: 'deboss',
      depth: 1,
      placement: { anchor: { chart: [0, 0], on: [10, 0, 0] } },
    });
    expect(relative(done.data['volumeDelta'] as number, -36 * 1 * (1 + 1 / 20))).toBeLessThan(1e-6);
  });
});

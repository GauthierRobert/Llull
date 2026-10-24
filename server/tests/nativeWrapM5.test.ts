/**
 * 03 WRP M5 on the native OCCT kernel: engraving with the single-line font and along contours, text on a curve embossed on a cylinder, pattern_on_face against single embosses (VC-WRP-38) and the modeled straight knurl
 * against its closed-form groove volume (VC-WRP-39). Skipped when the llull-kernel binary (with the `emboss` capability) is not built.
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
type Row = Record<string, unknown>;

describeNativeWhen({ capabilities: ['emboss'], label: 'WRP M5 native' })('WRP M5 on the native OCCT kernel', () => {
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

  const must = (doc: Doc, name: string, params: Row): { doc: Doc; id: string; data: Row } => {
    const result = execute(doc, name, params);
    expect(result.rejected, result.summary).toBeUndefined();
    expect(result.affected.length, result.summary).toBeGreaterThan(0);
    return { doc: result.document, id: result.affected[0] as string, data: (result.data ?? {}) as Row };
  };
  const volume = (doc: Doc, id: string): number => (execute(doc, 'mass_properties', { entityId: id }).data as { volume: number }).volume;
  const relative = (value: number, reference: number): number => Math.abs(value - reference) / Math.abs(reference);
  const cylinder = (radius = 20): { doc: Doc; id: string } => must(createEmptyDocument(), 'add_cylinder', { radius, height: 40 });
  const face = { faceNear: [20, 0, 0] };

  it('engraves a straight stroke: the groove is a stadium, the volume change follows the closed form of its footprint', () => {
    const base = cylinder();
    const line = must(base.doc, 'draw_polyline', {
      points: [
        [-15, 0],
        [15, 0],
      ],
    });
    const result = must(line.doc, 'emboss_on_face', {
      id: base.id,
      face,
      profileIds: [line.id],
      mode: 'engrave',
      depth: 0.5,
      toolWidth: 2,
    });
    const removed = volume(line.doc, base.id) - volume(result.doc, result.id);
    expect(relative(removed, -(result.data['expectedVolumeDelta'] as number))).toBeLessThan(1e-6);
    expect(relative(result.data['regionArea'] as number, 60 + Math.PI)).toBeLessThan(5e-3);
  });

  it('engraves single-line text "LLULL" 8 high with a 0.8 mm tool, 0.4 deep on r 20', () => {
    const base = cylinder();
    const text = must(base.doc, 'add_text', {
      content: 'LLULL',
      position: [0, 0, 0],
      height: 8,
      anchor: 'center',
      verticalAnchor: 'cap_middle',
      font: 'LLULL Single Line',
    });
    const started = Date.now();
    const result = must(text.doc, 'emboss_on_face', {
      id: base.id,
      face,
      profileIds: [text.id],
      mode: 'engrave',
      depth: 0.4,
      toolWidth: 0.8,
    });
    const seconds = (Date.now() - started) / 1000;
    const removed = volume(text.doc, base.id) - volume(result.doc, result.id);
    expect(removed).toBeGreaterThan(0);
    expect(relative(removed, -(result.data['expectedVolumeDelta'] as number))).toBeLessThan(1e-5);
    expect(seconds).toBeLessThan(60);
    expect(result.data['unverified']).toBe(false);
    const check = execute(result.doc, 'check_wrap', {});
    expect(['pass', 'warn']).toContain((check.data as Row)['status']);
  }, 120_000);

  it('engraves the contour of a 20 x 20 square: a groove along its path, a hole in the middle', () => {
    const base = cylinder();
    const square = must(base.doc, 'draw_rectangle', { width: 20, height: 20, position: [-10, -10, 0] });
    const result = must(square.doc, 'emboss_on_face', {
      id: base.id,
      face,
      profileIds: [square.id],
      mode: 'engrave',
      depth: 0.5,
      toolWidth: 1,
    });
    expect(result.data['loops']).toBe(2);
    const removed = volume(square.doc, base.id) - volume(result.doc, result.id);
    expect(relative(removed, -(result.data['expectedVolumeDelta'] as number))).toBeLessThan(1e-6);
  });

  it('embosses Fira Sans text bent along a line and along an arc on the cylinder', () => {
    const base = cylinder();
    const arc = must(base.doc, 'draw_arc', { center: [0, -60], radius: 70, startAngle: 1.2, endAngle: 1.95 });
    const text = must(arc.doc, 'add_text', {
      content: 'LLULL',
      position: [0, 0, 0],
      height: 5,
      anchor: 'center',
      font: 'Fira Sans',
      onCurve: { curveId: arc.id },
    });
    const result = must(text.doc, 'emboss_on_face', { id: base.id, face, profileIds: [text.id], mode: 'emboss', depth: 0.5 });
    const gained = volume(result.doc, result.id) - volume(text.doc, base.id);
    expect(relative(gained, result.data['expectedVolumeDelta'] as number)).toBeLessThan(1e-6);
    expect(result.data['exact']).toBe(true);
  }, 120_000);

  it('VC-WRP-38: a 12 x 3 pattern of 2 x 2 squares on the cylinder is 36 instances with 36 times the single emboss volume', () => {
    const base = cylinder();
    const seed = must(base.doc, 'draw_rectangle', { width: 2, height: 2, position: [-1, -1, 0] });
    const single = must(seed.doc, 'emboss_on_face', { id: base.id, face, profileIds: [seed.id], mode: 'emboss', depth: 0.5 });
    const one = volume(single.doc, single.id) - volume(seed.doc, base.id);
    const grid = { countX: 12, countY: 3, pitchX: 5, pitchY: 6 };
    const started = Date.now();
    const result = must(seed.doc, 'pattern_on_face', {
      id: base.id,
      face,
      seedProfileIds: [seed.id],
      mode: 'emboss',
      depth: 0.5,
      grid,
      placement: { anchor: { chart: [0, 0], on: [20 * Math.cos(-0.5), 20 * Math.sin(-0.5), -6] } },
    });
    const seconds = (Date.now() - started) / 1000;
    expect(result.data['instances']).toBe(36);
    const gained = volume(result.doc, result.id) - volume(seed.doc, base.id);
    expect(relative(gained, 36 * one)).toBeLessThan(1e-6);
    expect(seconds).toBeLessThan(30);
  }, 120_000);

  it('VC-WRP-39: the modeled straight knurl d 20, pitch 1: 63 grooves, the volume removed equals the closed form to 1e-6', () => {
    const base = cylinder(10);
    const result = must(base.doc, 'add_knurl', {
      id: base.id,
      face: { faceNear: [10, 0, 0] },
      pattern: 'straight',
      pitch: 1,
      model: 'geometry',
    });
    expect(result.data['teeth']).toBe(63);
    const removed = volume(result.doc, result.id) - volume(base.doc, base.id);
    expect(removed).toBeLessThan(0);
    expect(relative(removed, result.data['expectedVolumeDelta'] as number)).toBeLessThan(1e-6);
    const faces = execute(result.doc, 'inspect_faces', { entityId: result.id });
    expect(faces.rejected, faces.summary).toBeUndefined();
    expect(JSON.stringify(faces.data)).toContain('cylinder');
  }, 120_000);
  it('knurls the thin end of a shouldered shaft without notching the shoulder: the grooves end flush, the volume removed equals the closed form', () => {
    const shaft = must(createEmptyDocument(), 'revolve_profile', {
      profile: [
        [0, 0],
        [10, 0],
        [10, 20],
        [15, 20],
        [15, 40],
        [0, 40],
      ],
      axis: 'z',
      segments: 64,
    });
    const face = { faceNear: [10, 0, 10] };
    const result = must(shaft.doc, 'add_knurl', { id: shaft.id, face, pattern: 'straight', pitch: 1, model: 'geometry' });
    expect(result.data['teeth']).toBe(63);
    const removed = volume(result.doc, result.id) - volume(shaft.doc, shaft.id);
    expect(relative(removed, result.data['expectedVolumeDelta'] as number)).toBeLessThan(1e-4);
    const big = (doc: Doc, id: string): Row | undefined =>
      ((execute(doc, 'inspect_faces', { entityId: id }).data as { faces: Row[] }).faces ?? []).find(
        (f) => f['surface'] === 'cylinder' && Math.abs((f['radius'] as number) - 15) < 1e-6,
      );
    expect(relative(big(result.doc, result.id)?.['area'] as number, big(shaft.doc, shaft.id)?.['area'] as number)).toBeLessThan(1e-9);
  }, 120_000);
});

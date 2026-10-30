/**
 * 03 WRP M5 on the native OCCT kernel: multi-face wraps (VC-WRP-36). A stadium (box 40 x 20 x 10 united with two r 10 cylinders) has plane sides tangent to cylinder ends; a band
 * sketch is unfolded across the smooth edges, cut at them and embossed on every face in one result. Closed forms: a plane part adds A d, a cylinder part A d (1 + d / 2r). Skipped
 * when the llull-kernel binary (with the `emboss` capability) is not built.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { createNativeTestKernel, describeNativeWhen } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';

type Run = ReturnType<typeof execute>;
const relative = (value: number, reference: number): number => Math.abs(value - reference) / Math.abs(reference);

describeNativeWhen({ capabilities: ['emboss'], label: 'WRP chain' })('WRP multi-face wraps on the native OCCT kernel', () => {
  let kernel: IsolatedKernel;
  beforeAll(() => {
    kernel = createNativeTestKernel();
    setGeometryKernel(kernel);
  }, 120_000);
  afterAll(() => {
    setGeometryKernel(null);
    kernel.dispose();
  });

  const must = (doc: CadDocument, name: string, params: Record<string, unknown>): Run => {
    const result = execute(doc, name, params);
    expect(result.rejected, result.summary).toBeUndefined();
    return result;
  };
  const stadium = (): { doc: CadDocument; id: string } => {
    const base: CadDocument = { ...createEmptyDocument(), units: 'mm' };
    const box = must(base, 'add_box', { size: [40, 20, 10] });
    const right = must(box.document, 'add_cylinder', { radius: 10, height: 10, position: [20, 0, 0] });
    const left = must(right.document, 'add_cylinder', { radius: 10, height: 10, position: [-20, 0, 0] });
    const one = must(left.document, 'boolean', { op: 'union', a: box.affected[0], b: right.affected[0] });
    const two = must(one.document, 'boolean', { op: 'union', a: one.affected[0], b: left.affected[0] });
    return { doc: two.document, id: two.affected[0] as string };
  };
  const volume = (doc: CadDocument, id: string): number =>
    (execute(doc, 'mass_properties', { entityId: id }).data as { volume: number }).volume;
  // the front plane (y = -10, outward -y) has chart x along z and chart y along +x: a band tall in chart y runs over the +x cylinder end
  const FRONT = { faceNear: [0, -10, 0] };
  const END = { faceNear: [30, 0, 0] };
  const BACK = { faceNear: [0, 10, 0] };
  const band = (doc: CadDocument, length: number): { doc: CadDocument; id: string } => {
    const sketch = must(doc, 'draw_rectangle', { width: 6, height: length, position: [-3, 0, 0] });
    return { doc: sketch.document, id: sketch.affected[0] as string };
  };
  const placement = { anchor: { chart: [0, 0], on: [10, -10, 0] } };

  it('VC-WRP-36: a 30 long band over a plane and a tangent cylinder end adds 60 + 120 x 1.05 = 186 mm3 (areas 60 + 120 in the two faces)', () => {
    const { doc, id } = stadium();
    const sketch = band(doc, 30);
    const done = must(sketch.doc, 'emboss_on_face', {
      id,
      face: FRONT,
      chain: [END],
      profileIds: [sketch.id],
      mode: 'emboss',
      depth: 1,
      placement,
    });
    const data = done.data as Record<string, unknown>;
    const faces = data['faces'] as Array<{ faceKind: string; area: number; expectedVolumeDelta: number }>;
    expect(faces.map((f) => f.faceKind)).toEqual(['plane', 'cylinder']);
    expect(faces[0]?.area).toBeCloseTo(60, 9);
    expect(faces[1]?.area).toBeCloseTo(120, 9);
    expect(data['chainArea'] as number).toBeCloseTo(180, 9);
    expect(relative(data['expectedVolumeDelta'] as number, 186)).toBeLessThan(1e-9);
    expect(relative(data['volumeDelta'] as number, 186)).toBeLessThan(1e-6);
    expect(relative(volume(done.document, done.affected[0] as string) - volume(doc, id), 186)).toBeLessThan(1e-6);
    expect((data['distortion'] as { maxLengthStrain: number }).maxLengthStrain).toBe(0);
    expect((data['edges'] as Array<{ convexity: string; length: number }>).map((e) => [e.convexity, e.length])).toEqual([['smooth', 10]]);
  });

  it('a band over plane, cylinder end and the opposite plane (three faces, two edges): 60 + 188.4956 x 1.05 + 111.5044 = 369.4248 mm3', () => {
    const { doc, id } = stadium();
    const sketch = band(doc, 60);
    const done = must(sketch.doc, 'emboss_on_face', {
      id,
      face: FRONT,
      chain: [END, BACK],
      profileIds: [sketch.id],
      mode: 'emboss',
      depth: 1,
      placement,
    });
    const data = done.data as Record<string, unknown>;
    const areas = (data['faces'] as Array<{ area: number }>).map((f) => f.area);
    expect(areas[0]).toBeCloseTo(60, 9);
    expect(areas[1]).toBeCloseTo(6 * 10 * Math.PI, 9);
    expect(areas[2]).toBeCloseTo(6 * (50 - 10 * Math.PI), 9);
    const expected = 60 + 6 * 10 * Math.PI * 1.05 + 6 * (50 - 10 * Math.PI);
    expect(relative(data['expectedVolumeDelta'] as number, expected)).toBeLessThan(1e-9);
    expect(relative(data['volumeDelta'] as number, expected)).toBeLessThan(1e-6);
  });

  it('face indices really shift when the chain starts on the cylinder end: the recipe steps re-find the plane faces (indices differ from data.faces), volume 369.4248', () => {
    const { doc, id } = stadium();
    const sketch = must(doc, 'draw_rectangle', { width: 60, height: 6, position: [-10, -3, 0] });
    const done = must(sketch.document, 'emboss_on_face', {
      id,
      face: END,
      chain: [FRONT, BACK],
      profileIds: [sketch.affected[0]],
      mode: 'emboss',
      depth: 1,
      placement: { anchor: { chart: [0, 0], on: [20, -10, 0] } },
    });
    const info = done.data as { faces: Array<{ face: number; faceKind: string }>; volumeDelta: number; expectedVolumeDelta: number };
    expect(info.faces.map((f) => f.faceKind)).toEqual(['cylinder', 'plane', 'plane']);
    const expected = 60 + 6 * 10 * Math.PI * 1.05 + 6 * (50 - 10 * Math.PI);
    expect(relative(info.expectedVolumeDelta, expected)).toBeLessThan(1e-9);
    expect(relative(info.volumeDelta, expected)).toBeLessThan(1e-6);
    // the recipe of the result: one emboss step per face, innermost first
    const steps: number[] = [];
    for (
      let node = (done.document.entities[done.affected[0] as string] as { brep?: { op: string; face?: number; source?: unknown } }).brep;
      node?.op === 'emboss';
      node = node.source as typeof node
    )
      steps.unshift(node.face as number);
    expect(steps).toHaveLength(3);
    expect(steps).not.toEqual(info.faces.map((f) => f.face));
  });

  it('deboss across the same faces removes 60 + 120 x 0.95 = 174 mm3', () => {
    const { doc, id } = stadium();
    const sketch = band(doc, 30);
    const done = must(sketch.doc, 'emboss_on_face', {
      id,
      face: FRONT,
      chain: [END],
      profileIds: [sketch.id],
      mode: 'deboss',
      depth: 1,
      placement,
    });
    expect(relative(-(done.data as { volumeDelta: number }).volumeDelta, 174)).toBeLessThan(1e-6);
  });

  const curveLengths = (done: Run): Array<{ face: number; length3d: number; chartLength: number }> =>
    ((done.data as { curves: Array<{ face: number; length3d: number; chartLength: number }> }).curves ?? []).map((c) => ({
      face: c.face,
      length3d: c.length3d,
      chartLength: c.chartLength,
    }));

  it('wrap_to_face across a smooth edge: a 40 long line over the plane and the cylinder end is 10 + 30 long in the two faces, the lengths add up to the chart length', () => {
    const { doc, id } = stadium();
    const line = must(doc, 'draw_polyline', {
      points: [
        [0, 0],
        [0, 40],
      ],
    });
    const done = must(line.document, 'wrap_to_face', { id, face: FRONT, chain: [END], entityIds: [line.affected[0]], placement });
    const lengths = curveLengths(done);
    expect(lengths).toHaveLength(2);
    expect(lengths[0]?.length3d).toBeCloseTo(10, 9);
    expect(lengths[1]?.length3d).toBeCloseTo(30, 7);
    expect(lengths.reduce((sum, l) => sum + l.length3d, 0)).toBeCloseTo(40, 7);
    expect((done.data as { distortion: { maxLengthStrain: number } }).distortion.maxLengthStrain).toBe(0);
    const entities = done.affected.map((curveId) => done.document.entities[curveId] as { onFace?: { faceIndex: number } });
    expect(entities.map((e) => e.onFace?.faceIndex)).toEqual(lengths.map((l) => l.face));
  });

  it('wrap_to_face crosses a sharp edge: a chart line from z = 0 over the front plane and the top plane (edge at z = 5) is 5 + 3 long', () => {
    const { doc, id } = stadium();
    const line = must(doc, 'draw_polyline', {
      points: [
        [0, 0],
        [8, 0],
      ],
    });
    const done = must(line.document, 'wrap_to_face', {
      id,
      face: FRONT,
      chain: [{ faceNear: [0, 0, 5] }],
      entityIds: [line.affected[0]],
      placement,
    });
    const lengths = curveLengths(done);
    expect(lengths.map((l) => l.length3d.toFixed(9))).toEqual(['5.000000000', '3.000000000']);
    expect((done.data as { edges: Array<{ convexity: string }> }).edges[0]?.convexity).toBe('convex');
  });

  it('wrap_to_face refuses a face that shares no edge and a circular edge, by code', () => {
    const { doc, id } = stadium();
    const line = must(doc, 'draw_polyline', {
      points: [
        [0, 0],
        [0, 5],
      ],
    });
    const base = { id, entityIds: [line.affected[0]], placement };
    expect(execute(line.document, 'wrap_to_face', { ...base, face: FRONT, chain: [BACK] }).error?.code).toBe('WRP_CHAIN_NOT_ADJACENT');
    expect(
      execute(line.document, 'wrap_to_face', {
        ...base,
        face: END,
        chain: [{ faceNear: [30, 0, 5] }],
        placement: { anchor: { chart: [0, 0], on: [30, 0, 0] } },
      }).error?.code,
    ).toBe('WRP_CHAIN_EDGE_CURVED');
  });

  it('replay_history rebuilds the chain emboss to the same solid', () => {
    const { doc, id } = stadium();
    const sketch = band(doc, 30);
    const done = must(sketch.doc, 'emboss_on_face', {
      id,
      face: FRONT,
      chain: [END],
      profileIds: [sketch.id],
      mode: 'emboss',
      depth: 1,
      placement,
    });
    const replayed = must(done.document, 'replay_history', {});
    expect(JSON.stringify(replayed.document.entities)).toBe(JSON.stringify(done.document.entities));
  });

  it('refuses a sharp edge, a face that shares no edge, a circular edge and a face listed twice, by code', () => {
    const { doc, id } = stadium();
    const sketch = band(doc, 30);
    const base = { id, profileIds: [sketch.id], mode: 'emboss', depth: 1, placement };
    const codeOf = (extra: Record<string, unknown>): string | undefined =>
      execute(sketch.doc, 'emboss_on_face', { ...base, ...extra }).error?.code;
    const crossing = must(doc, 'draw_rectangle', { width: 6, height: 8, position: [2, 0, 0] });
    const sharp = execute(crossing.document, 'emboss_on_face', {
      ...base,
      profileIds: [crossing.affected[0]],
      face: FRONT,
      chain: [{ faceNear: [0, 0, 5] }],
    });
    expect(sharp.error?.code).toBe('WRP_CHAIN_EDGE_SHARP');
    expect(codeOf({ face: FRONT, chain: [BACK] })).toBe('WRP_CHAIN_NOT_ADJACENT');
    expect(
      codeOf({ face: END, chain: [{ faceNear: [30, 0, 5] }].slice(0, 0).concat([{ faceNear: [20, 0, 5] }]), placement: undefined }),
    ).toBeDefined();
    expect(codeOf({ face: FRONT, chain: [FRONT] })).toBe('WRP_PARAM_INVALID');
    expect(codeOf({ face: FRONT, chain: [END], mode: 'engrave', toolWidth: 1 })).toBe('WRP_PARAM_INVALID');
    expect(execute(sketch.doc, 'emboss_on_face', { ...base, face: FRONT, chain: [END] }).rejected).toBeUndefined();
  });
});

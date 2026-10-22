/**
 * 12 CFD M2: `buildFlowJob` — the `case.json` + binary STL the `cfd_solve` transport hands to `llull-compute flow` (TECHNICAL_SPEC §6): grid
 * from the sized domain, far-field / slip / ground faces, per-body triangle ranges, probes and slices in the case frame, named defaults; the
 * refusals (failing prepare rows, compressible cases, VC-CFD-50 memory refusal before anything runs).
 */
import { describe, expect, it } from 'vitest';
import type { CfdCase } from '@aero/cfd/types';
import { buildFlowJob, freestreamDirection, type FlowJob } from '@aero/cfd/flowJob';
import type { CadDocument } from '@core/model/types';
import { addBody, boxMesh, metreDocument, ok, withCase } from './fixtures';

const ball = addBody(metreDocument(), 'add_sphere', { radius: 0.5, position: [0, 0, 0] });
const caseOf = (doc: CadDocument, id = 'c1'): CfdCase => doc.cfd?.cases[id] as CfdCase;

function build(doc: CadDocument, options: Parameters<typeof buildFlowJob>[3] = {}): FlowJob {
  const built = buildFlowJob(doc, caseOf(doc), null, options);
  expect(built.ok, built.ok ? '' : built.message).toBe(true);
  return (built as { ok: true; job: FlowJob }).job;
}

/** Vertices of triangle `t` of a binary STL. */
function stlTriangle(stl: Uint8Array, t: number): number[][] {
  const view = new DataView(stl.buffer, stl.byteOffset, stl.byteLength);
  const base = 84 + 50 * t + 12;
  return [0, 1, 2].map((k) => [0, 1, 2].map((axis) => view.getFloat32(base + 12 * k + 4 * axis, true)));
}

describe('buildFlowJob', () => {
  it('writes the case.json contract from the prepare report and a hashed STL of the flow surface', () => {
    const doc = withCase(ball.doc, [ball.id], {
      freestream: { speedMS: 1, air: { densityKgM3: 1, temperatureK: 288.15, viscosityPaS: 0.01 } },
      reference: { areaM2: 0.7853981634, lengthM: 1, momentPointM: [0.1, 0, 0] },
      cellsPerReferenceLength: 16,
      outputs: { probes: [[2, 0, 0]], slices: [{ origin: [0, 0, 0], normal: [0, 1, 0], field: 'speed' }], surfaceFields: ['Cp'] },
    });
    const job = build(doc, { device: 'gpu', maxSteps: 500 });
    const { caseJson } = job;
    expect(caseJson.version).toBe(1);
    expect(caseJson.caseId).toBe('c1');
    expect(caseJson.grid.cellM).toBeCloseTo(1 / 16, 12);
    expect(caseJson.grid.minM[0]).toBeLessThan(-0.5);
    expect(caseJson.grid.maxM[0]).toBeGreaterThan(0.5);
    expect(caseJson.flow).toEqual({ speedMS: 1, direction: [1, 0, 0], densityKgM3: 1, viscosityPaS: 0.01 });
    expect(caseJson.reference).toEqual({ areaM2: 0.7853981634, lengthM: 1, momentPointM: [0.1, 0, 0], up: [0, 0, 1] });
    expect(caseJson.faces).toEqual({
      xMin: 'far_field',
      xMax: 'far_field',
      yMin: 'far_field',
      yMax: 'far_field',
      zMin: 'far_field',
      zMax: 'far_field',
    });
    expect(caseJson.bodies).toEqual([{ entityId: ball.id, triangles: [0, job.triangles] }]);
    expect(caseJson.settings).toEqual({
      latticeMach: 0.1,
      les: true,
      smagorinsky: 0.1,
      maxSteps: 500,
      startAveragingTol: 0.005,
      stopTol: 0.001,
      sampleEvery: 0,
      historyCap: 1000,
      device: 'gpu',
    });
    expect(caseJson.outputs).toEqual({
      probesM: [[2, 0, 0]],
      slices: [{ originM: [0, 0, 0], normal: [0, 1, 0], field: 'speed' }],
      surfaceFields: ['cp'],
    });
    expect(job.stl).toHaveLength(84 + 50 * job.triangles);
    expect(new DataView(job.stl.buffer).getUint32(80, true)).toBe(job.triangles);
    expect(job.triangles).toBeGreaterThan(100);
    expect(job.geometryHash).toBe(job.report.geometryHash);
    expect(job.caseHash).toBe(job.report.caseHash);
    expect(job.kernel).toBe('none');
    expect(job.defaults.map((entry) => entry.path)).toEqual([
      'settings.latticeMach',
      'settings.les',
      'settings.startAveragingTol',
      'settings.stopTol',
      'flow.direction',
    ]);
    expect(job.notes).toEqual([]);
    // Every STL vertex lies on the unit-diameter sphere.
    for (const t of [0, Math.floor(job.triangles / 2), job.triangles - 1]) {
      for (const vertex of stlTriangle(job.stl, t)) expect(Math.hypot(...vertex)).toBeCloseTo(0.5, 3);
    }
  });

  it('rotates the free stream by alpha / beta, halves a symmetric domain, grounds the floor and converts outputs to the case frame', () => {
    expect(freestreamDirection(0, 0)).toEqual([1, 0, 0]);
    expect(freestreamDirection(90, 0).map((v) => Math.round(v * 1e9) / 1e9)).toEqual([0, 0, 1]);
    expect(freestreamDirection(0, 90).map((v) => Math.round(v * 1e9) / 1e9)).toEqual([0, 1, 0]);
    const doc = withCase(ball.doc, [ball.id], {
      freestream: { speedMS: 2, alphaDeg: 10, air: { densityKgM3: 1.2, temperatureK: 288.15, viscosityPaS: 1.8e-5 } },
      flowAxis: [0, 1, 0],
      upAxis: [0, 0, 1],
      domain: { rule: 'external_aero', symmetryPlane: 'xz' },
      ground: { enabled: true, moving: true },
      outputs: { probes: [[0, 3, 0]], slices: [{ origin: [0, 0, 0], normal: [0, 0, 1], field: 'temperature' }], surfaceFields: [] },
    });
    const job = build(doc, { les: false, latticeMach: 0.05 });
    const { caseJson } = job;
    expect(caseJson.flow.direction[0]).toBeCloseTo(Math.cos((10 * Math.PI) / 180), 12);
    expect(caseJson.flow.direction[2]).toBeCloseTo(Math.sin((10 * Math.PI) / 180), 12);
    expect(caseJson.grid.minM[1]).toBe(0);
    expect(caseJson.faces.yMin).toBe('slip');
    expect(caseJson.faces.zMin).toBe('moving_ground');
    expect(caseJson.settings).toMatchObject({ les: false, latticeMach: 0.05, device: 'cpu', maxSteps: 200_000 });
    // World (0, 3, 0) is 3 m along the flow axis (+y world): case-frame x = 3.
    expect(caseJson.outputs.probesM[0]?.[0]).toBeCloseTo(3, 12);
    expect(caseJson.outputs.slices).toEqual([]);
    expect(job.notes[0]).toContain("slice field 'temperature'");
    expect(caseJson.outputs.surfaceFields).toEqual(['p', 'cp']);
    expect(job.defaults.map((entry) => entry.path)).toContain('outputs.surfaceFields');
    expect(job.defaults.map((entry) => entry.path)).not.toContain('settings.les');
  });

  it('groups the STL triangles per body so each body is one contiguous range', () => {
    const left = addBody(metreDocument(), 'add_box', { size: [1, 1, 1], position: [0, 0, 0], anchor: 'min' });
    const right = addBody(left.doc, 'add_box', { size: [0.5, 0.5, 0.5], position: [3, 0, 0], anchor: 'min' });
    const doc = withCase(right.doc, [left.id, right.id], { reference: { areaM2: 1, lengthM: 1 } });
    const job = build(doc);
    expect(job.caseJson.bodies.map((body) => body.entityId)).toEqual([left.id, right.id]);
    const [first, second] = job.caseJson.bodies;
    expect(first?.triangles).toEqual([0, 12]);
    expect(second?.triangles).toEqual([12, 12]);
    expect(job.triangles).toBe(24);
    for (let t = 0; t < 12; t += 1) for (const vertex of stlTriangle(job.stl, t)) expect(vertex[0]).toBeLessThanOrEqual(1 + 1e-6);
    for (let t = 12; t < 24; t += 1) for (const vertex of stlTriangle(job.stl, t)) expect(vertex[0]).toBeGreaterThanOrEqual(3 - 1e-6);
  });

  it('refuses on a failing prepare row, a compressible case and a memory estimate above the device (VC-CFD-50)', () => {
    const open = boxMesh([0, 0, 0], [1, 1, 1]);
    const holed = ok(metreDocument(), 'import_mesh', { bodies: [{ positions: open.positions, indices: open.indices.slice(0, 30) }] });
    const leaky = withCase(holed.document, [holed.affected[0] as string]);
    const refused = buildFlowJob(leaky, caseOf(leaky), null);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe('CFD_GEOMETRY_NOT_WATERTIGHT');
      expect(refused.ids).toEqual(['c1']);
      expect(refused.checks.map((check) => check.code)).toContain('CFD_GEOMETRY_NOT_WATERTIGHT');
    }
    const supersonic = withCase(ball.doc, [ball.id], {
      freestream: { mach: 2, altitudeM: 0 },
      domain: { rule: 'custom', box: { min: [-5, -5, -5], max: [10, 5, 5] } },
    });
    const euler = buildFlowJob(supersonic, caseOf(supersonic), null);
    expect(euler.ok).toBe(false);
    if (!euler.ok) expect(euler.code).toBe('CFD_REGIME_MISMATCH');
    const doc = withCase(ball.doc, [ball.id], { cellsPerReferenceLength: 64 });
    const memory = buildFlowJob(doc, caseOf(doc), null, { deviceMemoryBytes: 1e6 });
    expect(memory.ok).toBe(false);
    if (!memory.ok) {
      expect(memory.code).toBe('CFD_MEMORY_EXCEEDED');
      const row = memory.checks.find((check) => check.code === 'CFD_MEMORY_EXCEEDED');
      expect(row?.['bytes']).toBeGreaterThan(1e6);
      expect(row?.['largestFittingCellsPerReferenceLength']).not.toBeUndefined();
    }
    expect(buildFlowJob(doc, caseOf(doc), null, { deviceMemoryBytes: 1e12 }).ok).toBe(true);
  });
});

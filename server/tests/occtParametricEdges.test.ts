/**
 * Live OpenCascade: a fillet chosen by location (`edgesNear`) follows its edge through a parametric
 * edit — the feature history keeps the point, and replay re-resolves it on the regenerated B-rep.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { setGeometryKernel, type ShapeTopology } from '@core/geometry/kernel';
import { createNodeOcctKernel } from '../src/occtNode';

beforeAll(async () => setGeometryKernel(await createNodeOcctKernel()), 120_000);
afterAll(() => setGeometryKernel(null));

function apply(doc: CadDocument, name: string, params: unknown): CadDocument {
  const result = execute(doc, name, params);
  expect(result.summary).not.toMatch(/rejected|no-op|not found|could not/);
  return result.document;
}

const topologyOf = (doc: CadDocument): ShapeTopology => {
  const [id] = doc.order;
  return execute(doc, 'inspect_topology', { id }).data as ShapeTopology;
};

/** Volume a fillet of radius r removes along a straight edge of length l. */
const filletLoss = (r: number, l: number): number => (r * r - (Math.PI * r * r) / 4) * l;

describe('occt fillet by location across a parametric edit', () => {
  it('re-selects the top front edge after the box step is widened', () => {
    let doc = apply(createEmptyDocument(), 'add_box', { size: [40, 20, 10] });
    const [box] = doc.order;
    // Top front edge of a box centred at the origin: mid point (0, -10, 5).
    doc = apply(doc, 'fillet_edge', { id: box, edgesNear: [[0, -10, 5]], radius: 2 });
    expect(topologyOf(doc).volume).toBeCloseTo(40 * 20 * 10 - filletLoss(2, 40), 6);

    const boxStep = doc.featureHistory[0]!;
    const widened = apply(doc, 'edit_step_params', { stepId: boxStep.id, params: { ...(boxStep.params as object), size: [80, 20, 10] } });
    const topology = topologyOf(widened);
    expect(topology.volume).toBeCloseTo(80 * 20 * 10 - filletLoss(2, 80), 6);
    expect(topology.faces.filter((face) => face.surface === 'cylinder')).toHaveLength(1);
  });
});

describe('occt booleans merge same-domain faces', () => {
  it('a union of a plate and an upright flush with its side is one face per side', () => {
    // Plate 60×20×10 and an upright 20×20×40 standing on its left end, flush with three sides.
    let doc = apply(createEmptyDocument(), 'add_box', { size: [60, 20, 10], anchor: 'min', position: [0, 0, 0] });
    doc = apply(doc, 'add_box', { size: [20, 20, 40], anchor: 'min', position: [0, 0, 0] });
    const [plate, upright] = doc.order;
    doc = apply(doc, 'boolean', { op: 'union', a: plate, b: upright });
    // An L-shaped prism: 8 faces, 18 edges (two 6-gon caps + 6 side faces) — no split side faces.
    const topology = topologyOf(doc);
    expect(topology.faces).toHaveLength(8);
    expect(topology.edges).toHaveLength(18);

    // So one point on the outer vertical corner rounds its full height (0..40), not just 10..40.
    const [lBracket] = doc.order;
    doc = apply(doc, 'fillet_edge', { id: lBracket, edgesNear: [[0, 0, 5]], radius: 3 });
    expect(topologyOf(doc).volume).toBeCloseTo(60 * 20 * 10 + 20 * 20 * 30 - filletLoss(3, 40), 4);
  });
});

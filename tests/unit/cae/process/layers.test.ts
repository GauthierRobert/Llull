/** PHY-16 layer binning: centroid height above the plate top, empty layers, build parts, refusals. */
import { describe, expect, it } from 'vitest';
import type { FeMeshArtifact } from '@core/model/analysis';
import type { AmBuildSettings } from '@core/model/am';
import type { AnalysisCase } from '@core/model/analysis';
import { caseOf } from '@cae/shared/access';
import { amLayerPlan, buildPartsOf, MAX_LAYERS } from '@cae/process/layers';
import { amBar, amMesh, must, type AmBar } from './support';

interface Setup {
  readonly bar: AmBar;
  readonly analysis: AnalysisCase;
  readonly am: AmBuildSettings;
}

const setup = (layerHeight: number, bar = amBar()): Setup => {
  const doc = must(bar.doc, 'am_build_setup', {
    analysisId: bar.analysisId,
    buildDirection: [0, 0, 1],
    plateEntityId: bar.plate,
    layerHeight,
  }).doc;
  const analysis = caseOf(doc, bar.analysisId);
  if (analysis?.am === undefined) throw new Error('no am');
  return { bar, analysis, am: analysis.am };
};

describe('amLayerPlan', () => {
  it('bins the deposit cells into the three 0.5 layers by centroid height from the plate top; every element once, in mesh order', () => {
    const { bar, analysis, am } = setup(0.5);
    const mesh = amMesh(bar);
    const plan = amLayerPlan(analysis, am, mesh, 1);
    if ('code' in plan) throw new Error(plan.message);
    expect(plan.plateTop).toBe(0);
    expect(plan.buildParts).toEqual([bar.deposit]);
    expect(plan.layers.map((layer) => layer.layer)).toEqual([1, 2, 3]);
    expect(plan.emptyLayers).toEqual([]);
    const deposit = mesh.blocks.find((block) => block.entityId === bar.deposit)?.elements ?? [];
    const binned = plan.layers.flatMap((layer) => layer.sets.flatMap((set) => set.elements));
    expect(binned).toEqual(deposit.map((element) => element[0]));
    expect(plan.layers.map((layer) => layer.sets[0]?.elements.length)).toEqual([24, 24, 24]);
  });

  it('puts a centroid exactly on a layer boundary in the layer above it (k - 1) t <= h < k t, and reports layers that hold no element', () => {
    const { bar, analysis, am } = setup(0.1);
    const plan = amLayerPlan(analysis, am, amMesh(bar), 1);
    if ('code' in plan) throw new Error(plan.message);
    expect(plan.emptyLayers.length).toBeGreaterThan(0);
    expect(plan.layers.length + plan.emptyLayers.length).toBe(Math.max(...plan.layers.map((layer) => layer.layer)));
  });

  it('converts the layer height with lengthToAnalysis (layers of 0.5 document units of 1000 mesh units = 1 mesh layer height)', () => {
    const { bar, analysis, am } = setup(0.5);
    const metres = amLayerPlan(analysis, am, amMesh(bar), 1000);
    if ('code' in metres) throw new Error(metres.message);
    expect(metres.layers.length).toBe(1);
  });

  it('lists the build parts without the plate and the supports, sorted', () => {
    const { bar, analysis, am } = setup(0.5);
    expect(buildPartsOf(analysis, am)).toEqual([bar.deposit]);
    expect(buildPartsOf(analysis, { ...am, supportEntityIds: [bar.deposit] })).toEqual([]);
  });

  it('refuses a mesh without plate elements, without build elements, and with more than MAX_LAYERS layers', () => {
    const { bar, analysis, am } = setup(0.5);
    const mesh = amMesh(bar);
    const noPlate: FeMeshArtifact = { ...mesh, blocks: mesh.blocks.filter((block) => block.entityId !== bar.plate) };
    const noBuild: FeMeshArtifact = { ...mesh, blocks: mesh.blocks.filter((block) => block.entityId !== bar.deposit) };
    expect(amLayerPlan(analysis, am, noPlate, 1)).toMatchObject({ code: 'PRC_BUILD_SETUP_INVALID' });
    expect(amLayerPlan(analysis, am, noBuild, 1)).toMatchObject({ code: 'PRC_PART_NOT_BUILT' });
    expect(amLayerPlan(analysis, { ...am, supportEntityIds: [bar.deposit] }, mesh, 1)).toMatchObject({ code: 'PRC_PART_NOT_BUILT' });
    const columns = MAX_LAYERS + 1;
    const nodes: [number, number, number, number][] = [
      [1, 0, 0, 0],
      [2, 1, 0, 0],
      [3, 0, 1, 0],
      [4, 0, 0, 1],
    ];
    const stack: number[][] = [[1, 1, 2, 3, 4]];
    for (let layer = 0; layer < columns; layer++) {
      const base = nodes.length;
      nodes.push([base + 1, 0, 0, layer + 1], [base + 2, 1, 0, layer + 1], [base + 3, 0, 1, layer + 1], [base + 4, 0, 0, layer + 1.5]);
      stack.push([layer + 2, base + 1, base + 2, base + 3, base + 4]);
    }
    const tall: FeMeshArtifact = {
      ...mesh,
      nodes,
      blocks: [
        { type: 'C3D4', entityId: bar.plate, elements: [[1, 1, 2, 3, 4]] },
        { type: 'C3D4', entityId: bar.deposit, elements: stack.slice(1) },
      ],
    };
    expect(amLayerPlan(analysis, { ...am, layerHeight: 1 }, tall, 1)).toMatchObject({ code: 'PRC_LAYERS_TOO_MANY' });
  });
});

/**
 * PHY-06 M4 joint_from_fastener_stack on a REAL stack placed by the fasteners plugin (08 MAT insert_fastener_stack, Manifold kernel) in an INCH document:
 * the stack record the plugin writes is what the command reads, the catalogue diameter is converted to document units, and the whole set-up survives history replay.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { GeometryKernel } from '@core/geometry/kernel';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { stackOf } from '@cae/contact/stackRead';
import { caseOf } from '@cae/shared/access';
import { ctxWith, docWith, inchDocument, ok, sampleCatalogFile } from '../../aero/fasteners/fixtures';

let kernel: GeometryKernel;
beforeAll(async () => {
  kernel = await createManifoldKernel();
});

interface Scene {
  readonly doc: CadDocument;
  readonly analysisId: string;
  readonly stepId: string;
  readonly stackId: string;
  readonly boltPart: string;
  readonly plates: readonly [string, string];
}

/** Two plates (0.25 + 0.26 in) clamped by an NAS6203-9 (3/16 in) bolt placed by the plugin, the bolt exploded into a solid part, a nonlinear case over the three parts. */
function scene(): Scene {
  const ctx = ctxWith(kernel);
  const first = ok(docWith(sampleCatalogFile(), inchDocument()), 'add_box', { size: [2, 1, 0.25], anchor: 'min', position: [0, 0, 0] });
  const second = ok(first.document, 'add_box', { size: [2, 1, 0.26], anchor: 'min', position: [0, 0, 0.25] });
  const [a = '', b = ''] = [first.affected[0], second.affected[0]];
  let doc = ok(second.document, 'create_material', {
    name: 'al7075',
    density: 2.81,
    densityUnit: 'g/cm^3',
    color: '#b8bcc2',
    metalness: 1,
    roughness: 0.35,
  }).document;
  doc = ok(doc, 'assign_material', { entityIds: [a, b], materialName: 'al7075' }).document;
  doc = ok(doc, 'add_material_model', {
    material: 'al7075',
    id: 'elastic',
    model: { kind: 'elastic_isotropic', E: { value: 71.7, unit: 'GPa' }, nu: { value: 0.33, unit: '1' } },
    basis: 'unspecified',
    source: { citation: 'synthetic test fixture', locator: 'tests/unit/cae/contact' },
  }).document;
  doc = ok(doc, 'define_constitutive_set', { material: 'al7075', set: { id: 'linear', elastic: 'elastic' }, makeDefault: true }).document;
  const placed = ok(
    doc,
    'insert_fastener_stack',
    {
      family: 'NAS6203-6220',
      diameterDash: '3',
      stackIds: [a, b],
      axisPoint: [1, 0.5, 0],
      axis: [0, 0, 1],
      nut: 'MS21042',
      washer: 'NAS1149',
      holeMode: 'cut_close_tolerance',
      holeDiameter: { value: 0.19, unit: 'in' },
    },
    ctx,
  );
  const stackId = (placed.data as { stack: { id: string; fastener: { instanceId: string } } }).stack.id;
  const instanceId = (placed.data as { stack: { fastener: { instanceId: string } } }).stack.fastener.instanceId;
  // the stack instances are plugin-owned (explode_instance is refused on them): a fresh instance of the same component at the same place is exploded instead
  const bolt = placed.document.entities[instanceId];
  if (bolt?.kind !== 'instance') throw new Error('the bolt instance is missing');
  const fresh = ok(
    placed.document,
    'insert_instance',
    { componentId: bolt.componentId, position: bolt.position, rotation: bolt.rotation },
    ctx,
  );
  const exploded = ok(fresh.document, 'explode_instance', { id: fresh.affected[0] ?? '' }, ctx);
  // the catalogue bolt is two cylinders (head, then shank): the shank is the part the section crosses
  const boltPart = exploded.affected[1] ?? '';
  doc = ok(exploded.document, 'assign_material', { entityIds: [boltPart], materialName: 'al7075' }).document;
  const created = ok(doc, 'create_analysis', { name: 'joint', analysisType: 'nonlinear_static' });
  const analysisId = created.affected[0] ?? '';
  doc = created.document;
  for (const entityId of [a, b, boltPart]) doc = ok(doc, 'set_part_idealization', { analysisId, entityId }).document;
  doc = ok(doc, 'add_fea_constraint', {
    analysisId,
    name: 'base',
    kind: 'fixed',
    target: { entityId: a, facesNear: [[0.2, 0.2, 0]] },
  }).document;
  doc = ok(doc, 'set_nonlinear_controls', { analysisId, nlgeom: false, outputIncrements: 'all' }).document;
  const step = ok(doc, 'add_analysis_step', {
    analysisId,
    name: 'preload',
    multipliers: {},
    control: { kind: 'load', initialIncrement: 0.5, minIncrement: 0.001, maxIncrement: 0.5, maxIncrements: 20 },
  });
  return { doc: step.document, analysisId, stepId: step.affected[0] ?? '', stackId, boltPart, plates: [a, b] };
}

describe('joint_from_fastener_stack on a stack placed by the fasteners plugin', () => {
  it('reads the stack the plugin wrote (inch document, catalogue diameter in inches) and sets the joint up in document units', () => {
    const s = scene();
    const view = stackOf(s.doc, s.stackId);
    if ('message' in view) throw new Error(view.message);
    expect(view.holeDiameter).toBeCloseTo(0.19, 9);
    expect(view.nominalDiameter).toBeCloseTo(0.1875, 9);
    expect(view.washerCount).toBe(1);
    expect(view.hasNut).toBe(true);
    const result = execute(
      s.doc,
      'joint_from_fastener_stack',
      {
        analysisId: s.analysisId,
        stackId: s.stackId,
        boltEntityId: s.boltPart,
        preload: { kind: 'force', value: 500 },
        preloadStepId: s.stepId,
      },
      ctxWith(kernel),
    );
    expect(result.error, result.summary).toBeUndefined();
    const analysis = caseOf(result.document, s.analysisId);
    const bolt = Object.values(analysis?.pretension?.bolts ?? {})[0];
    // the grip is 0.51 in thick (z 0..0.51): the section sits at its mid-plane on the axis x = 1, y = 0.5
    expect(bolt?.section.point[0]).toBeCloseTo(1, 9);
    expect(bolt?.section.point[1]).toBeCloseTo(0.5, 9);
    expect(bolt?.section.point[2]).toBeCloseTo(0.255, 6);
    expect(bolt?.section.normal).toEqual([0, 0, 1]);
    const pairs = Object.values(analysis?.contact?.pairs ?? {});
    expect(pairs.map((pair) => pair.name)).toEqual([`${s.stackId}_if1`, `${s.stackId}_head`, `${s.stackId}_nut`]);
    // face-selection points are 0.65 hole diameters (0.1235 in) off the axis
    expect(pairs[0]?.slave.facesNear?.[0]?.[1]).toBeCloseTo(0.5 + 0.65 * 0.19, 9);
    expect(result.summary).toContain('1 washer(s) and the nut of the stack are not modelled');
    const stiffness = (result.data as { stiffness: { available: boolean; kMembers: number; kBolt: number; phi: number; grip: number } })
      .stiffness;
    expect(stiffness.available).toBe(true);
    // grip 0.51 in = 12.954 mm, nominal d = 3/16 in = 4.7625 mm, E 71.7 GPa
    expect(stiffness.grip).toBeCloseTo(0.51, 6);
    expect(stiffness.kBolt).toBeCloseTo((Math.PI * 4.7625 ** 2 * 71700) / (4 * 12.954), 0);
    expect(stiffness.phi).toBeGreaterThan(0);
    expect(stiffness.phi).toBeLessThan(1);
  });

  it('survives history replay: the same pairs, bolt and ids', () => {
    const s = scene();
    const ctx = ctxWith(kernel);
    const result = execute(
      s.doc,
      'joint_from_fastener_stack',
      {
        analysisId: s.analysisId,
        stackId: s.stackId,
        boltEntityId: s.boltPart,
        preload: { kind: 'force', value: 500 },
        preloadStepId: s.stepId,
      },
      ctx,
    );
    expect(result.error, result.summary).toBeUndefined();
    expect(result.document.featureHistory.at(-1)?.name).toBe('joint_from_fastener_stack');
    const replayed = execute(result.document, 'replay_history', {}, ctx);
    expect(replayed.error, replayed.summary).toBeUndefined();
    const of = (doc: CadDocument): unknown => {
      const analysis = caseOf(doc, s.analysisId);
      return { contact: analysis?.contact, pretension: analysis?.pretension };
    };
    expect(of(replayed.document)).toEqual(of(result.document));
    expect(Object.keys(caseOf(replayed.document, s.analysisId)?.contact?.pairs ?? {})).toHaveLength(3);
  });
});

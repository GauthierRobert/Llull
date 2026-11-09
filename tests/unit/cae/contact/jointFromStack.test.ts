/**
 * PHY-06 M4 joint_from_fastener_stack (FR-CNT-10, VC-CNT-64): the pretension and contact pairs of a placed stack, the stack read as document data,
 * and the Shigley frustum stiffness against the closed form (eq. 8-20, derived below).
 */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { analysisErrors } from '@cae/model/validate';
import { caseOf } from '@cae/shared/access';
import { boltStiffness, membersStiffness, stiffnessFactor } from '@cae/contact/stackStiffness';
import { readStack } from '@cae/contact/stackRead';
import { blocks, must, type Blocks } from './support';

const D = 0.4;
const E_MPA = 210000;

interface Stacked extends Blocks {
  readonly bolt: string;
}

/** Two stacked 1 mm cubes (steel) clamped by a 0.4 x 0.4 x 3 steel bolt at x = y = 0.5, with fastener stack `fst-1.1` in the document slice. */
function stacked(options: { readonly slice?: unknown } = {}): Stacked & { readonly doc: CadDocument } {
  const b = blocks();
  const box = must(b.doc, 'add_box', { size: [D, D, 3], position: [0.3, 0.3, -0.5], anchor: 'min' });
  const bolt = box.affected[0] ?? '';
  let doc = must(box.doc, 'assign_material', { materialName: 'steel', entityIds: [bolt] }).doc;
  doc = must(doc, 'set_part_idealization', { analysisId: b.analysisId, entityId: bolt }).doc;
  const slice = options.slice ?? {
    catalogs: { NAS: { id: 'NAS', sizes: [{ dash: '-5', nominalDiameter: { value: D, unit: 'mm' } }] } },
    stacks: {
      'fst-1.1': {
        id: 'fst-1.1',
        axis: { origin: [0.5, 0.5, 0], direction: [0, 0, 1] },
        layers: [
          { entityId: b.lower, thickness: 1 },
          { entityId: b.upper, thickness: 1 },
        ],
        fastener: { family: 'NAS', partNumber: 'NAS1', instanceId: 'inst-1', diameterDash: '-5' },
        washers: [],
        stackThickness: 2,
        holeMode: 'cut_clearance',
        holeDiameter: D,
      },
    },
  };
  return { ...b, bolt, doc: { ...doc, fasteners: slice } as unknown as CadDocument };
}

const params = (s: Stacked, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  analysisId: s.analysisId,
  stackId: 'fst-1.1',
  boltEntityId: s.bolt,
  preload: { kind: 'force', value: 1000 },
  preloadStepId: s.stepId,
  ...extra,
});

/** Shigley eq. 8-20, derived from eq. 8-18 with D = 1.5 d and t = l / 2 per cone: k_m = pi E d tan(a) / (2 ln(5 (l tan(a) + d / 2) / (l tan(a) + 5 d / 2))). */
const shigley820 = (d: number, l: number, E: number): number => {
  const t = Math.tan(Math.PI / 6);
  return (Math.PI * E * d * t) / (2 * Math.log((5 * (l * t + 0.5 * d)) / (l * t + 2.5 * d)));
};

describe('joint_from_fastener_stack', () => {
  it('adds the bolt pretension at the grip mid-plane and the interface, head and nut pairs (ids step-scoped), is pure and valid on load', () => {
    const s = stacked();
    const before = structuredClone(s.doc);
    const result = execute(s.doc, 'joint_from_fastener_stack', params(s));
    expect(result.error).toBeUndefined();
    expect(s.doc).toEqual(before);
    const [analysisId, boltId = '', ...pairIds] = result.affected;
    expect(analysisId).toBe(s.analysisId);
    expect(boltId).toMatch(/^bp-\d+\.1$/);
    expect(pairIds).toHaveLength(3);
    pairIds.forEach((id, index) => expect(id).toMatch(new RegExp(`^cp-\\d+\\.${index + 2}$`)));
    const analysis = caseOf(result.document, s.analysisId);
    expect(analysis?.pretension?.bolts[boltId]).toMatchObject({
      name: 'fst-1.1_bolt',
      entityId: s.bolt,
      section: { point: [0.5, 0.5, 1], normal: [0, 0, 1] },
      preload: { kind: 'force', value: 1000 },
      lockAfter: true,
    });
    expect(analysis?.contact?.formulation).toBe('surface_to_surface');
    const pairs = pairIds.map((id) => analysis?.contact?.pairs[id]);
    expect(pairs.map((pair) => pair?.name)).toEqual(['fst-1.1_if1', 'fst-1.1_head', 'fst-1.1_nut']);
    // interface: upper plate = slave, lower plate = master, points on the plane z = 1 offset 0.65 d from the axis
    expect(pairs[0]?.slave).toEqual({ entityId: s.upper, facesNear: [[0.5, 0.5 + 0.65 * D, 1]] });
    expect(pairs[0]?.master).toEqual({ entityId: s.lower, facesNear: [[0.5, 0.5 + 0.65 * D, 1]] });
    expect(pairs[1]?.slave.entityId).toBe(s.lower);
    expect(pairs[1]?.master.entityId).toBe(s.bolt);
    expect(pairs[2]?.slave.facesNear?.[0]?.[2]).toBe(2);
    expect(pairs[0]?.behaviour).toEqual({ kind: 'hard' });
    expect(pairs[0]?.friction).toBeUndefined();
    expect(analysisErrors(result.document as unknown as Record<string, unknown>)).toEqual([]);
    expect(result.summary).toContain('formulation surface_to_surface by default');
    expect(result.summary).toContain('hard by default');
    expect(result.summary).toContain('frictionless by default');
    expect(result.summary).toContain('not approved');
    expect(execute(s.doc, 'joint_from_fastener_stack', params(s)).document).toEqual(result.document);
  });

  it('passes the formulation of the case, the behaviour and the friction to every pair; bearing false leaves the interfaces only', () => {
    const s = stacked();
    const result = execute(
      s.doc,
      'joint_from_fastener_stack',
      params(s, { bearing: false, behaviour: { kind: 'linear', slope: 1e6 }, friction: { mu: 0.2 }, lockAfter: false }),
    );
    expect(result.error).toBeUndefined();
    expect(result.affected).toHaveLength(3);
    const analysis = caseOf(result.document, s.analysisId);
    const pair = Object.values(analysis?.contact?.pairs ?? {})[0];
    expect(pair).toMatchObject({ behaviour: { kind: 'linear', slope: 1e6 }, friction: { mu: 0.2 } });
    expect(Object.values(analysis?.pretension?.bolts ?? {})[0]?.lockAfter).toBe(false);
    expect(result.summary).toContain('friction mu 0.2');
  });

  it('keeps the formulation the case already has and does not say it was defaulted', () => {
    const s = stacked();
    const first = must(s.doc, 'add_contact_pair', {
      analysisId: s.analysisId,
      name: 'pre',
      slave: { entityId: s.upper, facesNear: [[0.5, 0.5, 2]] },
      master: { entityId: s.lower, facesNear: [[0.5, 0.5, 0]] },
      formulation: 'mortar',
      behaviour: { kind: 'hard' },
    });
    const result = execute(first.doc, 'joint_from_fastener_stack', params(s, { bearing: false }));
    expect(result.error).toBeUndefined();
    expect(caseOf(result.document, s.analysisId)?.contact?.formulation).toBe('mortar');
    expect(result.summary).toContain('formulation mortar,');
  });

  it('returns the Shigley frustum stiffness: k_b = A E / l, k_m = eq. 8-20 for the two steel plates, phi = k_b / (k_b + k_m)', () => {
    const s = stacked();
    const result = execute(s.doc, 'joint_from_fastener_stack', params(s));
    const stiffness = (result.data as { stiffness: Record<string, number> }).stiffness;
    const kBolt = (Math.PI * D * D * E_MPA) / (4 * 2);
    const kMembers = shigley820(D, 2, E_MPA);
    expect(stiffness['kBolt']).toBeCloseTo(kBolt, 6);
    expect(stiffness['kMembers']).toBeCloseTo(kMembers, 6);
    expect(stiffness['phi']).toBeCloseTo(kBolt / (kBolt + kMembers), 12);
    expect(stiffness['phi']).toBeGreaterThan(0);
    expect(stiffness['phi']).toBeLessThan(1);
    expect(stiffness['unit']).toBe('N/mm');
    expect(result.summary).toContain('Shigley estimate phi');
  });

  it('reports no stiffness (and still sets the joint up) when a plate has no elastic law', () => {
    const s = stacked();
    const bare = {
      ...s.doc,
      entities: { ...s.doc.entities, [s.lower]: { ...s.doc.entities[s.lower]!, materialId: undefined } },
    } as unknown as CadDocument;
    const result = execute(bare, 'joint_from_fastener_stack', params(s));
    expect(result.error).toBeUndefined();
    expect((result.data as { stiffness: { available: boolean } }).stiffness.available).toBe(false);
  });

  it.each([
    ['unknown analysis', { analysisId: 'nope' }, 'FEA_ANALYSIS_NOT_FOUND'],
    ['unknown stack', { stackId: 'fst-9.9' }, 'CNT_STACK_NOT_FOUND'],
    ['bolt entity not in the case', { boltEntityId: 'missing' }, 'FEA_TARGET_UNRESOLVED'],
    ['torque preload without nut factor', { preload: { kind: 'torque', torque: 5000, diameter: 0.4 } }, 'CNT_NUT_FACTOR_MISSING'],
    ['preload not on the first step', { preloadStepId: 'nope' }, 'CNT_STEP_UNKNOWN'],
    ['bad friction', { friction: { mu: -1 } }, 'CNT_FRICTION_INVALID'],
  ])('refuses %s with %s and leaves the document unchanged', (_label, extra, code) => {
    const s = stacked();
    const before = structuredClone(s.doc);
    const result = execute(s.doc, 'joint_from_fastener_stack', params(s, extra));
    expect(result.error?.code).toBe(code);
    expect(result.document).toEqual(before);
    expect(result.affected).toEqual([]);
  });

  it('is all or nothing: a pair that the case refuses after the pretension was added rolls the whole joint back', () => {
    const s = stacked();
    const taken = must(s.doc, 'add_contact_pair', {
      analysisId: s.analysisId,
      name: 'fst-1.1_if1',
      slave: { entityId: s.upper, facesNear: [[0.5, 0.5, 2]] },
      master: { entityId: s.lower, facesNear: [[0.5, 0.5, 0]] },
      formulation: 'surface_to_surface',
      behaviour: { kind: 'hard' },
    });
    const result = execute(taken.doc, 'joint_from_fastener_stack', params(s));
    expect(result.error?.code).toBe('CNT_PAIR_NAME_TAKEN');
    expect(result.summary).toContain("add_contact_pair 'fst-1.1_if1' refused");
    expect(result.document).toEqual(taken.doc);
    expect(caseOf(result.document, s.analysisId)?.pretension).toBeUndefined();
  });

  it.each([
    ['no fasteners slice', undefined],
    [
      'a stack without layers',
      { catalogs: {}, stacks: { 'fst-1.1': { id: 'fst-1.1', axis: { origin: [0, 0, 0], direction: [0, 0, 1] }, layers: [] } } },
    ],
  ])('refuses %s as CNT_STACK_NOT_FOUND', (_label, slice) => {
    const s = stacked();
    const doc = slice === undefined ? ({ ...s.doc, fasteners: undefined } as unknown as CadDocument) : stacked({ slice }).doc;
    expect(execute(doc, 'joint_from_fastener_stack', params(s)).error?.code).toBe('CNT_STACK_NOT_FOUND');
  });
});

describe('stack reader', () => {
  const slice = (stack: Record<string, unknown>): CadDocument => stacked({ slice: { catalogs: {}, stacks: { 'fst-1.1': stack } } }).doc;
  const good = {
    id: 'fst-1.1',
    axis: { origin: [0.5, 0.5, 0], direction: [0, 0, 1] },
    layers: [{ entityId: 'a', thickness: 1 }],
    fastener: { family: 'NAS', partNumber: 'p', instanceId: 'i', diameterDash: '-5' },
    washers: [{}, {}],
    nut: { partNumber: 'n', instanceId: 'm' },
    holeDiameter: 0,
  };

  it('reads washers, the nut and a missing catalogue size as null diameter', () => {
    expect(readStack(slice(good), 'fst-1.1')).toMatchObject({ washerCount: 2, hasNut: true, nominalDiameter: null, holeDiameter: 0 });
  });

  it.each([
    ['axis', { ...good, axis: { origin: [0, 0, 0] } }],
    ['layer', { ...good, layers: [{ entityId: 'a' }] }],
    ['fastener', { ...good, fastener: {} }],
  ])('rejects a malformed %s', (_what, stack) => {
    expect(readStack(slice(stack), 'fst-1.1')).toHaveProperty('message');
  });

  it('converts the catalogue diameter to document units (0.5 in in a mm document = 12.7)', () => {
    const doc = stacked({
      slice: { catalogs: { NAS: { sizes: [{ dash: '-5', nominalDiameter: { value: 0.5, unit: 'in' } }] } }, stacks: { 'fst-1.1': good } },
    }).doc;
    expect(readStack(doc, 'fst-1.1')).toMatchObject({ nominalDiameter: 12.7 });
  });
});

describe('frustum stiffness (Shigley section 8-2)', () => {
  it('one layer equals eq. 8-20 and two identical layers equal one layer of the total thickness', () => {
    expect(membersStiffness([{ thickness: 3, modulus: 70000 }], 5)).toBeCloseTo(shigley820(5, 3, 70000), 8);
    const split = membersStiffness(
      [
        { thickness: 1, modulus: 70000 },
        { thickness: 2, modulus: 70000 },
      ],
      5,
    );
    expect(split).toBeCloseTo(shigley820(5, 3, 70000), 8);
  });

  it('a stiffer layer stiffens the joint; the bolt stiffness is A E / l and phi lies in (0, 1)', () => {
    const soft = membersStiffness(
      [
        { thickness: 2, modulus: 70000 },
        { thickness: 2, modulus: 70000 },
      ],
      6,
    );
    const mixed = membersStiffness(
      [
        { thickness: 2, modulus: 210000 },
        { thickness: 2, modulus: 70000 },
      ],
      6,
    );
    expect(mixed).toBeGreaterThan(soft);
    expect(boltStiffness(6, 4, 210000)).toBeCloseTo((Math.PI * 36 * 210000) / 16, 8);
    expect(stiffnessFactor(1, 3)).toBe(0.25);
  });
});

/** export_step_exact assembly edges: depth/cycle parity with the flat export, factor rounding, kernels that cannot scale, baked labels. */
import { describe, expect, it } from 'vitest';
import { type CadDocument, type Component, type Entity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { StepAssemblyPart, StepOccurrence } from '@core/geometry/kernel';
import { planStepAssembly } from '@core/commands/brep/stepAssembly';
import { stepTargets } from '@core/commands/brep/stepTargets';
import { type FakeKernel, type FakeShape, fakeKernel } from '../helpers/fakeKernel';

const captured: { occurrences: readonly StepOccurrence<FakeShape>[] } = { occurrences: [] };
const assemblyKernel = (spec: { unsupported?: readonly ['scale']; scaleFails?: boolean } = {}): FakeKernel => {
  const kernel = fakeKernel({
    ...(spec.unsupported === undefined ? {} : { unsupported: spec.unsupported }),
    assemblyStep: (occurrences) => {
      captured.occurrences = occurrences;
      return 'TEXT';
    },
  });
  if (spec.scaleFails !== true) return kernel;
  return { ...kernel, evaluate: (recipe) => (recipe.op === 'scale' ? null : kernel.evaluate(recipe)) };
};

const step = (doc: CadDocument, kernel: FakeKernel): ReturnType<typeof execute> =>
  execute(doc, 'export_step_exact', {}, { ...defaultContext(), kernel });

/** Document with component `Bolt` (one box) and an unscaled instance of it; returns the box and instance prototypes. */
function boltDoc(): { doc: CadDocument; bolt: string; box: Entity; instance: Entity } {
  let doc = execute(createEmptyDocument(), 'add_box', { size: [4, 4, 4] }).document;
  doc = execute(doc, 'create_component', { name: 'Bolt', entityIds: [...doc.order] }).document;
  const bolt = Object.keys(doc.components)[0] ?? '';
  const instance = Object.values(doc.entities).find((entity) => entity.kind === 'instance') as Entity;
  const box = Object.values((doc.components[bolt] as Component).entities)[0] as Entity;
  return { doc, bolt, box, instance };
}

const withComponents = (doc: CadDocument, components: Record<string, Component>): CadDocument => ({
  ...doc,
  components: { ...doc.components, ...components },
});

const component = (id: string, name: string, children: Entity[]): Component => ({
  id,
  name,
  entities: Object.fromEntries(children.map((child) => [child.id, child])),
  order: children.map((child) => child.id),
});

const solidTotal = (part: StepAssemblyPart<FakeShape>): number =>
  part.shapes.length + (part.children ?? []).reduce((sum, use) => sum + solidTotal(use.part), 0);

/** `levels` components each holding one box and one instance of the next; the last holds only a box (levels 1 = just a box). */
function chain(levels: number, cyclic: boolean): CadDocument {
  const { doc, box, instance } = boltDoc();
  const ids = Array.from({ length: levels }, (_, index) => `chain-${index + 1}`);
  const made: Record<string, Component> = {};
  ids.forEach((id, index) => {
    const next = ids[index + 1] ?? (cyclic ? ids[0] : undefined);
    made[id] = component(id, `Level ${index + 1}`, [
      { ...box, id: `${id}-box` },
      ...(next === undefined ? [] : [{ ...instance, id: `${id}-use`, componentId: next } as Entity]),
    ]);
  });
  return execute(withComponents(doc, made), 'insert_instance', { componentId: ids[0] ?? '' }).document;
}

describe('export_step_exact assembly depth and cycles', () => {
  it.each([
    ['too deep', chain(7, false)],
    ['cyclic', chain(2, true)],
    ['self-instancing', chain(1, true)],
  ])('%s hierarchy: assembly solids == solidCount == flat solids', (_label, doc) => {
    const flat = step(doc, fakeKernel({ step: 'FLAT' }));
    const assembled = step(doc, assemblyKernel());
    const flatCount = (flat.data as { solidCount: number }).solidCount;
    expect((assembled.data as { solidCount: number }).solidCount).toBe(flatCount);
    const written = captured.occurrences.reduce((sum, use) => sum + solidTotal(use.part), 0);
    expect(written).toBe(flatCount);
  });
});

describe('export_step_exact scale factors', () => {
  it('shares one product between x3 inside x0.1 and a top-level x0.3', () => {
    const { doc: base, bolt, instance } = boltDoc();
    const inner = { ...instance, id: 'inner', componentId: bolt, scale: [3, 3, 3] } as Entity;
    let doc = withComponents(base, { big: component('big', 'Big', [inner]) });
    doc = execute(doc, 'insert_instance', { componentId: 'big', scale: [0.1, 0.1, 0.1], position: [5, 0, 0] }).document;
    doc = execute(doc, 'insert_instance', { componentId: bolt, scale: [0.3, 0.3, 0.3], position: [9, 0, 0] }).document;
    step(doc, assemblyKernel());
    const big = captured.occurrences.find((use) => use.position[0] === 5);
    const direct = captured.occurrences.find((use) => use.position[0] === 9);
    expect(big?.part.children?.[0]?.part).toBe(direct?.part);
  });

  it.each([
    ['cannot scale at all', { unsupported: ['scale'] } as const],
    ['refuses to scale a shape', { scaleFails: true } as const],
  ])('a kernel that %s bakes the scaled instance instead of failing', (_label, spec) => {
    const { doc: base, bolt, instance } = boltDoc();
    let doc = execute(base, 'insert_instance', { componentId: bolt, scale: [2, 2, 2], position: [7, 0, 0] }).document;
    const result = step(doc, assemblyKernel(spec));
    expect(result.data).toBeDefined();
    const scaledUse = captured.occurrences.find(
      (use) => use.part.children === undefined && use.position[0] === 0 && use.part.shapes.length === 1,
    );
    expect(scaledUse).toBeDefined();
    expect(captured.occurrences.some((use) => use.position[0] === 7)).toBe(false);

    const inner = { ...instance, id: 'inner', componentId: bolt, scale: [2, 2, 2] } as Entity;
    doc = withComponents(base, { big: component('big', 'Big', [inner]) });
    doc = execute(doc, 'insert_instance', { componentId: 'big', position: [50, 0, 0] }).document;
    expect(step(doc, assemblyKernel(spec)).data).toBeDefined();
    const big = captured.occurrences.find((use) => use.position[0] === 50);
    expect(big?.part.children).toBeUndefined();
    expect(big?.part.shapes).toHaveLength(1);
  });

  it('skips a nested component with nothing exportable and keeps the rest of the parent shared', () => {
    const { doc: base, box, instance } = boltDoc();
    const hollow = component('hollow', 'Hollow', []);
    const holder = component('holder', 'Holder', [box, { ...instance, id: 'use-hollow', componentId: 'hollow' } as Entity]);
    const doc = execute(withComponents(base, { hollow, holder }), 'insert_instance', {
      componentId: 'holder',
      position: [30, 0, 0],
    }).document;
    step(doc, assemblyKernel());
    const use = captured.occurrences.find((candidate) => candidate.position[0] === 30);
    expect(use?.part.shapes).toHaveLength(1);
    expect(use?.part.children).toBeUndefined();
  });
});

describe('export_step_exact baked nested labels', () => {
  const skewed = (instance: Entity, id: string, componentId: string): Entity =>
    ({ ...instance, id, componentId, scale: [2, 1, 1] }) as Entity;

  it('numbers baked twins among themselves and shared twins among themselves', () => {
    const { doc: base, bolt, box, instance } = boltDoc();
    const plain = (id: string): Entity => ({ ...instance, id, componentId: bolt }) as Entity;
    const mix = component('mix', 'Mix', [box, plain('p1'), plain('p2'), skewed(instance, 's1', bolt)]);
    const doc = execute(withComponents(base, { mix }), 'insert_instance', { componentId: 'mix', position: [30, 0, 0] }).document;
    const plan = planStepAssembly(doc, stepTargets(doc, undefined).entries, assemblyKernel());
    if ('failed' in plan) throw new Error(plan.failed);
    const part = plan.labels.parts.find((candidate) => candidate.name === 'Mix');
    expect(part?.occurrences?.map((use) => use.name)).toEqual(['Bolt 1', 'Bolt 2']);
    expect(part?.solids.map((solid) => solid.name)).toContain('Bolt/Bolt');
  });

  it('gives several baked nested instances of one base distinct names', () => {
    const { doc: base, bolt, instance } = boltDoc();
    const mix = component('mix', 'Mix', [skewed(instance, 's1', bolt), skewed(instance, 's2', bolt)]);
    const doc = execute(withComponents(base, { mix }), 'insert_instance', { componentId: 'mix', position: [30, 0, 0] }).document;
    const plan = planStepAssembly(doc, stepTargets(doc, undefined).entries, assemblyKernel());
    if ('failed' in plan) throw new Error(plan.failed);
    const names = plan.labels.parts.find((candidate) => candidate.name === 'Mix')?.solids.map((solid) => solid.name);
    expect(names).toEqual(['Bolt 1/Bolt', 'Bolt 2/Bolt']);
  });
});

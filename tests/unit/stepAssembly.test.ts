/** export_step_exact assembly structure: planning (shared parts vs baked), labeling of the kernel text, refusals. */
import { describe, expect, it } from 'vitest';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { StepOccurrence } from '@core/geometry/kernel';
import { labelStepAssembly } from '@core/commands/brep/stepAssemblyLabels';
import { type FakeKernel, type FakeShape, fakeKernel } from '../helpers/fakeKernel';

const step = (doc: CadDocument, kernel: FakeKernel | null): ReturnType<typeof execute> =>
  execute(doc, 'export_step_exact', {}, { ...defaultContext(), kernel });

/** Kernel STEP text for a root with `nauos` placed uses (part index each) over `parts` single-solid products, plus optional inner NAUOs. */
function fakeText(placed: readonly number[], innerSolids: Record<number, number> = {}, nested: Record<number, number[]> = {}): string {
  const lines: string[] = [
    "#11 = AXIS2_PLACEMENT_3D('',#1,#2,#3);",
    "#7 = PRODUCT('Open CASCADE STEP translator 7.4 1','Open CASCADE STEP translator 7.4 1','',(#8));",
  ];
  lines.push("#6 = PRODUCT_DEFINITION_FORMATION('','',#7);", "#5 = PRODUCT_DEFINITION('design','',#6,#9);");
  const partCount = Math.max(...placed, ...Object.values(nested).flat()) + 1;
  let next = 100;
  const definitions: number[] = [];
  for (let part = 0; part < partCount; part += 1) {
    const [definition, formation, product, shape, representation] = [next, next + 1, next + 2, next + 3, next + 4];
    next += 5;
    definitions.push(definition);
    const solids = innerSolids[part] ?? 0;
    lines.push(
      `#${product} = PRODUCT('Open CASCADE STEP translator 7.4 ${part + 2}','Open CASCADE STEP translator 7.4 ${part + 2}','',(#8));`,
      `#${formation} = PRODUCT_DEFINITION_FORMATION('','',#${product});`,
      `#${definition} = PRODUCT_DEFINITION('design','',#${formation},#9);`,
    );
    if (solids === 0) {
      lines.push(
        `#${shape} = PRODUCT_DEFINITION_SHAPE('','',#${definition});`,
        `#3${part} = SHAPE_DEFINITION_REPRESENTATION(#${shape},#${representation});`,
        `#${representation} = ADVANCED_BREP_SHAPE_REPRESENTATION('',(#11,#${next}),#99);`,
        `#${next} = MANIFOLD_SOLID_BREP('',#1);`,
      );
      next += 1;
    }
  }
  for (const [part, solids] of Object.entries(innerSolids)) {
    for (let k = 0; k < solids; k += 1) {
      const [definition, formation, product, shape, representation, solid, nauo] = [0, 1, 2, 3, 4, 5, 6].map((n) => next + n);
      next += 7;
      lines.push(
        `#${product} = PRODUCT('Open CASCADE STEP translator 7.4 9','Open CASCADE STEP translator 7.4 9','',(#8));`,
        `#${formation} = PRODUCT_DEFINITION_FORMATION('','',#${product});`,
        `#${definition} = PRODUCT_DEFINITION('design','',#${formation},#9);`,
        `#${shape} = PRODUCT_DEFINITION_SHAPE('','',#${definition});`,
        `#4${k} = SHAPE_DEFINITION_REPRESENTATION(#${shape},#${representation});`,
        `#${representation} = ADVANCED_BREP_SHAPE_REPRESENTATION('',(#11,#${solid}),#99);`,
        `#${solid} = MANIFOLD_SOLID_BREP('',#1);`,
        `#${nauo} = NEXT_ASSEMBLY_USAGE_OCCURRENCE('${k}','','',#${definitions[Number(part)]},#${definition},$);`,
      );
    }
  }
  for (const [part, uses] of Object.entries(nested)) {
    uses.forEach((child, k) => {
      lines.push(`#${next}${k} = NEXT_ASSEMBLY_USAGE_OCCURRENCE('n${k}','','',#${definitions[Number(part)]},#${definitions[child]},$);`);
    });
    next += 1;
  }
  placed.forEach((part, k) => lines.push(`#${next + k} = NEXT_ASSEMBLY_USAGE_OCCURRENCE('${k + 7}','','',#5,#${definitions[part]},$);`));
  return `DATA;\n${lines.join('\n')}\nENDSEC;`;
}

/** Component `Rod` (one box) inserted `count` times in total, plus one loose box named `Plate`. */
function rodsAndPlate(count: number, insert: Record<string, unknown> = {}): CadDocument {
  let doc = execute(createEmptyDocument(), 'add_box', { size: [10, 10, 10] }).document;
  const rod = doc.order[0] ?? '';
  doc = execute(doc, 'create_component', { name: 'Rod', entityIds: [rod] }).document;
  const componentId = Object.keys(doc.components)[0] ?? '';
  for (let k = 1; k < count; k += 1) doc = execute(doc, 'insert_instance', { componentId, position: [k * 20, 0, 0], ...insert }).document;
  doc = execute(doc, 'add_box', { size: [5, 5, 5] }).document;
  return execute(doc, 'set_entity_name', { id: doc.order[doc.order.length - 1] ?? '', name: 'Plate' }).document;
}

const captured: { occurrences: readonly StepOccurrence<FakeShape>[] } = { occurrences: [] };
const assemblyKernel = (placedParts: (occurrences: readonly StepOccurrence<FakeShape>[]) => string | null): FakeKernel =>
  fakeKernel({
    assemblyStep: (occurrences) => {
      captured.occurrences = occurrences;
      return placedParts(occurrences);
    },
  });

describe('export_step_exact assembly', () => {
  it('shares one part across the rigid instances of a component and names products and occurrences', () => {
    const doc = rodsAndPlate(3);
    const result = step(
      doc,
      assemblyKernel(() => fakeText([0, 0, 0, 1])),
    );
    expect(result.data).toMatchObject({ solidCount: 4, assembly: { products: 2, occurrences: 4 } });
    expect(result.summary).toContain('assembly, 2 product(s), 4 occurrence(s)');
    const [first, second, third, plate] = captured.occurrences;
    expect(first?.part).toBe(second?.part);
    expect(second?.part).toBe(third?.part);
    expect(plate?.part).not.toBe(first?.part);
    expect(second?.position).toEqual([20, 0, 0]);
    const text = (result.data as { step: string }).step;
    expect(text).toContain("PRODUCT('Assembly','Assembly',''");
    expect(text).toContain("PRODUCT('Rod','Rod',''");
    expect(text).toContain("PRODUCT('Plate','Plate',''");
    for (const name of ['Rod 1', 'Rod 2', 'Rod 3', 'Plate']) expect(text).toContain(`NEXT_ASSEMBLY_USAGE_OCCURRENCE('${name}'`);
    expect(text).toContain("MANIFOLD_SOLID_BREP('Rod'");
    expect(text).not.toContain('Open CASCADE STEP translator');
    expect(
      execute(doc, 'export_step_exact', {}, { ...defaultContext(), kernel: assemblyKernel(() => fakeText([0, 0, 0, 1])) }).document,
    ).toBe(doc);
  });

  it('writes a scaled instance as its own part of world-space solids', () => {
    const doc = rodsAndPlate(2, { scale: [2, 1, 1] });
    step(
      doc,
      assemblyKernel(() => null),
    );
    const [first, second] = captured.occurrences;
    expect(first?.part).not.toBe(second?.part);
    expect(second?.position).toEqual([0, 0, 0]);
  });

  it('places a rotated instance of an unrotated child by location', () => {
    const rotated = rodsAndPlate(2, { rotation: [0, 0, 90] });
    step(
      rotated,
      assemblyKernel(() => null),
    );
    expect(captured.occurrences[1]?.part).toBe(captured.occurrences[0]?.part);
    expect(captured.occurrences[1]?.rotation[2]).not.toBe(0);
  });

  it('places a rotated instance of a rotated child by location (any rotation is a location, no Euler addition)', () => {
    let doc = execute(createEmptyDocument(), 'add_box', { size: [4, 4, 4], rotation: [0, 0, 30] }).document;
    doc = execute(doc, 'create_component', { name: 'Skew', entityIds: [...doc.order] }).document;
    const componentId = Object.keys(doc.components)[0] ?? '';
    doc = execute(doc, 'insert_instance', { componentId, rotation: [90, 0, 0] }).document;
    step(
      doc,
      assemblyKernel(() => null),
    );
    const [first, second] = captured.occurrences;
    expect(first?.part).toBe(second?.part);
    expect(second?.rotation).toEqual([90, 0, 0]);
  });

  it('names a baked scaled instance after its component and scale', () => {
    const result = step(
      rodsAndPlate(2, { scale: [2, 1, 1] }),
      assemblyKernel(() => fakeText([0, 1, 2])),
    );
    const text = (result.data as { step: string }).step;
    // × is written as the STEP escape \X2\00D7\X0\\
    const times = '\\X2\\00D7\\X0\\';
    expect(text).toContain(`PRODUCT('Rod (scaled ${times}2${times}1${times}1)'`);
    const uniform = step(
      rodsAndPlate(2, { scale: [1.5, 1.5, 1.5] }),
      assemblyKernel(() => fakeText([0, 1, 2])),
    );
    expect((uniform.data as { step: string }).step).toContain(`PRODUCT('Rod (scaled ${times}1.5)'`);
  });

  it('writes a sub-assembly once: a component of two instances used three times shares its nested part', () => {
    let doc = execute(createEmptyDocument(), 'add_box', { size: [4, 4, 4], name: 'Bolt body' }).document;
    doc = execute(doc, 'create_component', { name: 'Bolt', entityIds: [...doc.order] }).document;
    const bolt = Object.keys(doc.components)[0] ?? '';
    const first = Object.keys(doc.entities).find((id) => doc.entities[id]?.kind === 'instance') ?? '';
    const second = execute(doc, 'insert_instance', { componentId: bolt, position: [10, 0, 0], rotation: [0.2, 0.3, 0.4] });
    doc = execute(second.document, 'create_component', { name: 'Pair', entityIds: [first, ...second.affected] }).document;
    const pair = Object.keys(doc.components).find((id) => id !== bolt) ?? '';
    for (const rotation of [
      [0, 0, 0],
      [0.4, 0.5, 0.6458],
    ])
      doc = execute(doc, 'insert_instance', { componentId: pair, rotation }).document;
    const result = step(
      doc,
      assemblyKernel(() => fakeText([1, 1, 1], {}, { 1: [0, 0] })),
    );
    const [use1, use2, use3] = captured.occurrences;
    expect(use1?.part).toBe(use2?.part);
    expect(use2?.part).toBe(use3?.part);
    const children = use1?.part.children ?? [];
    expect(children).toHaveLength(2);
    expect(children[0]?.part).toBe(children[1]?.part);
    expect(children[1]?.position).toEqual([10, 0, 0]);
    expect(children[1]?.rotation).toEqual([0.2, 0.3, 0.4]);
    expect(use3?.rotation).toEqual([0.4, 0.5, 0.6458]);
    expect(result.data).toMatchObject({ assembly: { products: 2, occurrences: 3 } });
    const text = (result.data as { step: string }).step;
    expect(text).toContain("PRODUCT('Pair','Pair'");
    expect(text).toContain("PRODUCT('Bolt','Bolt'");
    for (const name of ['Pair 1', 'Pair 2', 'Pair 3', 'Bolt 1', 'Bolt 2'])
      expect(text).toContain(`NEXT_ASSEMBLY_USAGE_OCCURRENCE('${name}'`);
  });

  it('bakes a component whose nested instance is scaled, and one that instances itself', () => {
    let doc = execute(createEmptyDocument(), 'add_box', { size: [4, 4, 4] }).document;
    doc = execute(doc, 'create_component', { name: 'Bolt', entityIds: [...doc.order] }).document;
    const bolt = Object.keys(doc.components)[0] ?? '';
    const scaled = execute(doc, 'insert_instance', { componentId: bolt, scale: [2, 2, 2] });
    doc = execute(scaled.document, 'create_component', { name: 'Big', entityIds: scaled.affected }).document;
    step(
      doc,
      assemblyKernel(() => null),
    );
    expect(captured.occurrences[0]?.part.children).toBeUndefined();
    expect(captured.occurrences[0]?.position).toEqual([0, 0, 0]);
  });

  it('names the solids of a multi-solid component as sub-products', () => {
    let doc = execute(createEmptyDocument(), 'add_box', { size: [4, 4, 4], name: 'Head' }).document;
    doc = execute(doc, 'add_cylinder', { radius: 1, height: 10, name: 'Shank' }).document;
    doc = execute(doc, 'create_component', { name: 'Screw', entityIds: [...doc.order] }).document;
    const result = step(
      doc,
      assemblyKernel(() => fakeText([0], { 0: 2 })),
    );
    const text = (result.data as { step: string }).step;
    expect(text).toContain("PRODUCT('Screw','Screw'");
    expect(text).toContain("NEXT_ASSEMBLY_USAGE_OCCURRENCE('Screw'");
    expect(text).toMatch(/PRODUCT\('(Head|Screw part 1)'/);
  });

  it('refuses without writing: a solid the kernel cannot build, or an assembly the kernel cannot write', () => {
    const doc = rodsAndPlate(2);
    expect(
      step(
        doc,
        assemblyKernel(() => null),
      ).summary,
    ).toMatch(/could not write the assembly/);
    expect(step(doc, fakeKernel({ solid: null, assemblyStep: () => 'S' })).summary).toMatch(/could not build/);
  });

  it('falls back to the flat list when the kernel has no assembly writer', () => {
    const result = step(rodsAndPlate(2), fakeKernel({ step: 'FLAT' }));
    expect((result.data as { assembly?: unknown }).assembly).toBeUndefined();
    expect((result.data as { step: string }).step).toBe('FLAT');
  });
});

describe('kernel assembly wrapper', () => {
  const identity = { position: [0, 0, 0], rotation: [0, 0, 0] } as const;

  it('hands nested parts to the writer once each, and refuses a part nested in itself', () => {
    const kernel = assemblyKernel(() => 'TEXT');
    const solid = kernel.evaluate({ op: 'solid', entity: { ...createEmptyDocument().entities, id: 'x' } as never });
    expect(solid).not.toBeNull();
    const inner = { shapes: [solid as never] };
    const outer = { shapes: [], children: [{ part: inner, ...identity }] };
    expect(kernel.exportStepAssembly?.([{ part: outer, ...identity }])).toBe('TEXT');
    const handed = captured.occurrences[0]?.part.children?.[0]?.part;
    expect(handed).toBeDefined();
    expect(handed).not.toBe(inner);
    const loop: { shapes: never[]; children: StepOccurrence[] } = { shapes: [], children: [] };
    loop.children.push({ part: loop, ...identity });
    expect(kernel.exportStepAssembly?.([{ part: loop, ...identity }])).toBeNull();
  });
});

describe('labelStepAssembly', () => {
  const labels = {
    rootName: 'Root',
    parts: [{ name: 'Part', solids: [{ name: 'Solid', color: '#ff0000' }] }],
    occurrences: [
      { name: 'A', part: 0 },
      { name: 'B', part: 0 },
    ],
  };

  it('names the products, occurrences and solids and colors the solid once', () => {
    const text = labelStepAssembly(fakeText([0, 0]), labels);
    expect(text).toContain("NEXT_ASSEMBLY_USAGE_OCCURRENCE('A'");
    expect(text).toContain("NEXT_ASSEMBLY_USAGE_OCCURRENCE('B'");
    expect(text).toContain("MANIFOLD_SOLID_BREP('Solid'");
    expect(text.match(/STYLED_ITEM\('color'/g)).toHaveLength(1);
  });

  it('returns the text untouched when the occurrences do not match the plan', () => {
    const text = fakeText([0, 0, 0]);
    expect(labelStepAssembly(text, labels)).toBe(text);
    expect(labelStepAssembly('DATA;\nENDSEC;', labels)).toBe('DATA;\nENDSEC;');
    const mixed = fakeText([0, 1]);
    expect(labelStepAssembly(mixed, labels)).toBe(mixed);
  });
});

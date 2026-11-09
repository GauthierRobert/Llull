import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { budgetOf as budgetOfParts } from '@cae/environment/budget';
import { partsOf } from '@cae/environment/parts';
import { close, emptyMm, run, withMaterial, withPanel } from './fixtures';

type Entity = CadDocument['entities'][string];

interface Budget {
  perPart: {
    entityId: string;
    material: string;
    massG: number | null;
    maxMassLossG: number | null;
    maxCondensableG: number | null;
    note?: string;
  }[];
  totalMassLossG: number;
  totalCondensableG: number;
  counted: number;
  uncounted: number;
}

const budgetOf = (doc: CadDocument, params: Record<string, unknown> = {}): Budget =>
  (execute(doc, 'check_space_environment', { profile: 'nasa_gsfc_screening', ...params }).data as { budget: Budget }).budget;

/** A component holding one 100 x 100 x 16.6667 mm panel (200 g of syn_low) and `count` instances of it (create_component already leaves one). */
function instanced(count: number): CadDocument {
  let doc = withMaterial(emptyMm(), 'syn_low', { TML: 0.95, CVCM: 0.05, WVR: 0.3 });
  const added = run(doc, 'add_box', { size: [100, 100, 16.6666666667], anchor: 'min' });
  const id = added.affected[0] ?? '';
  doc = run(added.document, 'assign_material', { materialName: 'syn_low', entityIds: [id] }).document;
  doc = run(doc, 'create_component', { name: 'panel', entityIds: [id], componentId: 'panel' }).document;
  for (let k = 1; k < count; k += 1) doc = run(doc, 'insert_instance', { componentId: 'panel', position: [k * 200, 0, 0] }).document;
  return doc;
}

function firstInstance(doc: CadDocument): Entity {
  const found = Object.values(doc.entities).find((entity) => entity.kind === 'instance');
  if (found === undefined) throw new Error('fixture: no instance');
  return found;
}

const asInstance = (doc: CadDocument, id: string, componentId: string): Entity => ({ ...firstInstance(doc), id, componentId }) as Entity;

function panelOf(doc: CadDocument): CadDocument['components'][string] {
  const panel = doc.components['panel'];
  if (panel === undefined) throw new Error('fixture: no panel component');
  return panel;
}

describe('screening budget over component instances (FR-ENV-04)', () => {
  it('counts a component instanced twice twice, and the component definition itself never', () => {
    const budget = budgetOf(instanced(2));
    expect(budget.perPart).toHaveLength(2);
    expect(budget.perPart.every((part) => part.entityId.startsWith('expanded::'))).toBe(true);
    expect(close(budget.totalMassLossG, 2 * 1.9)).toBe(true);
    expect(close(budget.totalCondensableG, 2 * 0.1)).toBe(true);
    expect(budget.counted).toBe(2);
  });

  it('one instance counts once; a scaled instance counts its scaled mass', () => {
    expect(close(budgetOf(instanced(1)).totalMassLossG, 1.9)).toBe(true);
    const doc = run(instanced(1), 'insert_instance', { componentId: 'panel', scale: [2, 1, 1], position: [500, 0, 0] }).document;
    expect(close(budgetOf(doc).totalMassLossG, 1.9 + 3.8)).toBe(true);
  });

  it('a part without a TML value is listed with a note and only its CVCM figure is counted', () => {
    let doc = withMaterial(emptyMm(), 'cvcm_only', { CVCM: 0.05 });
    const added = run(doc, 'add_box', { size: [100, 100, 16.6666666667], anchor: 'min' });
    doc = run(added.document, 'assign_material', { materialName: 'cvcm_only', entityIds: added.affected }).document;
    const part = budgetOf(doc).perPart[0];
    expect(part?.maxMassLossG).toBeNull();
    expect(close(part?.maxCondensableG ?? NaN, 0.1)).toBe(true);
    expect(part?.note).toContain('TML unknown');
  });

  it('a part with a TML value but no CVCM names CVCM in the note', () => {
    let doc = withMaterial(emptyMm(), 'tml_only', { TML: 0.5 });
    const added = run(doc, 'add_box', { size: [100, 100, 16.6666666667], anchor: 'min' });
    doc = run(added.document, 'assign_material', { materialName: 'tml_only', entityIds: added.affected }).document;
    expect(budgetOf(doc).perPart[0]?.note).toContain('CVCM unknown');
  });

  it('a material with TML / CVCM but no density has no mass: listed with a note, not counted', () => {
    const base = withMaterial(emptyMm(), 'weightless', { TML: 0.5, CVCM: 0.05 });
    const material = base.materials['weightless'];
    if (material === undefined) throw new Error('fixture');
    const doc = withPanel({ ...base, materials: { ...base.materials, weightless: { ...material, density: 0 } } }, 'weightless').document;
    const budget = budgetOf(doc);
    expect(budget.perPart).toHaveLength(1);
    expect(budget.perPart[0]).toMatchObject({ massG: null, maxMassLossG: null, maxCondensableG: null });
    expect(budget.perPart[0]?.note).toContain('mass_properties');
    expect(budget.counted).toBe(0);
    expect(budget.uncounted).toBe(1);
  });
});

describe('instance scale, nesting and inherited material', () => {
  it('a uniform scale of 2 multiplies the mass by 8', () => {
    const doc = run(instanced(1), 'insert_instance', { componentId: 'panel', scale: [2, 2, 2], position: [500, 0, 0] }).document;
    expect(close(budgetOf(doc).totalMassLossG, 1.9 + 8 * 1.9)).toBe(true);
  });

  it('a rotated, non-uniformly scaled instance keeps its scaled mass', () => {
    const doc = run(instanced(1), 'insert_instance', {
      componentId: 'panel',
      scale: [2, 1, 1],
      rotation: [30, 40, 50],
      position: [500, 0, 0],
    }).document;
    expect(close(budgetOf(doc).totalMassLossG, 1.9 + 3.8)).toBe(true);
  });

  it('a nested instance inherits the material of the instance that carries it, once per outer instance', () => {
    let doc = withMaterial(emptyMm(), 'syn_low', { TML: 0.95, CVCM: 0.05, WVR: 0.3 });
    const bare = run(doc, 'add_box', { size: [100, 100, 16.6666666667], anchor: 'min' });
    doc = run(bare.document, 'create_component', { name: 'bare', entityIds: bare.affected, componentId: 'bare' }).document;
    const inner = { ...firstInstance(doc), id: 'inner-1', materialId: 'syn_low' } as Entity;
    const outerBox = run(doc, 'add_box', { size: [10, 10, 10] });
    doc = run(outerBox.document, 'create_component', { name: 'outer', entityIds: outerBox.affected, componentId: 'outer' }).document;
    const outer = doc.components['outer'];
    if (outer === undefined) throw new Error('fixture');
    const kept = Object.fromEntries(
      Object.entries(doc.entities).filter(([, entity]) => entity.kind !== 'instance' || entity.componentId !== 'bare'),
    );
    const withInner: CadDocument = {
      ...doc,
      entities: kept,
      components: {
        ...doc.components,
        outer: { ...outer, entities: { ...outer.entities, 'inner-1': inner }, order: [...outer.order, 'inner-1'] },
      },
    };
    const twice = run(withInner, 'insert_instance', { componentId: 'outer', position: [300, 0, 0] }).document;
    const budget = budgetOf(twice);
    expect(budget.perPart.filter((part) => part.material === 'syn_low' && close(part.massG ?? NaN, 200))).toHaveLength(2);
  });
});

describe('parts that cannot be listed are reported, never dropped', () => {
  it('a missing component is listed with a note, counted as uncounted and warned', () => {
    const broken: CadDocument = { ...instanced(1), components: {} };
    const budget = budgetOf(broken);
    expect(budget.perPart).toHaveLength(1);
    expect(budget.perPart[0]).toMatchObject({ massG: null });
    expect(budget.perPart[0]?.note).toContain('component missing');
    expect(budget.uncounted).toBe(1);
    const result = execute(broken, 'check_space_environment', { profile: 'nasa_gsfc_screening' });
    expect((result.data as { findings: { code: string }[] }).findings.map((finding) => finding.code)).toContain('ENV_PARTS_SKIPPED');
  });

  it('a component that holds an instance of itself (a cycle) is skipped with a reason, not looped', () => {
    const doc = instanced(1);
    const panel = panelOf(doc);
    const cyclic: CadDocument = {
      ...doc,
      components: {
        panel: {
          ...panel,
          entities: { ...panel.entities, 'self-1': asInstance(doc, 'self-1', 'panel') },
          order: [...panel.order, 'self-1'],
        },
      },
    };
    const { parts, skipped } = partsOf(cyclic);
    expect(skipped.map((entry) => entry.reason)).toEqual(['nesting deeper than 8 or cyclic']);
    expect(parts.length).toBeGreaterThan(0);
    const budget = budgetOf(cyclic);
    expect(budget.perPart.some((part) => part.note?.includes('cyclic'))).toBe(true);
    expect(budget.uncounted).toBeGreaterThanOrEqual(1);
  });

  /** `levels` components in a chain, each holding one instance of the next, the last one the panel. */
  function chain(levels: number): CadDocument {
    const doc = instanced(1);
    const panel = panelOf(doc);
    const components: CadDocument['components'] = { ...doc.components };
    for (let level = 0; level < levels; level += 1) {
      const child = asInstance(doc, `link-${level}`, level === levels - 1 ? 'panel' : `chain-${level + 1}`);
      components[`chain-${level}`] = { ...panel, id: `chain-${level}`, entities: { [child.id]: child }, order: [child.id] };
    }
    return { ...doc, components, entities: { 'root-1': asInstance(doc, 'root-1', 'chain-0') } };
  }

  it('a chain of nested components deeper than 8 is skipped with a reason', () => {
    expect(partsOf(chain(10)).skipped.map((entry) => entry.reason)).toEqual(['nesting deeper than 8 or cyclic']);
  });

  it('a chain within the depth limit is fully listed', () => {
    const { parts, skipped } = partsOf(chain(6));
    expect(skipped).toEqual([]);
    expect(parts).toHaveLength(1);
  });

  it('an exponential fan-out stops at the part cap with the reason', () => {
    const doc = instanced(1);
    const panel = panelOf(doc);
    const components: CadDocument['components'] = { ...doc.components };
    for (let level = 0; level < 7; level += 1) {
      const entities: Record<string, Entity> =
        level === 6
          ? { ...panel.entities }
          : Object.fromEntries(
              Array.from({ length: 12 }, (_, k) => [`f${level}-${k}`, asInstance(doc, `f${level}-${k}`, `fan-${level + 1}`)]),
            );
      components[`fan-${level}`] = { ...panel, id: `fan-${level}`, entities, order: Object.keys(entities) };
    }
    const fanned: CadDocument = { ...doc, components, entities: { 'root-1': asInstance(doc, 'root-1', 'fan-0') } };
    expect(partsOf(fanned).skipped.map((entry) => entry.reason)).toContain('part cap reached');
  });

  it('ignores an unknown id, a root without material and a leaf with no material after inheritance', () => {
    const bare = run(emptyMm(), 'add_box', { size: [1, 1, 1] });
    expect(partsOf(bare.document, ['nothing', ...bare.affected])).toEqual({ parts: [], skipped: [] });
    const nested = run(bare.document, 'create_component', { name: 'bare', entityIds: bare.affected, componentId: 'bare' }).document;
    expect(partsOf(nested)).toEqual({ parts: [], skipped: [] });
  });
});

describe('budgetOf without material data or with unverified values', () => {
  it('a part whose material has no entry in the data map is listed as "no material data", not counted', () => {
    const { parts } = partsOf(instanced(1));
    expect(parts).toHaveLength(1);
    const budget = budgetOfParts(undefined, parts, new Map());
    expect(budget.perPart[0]).toMatchObject({ massG: null, note: 'no material data' });
    expect(budget.uncounted).toBe(1);
  });

  it('a typical-basis TML marks the part unverified', () => {
    let doc = run(emptyMm(), 'create_material', { name: 'typ', density: 0.0012, color: '#333333', metalness: 0, roughness: 0.5 }).document;
    for (const property of ['TML', 'CVCM'])
      doc = run(doc, 'set_material_property', {
        material: 'typ',
        property,
        value: 0.1,
        unit: '%',
        basis: 'typical',
        source: { citation: 'datasheet' },
      }).document;
    doc = withPanel(doc, 'typ').document;
    expect(budgetOf(doc).perPart[0]).toMatchObject({ unverified: true });
    expect(budgetOf(withPanel(withMaterial(emptyMm(), 'ok', { TML: 0.1, CVCM: 0.1 }), 'ok').document).perPart[0]).toMatchObject({
      unverified: true,
    });
  });
});

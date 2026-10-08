import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { findComponentCycle } from '@core/commands/assemblies';
import { validateDocumentValues } from '@core/commands/persistenceValidation';

function withComponentA(): { doc: CadDocument; instanceOfA: string } {
  const box = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] });
  const made = execute(box.document, 'create_component', {
    name: 'A',
    entityIds: [box.affected[0]!],
    componentId: 'A',
  });
  return { doc: made.document, instanceOfA: made.affected[0]! };
}

describe('component reference cycles', () => {
  it('create_component refuses a component that would contain an instance of itself', () => {
    const { doc, instanceOfA } = withComponentA();
    const result = execute(doc, 'create_component', {
      name: 'A again',
      entityIds: [instanceOfA],
      componentId: 'A',
      replace: true,
    });
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(result.summary).toContain('would contain itself');
    expect(result.summary).toContain('A -> A');
  });

  it('create_component refuses an indirect A -> B -> A cycle', () => {
    const { doc, instanceOfA } = withComponentA();
    const b = execute(doc, 'create_component', {
      name: 'B',
      entityIds: [instanceOfA],
      componentId: 'B',
    });
    const instanceOfB = b.affected[0]!;
    const result = execute(b.document, 'create_component', {
      name: 'A rebuilt',
      entityIds: [instanceOfB],
      componentId: 'A',
      replace: true,
    });
    expect(result.document).toBe(b.document);
    expect(result.summary).toContain('A -> B -> A');
  });

  it('nesting without a cycle is allowed', () => {
    const { doc, instanceOfA } = withComponentA();
    const b = execute(doc, 'create_component', {
      name: 'B',
      entityIds: [instanceOfA],
      componentId: 'B',
    });
    expect(b.affected).toHaveLength(1);
    expect(findComponentCycle(b.document.components, 'B')).toBeNull();
  });

  it('findComponentCycle ignores missing components and cycles not through the start', () => {
    const { doc, instanceOfA } = withComponentA();
    expect(findComponentCycle(doc.components, 'ghost')).toBeNull();
    const instance = doc.entities[instanceOfA]!;
    const loop = {
      B: {
        id: 'B',
        name: 'B',
        entities: { x: { ...instance, id: 'x', componentId: 'C' } },
        order: ['x'],
      },
      C: {
        id: 'C',
        name: 'C',
        entities: { y: { ...instance, id: 'y', componentId: 'B' } },
        order: ['y'],
      },
      D: {
        id: 'D',
        name: 'D',
        entities: { z: { ...instance, id: 'z', componentId: 'B' } },
        order: ['z'],
      },
    } as unknown as CadDocument['components'];
    expect(findComponentCycle(loop, 'D')).toBeNull();
    expect(findComponentCycle(loop, 'B')).toEqual(['B', 'C', 'B']);
  });

  it('a loaded document with a cyclic component is reported invalid', () => {
    const { doc, instanceOfA } = withComponentA();
    const instance = doc.entities[instanceOfA]!;
    const cyclic = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
    cyclic['components'] = {
      A: {
        id: 'A',
        name: 'A',
        entities: { x: { ...instance, id: 'x', componentId: 'A' } },
        order: ['x'],
      },
    };
    const errors = validateDocumentValues(cyclic);
    expect(errors.join('\n')).toContain("component 'A' contains itself");
    const clean = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
    expect(validateDocumentValues(clean)).toEqual([]);
  });

  describe('reusing a component id', () => {
    it('is refused unless replace is true', () => {
      const { doc } = withComponentA();
      const sphere = execute(doc, 'add_sphere', { radius: 1 });
      const refused = execute(sphere.document, 'create_component', {
        name: 'Other',
        entityIds: [sphere.affected[0]!],
        componentId: 'A',
      });
      expect(refused.document).toBe(sphere.document);
      expect(refused.summary).toContain('already exists');
      expect(refused.summary).toContain('replace:true');

      const replaced = execute(sphere.document, 'create_component', {
        name: 'Other',
        entityIds: [sphere.affected[0]!],
        componentId: 'A',
        replace: true,
      });
      expect(replaced.affected).toHaveLength(1);
      expect(replaced.document.components['A']!.name).toBe('Other');
    });

    it('a fresh explicit id is unaffected', () => {
      const { doc } = withComponentA();
      const sphere = execute(doc, 'add_sphere', { radius: 1 });
      const made = execute(sphere.document, 'create_component', {
        name: 'S',
        entityIds: [sphere.affected[0]!],
        componentId: 'S',
      });
      expect(Object.keys(made.document.components).sort()).toEqual(['A', 'S']);
    });
  });
});

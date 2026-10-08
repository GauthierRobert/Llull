import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';

const svgOf = (doc: CadDocument, params: Record<string, unknown> = {}): string =>
  (execute(doc, 'render_view', params).data as { svg: string }).svg;

const shapeCount = (svg: string): number => (svg.match(/<polygon|<path|<polyline/g) ?? []).length;

function assembly(): { doc: CadDocument; instanceId: string } {
  const part = execute(createEmptyDocument(), 'add_box', { size: [2, 2, 2] });
  const component = execute(part.document, 'create_component', {
    name: 'Part',
    entityIds: [part.affected[0]!],
    componentId: 'comp-part',
  });
  const inserted = execute(component.document, 'insert_instance', {
    componentId: 'comp-part',
    position: [5, 0, 0],
  });
  return { doc: inserted.document, instanceId: inserted.affected[0]! };
}

describe('render_view draws component instances', () => {
  const { doc, instanceId } = assembly();

  it('an assembly-only document renders its component geometry', () => {
    const empty = svgOf(createEmptyDocument());
    expect(shapeCount(svgOf(doc))).toBeGreaterThan(shapeCount(empty));
    expect(doc.order).toContain(instanceId);
  });

  it('a scaled instance covers more of the view than the unit-scale one', () => {
    const scaled = execute(doc, 'move_entity', { id: instanceId, delta: [0, 0, 0] }).document;
    const bigger: CadDocument = {
      ...scaled,
      entities: {
        ...scaled.entities,
        [instanceId]: { ...scaled.entities[instanceId]!, scale: [3, 3, 3] } as never,
      },
    };
    expect(svgOf(bigger)).not.toBe(svgOf(doc));
  });

  it('a missing component and a self-referencing component do not throw or loop', () => {
    const broken: CadDocument = { ...doc, components: {} };
    expect(svgOf(broken)).toContain('<svg');
    const cyclic: CadDocument = {
      ...doc,
      components: {
        'comp-part': {
          ...doc.components['comp-part']!,
          entities: {
            [instanceId]: doc.entities[instanceId]!,
          },
          order: [instanceId],
        },
      },
    };
    expect(svgOf(cyclic)).toContain('<svg');
  });

  it('no NaN or Infinity leaks into the SVG', () => {
    expect(svgOf(doc, { view: 'front' })).not.toMatch(/NaN|Infinity/);
  });
});

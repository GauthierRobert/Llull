import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';

/** A document holding a curve next to a solid: whole-document commands must treat the curve as "no solid" without failing. */
const made = (() => {
  const box = execute(createEmptyDocument(), 'add_box', { size: [2, 2, 2] });
  const curve = execute(box.document, 'interpolate_curve', {
    points: [
      [0, 0, 0],
      [1, 1, 0],
      [2, 0, 1],
      [3, 1, 1],
    ],
  });
  return { doc: curve.document, curveId: curve.affected[0]!, boxId: box.affected[0]! };
})();

describe('nurbs_curve next to solids', () => {
  it.each([
    ['describe_scene', {}],
    ['check_model', {}],
    ['export_stl', {}],
    ['export_obj', {}],
    ['export_gltf', {}],
    ['export_code', { language: 'cadquery' }],
    ['bill_of_materials', {}],
    ['render_view', { view: 'front' }],
    ['fit_view', {}],
  ])('%s is not refused', (name, params) => {
    const result = execute(made.doc, name, params);
    expect(result.rejected, result.summary).toBeUndefined();
  });

  it('mass_properties and measure_area do not invent a volume for a curve', () => {
    const mass = execute(made.doc, 'mass_properties', { entityId: made.curveId });
    expect((mass.data as { volume?: number } | undefined)?.volume ?? 0).toBe(0);
    expect(execute(made.doc, 'mass_properties', { entityId: made.boxId }).affected).toEqual([]);
  });

  it('move, rotate, duplicate and delete work like for any entity', () => {
    const moved = execute(made.doc, 'move_entities', { ids: [made.curveId], delta: [1, 2, 3] });
    expect(moved.document.entities[made.curveId]!.position).toEqual([1, 2, 3]);
    const rotated = execute(made.doc, 'rotate_entity', { id: made.curveId, delta: [0, 0, Math.PI / 2] });
    expect(rotated.rejected).toBeUndefined();
    const copy = execute(made.doc, 'duplicate_entities', { ids: [made.curveId] });
    expect(copy.affected).toHaveLength(1);
    const gone = execute(made.doc, 'delete_entities', { ids: [made.curveId] });
    expect(gone.document.entities[made.curveId]).toBeUndefined();
  });

  it('replay_history regenerates the curve with the same id', () => {
    const replayed = execute(made.doc, 'replay_history', {});
    expect(replayed.rejected).toBeUndefined();
    expect(Object.keys(replayed.document.entities).sort()).toEqual(Object.keys(made.doc.entities).sort());
  });
});

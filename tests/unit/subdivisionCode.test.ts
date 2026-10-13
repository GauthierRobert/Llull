import { describe, it, expect } from 'vitest';
import { type SubdivisionEntity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { boxCage } from '@core/geometry/subdivision';

const cage = boxCage([2, 2, 2], [1, 1, 1]);
const doc = execute(createEmptyDocument(), 'add_subdivision_solid', {
  ...cage,
  creases: [[0, 1]],
  levels: 3,
  position: [1, 2, 3],
  name: 'knob',
}).document;

const exported = (language: string, source = doc): string => (execute(source, 'export_code', { language }).data as { text: string }).text;

describe('subdivision solids in export_code', () => {
  it('emits an exact subdivision(...) call with the cage, creases, levels and placement', () => {
    const text = exported('cadquery');
    expect(text).toContain('subdivision([');
    expect(text).toContain('creases=[(0, 1)], levels=3, position=(1, 2, 3)');
    expect(text).toContain('def _make_subdivision(');
    expect(text).not.toMatch(/has no analytic form/);
  });

  it('snapshot exports (no history) use the same call; FreeCAD builds B-spline faces', () => {
    expect(exported('build123d', { ...doc, featureHistory: [] })).toContain('subdivision([');
    expect(exported('freecad')).toContain('buildFromPolesMultsKnots');
  });

  it('openscad falls back to the subdivided surface, placed', () => {
    expect(exported('openscad')).toMatch(/translate\(\[1, 2, 3\]\) polyhedron\(/);
  });
});

describe('apply_code_trace with add_subdivision_solid', () => {
  it('rebuilds an editable subdivision solid from the recorded cage', () => {
    const trace = {
      version: 1,
      units: 'mm',
      parameters: [],
      features: [
        {
          command: 'add_subdivision_solid',
          ref: 'f1',
          params: {
            vertices: cage.vertices,
            faces: cage.faces,
            creases: [[0, 1]],
            levels: 2,
            position: [{ value: 4 }, { value: 0 }, { value: 0 }],
            rotation: [{ value: 0 }, { value: 0 }, { value: 0 }],
          },
        },
      ],
    };
    const applied = execute(createEmptyDocument(), 'apply_code_trace', { trace });
    const entity = applied.document.entities[applied.document.order[0] as string] as SubdivisionEntity;
    expect(entity.kind).toBe('subdivision');
    expect(entity.position).toEqual([4, 0, 0]);
    expect(entity.creases).toEqual([[0, 1]]);
    expect(applied.document.featureHistory.map((step) => step.name)).toEqual(['add_subdivision_solid']);
  });
});

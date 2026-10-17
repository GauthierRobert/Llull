import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import type { AnalysisCase } from '@core/model/analysis';
import { feaSetupGlyphs, formatValue } from '@ui/feaSetupGlyphs';

/** 100 x 100 x 100 mm box centred at the origin (faces at +-50). */
function boxDocument(): { doc: ReturnType<typeof createEmptyDocument>; id: string } {
  const result = execute(createEmptyDocument(), 'add_box', { size: [100, 100, 100] });
  expect(result.error, result.summary).toBeUndefined();
  return { doc: result.document, id: result.affected[0] ?? '' };
}

function baseCase(id: string, overrides: Partial<AnalysisCase>): AnalysisCase {
  return {
    id: 'a1',
    name: 'Case',
    type: 'static',
    solver: 'calculix',
    unitSystem: 'N-mm-t-s',
    factors: { ultimate: 1.5, yield: 1.1, extra: [] },
    parts: { [id]: { kind: 'solid' } },
    constraints: {},
    constraintOrder: [],
    loads: {},
    loadOrder: [],
    mesh: { mesher: 'gmsh', elementFamily: 'tet', order: 2, globalSize: 10, refinements: [], optimize: 'default' },
    probes: {},
    dispositions: {},
    ...overrides,
  };
}

describe('feaSetupGlyphs', () => {
  it('draws a fixed support as a cube pointing into the face, labelled by name and kind', () => {
    const { doc, id } = boxDocument();
    const analysis = baseCase(id, {
      constraints: { c1: { id: 'c1', name: 'Wall', kind: 'fixed', target: { entityId: id, facesNear: [[-50, 0, 0]] } } },
      constraintOrder: ['c1'],
    });
    const [glyph] = feaSetupGlyphs(doc, analysis);
    expect(glyph).toMatchObject({ kind: 'support', shape: 'cube', label: 'Wall · fixed', direction: [1, 0, 0] });
  });

  it('draws a force arrow along its vector with the case unit, coloured by category, and staggers labels at one point', () => {
    const { doc, id } = boxDocument();
    const target = { entityId: id, facesNear: [[50, 0, 0]] as [number, number, number][] };
    const analysis = baseCase(id, {
      loads: {
        l1: { id: 'l1', name: 'Pull', loadCase: 'lc', category: 'limit', kind: 'force', target, vector: [0, 0, -2000] },
        l2: { id: 'l2', name: 'Burst', loadCase: 'lc', category: 'ultimate', kind: 'pressure', target, magnitude: 3.5 },
      },
      loadOrder: ['l1', 'l2'],
      unitSystem: 'N-mm-t-s',
    });
    const [force, pressure] = feaSetupGlyphs(doc, analysis);
    expect(force).toMatchObject({ shape: 'arrow', direction: [0, 0, -1], label: 'Pull · 2000 N', color: '#ff9100', stack: 0 });
    expect(pressure).toMatchObject({ direction: [-1, 0, 0], label: 'Burst · 3.5 MPa', color: '#ff3d3d', stack: 1 });
  });

  it('uses imperial unit labels', () => {
    const { doc, id } = boxDocument();
    const analysis = baseCase(id, {
      unitSystem: 'lbf-in-slinch-s',
      loads: { l1: { id: 'l1', name: 'P', loadCase: 'lc', category: 'limit', kind: 'pressure', magnitude: 100 } },
      loadOrder: ['l1'],
    });
    expect(feaSetupGlyphs(doc, analysis)[0]?.label).toBe('P · 100 psi');
  });

  it('draws probes and falls back to the part centre for a load without a target', () => {
    const { doc, id } = boxDocument();
    const analysis = baseCase(id, {
      loads: { g: { id: 'g', name: 'Gravity', loadCase: 'lc', category: 'limit', kind: 'gravity', vector: [0, 0, -9810] } },
      loadOrder: ['g'],
      probes: { p1: { name: 'Tip', point: [10, 20, 30], quantity: 'von_mises' } },
    });
    const [gravity, probe] = feaSetupGlyphs(doc, analysis);
    expect(gravity?.position).toEqual([0, 0, 0]);
    expect(gravity?.label).toBe('Gravity · 9810 mm/s²');
    expect(probe).toMatchObject({ kind: 'probe', shape: 'diamond', position: [10, 20, 30], label: 'Tip · von Mises' });
  });

  it('draws thermal boundary conditions with their values', () => {
    const { doc, id } = boxDocument();
    const target = { entityId: id, facesNear: [[0, 50, 0]] as [number, number, number][] };
    const analysis = baseCase(id, {
      type: 'heat_steady',
      thermal: {
        temperatureScale: 'degC',
        bcs: {
          t1: { id: 't1', name: 'Hot', bc: { kind: 'temperature', value: { value: 120, unit: 'degC' }, target } },
          f1: {
            id: 'f1',
            name: 'Air',
            bc: { kind: 'film', filmCoefficient: { value: 25, unit: 'W/(m^2*K)' }, sinkTemperature: { value: 20, unit: 'degC' }, target },
          },
        },
        bcOrder: ['t1', 'f1'],
        amplitudes: {},
        cavities: {},
        contacts: {},
        step: {},
        limits: {},
        limitOrder: [],
        dispositions: {},
      },
    });
    const labels = feaSetupGlyphs(doc, analysis).map((glyph) => glyph.label);
    expect(labels).toEqual(['Hot · 120 degC', 'Air · h 25 W/(m^2*K) → 20 degC']);
  });

  it('formats numbers compactly', () => {
    expect(formatValue(1234.5678)).toBe('1235');
    expect(formatValue(0)).toBe('0');
    expect(formatValue(2.1e9)).toBe('2.10e+9');
  });
});

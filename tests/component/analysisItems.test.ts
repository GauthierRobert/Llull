import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { AnalysisCase, ThermalBcRecord, ThermalSetup } from '@core/model/analysis';
import { useStore } from '@ui/store';
import { buildSetupItems, analysisToDocument, loadValueText } from '@ui/panels/analysis/analysisItems';
import { parseSurface } from '@ui/panels/analysis/surfaceData';
import { localDispatch } from '../helpers/storeTestHelpers';

describe('analysis set-up items', () => {
  it('places supports, loads and thermal BCs at their target points with value labels', () => {
    useStore.getState().setDocument(createEmptyDocument());
    const boxId = localDispatch('add_box', { size: [10, 20, 30] }).affected[0]!;
    const analysisId = localDispatch('create_analysis', { name: 'Plate', analysisType: 'heat_steady' }).affected[0]!;
    localDispatch('set_part_idealization', { analysisId, entityId: boxId });
    const doc = useStore.getState().document;
    const base = doc.analysis!.cases[analysisId]!;
    const bc: ThermalBcRecord = {
      id: 'tb-1',
      name: 'hot face',
      bc: {
        kind: 'film',
        filmCoefficient: { value: 25, unit: 'W/m2K' },
        sinkTemperature: { value: 20, unit: 'degC' },
        target: { entityId: boxId, facesNear: [[5, 10, 30]] },
      },
    };
    const analysisCase: AnalysisCase = { ...base, thermal: { ...(base.thermal as ThermalSetup), bcs: { 'tb-1': bc }, bcOrder: ['tb-1'] } };
    const items = buildSetupItems(doc, analysisCase);
    expect(items.size).toBeGreaterThan(0);
    const drawn = items.thermal[0];
    expect(drawn?.points).toEqual([[5, 10, 30]]);
    expect(drawn?.label).toBe('h = 25 W/m2K, T∞ = 20 °C');
    expect(drawn?.color).toBe('#14b8a6');
  });

  it('writes load values with the unit of the case unit system', () => {
    const load = { id: 'l', name: 'l', loadCase: 'LC1', category: 'limit', kind: 'pressure', magnitude: 2 } as const;
    expect(loadValueText(load, 'N-mm-t-s')).toBe('2 MPa');
    expect(
      loadValueText({ id: 'f', name: 'f', loadCase: 'LC1', category: 'limit', kind: 'force', vector: [0, 3, 4] }, 'lbf-in-slinch-s'),
    ).toBe('5 lbf');
    expect(
      loadValueText({ id: 'g', name: 'g', loadCase: 'LC1', category: 'limit', kind: 'gravity', vector: [0, 0, -9810] }, 'N-mm-t-s'),
    ).toBe('9.81 m/s²');
  });

  it('converts mesh coordinates to document units', () => {
    expect(analysisToDocument({ ...createEmptyDocument(), units: 'mm' }, 'N-m-kg-s')).toBe(1000);
    expect(analysisToDocument({ ...createEmptyDocument(), units: 'mm' }, 'N-mm-t-s')).toBe(1);
  });

  it('parses a surface answer and rejects an answer without one', () => {
    const data = {
      field: 'von_mises',
      unit: 'MPa',
      levels: [0, 1, 2],
      min: { value: 0, at: [0, 0, 0] },
      max: { value: 2, at: [0, 0, 0] },
      surface: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], values: [0, 1, 2], triangles: 1, truncated: false },
    };
    expect(parseSurface(data)?.triangles).toBe(1);
    expect(parseSurface({ ...data, surface: undefined })).toBeNull();
    expect(parseSurface({ ...data, surface: { ...data.surface, values: [1] } })).toBeNull();
  });
});

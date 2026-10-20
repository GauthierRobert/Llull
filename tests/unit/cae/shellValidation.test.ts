/** Load-time validation of shell / plane-stress idealizations and defeaturing (M6 review item 7). */
import { describe, expect, it } from 'vitest';
import type { AnalysisCase } from '@core/model/analysis';
import { analysisErrors } from '@cae/model/validate';
import { defeatureErrors, idealizationErrors } from '@cae/model/validateIdealization';
import { must, plateDocument } from './shellFixtures';

const good = { kind: 'shell', thickness: 2, offset: 'mid', midsurface: { maxThickness: 2, angularTolDeg: 1, minCoverage: 0.9 } };

describe('idealization validation', () => {
  it('accepts well-formed shells, plane stress and solids', () => {
    expect(idealizationErrors(good, 'p')).toEqual([]);
    expect(idealizationErrors({ ...good, thickness: 'auto', laminate: { compositePartId: 'cp', sectionId: 's' } }, 'p')).toEqual([]);
    expect(idealizationErrors({ kind: 'plane_stress', thickness: 1, sourceFacesNear: [[0, 0, 0]] }, 'p')).toEqual([]);
    expect(idealizationErrors({ kind: 'solid' }, 'p')).toEqual([]);
  });

  it('rejects bad shell and plane-stress values', () => {
    expect(idealizationErrors({ ...good, thickness: -1, offset: 'side' }, 'p')).toHaveLength(2);
    expect(idealizationErrors({ ...good, midsurface: null }, 'p')[0]).toContain('maxThickness');
    expect(idealizationErrors({ ...good, midsurface: { maxThickness: 1, angularTolDeg: 90, minCoverage: 2 } }, 'p')).toHaveLength(2);
    expect(idealizationErrors({ ...good, laminate: { compositePartId: 3 } }, 'p')[0]).toContain('laminate');
    expect(idealizationErrors({ ...good, laminate: { compositePartId: 'c', sectionId: 1 } }, 'p')).toHaveLength(1);
    expect(idealizationErrors({ kind: 'plane_stress', thickness: 0, sourceFacesNear: [] }, 'p')).toHaveLength(2);
  });

  it('rejects bad defeature specs', () => {
    const parts = { a: {} };
    expect(defeatureErrors(undefined, parts, 'c')).toEqual([]);
    expect(defeatureErrors(3, parts, 'c')).toHaveLength(1);
    expect(defeatureErrors({ a: { maxFeatureSize: 1, facesNear: [[0, 0, 0]] } }, parts, 'c')).toEqual([]);
    expect(defeatureErrors({ b: 'x' }, parts, 'c')).toHaveLength(2);
    expect(defeatureErrors({ a: { maxFeatureSize: -1, facesNear: 'x' } }, parts, 'c')).toHaveLength(2);
    expect(defeatureErrors({ a: {} }, parts, 'c')[0]).toContain('names no feature');
  });

  it('runs on a loaded document', () => {
    const plate = plateDocument();
    const doc = must(plate.doc, 'set_part_idealization', { analysisId: plate.analysisId, entityId: plate.plateId, idealization: 'shell' });
    const raw = JSON.parse(JSON.stringify(doc)) as { analysis: { cases: Record<string, AnalysisCase & { defeature?: unknown }> } };
    expect(analysisErrors(raw as unknown as Record<string, unknown>)).toEqual([]);
    const broken = raw.analysis.cases[plate.analysisId];
    if (broken === undefined) throw new Error('fixture');
    (broken.parts as Record<string, unknown>)[plate.plateId] = { ...good, offset: 'side' };
    broken.defeature = { ghost: { maxFeatureSize: 1 } };
    const errors = analysisErrors(raw as unknown as Record<string, unknown>);
    expect(errors.some((text) => text.includes('offset'))).toBe(true);
    expect(errors.some((text) => text.includes("'ghost', which is not a part"))).toBe(true);
  });
});

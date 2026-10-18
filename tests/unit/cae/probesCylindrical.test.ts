import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { FeMeshArtifact, ResultProbe } from '@core/model/analysis';
import { evaluateProbes } from '@cae/results/probes';
import { analysisErrors } from '@cae/model/validate';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { caseOf, withCase } from '@cae/shared/access';
import { solvedBar } from './deckFixtures';

const noSets = (mesh: FeMeshArtifact): FeMeshArtifact => ({ ...mesh, nodeSets: {} });

describe('cylindrical result probes', () => {
  it('add_result_probe stores the axis and the probe round-trips through save / validate', () => {
    const bar = solvedBar();
    const added = execute(bar.doc, 'add_result_probe', {
      analysisId: bar.analysisId,
      name: 'hoop',
      point: [2, 1, 1],
      quantity: 's_hoop',
      axisPoint: [0, 0, 0],
      axisDirection: [0, 0, 2],
    });
    expect(added.affected).toHaveLength(1);
    const id = added.affected[0] ?? '';
    expect(caseOf(added.document, bar.analysisId)?.probes[id]).toMatchObject({
      quantity: 's_hoop',
      axisPoint: [0, 0, 0],
      axisDirection: [0, 0, 2],
    });
    const loaded = deserializeDocument(serializeDocument(added.document));
    expect(caseOf(loaded, bar.analysisId)?.probes[id]?.axisDirection).toEqual([0, 0, 2]);
    expect(analysisErrors(JSON.parse(serializeDocument(added.document)).document)).toEqual([]);
  });

  it('validation rejects a probe with a zero axis direction or an unknown quantity', () => {
    const bar = solvedBar();
    const added = execute(bar.doc, 'add_result_probe', { analysisId: bar.analysisId, name: 'r', point: [2, 1, 1], quantity: 'u_radial' });
    const id = added.affected[0] ?? '';
    const base = caseOf(added.document, bar.analysisId);
    if (base === undefined) throw new Error('no case');
    const bad = (probe: Record<string, unknown>): string[] =>
      analysisErrors(JSON.parse(serializeDocument(withCase(added.document, { ...base, probes: { [id]: probe as never } }))).document);
    expect(bad({ name: 'r', point: [2, 1, 1], quantity: 'u_radial', axisDirection: [0, 0, 0] }).join()).toContain('malformed axis');
    expect(bad({ name: 'r', point: [2, 1, 1], quantity: 'u_hoop' }).join()).toContain('malformed');
  });

  it('refuses an axis on a plain quantity, a zero direction and a non-finite axis point', () => {
    const bar = solvedBar();
    const run = (extra: Record<string, unknown>, quantity = 's_hoop'): ReturnType<typeof execute> =>
      execute(bar.doc, 'add_result_probe', { analysisId: bar.analysisId, name: 'x', point: [2, 1, 1], quantity, ...extra });
    for (const result of [
      run({ axisDirection: [1, 0, 0] }, 's_xx'),
      run({ axisDirection: [0, 0, 0] }),
      run({ axisPoint: [Number.NaN, 0, 0] }),
    ]) {
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(bar.doc);
      expect(result.summary).toMatch(/FEA_PROBE_INVALID|rejected/);
    }
  });

  it('evaluateProbes reads hoop / radial / axial stress and radial displacement about the stored axis', () => {
    const bar = solvedBar();
    const base = caseOf(bar.doc, bar.analysisId);
    if (base === undefined) throw new Error('no case');
    const probe = (quantity: 's_hoop' | 's_radial' | 's_axial' | 'u_radial', extra: object = {}): ResultProbe => ({
      name: quantity,
      point: [2, 1, 1] as [number, number, number],
      quantity,
      ...extra,
    });
    const analysis = {
      ...base,
      probes: {
        hoop: probe('s_hoop', { axisPoint: [0, 0, 0] }),
        radial: probe('s_radial', { axisPoint: [0, 0, 0] }),
        axial: probe('s_axial', { axisPoint: [0, 0, 0] }),
        ur: probe('u_radial', { axisPoint: [0, 0, 0] }),
        axialX: probe('s_axial', { axisPoint: [0, 0, 0], axisDirection: [1, 0, 0] }),
        flat: probe('s_hoop', { axisDirection: [0, 0, 0] }),
      },
    };
    const readings = evaluateProbes(analysis, noSets(bar.mesh), bar.results, 1);
    const at = (id: string): number | null => readings.find((reading) => reading.probeId === id)?.values[0]?.value ?? null;
    expect(at('hoop')).toBeCloseTo(42, 9);
    expect(at('radial')).toBeCloseTo(168, 9);
    expect(at('axial')).toBeCloseTo(0, 9);
    expect(at('ur')).toBeCloseTo((2 * 0.002 - 3e-4) / Math.sqrt(5), 12);
    expect(at('axialX')).toBeCloseTo(210, 9);
    expect(at('flat')).toBeNull();
    expect(readings.find((reading) => reading.probeId === 'hoop')?.unit).toBe('MPa');
    expect(readings.find((reading) => reading.probeId === 'ur')?.unit).toBe('mm');
  });

  it('defaults to the z axis through the mesh bounding-box centre when no axis is stored', () => {
    const bar = solvedBar();
    const base = caseOf(bar.doc, bar.analysisId);
    if (base === undefined) throw new Error('no case');
    const analysis = { ...base, probes: { r: { name: 'r', point: [2, 1, 1] as [number, number, number], quantity: 's_radial' as const } } };
    const value = evaluateProbes(analysis, noSets(bar.mesh), bar.results, 1)[0]?.values[0]?.value;
    expect(typeof value).toBe('number');
    expect(Number.isFinite(value)).toBe(true);
  });
});

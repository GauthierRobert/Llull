/** PST-FU2 `pipe_stress_pcf_attributes`: COMPONENT-ATTRIBUTE1..10 of the CAESAR II import map (05 ISO pcf_keywords.json) from the stored conditions. */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { data, expectRefusal } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { baseDoc, conditioned, DN100, withModel, withPipe } from './m3Fixtures';

interface Attributes {
  modelId: string;
  pipeIds: string[];
  attributes: Record<string, string>;
  lines: string[];
  omitted: Record<string, string>;
  unitsGrade: string;
  reviewRequired: boolean;
  slots: { key: string; value: string | null }[];
}

function scene(over: Record<string, unknown> = {}): { doc: ReturnType<typeof baseDoc>; id: string; pipe: string } {
  const pipe = withPipe(
    baseDoc(),
    [
      [0, 0, 0],
      [3000, 0, 0],
    ],
    DN100.odMm,
  );
  const model = withModel(pipe.doc, [pipe.id]);
  return { doc: conditioned(model.doc, model.id, over), id: model.id, pipe: pipe.id };
}

describe('pipe_stress_pcf_attributes', () => {
  it('maps the stored conditions to slots 1, 2, 4 to 7, 9, 10 (largest P and T) and omits material and weight with reasons', () => {
    const s = scene({
      temperatures: [
        { name: 'T1', tempC: 150 },
        { name: 'T2', tempC: 260 },
      ],
      pressures: [
        { name: 'P1', gaugeBar: 10 },
        { name: 'P2', gaugeBar: 25.5 },
      ],
      corrosionAllowanceMm: 1.5,
      fluidDensityKgM3: 998,
      insulation: { thicknessMm: 50, densityKgM3: 120, claddingKgM2: 0 },
      hydrotest: { testPressureBar: 38.25, allowableMPa: 200, fluidDensityKgM3: 1000 },
    });
    const out = data<Attributes>(s.doc, 'pipe_stress_pcf_attributes', { modelId: s.id });
    expect(out.attributes).toEqual({
      'COMPONENT-ATTRIBUTE1': '25.5',
      'COMPONENT-ATTRIBUTE2': '260',
      'COMPONENT-ATTRIBUTE4': String(DN100.wallMm),
      'COMPONENT-ATTRIBUTE5': '50',
      'COMPONENT-ATTRIBUTE6': '120',
      'COMPONENT-ATTRIBUTE7': '1.5',
      'COMPONENT-ATTRIBUTE9': '998',
      'COMPONENT-ATTRIBUTE10': '38.25',
    });
    expect(out.lines[0]).toBe('COMPONENT-ATTRIBUTE1 25.5');
    expect(out.lines).toHaveLength(8);
    expect(Object.keys(out.omitted).sort()).toEqual(['COMPONENT-ATTRIBUTE3', 'COMPONENT-ATTRIBUTE8']);
    expect(out.slots).toHaveLength(10);
    expect(out.pipeIds).toEqual([s.pipe]);
    expect(out.unitsGrade).toBe('C');
    expect(out.reviewRequired).toBe(true);
  });

  it('omits slots with no stored value, never defaulting them', () => {
    const s = scene({ temperatures: [], wallMm: undefined });
    const out = data<Attributes>(s.doc, 'pipe_stress_pcf_attributes', { modelId: s.id });
    expect(Object.keys(out.attributes)).toEqual(['COMPONENT-ATTRIBUTE7', 'COMPONENT-ATTRIBUTE9']);
    for (const key of [1, 2, 3, 4, 5, 6, 8, 10]) expect(out.omitted[`COMPONENT-ATTRIBUTE${key}`]).toBeDefined();
  });

  it('refuses an unknown model and a model without conditions; is pure', () => {
    const s = scene();
    expectRefusal(s.doc, 'pipe_stress_pcf_attributes', { modelId: 'nope' }, 'PST_MODEL_NOT_FOUND');
    const pipe = withPipe(
      baseDoc(),
      [
        [0, 0, 0],
        [3000, 0, 0],
      ],
      DN100.odMm,
    );
    const bare = withModel(pipe.doc, [pipe.id]);
    expectRefusal(bare.doc, 'pipe_stress_pcf_attributes', { modelId: bare.id }, 'PST_CONDITIONS_MISSING');
    expectPure(s.doc, () => execute(s.doc, 'pipe_stress_pcf_attributes', { modelId: s.id }));
  });

  it('reports a run-scoped model under runIds and no pipeIds', () => {
    const s = scene();
    const model = s.doc.plant?.stress?.models[s.id];
    if (model === undefined) throw new Error('model');
    const runs = {
      ...s.doc,
      plant: {
        ...s.doc.plant,
        stress: { ...s.doc.plant?.stress, models: { [s.id]: { ...model, scope: { kind: 'runs', ids: ['run-1'] } } } },
      },
    } as typeof s.doc;
    const out = data<Attributes & { runIds: string[] }>(runs, 'pipe_stress_pcf_attributes', { modelId: s.id });
    expect(out.runIds).toEqual(['run-1']);
    expect(out.pipeIds).toEqual([]);
  });
});

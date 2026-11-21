/** PST-FU2 (part 2) + ISO-M6e: `export_pcf` with `stressModelId` writes COMPONENT-ATTRIBUTE1..10 of the stress model on the pipe-borne components. */

import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { addTie, cs150Line } from '../piping/rteFixtures';
import { baseDoc, conditioned, DN100, withModel, withPipe } from './m3Fixtures';

interface Exported {
  files: { name: string; content: string; componentCount: number }[];
  stressAttributes: { modelId: string; attributes: Record<string, string>; covered: string[]; notCovered: string[] } | null;
}

const CONDITIONS = {
  temperatures: [
    { name: 'T1', tempC: 150 },
    { name: 'T2', tempC: 260 },
  ],
  pressures: [{ name: 'P1', gaugeBar: 25.5 }],
  corrosionAllowanceMm: 1.5,
  fluidDensityKgM3: 998,
  insulation: { thicknessMm: 50, densityKgM3: 120, claddingKgM2: 0 },
};

/** Two legacy pipe lines: L-1 (in the model) and L-2 (not). */
function scene(): { doc: ReturnType<typeof baseDoc>; modelId: string } {
  const first = withPipe(
    baseDoc(),
    [
      [0, 0, 0],
      [3000, 0, 0],
    ],
    DN100.odMm,
    { line: 'L-1' },
  );
  const second = withPipe(
    first.doc,
    [
      [0, 2000, 0],
      [3000, 2000, 0],
    ],
    DN100.odMm,
    { line: 'L-2' },
  );
  const model = withModel(second.doc, [first.id]);
  return { doc: conditioned(model.doc, model.id, CONDITIONS), modelId: model.id };
}

const fileOf = (out: Exported, name: string): string => out.files.find((file) => file.name === name)?.content ?? '';

describe('export_pcf stressModelId', () => {
  const s = scene();
  const out = data<Exported>(s.doc, 'export_pcf', { stressModelId: s.modelId });

  it('writes the present slots on the PIPE records of the covered line only, as pipe_stress_pcf_attributes reports them', () => {
    const query = data<{ attributes: Record<string, string> }>(s.doc, 'pipe_stress_pcf_attributes', { modelId: s.modelId });
    expect(out.stressAttributes?.attributes).toEqual(query.attributes);
    expect(out.stressAttributes?.covered).toEqual(['L-1']);
    expect(out.stressAttributes?.notCovered).toEqual(['L-2']);
    const covered = fileOf(out, 'L-1.pcf');
    expect(covered).toContain('    COMPONENT-ATTRIBUTE1 25.5');
    expect(covered).toContain('    COMPONENT-ATTRIBUTE2 260');
    expect(covered).toContain('    COMPONENT-ATTRIBUTE7 1.5');
    expect(covered).toContain('    COMPONENT-ATTRIBUTE9 998');
    expect(covered).not.toContain('COMPONENT-ATTRIBUTE3');
    expect(covered).not.toContain('COMPONENT-ATTRIBUTE8');
    expect(fileOf(out, 'L-2.pcf')).not.toContain('COMPONENT-ATTRIBUTE');
  });

  it('is off by default (byte-identical file without the param) and never writes support attributes', () => {
    const plain = data<Exported>(s.doc, 'export_pcf', {});
    expect(plain.stressAttributes).toBeNull();
    expect(fileOf(plain, 'L-1.pcf')).not.toContain('COMPONENT-ATTRIBUTE');
    expect(fileOf(out, 'L-1.pcf')).not.toContain('SUPPORT-TYPE');
  });

  it('survives a PCF round trip: import_pcf keeps the attributes and export_pcf writes the same file', () => {
    const text = fileOf(out, 'L-1.pcf');
    const imported = apply(createEmptyDocument(), 'import_pcf', { text });
    const again = data<Exported>(imported, 'export_pcf', {});
    expect(fileOf(again, 'L-1.pcf')).toBe(text);
  });

  it('refuses an unknown model and a model without operating conditions (ISO_PARAM_INVALID), document unchanged', () => {
    expectRefusal(s.doc, 'export_pcf', { stressModelId: 'nope' }, 'ISO_PARAM_INVALID');
    const pipe = withPipe(
      baseDoc(),
      [
        [0, 0, 0],
        [3000, 0, 0],
      ],
      DN100.odMm,
      { line: 'L-1' },
    );
    const bare = withModel(pipe.doc, [pipe.id]);
    expectRefusal(bare.doc, 'export_pcf', { stressModelId: bare.id }, 'ISO_PARAM_INVALID');
  });

  it('is pure', () => {
    expectPure(s.doc, () => execute(s.doc, 'export_pcf', { stressModelId: s.modelId }));
  });
});

describe('export_pcf stressModelId on a routed line (run-scoped model)', () => {
  it('writes the attributes on a routed line the run-scoped model covers', () => {
    const line = cs150Line(150, '3001');
    const tie = addTie(line.doc, 'A', [0, 0, 0], [1, 0, 0], { dn: 150 });
    const route = execute(tie.doc, 'route_pipe', {
      lineId: line.lineId,
      from: { portId: tie.id },
      legs: [{ direction: '+X', length: 3000 }],
    });
    const runId = (route.data as { runId: string }).runId;
    const model = withModel(route.document, [runId]);
    const doc = conditioned(model.doc, model.id, CONDITIONS);
    const result = data<Exported>(doc, 'export_pcf', { stressModelId: model.id });
    expect(result.stressAttributes?.covered).toHaveLength(1);
    const content = result.files[0]?.content ?? '';
    expect(content).toContain('COMPONENT-ATTRIBUTE2 260');
    expect(content).toContain('PIPE\n    COMPONENT-IDENTIFIER 1');
  });
});

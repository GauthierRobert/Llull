/** 07 PST nozzle fixtures: a pump with a +Z nozzle, the pipe anchored at its flange, the model recorded; optionally with the hot modulus of a fixture E table. */

import type { CadDocument } from '@core/model/types';
import { apply } from '../../../helpers/commandAssertions';
import { anchorAt, baseDoc, cases, conditioned, DN100, withModel, withPipe } from './m3Fixtures';

/** Fixture E(T) rows (GPa at degC), not code data. */
export const E_ROWS = [
  { tempC: 20, ShMPa: 138, EGPa: 200, meanCtePerK: 1.2e-5 },
  { tempC: 100, ShMPa: 138, EGPa: 195, meanCtePerK: 1.2e-5 },
  { tempC: 200, ShMPa: 138, EGPa: 190, meanCtePerK: 1.2e-5 },
];

export const withEModulus = (doc: CadDocument, rows: unknown[] = E_ROWS): CadDocument =>
  apply(doc, 'import_pipe_material_data', {
    materialId: 'FIX',
    designation: 'fixture steel',
    rows,
    referenceTempC: 20,
    source: { citation: 'test fixture', locator: 'none' },
    licence: 'test fixture values',
  });

export interface Scene {
  doc: CadDocument;
  id: string;
  restraintId: string;
}

export interface Row {
  case: string;
  ratio: number;
  forceNozzleFrameN: [number, number, number];
  momentNozzleFrameNm: [number, number, number];
}

/** Pump P-101 with a +Z nozzle N2 at (0, 300, 1000); the pipe rises 3000 mm from the flange face (world 0, 0, 1000: the nozzle position plus the equipment location), turns +X for 3000 mm; anchor at the nozzle. */
export function scene(record = true, hot = false): Scene {
  let doc = apply(hot ? withEModulus(baseDoc()) : baseDoc(), 'add_equipment', {
    name: 'Centrifugal pump',
    mark: 'P-101',
    location: [0, -300],
    size: [1200, 600, 800],
    weight: 650,
  });
  doc = apply(doc, 'add_nozzle', {
    equipment: 'P-101',
    mark: 'N2',
    dn: 100,
    rating: 'CL150',
    facing: 'RF',
    location: { on: 'free', position: [0, 300, 1000], direction: [0, 0, 1] },
    projection: 300,
  });
  const pipe = withPipe(
    doc,
    [
      [0, 0, 1000],
      [0, 0, 4000],
      [3000, 0, 4000],
    ],
    DN100.odMm,
  );
  const model = withModel(pipe.doc, [pipe.id]);
  let d = conditioned(model.doc, model.id, { temperatures: [{ name: 'T1', tempC: 60 }] });
  d = anchorAt(d, model.id, pipe.id, 0);
  d = cases(d, model.id, [
    { name: 'SUS', type: 'SUS', basic: ['W'] },
    { name: 'OPE', type: 'OPE', basic: ['W', 'T1'] },
  ]);
  if (hot) d = apply(d, 'set_hot_modulus', { modelId: model.id, materialId: 'FIX' });
  const restraintId = d.plant?.stress?.models[model.id]?.restraints[0]?.id as string;
  return { doc: record ? apply(d, 'record_pipe_stress_results', { modelId: model.id }) : d, id: model.id, restraintId };
}

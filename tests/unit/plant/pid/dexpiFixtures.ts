/** Fixtures of the 04 PID DEXPI tests: the validation pack files and its census (computed by python from the files, not by llull). */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { apply, data } from '../../../helpers/commandAssertions';

export const PID_PACK = path.resolve(__dirname, '../../../../docs/plant/04-pid-schematics/validation');

interface CensusFile {
  file: string;
  sha256: string;
  counts: Record<string, number>;
  equipment: Array<{ id: string; class: string; tagName: string | null; nozzles: number; subEquipment: number }>;
  lines: Array<{ lineNumber: string; fluidCode: string; nominalDiameter: string; pipingClass: string; segments: number }>;
  instrumentFunctions: Array<{ category: string; functions: string; number: string }>;
  loops: string[];
  equipmentByClass: Record<string, number>;
  pipingComponentsByClass: Record<string, number>;
}

export interface Census {
  proteus13: CensusFile[];
  C01connectivity: {
    connections: number;
    endpointTypes: Record<string, number>;
    nozzlesTotal: number;
    nozzlesReferencedByConnection: number;
  };
}

export const census = JSON.parse(readFileSync(path.join(PID_PACK, 'data/dexpi_census.json'), 'utf8')) as Census;

export const dexpiText = (file: string): string => readFileSync(path.join(PID_PACK, 'data/dexpi13', file), 'utf8');

export const C01 = 'C01V04-VER.EX01.xml';

export const importFile = (file: string, doc: CadDocument = createEmptyDocument()): CadDocument =>
  apply(doc, 'import_dexpi', { text: dexpiText(file) });

export const countsOf = (doc: CadDocument): Record<string, number> =>
  data<{ counts: Record<string, number> }>(doc, 'pid_report', { kind: 'counts' }).counts;

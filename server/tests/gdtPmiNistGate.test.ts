/**
 * 03 GDT M6 quality gate on the NIST MBE PMI files (VC-GDT-20): `import_step_exact` reads the semantic PMI of each file into `doc.pmi`
 * (`apply_pmi_set`) and the census of what arrived is compared with the independent entity census of the file
 * (docs/aerospace/03-gdt-mbd-pmi/validation/nist_pmi_census.json, generated from the Part 21 text by a script that shares no code with llull).
 * `nist_pmi_import_expected.json` pins the measured result per file (a ratchet: a count may only rise towards the census, never fall);
 * regenerate it with LLULL_GDT_RECORD=<path>. The NIST files are fetched, never committed (fetch_nist_step_files.py); the suite skips without them.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { createEmptyDocument } from '@core/model/types';
import { describeNative, liveKernels } from './kernelTestSupport';

const kernels = liveKernels();
const PACK = path.resolve(__dirname, '../../docs/aerospace/03-gdt-mbd-pmi/validation');
const NIST = process.env['LLULL_NIST_STEP_DIR'] || path.join(os.homedir(), '.cache', 'llull', 'nist-pmi-step-files');
const RECORD = process.env['LLULL_GDT_RECORD'];

interface Census {
  readonly file: string;
  readonly geometricTolerances: { readonly total: number };
  readonly dimensions: Readonly<Record<string, number>>;
  readonly datums: Readonly<Record<string, number>>;
}
interface Measured {
  readonly tolerances: number;
  readonly dimensions: number;
  readonly datumFeatures: number;
  readonly unresolved: number;
  readonly unmapped: number;
  readonly unverified: number;
}
interface Entry {
  readonly reference: { tolerances: number; dimensions: number; datumFeatures: number };
  readonly imported: Measured;
}

const census = (JSON.parse(readFileSync(path.join(PACK, 'nist_pmi_census.json'), 'utf8')) as { files: Record<string, Census> }).files;
const files = (
  JSON.parse(readFileSync(path.join(PACK, 'nist_pmi_files.json'), 'utf8')) as { files: { id: string; semanticPmi: boolean }[] }
).files
  .filter((file) => file.semanticPmi)
  .map((file) => file.id);
const expectedPath = path.join(PACK, 'nist_pmi_import_expected.json');
const pinned: Record<string, Entry> = existsSync(expectedPath)
  ? (JSON.parse(readFileSync(expectedPath, 'utf8')) as Record<string, Entry>)
  : {};

const ctx = (): ExecutionContext => ({ ...defaultContext(), kernel: kernels.occt });
const sum = (record: Readonly<Record<string, number>>, names: readonly string[]): number =>
  names.reduce((total, name) => total + (record[name] ?? 0), 0);

function importCensus(id: string): Entry {
  const reference = census[id] as Census;
  const text = readFileSync(path.join(NIST, reference.file), 'latin1');
  const result: CommandResult = execute(createEmptyDocument(), 'import_step_exact', { text, fileName: reference.file }, ctx());
  const items = Object.values(result.document.pmi?.items ?? {});
  const count = (...kinds: string[]): number => items.filter((item) => kinds.includes(item.kind)).length;
  return {
    reference: {
      tolerances: reference.geometricTolerances.total,
      dimensions: sum(reference.dimensions, ['DIMENSIONAL_SIZE', 'DIMENSIONAL_LOCATION', 'ANGULAR_LOCATION', 'ANGULAR_SIZE']),
      datumFeatures: reference.datums['DATUM_FEATURE'] ?? 0,
    },
    imported: {
      tolerances: count('geometric_tolerance'),
      dimensions: count('size_dimension', 'location_dimension'),
      datumFeatures: count('datum_feature'),
      unresolved: result.document.pmi?.import?.unresolved ?? 0,
      unmapped: result.document.pmi?.import?.unmapped ?? 0,
      unverified: items.filter((item) => item.unverified !== undefined).length,
    },
  };
}

const measured: Record<string, Entry> = {};
const missing = !existsSync(NIST) || files.some((id) => !existsSync(path.join(NIST, (census[id] as Census).file)));

describeNative.skipIf(missing)('NIST PMI import census (VC-GDT-20)', () => {
  for (const id of files) {
    it(`${id}: the semantic PMI imported into doc.pmi matches the pinned census`, () => {
      const entry = importCensus(id);
      measured[id] = entry;
      if (RECORD !== undefined) {
        writeFileSync(RECORD, JSON.stringify({ ...pinned, ...measured }, null, 1));
        return;
      }
      const expected = pinned[id];
      expect(expected, `no pinned result for ${id}: run with LLULL_GDT_RECORD`).toBeDefined();
      expect(entry.reference).toEqual(expected?.reference);
      for (const key of ['tolerances', 'dimensions', 'datumFeatures'] as const) {
        expect(entry.imported[key], `${id} ${key}`).toBeGreaterThanOrEqual(expected?.imported[key] ?? 0);
        // XDE datum objects include datum targets, so the census bounds tolerances and dimensions only
        if (key !== 'datumFeatures')
          expect(entry.imported[key], `${id} ${key} cannot exceed the census`).toBeLessThanOrEqual(entry.reference[key]);
      }
      expect(entry.imported.unmapped, `${id} unmapped`).toBeLessThanOrEqual(expected?.imported.unmapped ?? 0);
    }, 900_000);
  }
});

/**
 * 03 GDT VC-GDT-22: the NIST STEP File Analyzer (SFA 5.51, `sfa-cl.exe`) on the AP242 files llull writes with `includePmi`. Runs only where
 * `sfa-cl` is installed AND its IFCsvr toolkit is registered (SFA refuses to read a STEP file without it); otherwise skips with the reason
 * logged. Override the binary with LLULL_SFA. Install record: docs/decisions/SV1-solver-toolchain-windows.md.
 * Checks: no syntax-error report, the spreadsheet (CSV) reports exist and list the semantic PMI the file carries.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { describeNative, liveKernels } from './kernelTestSupport';

const SFA = process.env['LLULL_SFA'] || path.join(os.homedir(), 'tools', 'sfa-5.51', 'sfa-cl.exe');
const PLAN = path.resolve(__dirname, '../../docs/aerospace/03-gdt-mbd-pmi/validation/draft_plan_gdt_plate.json');

/** Runs sfa-cl on `file` in CSV mode; the combined text output. */
function analyse(file: string): { status: number | null; output: string } {
  const run = spawnSync(SFA, [file, 'csv', 'noopen', 'nolog'], { encoding: 'utf8', timeout: 600_000, windowsHide: true });
  return { status: run.status, output: `${run.stdout ?? ''}${run.stderr ?? ''}` };
}

function unavailable(): string | null {
  if (!existsSync(SFA)) return `sfa-cl not found at ${SFA} (download SFA-5.nn.zip from github.com/usnistgov/SFA, set LLULL_SFA)`;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'llull-sfa-probe-'));
  try {
    const probe = path.join(dir, 'probe.stp');
    writeFileSync(
      probe,
      "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('x'),'2;1');\nFILE_NAME('p.stp','',(''),(''),'','','');\nFILE_SCHEMA(('AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF { 1 0 10303 442 1 1 4 }'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n",
    );
    return /IFCsvr toolkit must be installed/.test(analyse(probe).output)
      ? 'the IFCsvr toolkit of SFA is not installed (run the .msi SFA unpacks into %TEMP%\\SFA; it needs administrator rights)'
      : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const reason = unavailable();
if (reason !== null) console.warn(`[sfaPmi] skipped: ${reason}`);
const kernels = liveKernels();
const ctx = (): ReturnType<typeof defaultContext> => ({ ...defaultContext(), kernel: kernels.occt });

function plateStep(): string {
  const steps = (JSON.parse(readFileSync(PLAN, 'utf8')) as { command: string }[]).slice(0, 25);
  const built = execute(createEmptyDocument(), 'build_project', { actions: steps }, ctx());
  const doc: CadDocument = built.document;
  const part = Object.values(doc.pmi?.items ?? {}).flatMap((item) =>
    item.kind === 'datum_feature' ? [item.feature.entityId] : [],
  )[0] as string;
  const exported = execute(doc, 'export_step_ap242', { entityIds: [part], includePmi: true, timestamp: '2026-10-20T00:00:00' }, ctx());
  return (exported.data as { step: string }).step;
}

describeNative.skipIf(reason !== null)('SFA on the AP242 files llull writes (VC-GDT-22)', () => {
  it('reads the plate round-trip file without syntax errors and reports its semantic PMI', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'llull-sfa-'));
    try {
      const file = path.join(dir, 'plate.stp');
      writeFileSync(file, plateStep());
      const { status, output } = analyse(file);
      expect(status, output).toBe(0);
      // SFA always prints the progress line "<Reading STEP file and checking for syntax errors>"; only a reported error counts.
      const syntaxErrors = output.split(/\r?\n/).filter((line) => /syntax error/i.test(line) && !/checking for syntax errors/i.test(line));
      expect(syntaxErrors, output).toEqual([]);
      const reports = readdirSync(dir).filter((name) => name.endsWith('.csv'));
      expect(reports.length, output).toBeGreaterThan(0);
      const text = reports
        .map((name) => readFileSync(path.join(dir, name), 'utf8'))
        .join('\n')
        .toLowerCase();
      for (const entity of ['flatness_tolerance', 'perpendicularity_tolerance', 'position_tolerance', 'datum'])
        expect(text, entity).toContain(entity);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 700_000);
});

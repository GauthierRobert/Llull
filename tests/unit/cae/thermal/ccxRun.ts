/** Write a thermal deck with the pure @cae writer, run the installed CalculiX on it and parse the FRD (tests skip when `ccx` is absent). */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import { writeInp } from '@cae/decks/inpWriter';
import { analysisInputHash } from '@cae/hash/inputHash';
import { parseDat } from '@cae/results/datReader';
import { parseFrd } from '@cae/results/frdReader';
import { hashOf, type ThermalFixture } from './fixtures';

export const hasCcx = spawnSync('ccx', ['-v']).error === undefined;

export interface CcxRun {
  readonly deck: string;
  readonly results: FeResultsArtifact;
}

export function solveWithCcx(fixture: ThermalFixture, mesh: FeMeshArtifact): CcxRun {
  const written = writeInp(fixture.doc, fixture.analysisId, mesh);
  if (!('text' in written)) throw new Error(`${written.code}: ${written.message}`);
  const dir = mkdtempSync(join(tmpdir(), 'llull-thermal-'));
  try {
    writeFileSync(join(dir, 'job.inp'), written.text);
    const ran = spawnSync('ccx', ['-i', 'job'], { cwd: dir, encoding: 'utf8' });
    if (ran.status !== 0) throw new Error(`ccx failed: ${ran.stdout}\n${ran.stderr}`);
    const results: FeResultsArtifact = {
      kind: 'fe_results',
      meshHash: hashOf(mesh),
      inputHash: analysisInputHash(fixture.doc, fixture.analysisId, 'full'),
      solver: 'CalculiX',
      solverVersion: '2.21',
      steps: parseFrd(readFileSync(join(dir, 'job.frd'), 'utf8')),
      dat: parseDat(readFileSync(join(dir, 'job.dat'), 'utf8')),
    };
    return { deck: written.text, results };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

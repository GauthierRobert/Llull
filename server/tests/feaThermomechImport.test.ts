/**
 * fea_import_field (PHY-04 TR-TMC-14) through the `llull` CLI and the @protocol tool layer: CSV `x,y,z,T` with declared units -> `fe_table` artifact in the
 * content-addressed store -> set_temperature_field kind table. Needs neither llull-mesh nor CalculiX (the nearest-node match at deck time is
 * covered by the unit tests and by feaThermomechT1.test.ts).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { applyExchangeToolCall } from '@protocol/index';
import { sha256Hex } from '@lib/sha256';
import { canonicalJson } from '@lib/canonicalJson';
import { createFeaToolsPort } from '../src/fea/transports';
import { dataOf, planPath, Workspace } from './feaThermomechSupport';

let workspace: Workspace;

beforeAll(async () => {
  workspace = new Workspace();
  setGeometryKernel(await createManifoldKernel());
});

afterAll(() => {
  setGeometryKernel(null);
  workspace.dispose();
});

const CSV = 'x,y,z,T\n0,0,0,20\n100,0,0,120\n# comment\n50,5,5,70\n';

describe('fea_import_field', () => {
  it('stores the table under its sha256 and sets the table field of the analysis (CLI file=)', async () => {
    const session = workspace.open('import-cli');
    const analysisId = await session.idOf(planPath('tmc_restrained_bar'), 'an');
    const csv = path.join(workspace.dir, 'field.csv');
    writeFileSync(csv, CSV);
    const result = await session.cli(
      'fea_import_field',
      `analysisId=${analysisId}`,
      `file=${csv}`,
      'coordinatesUnit=mm',
      'temperatureUnit=degC',
    );
    expect(result.code, String(result.json['summary'])).toBe(0);
    const data = dataOf(result.json);
    expect(data).toMatchObject({ rows: 3, minT: 20, maxT: 120, coordinatesUnit: 'mm', temperatureUnit: 'degC' });
    const hash = String(data['csvSha256']);
    const stored = path.join(workspace.dir, 'cache', `${hash}.json.gz`);
    expect(existsSync(stored)).toBe(true);
    const artifact: unknown = JSON.parse(gunzipSync(readFileSync(stored)).toString('utf8'));
    expect(artifact).toEqual({
      kind: 'fe_table',
      rows: [
        [0, 0, 0, 20],
        [100, 0, 0, 120],
        [50, 5, 5, 70],
      ],
    });
    expect(sha256Hex(canonicalJson(artifact))).toBe(hash);
    const described = await session.cli('describe_analysis', `analysisId=${analysisId}`);
    const field = (dataOf(described.json)['case'] as { thermomech: { field: unknown } }).thermomech.field;
    expect(field).toEqual({ kind: 'table', csvSha256: hash, rows: 3, coordinatesUnit: 'mm', temperatureUnit: 'degC' });
    // importing the same table again is idempotent (same hash)
    const again = await session.cli(
      'fea_import_field',
      `analysisId=${analysisId}`,
      `file=${csv}`,
      'coordinatesUnit=mm',
      'temperatureUnit=degC',
    );
    expect(dataOf(again.json)['csvSha256']).toBe(hash);
  });

  it('refuses a missing unit, bad CSV, bad units, a non-thermo_static case and an unknown analysis, leaving the document alone', async () => {
    const session = workspace.open('import-bad');
    const analysisId = await session.idOf(planPath('tmc_restrained_bar'), 'an');
    const bad = path.join(workspace.dir, 'bad.csv');
    writeFileSync(bad, '1,2,3\n');
    const run = (...argv: string[]): ReturnType<typeof session.cli> => session.cli('fea_import_field', ...argv);
    const missingUnit = await run(`analysisId=${analysisId}`, `file=${bad}`, 'coordinatesUnit=mm');
    expect(missingUnit.code).not.toBe(0);
    expect(String(missingUnit.json['summary'])).toContain('temperatureUnit');
    const malformed = await run(`analysisId=${analysisId}`, `file=${bad}`, 'coordinatesUnit=mm', 'temperatureUnit=K');
    expect(malformed.code).not.toBe(0);
    expect(String(malformed.json['summary'])).toContain('TMC_FIELD_INVALID');
    writeFileSync(bad, '1,2,3,4\n');
    const unit = await run(`analysisId=${analysisId}`, `file=${bad}`, 'coordinatesUnit=parsec', 'temperatureUnit=K');
    expect(String(unit.json['summary'])).toContain('TMC_FIELD_SOURCE_INVALID');
    const unknown = await run('analysisId=an-99', `file=${bad}`, 'coordinatesUnit=mm', 'temperatureUnit=K');
    expect(String(unknown.json['summary'])).toContain('FEA_ANALYSIS_NOT_FOUND');
    const heat = await session.cli('create_analysis', 'name=H', 'analysisType=heat_steady');
    const wrongType = await run(
      `analysisId=${heat.json['affected'] as unknown as string}`,
      `file=${bad}`,
      'coordinatesUnit=mm',
      'temperatureUnit=K',
    );
    expect(String(wrongType.json['summary'])).toContain('THM_CASE_TYPE');
    const described = await session.cli('describe_analysis', `analysisId=${analysisId}`);
    const field = (dataOf(described.json)['case'] as { thermomech: { field: { kind: string } } }).thermomech.field;
    expect(field.kind).toBe('uniform');
  });

  it('works at the @protocol tool layer with inline csv and refuses path without an exchange directory', async () => {
    const session = workspace.open('import-mcp');
    const analysisId = await session.idOf(planPath('tmc_restrained_bar'), 'an');
    const applied: { name: string; params: unknown }[] = [];
    const deps = {
      port: null,
      allowCodeExecution: false,
      getDoc: () => {
        throw new Error('the analysis lookup needs the document');
      },
      applyCommand: (name: string, params: unknown) => {
        applied.push({ name, params });
        return { summary: 'ok', affected: [analysisId], isError: false };
      },
      fea: createFeaToolsPort({}),
    };
    const noDoc = await applyExchangeToolCall(
      'fea_import_field',
      { analysisId, csv: CSV, coordinatesUnit: 'mm', temperatureUnit: 'degC' },
      deps,
    );
    expect(noDoc?.isError).toBe(true);
    expect(noDoc?.content[0]?.text).toContain('fea_import_field failed');
    const noSource = await applyExchangeToolCall('fea_import_field', { analysisId, coordinatesUnit: 'mm', temperatureUnit: 'degC' }, deps);
    expect(noSource?.content[0]?.text).toContain('provide csv');
    const path1 = await applyExchangeToolCall(
      'fea_import_field',
      { analysisId, path: 'a.csv', coordinatesUnit: 'mm', temperatureUnit: 'degC' },
      deps,
    );
    expect(path1?.content[0]?.text).toContain('exchange directory');
    expect(applied).toEqual([]);
  });
});

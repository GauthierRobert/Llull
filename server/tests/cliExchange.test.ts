/**
 * Exchange tools over REST and the CLI: `unshapeExchangeResult`, `POST /exchange`, and the CLI (local
 * in-process + `file=`), with a fake Python port. A real CadQuery round trip (export_step →
 * import_step) runs when LLULL_TEST_PYTHON names an interpreter with CadQuery.
 */

import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CadExchangePort } from '@protocol/index';
import { shapeToolCallContent } from '@protocol/index';
import { deserializeDocument } from '@core/commands/persistence/serialization';
import { unshapeExchangeResult } from '../src/exchangeResult';
import { buildExchangeRouter } from '../src/exchangeRoutes';
import { exchangeOptionsWithDwg } from '../src/dwgConvert';
import type { ExchangeOptions } from '../src/pythonExchange';
import { EXIT_COMMAND_ERROR, EXIT_OK, EXIT_USAGE, runCli, type CliIo } from '../src/cli/main';
import { withFileContent } from '../src/cli/exchange';
import { getLiveDoc } from '../src/liveDocument';

const triangle = { positions: [0, 0, 0, 10, 0, 0, 0, 10, 0], name: 'plate', color: '#336699' };
const fakePort: CadExchangePort = {
  runProgram: () => Promise.resolve({ trace: null, traced: false, stepBase64: Buffer.from('ISO-10303-21;').toString('base64'), log: '' }),
  importStep: (stepBase64) =>
    Buffer.from(stepBase64, 'base64').toString().startsWith('ISO-10303')
      ? Promise.resolve({ bodies: [triangle] })
      : Promise.reject(new Error('not a STEP file')),
};
const fakeOptions: ExchangeOptions = { port: fakePort, dwg: null, allowCodeExecution: false };

function capture(exchangeOptions: () => ExchangeOptions = () => fakeOptions): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      readStdin: () => Promise.resolve(''),
      env: {},
      prepareKernel: () => Promise.resolve(),
      exchangeOptions,
    },
  };
}

const work = (): string => mkdtempSync(path.join(tmpdir(), 'llull-exchange-'));

describe('unshapeExchangeResult', () => {
  it('recovers summary, affected ids and data from a shaped tool result', () => {
    const shaped = shapeToolCallContent({ summary: 'done', affected: ['a', 'b'], isError: false, data: { n: 1 } });
    expect(unshapeExchangeResult(shaped)).toEqual({ summary: 'done', affected: ['a', 'b'], isError: false, data: { n: 1 } });
  });

  it('reads affected ids from the text when there is no data, and unwraps non-record data', () => {
    expect(unshapeExchangeResult(shapeToolCallContent({ summary: 's', affected: ['x'], isError: false }))).toEqual({
      summary: 's',
      affected: ['x'],
      isError: false,
    });
    expect(unshapeExchangeResult(shapeToolCallContent({ summary: 's', affected: [], isError: true, data: [1] }))).toEqual({
      summary: 's',
      affected: [],
      isError: true,
      data: [1],
    });
  });
});

describe('POST /exchange', () => {
  const app = express();
  app.use(express.json());
  app.use(buildExchangeRouter((_req, _res, next) => next(), fakeOptions));

  it('runs import_step through the command bus and reports the change', async () => {
    const response = await request(app)
      .post('/exchange')
      .send({ name: 'import_step', params: { stepBase64: Buffer.from('ISO-10303-21;').toString('base64') } });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ isError: false, changed: true });
    const ids = (response.body as { affected: string[] }).affected;
    expect(ids).toHaveLength(1);
    expect(getLiveDoc().entities[ids[0] ?? '']?.name).toBe('plate');
  });

  it('answers 400 without a name, 404 for a non-exchange tool, isError for a failing port', async () => {
    expect((await request(app).post('/exchange').send({})).status).toBe(400);
    expect((await request(app).post('/exchange').send({ name: 'add_box' })).status).toBe(404);
    const bad = await request(app)
      .post('/exchange')
      .send({ name: 'import_step', params: { stepBase64: Buffer.from('nope').toString('base64') } });
    expect(bad.body).toMatchObject({ isError: true, changed: false });
    expect((bad.body as { summary: string }).summary).toMatch(/not a STEP file/);
  });
});

describe('llull CLI — exchange tools', () => {
  it('imports a STEP file into a local document with file=', async () => {
    const dir = work();
    const doc = path.join(dir, 'a.llull');
    const step = path.join(dir, 'part.step');
    writeFileSync(step, 'ISO-10303-21;');
    const c = capture();
    expect(await runCli(['import_step', `file=${step}`, '--doc', doc], c.io)).toBe(EXIT_OK);
    expect(c.out[0]).toMatch(/Imported 1 mesh bod/);
    const saved = deserializeDocument(readFileSync(doc, 'utf8'));
    expect(Object.values(saved.entities).map((entity) => entity.name)).toEqual(['plate']);
  });

  it('saves export_step output with --save and lists/describes the exchange tools', async () => {
    const dir = work();
    const doc = path.join(dir, 'a.llull');
    await runCli(['add_box', 'size=[1,1,1]', '--doc', doc], capture().io);
    const c = capture();
    expect(await runCli(['export_step', '--save', path.join(dir, 'p.step'), '--doc', doc], c.io)).toBe(EXIT_OK);
    expect(readFileSync(path.join(dir, 'p.step'), 'utf8')).toBe('ISO-10303-21;');

    const list = capture();
    await runCli(['list', 'exchange'], list.io);
    expect(list.out[0]).toMatch(/^import_step \[exchange\]/m);
    const described = capture();
    await runCli(['describe', 'import_dwg'], described.io);
    expect(described.out[0]).toMatch(/- dwgBase64 \(string\)/);
  });

  it('reports a missing Python bridge, a bad file= and file= on a tool without content', async () => {
    const noPython = capture(() => ({ port: null, dwg: null, allowCodeExecution: false }));
    expect(await runCli(['export_step', '--doc', path.join(work(), 'x.llull')], noPython.io)).toBe(EXIT_COMMAND_ERROR);
    expect(noPython.out[0]).toMatch(/Python/);

    const missing = capture();
    expect(await runCli(['import_step', 'file=/nope/x.step', '--doc', path.join(work(), 'x.llull')], missing.io)).toBe(EXIT_USAGE);
    expect(() => withFileContent('export_step', { file: 'x' })).toThrow(/takes no file=/);
    expect(withFileContent('import_code', { mode: 'append' })).toEqual({ mode: 'append' });
  });

  it('builds the default exchange options from the environment', () => {
    expect(exchangeOptionsWithDwg({ LLULL_PYTHON: 'off' }).port).toBeNull();
  });
});

const realPython = process.env['LLULL_TEST_PYTHON'];

describe.skipIf(realPython === undefined)('llull CLI — real CadQuery STEP round trip', () => {
  it('exports STEP with CadQuery and imports it back', async () => {
    const dir = work();
    const real = (): ExchangeOptions => exchangeOptionsWithDwg({ LLULL_PYTHON: realPython });
    const a = path.join(dir, 'a.llull');
    await runCli(['add_box', 'size=[40,30,10]', '--doc', a], capture(real).io);
    const exported = capture(real);
    expect(await runCli(['export_step', '--save', path.join(dir, 'part.step'), '--doc', a], exported.io)).toBe(EXIT_OK);
    expect(readFileSync(path.join(dir, 'part.step'), 'utf8')).toMatch(/^ISO-10303-21;/);
    const imported = capture(real);
    expect(await runCli(['import_step', `file=${path.join(dir, 'part.step')}`, '--doc', path.join(dir, 'b.llull')], imported.io)).toBe(
      EXIT_OK,
    );
    expect(imported.out[0]).toMatch(/Imported 1 mesh bod/);
  }, 120_000);
});

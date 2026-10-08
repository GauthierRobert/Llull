import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import {
  applyExchangeToolCall,
  buildExchangeToolDefinitions,
  type CadExchangePort,
  type ExchangeCommandResult,
  type ExchangeDeps,
  type ProgramRun,
} from '@mcp/exchangeTools';
import { shapeToolCallContent } from '@mcp/dispatch';

interface Harness {
  deps: ExchangeDeps;
  port: CadExchangePort & {
    runCalls: Array<{ language: string; source: string; step: boolean }>;
    stepCalls: string[];
    readCalls: Array<{ path: string; encoding: string }>;
    written: Array<{ fileName: string; base64: string }>;
  };
  state: { doc: CadDocument };
  applied: Array<{ name: string; params: unknown }>;
}

interface HarnessOptions {
  withFiles?: boolean;
  withRead?: boolean;
  allowCodeExecution?: boolean;
  run?: ProgramRun | Error;
  bodies?: unknown[] | Error;
  doc?: CadDocument;
}

const TRIANGLE_BODY = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], name: 'Tri' };

function makeHarness(options: HarnessOptions = {}): Harness {
  const state = { doc: options.doc ?? createEmptyDocument() };
  const applied: Array<{ name: string; params: unknown }> = [];
  const runCalls: Harness['port']['runCalls'] = [];
  const stepCalls: string[] = [];
  const readCalls: Harness['port']['readCalls'] = [];
  const written: Harness['port']['written'] = [];
  const run = options.run ?? { trace: { parameters: [], features: [] }, traced: true, log: '' };
  const port: Harness['port'] = {
    runCalls,
    stepCalls,
    readCalls,
    written,
    runProgram: (request) => {
      runCalls.push(request);
      if (run instanceof Error) return Promise.reject(run);
      return Promise.resolve(run);
    },
    importStep: (stepBase64) => {
      stepCalls.push(stepBase64);
      const bodies = options.bodies ?? [TRIANGLE_BODY];
      if (bodies instanceof Error) return Promise.reject(bodies);
      return Promise.resolve({ bodies });
    },
    ...(options.withRead === false
      ? {}
      : {
          readExchangeFile: (path: string, encoding: 'base64' | 'utf8') => {
            readCalls.push({ path, encoding });
            return Promise.resolve(encoding === 'base64' ? 'U1RFUA==' : 'x = 1\n');
          },
        }),
    ...(options.withFiles === false
      ? {}
      : {
          writeExchangeFile: (fileName: string, base64: string) => {
            written.push({ fileName, base64 });
            return Promise.resolve(`/exchange/${fileName}`);
          },
        }),
  };
  const deps: ExchangeDeps = {
    port,
    getDoc: () => state.doc,
    applyCommand: (name, params): ExchangeCommandResult => {
      applied.push({ name, params });
      const result = execute(state.doc, name, params);
      const isError = result.document === state.doc && result.affected.length === 0;
      state.doc = result.document;
      return { summary: result.summary, affected: result.affected, isError };
    },
    allowCodeExecution: options.allowCodeExecution ?? true,
  };
  return { deps, port, state, applied };
}

function docWithBox(): CadDocument {
  return execute(createEmptyDocument(), 'add_box', { size: [1, 2, 3] }).document;
}

const STEP_RUN: ProgramRun = { trace: {}, traced: true, stepBase64: 'U1RFUFNURVA=', log: '' };

function textOf(result: { content: Array<{ text: string }> } | null): string {
  return result === null ? '' : result.content.map((c) => c.text).join('\n');
}

describe('buildExchangeToolDefinitions', () => {
  it('defines export_step, import_step and import_code with annotations', () => {
    const tools = buildExchangeToolDefinitions();
    expect(tools.map((t) => t.name)).toEqual(['export_step', 'import_step', 'import_code']);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.export_step?.annotations).toEqual({ idempotentHint: true });
    expect(byName.import_step?.annotations).toBeUndefined();
    expect(byName.import_code?.annotations).toEqual({ destructiveHint: true });
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema.type).toBe('object');
    }
    expect(byName.import_code?.inputSchema.properties).toHaveProperty('mode');
  });
});

describe('applyExchangeToolCall routing', () => {
  it('returns null for a tool that is not an exchange tool', async () => {
    const h = makeHarness();
    expect(await applyExchangeToolCall('add_box', {}, h.deps)).toBeNull();
    expect(await applyExchangeToolCall('', {}, h.deps)).toBeNull();
  });

  it('returns null for a non-exchange tool even without a port', async () => {
    const h = makeHarness();
    expect(await applyExchangeToolCall('add_box', {}, { ...h.deps, port: null })).toBeNull();
  });

  it.each(['export_step', 'import_step', 'import_code'])(
    '%s reports how to enable the Python bridge when the port is null',
    async (tool) => {
      const h = makeHarness();
      const result = await applyExchangeToolCall(tool, {}, { ...h.deps, port: null });
      expect(result?.isError).toBe(true);
      expect(textOf(result)).toContain('LLULL_PYTHON');
      expect(textOf(result)).toContain(tool);
    },
  );
});

describe('export_step', () => {
  it('runs export_code text through the port and returns the STEP bytes only in structuredContent', async () => {
    const h = makeHarness({ doc: docWithBox(), run: STEP_RUN });
    const result = await applyExchangeToolCall('export_step', { name: 'my part' }, h.deps);
    expect(result?.isError).toBe(false);
    expect(h.port.runCalls).toHaveLength(1);
    expect(h.port.runCalls[0]).toMatchObject({ language: 'cadquery', step: true });
    expect(h.port.runCalls[0]!.source).toContain('box((1, 2, 3)');
    const text = textOf(result);
    expect(text).toContain('export_step: 1 solid(s) from history → my_part.step');
    expect(text).toContain('saved to /exchange/my_part.step');
    expect(text).not.toContain(STEP_RUN.stepBase64!);
    expect(result?.structuredContent).toMatchObject({
      format: 'step',
      fileName: 'my_part.step',
      language: 'cadquery',
      savedTo: '/exchange/my_part.step',
      stepBase64: STEP_RUN.stepBase64,
    });
    expect(h.port.written).toEqual([{ fileName: 'my_part.step', base64: STEP_RUN.stepBase64 }]);
    // Export never changes the document.
    expect(h.applied).toEqual([]);
  });

  it('uses build123d when asked and defaults the file name', async () => {
    const h = makeHarness({ doc: docWithBox(), run: STEP_RUN });
    await applyExchangeToolCall('export_step', { language: 'build123d' }, h.deps);
    expect(h.port.runCalls[0]).toMatchObject({ language: 'build123d' });
    expect(h.port.written[0]?.fileName).toBe('model.step');
  });

  it('does not write a file when save is false and says the data is returned', async () => {
    const h = makeHarness({ doc: docWithBox(), run: STEP_RUN });
    const result = await applyExchangeToolCall('export_step', { save: false }, h.deps);
    expect(h.port.written).toEqual([]);
    expect(textOf(result)).toContain('returned as data.stepBase64');
    expect(result?.structuredContent).not.toHaveProperty('savedTo');
    expect(result?.structuredContent).toHaveProperty('stepBase64');
  });

  it('returns the data without saving when the port cannot write files', async () => {
    const h = makeHarness({ doc: docWithBox(), run: STEP_RUN, withFiles: false });
    const result = await applyExchangeToolCall('export_step', {}, h.deps);
    expect(result?.isError).toBe(false);
    expect(textOf(result)).toContain('returned as data.stepBase64');
  });

  it('fails when the model has no 3D solids', async () => {
    const h = makeHarness({ run: STEP_RUN });
    const result = await applyExchangeToolCall('export_step', {}, h.deps);
    expect(result?.isError).toBe(true);
    expect(textOf(result)).toContain('no 3D solids');
    expect(h.port.runCalls).toEqual([]);
  });

  it('rejects an unsupported language', async () => {
    const h = makeHarness({ doc: docWithBox(), run: STEP_RUN });
    const result = await applyExchangeToolCall('export_step', { language: 'openscad' }, h.deps);
    expect(result?.isError).toBe(true);
    expect(textOf(result)).toContain('language must be "cadquery" or "build123d"');
    expect(h.port.runCalls).toEqual([]);
  });

  it('fails when the bridge returns no STEP data', async () => {
    const h = makeHarness({
      doc: docWithBox(),
      run: { trace: {}, traced: true, log: '' },
    });
    const result = await applyExchangeToolCall('export_step', {}, h.deps);
    expect(result?.isError).toBe(true);
    expect(textOf(result)).toContain('returned no STEP data');
  });

  it('turns a port exception into an isError result', async () => {
    const h = makeHarness({ doc: docWithBox(), run: new Error('cadquery exploded') });
    const result = await applyExchangeToolCall('export_step', {}, h.deps);
    expect(result?.isError).toBe(true);
    expect(textOf(result)).toContain('export_step failed: cadquery exploded');
  });

  it('treats non-object arguments as empty', async () => {
    const h = makeHarness({ doc: docWithBox(), run: STEP_RUN });
    expect((await applyExchangeToolCall('export_step', null, h.deps))?.isError).toBe(false);
    expect((await applyExchangeToolCall('export_step', 'x', h.deps))?.isError).toBe(false);
  });
});

describe('import_step', () => {
  it('imports inline base64 via import_mesh', async () => {
    const h = makeHarness();
    const result = await applyExchangeToolCall('import_step', { stepBase64: 'QUJD' }, h.deps);
    expect(result?.isError).toBe(false);
    expect(h.port.stepCalls).toEqual(['QUJD']);
    expect(h.applied).toHaveLength(1);
    expect(h.applied[0]?.name).toBe('import_mesh');
    expect(h.applied[0]?.params).toEqual({ bodies: [TRIANGLE_BODY] });
    expect(textOf(result)).toContain('import_step: Imported 1 mesh body');
    expect(result?.content.some((c) => c.text.startsWith('Affected entity ids:'))).toBe(true);
    expect(h.state.doc.order).toHaveLength(1);
  });

  it('reads the file through readExchangeFile when given a path', async () => {
    const h = makeHarness();
    const result = await applyExchangeToolCall('import_step', { path: 'parts/a.step' }, h.deps);
    expect(result?.isError).toBe(false);
    expect(h.port.readCalls).toEqual([{ path: 'parts/a.step', encoding: 'base64' }]);
    expect(h.port.stepCalls).toEqual(['U1RFUA==']);
  });

  it('prefers inline data over a path', async () => {
    const h = makeHarness();
    await applyExchangeToolCall('import_step', { stepBase64: 'QUJD', path: 'x.step' }, h.deps);
    expect(h.port.readCalls).toEqual([]);
    expect(h.port.stepCalls).toEqual(['QUJD']);
  });

  it('errors when neither stepBase64 nor path is given', async () => {
    const h = makeHarness();
    const result = await applyExchangeToolCall('import_step', {}, h.deps);
    expect(result?.isError).toBe(true);
    expect(textOf(result)).toContain('import_step failed: provide stepBase64 or path');
    expect(h.applied).toEqual([]);
  });

  it('errors when a path is given but the port has no readExchangeFile', async () => {
    const h = makeHarness({ withRead: false });
    const result = await applyExchangeToolCall('import_step', { path: 'a.step' }, h.deps);
    expect(result?.isError).toBe(true);
    expect(textOf(result)).toContain('LLULL_EXCHANGE_DIR');
  });

  it('reports an error when import_mesh rejects the bodies', async () => {
    const h = makeHarness({ bodies: [] });
    const result = await applyExchangeToolCall('import_step', { stepBase64: 'QUJD' }, h.deps);
    expect(result?.isError).toBe(true);
    expect(textOf(result)).toContain('import_step: import_mesh: bodies must be a non-empty array');
    expect(h.state.doc.order).toEqual([]);
  });

  it('turns a port exception into an isError result', async () => {
    const h = makeHarness({ bodies: new Error('not a STEP file') });
    const result = await applyExchangeToolCall('import_step', { stepBase64: 'QUJD' }, h.deps);
    expect(result?.isError).toBe(true);
    expect(textOf(result)).toContain('import_step failed: not a STEP file');
  });
});

describe('import_code', () => {
  const traced: ProgramRun = {
    traced: true,
    log: '',
    trace: {
      parameters: [{ name: 'w', expression: '5' }],
      features: [
        { command: 'add_sphere', ref: 'f1', params: { radius: { value: 2, expression: 'w' } } },
      ],
    },
  };

  it('refuses to run Python unless the host opted in', async () => {
    const h = makeHarness({ allowCodeExecution: false, run: traced });
    const result = await applyExchangeToolCall('import_code', { code: 'x = 1' }, h.deps);
    expect(result?.isError).toBe(true);
    expect(textOf(result)).toContain('LLULL_ALLOW_CODE_EXECUTION');
    expect(h.port.runCalls).toEqual([]);
    expect(h.applied).toEqual([]);
  });

  it('runs a traced script and rebuilds the model through apply_code_trace (replace by default)', async () => {
    const h = makeHarness({ run: traced });
    const result = await applyExchangeToolCall('import_code', { code: 'print(1)' }, h.deps);
    expect(result?.isError).toBe(false);
    expect(h.port.runCalls).toEqual([{ language: 'cadquery', source: 'print(1)', step: false }]);
    expect(h.applied[0]?.name).toBe('apply_code_trace');
    expect(h.applied[0]?.params).toEqual({ trace: traced.trace, mode: 'replace' });
    const text = textOf(result);
    expect(text).toContain(
      'import_code (cadquery, parametric (feature history + parameters rebuilt))',
    );
    expect(text).toContain('apply_code_trace (replace)');
    expect(h.state.doc.parameters.w?.value).toBe(5);
    expect(h.state.doc.order).toHaveLength(1);
  });

  it('describes a non-llull script as a mesh fallback and passes mode and language', async () => {
    const h = makeHarness({
      run: {
        traced: false,
        log: 'hello from script\n',
        trace: {
          parameters: [],
          features: [{ command: 'import_mesh', ref: 'f1', params: { bodies: [TRIANGLE_BODY] } }],
        },
      },
      doc: docWithBox(),
    });
    const result = await applyExchangeToolCall(
      'import_code',
      { code: 'x', language: 'build123d', mode: 'append' },
      h.deps,
    );
    expect(result?.isError).toBe(false);
    expect(h.port.runCalls[0]?.language).toBe('build123d');
    expect(h.applied[0]?.params).toMatchObject({ mode: 'append' });
    const text = textOf(result);
    expect(text).toContain('non-llull script: result shapes imported as meshes');
    expect(text).toContain('Script output: hello from script');
    expect(h.state.doc.order).toHaveLength(2);
  });

  it('rejects an unknown mode instead of silently replacing the model', async () => {
    const h = makeHarness({ run: traced });
    const result = await applyExchangeToolCall('import_code', { code: 'x', mode: 'merge' }, h.deps);
    expect(result?.isError).toBe(true);
    expect(textOf(result)).toContain('mode must be "replace" or "append" (got "merge")');
    expect(h.port.runCalls).toHaveLength(0);
    expect(h.applied).toHaveLength(0);
  });

  it('defaults to replace when mode is omitted', async () => {
    const h = makeHarness({ run: traced });
    await applyExchangeToolCall('import_code', { code: 'x' }, h.deps);
    expect(h.applied[0]?.params).toMatchObject({ mode: 'replace' });
  });

  it('reads the script from the exchange directory by path', async () => {
    const h = makeHarness({ run: traced });
    await applyExchangeToolCall('import_code', { path: 'scripts/model.py' }, h.deps);
    expect(h.port.readCalls).toEqual([{ path: 'scripts/model.py', encoding: 'utf8' }]);
    expect(h.port.runCalls[0]?.source).toBe('x = 1\n');
  });

  it('errors when neither code nor path is provided', async () => {
    const h = makeHarness({ run: traced });
    const result = await applyExchangeToolCall('import_code', {}, h.deps);
    expect(result?.isError).toBe(true);
    expect(textOf(result)).toContain('import_code failed: provide code or path');
  });

  it('rejects an unsupported language before running anything', async () => {
    const h = makeHarness({ run: traced });
    const result = await applyExchangeToolCall(
      'import_code',
      { code: 'x', language: 'openscad' },
      h.deps,
    );
    expect(result?.isError).toBe(true);
    expect(textOf(result)).toContain('language must be "cadquery" or "build123d"');
    expect(h.port.runCalls).toEqual([]);
  });

  it('is an error when the trace produces no solids, and the document is unchanged', async () => {
    const h = makeHarness({
      run: {
        traced: true,
        log: '',
        trace: { parameters: [], features: [{ command: 'clear_document', params: {} }] },
      },
    });
    const result = await applyExchangeToolCall('import_code', { code: 'x' }, h.deps);
    expect(result?.isError).toBe(true);
    expect(textOf(result)).toContain('not allowed in a code trace');
    expect(h.state.doc.order).toEqual([]);
  });

  it('turns a port exception into an isError result', async () => {
    const h = makeHarness({ run: new Error('SyntaxError: bad') });
    const result = await applyExchangeToolCall('import_code', { code: 'x' }, h.deps);
    expect(result?.isError).toBe(true);
    expect(textOf(result)).toContain('import_code failed: SyntaxError: bad');
  });

  it('stringifies non-Error exceptions', async () => {
    const h = makeHarness();
    h.port.runProgram = () => Promise.reject('plain string failure');
    const result = await applyExchangeToolCall('import_code', { code: 'x' }, h.deps);
    expect(textOf(result)).toContain('import_code failed: plain string failure');
  });
});

describe('shapeToolCallContent code blocks', () => {
  it('puts a format:"code" text in its own verbatim block, not inside the JSON block', () => {
    const source = 'x = 1\nprint("hi")\n';
    const shaped = shapeToolCallContent({
      summary: 'export_code ok',
      affected: [],
      isError: false,
      data: { format: 'code', language: 'cadquery', text: source },
    });
    expect(shaped.content).toHaveLength(3);
    expect(shaped.content[0]?.text).toBe('export_code ok');
    const json = shaped.content[1]!.text;
    expect(json.startsWith('```json')).toBe(true);
    expect(json).not.toContain('print');
    expect(json).toContain('(source code in the next block)');
    expect(json).toContain('"language": "cadquery"');
    expect(shaped.content[2]?.text).toBe(source);
    expect(shaped.structuredContent).toMatchObject({ text: source });
    expect(shaped.isError).toBe(false);
  });

  it('keeps ordinary data records and non-code formats in the JSON block only', () => {
    const plain = shapeToolCallContent({
      summary: 's',
      affected: ['a'],
      isError: false,
      data: { format: 'step', text: 'not code' },
    });
    expect(plain.content.map((c) => c.text)).toHaveLength(3);
    expect(plain.content[2]?.text).toContain('"text": "not code"');
    const noText = shapeToolCallContent({
      summary: 's',
      affected: [],
      isError: false,
      data: { format: 'code', text: 5 },
    });
    expect(noText.content).toHaveLength(2);
    const array = shapeToolCallContent({
      summary: 's',
      affected: [],
      isError: false,
      data: [1, 2],
    });
    expect(array.content).toHaveLength(2);
    expect(array.structuredContent).toBeUndefined();
    const nullData = shapeToolCallContent({
      summary: 's',
      affected: [],
      isError: false,
      data: null,
    });
    expect(nullData.content).toHaveLength(2);
  });

  it('applies to the real export_code result through applyToolCall', async () => {
    const { applyToolCall } = await import('../helpers/applyToolCall');
    const doc = docWithBox();
    const result = applyToolCall(doc, 'export_code', { language: 'openscad' });
    expect(result.isError).toBe(false);
    const last = result.content.at(-1)!.text;
    expect(last).toContain('cube([1, 2, 3], center = true)');
    expect(
      result.content.some((c) => c.text.startsWith('```json') && !c.text.includes('cube(')),
    ).toBe(true);
    expect(result.document).toBe(doc);
  });
});

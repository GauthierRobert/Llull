import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import {
  applyExchangeToolCall,
  buildExchangeToolDefinitions,
  type DwgConverterPort,
  type ExchangeCommandResult,
  type ExchangeDeps,
} from '@mcp/exchangeTools';
import { buildAllMcpTools } from '@mcp/discovery';
import { toolsetOf } from '@mcp/toolsets';

const applied: Array<{ name: string; params: unknown }> = [];

function deps(dwg: DwgConverterPort | null | undefined): ExchangeDeps {
  applied.length = 0;
  return {
    port: null,
    ...(dwg !== undefined ? { dwg } : {}),
    getDoc: () => createEmptyDocument(),
    applyCommand: (name, params): ExchangeCommandResult => {
      applied.push({ name, params });
      return { summary: 'imported 3 entities', affected: ['a', 'b'], isError: false };
    },
    allowCodeExecution: false,
  };
}

const converter: DwgConverterPort = {
  convertDwg: (base64) => Promise.resolve(`DXF(${base64})`),
  readExchangeFile: () => Promise.resolve('RklMRQ=='),
};

const textOf = (r: { content: Array<{ text: string }> } | null): string =>
  r === null ? '' : r.content.map((c) => c.text).join('\n');

describe('import_dwg tool', () => {
  it('is registered in the exchange toolset and the served tool list', () => {
    expect(buildExchangeToolDefinitions().map((t) => t.name)).toContain('import_dwg');
    expect(buildAllMcpTools().map((t) => t.name)).toContain('import_dwg');
    expect(toolsetOf('import_dwg')).toBe('exchange');
  });

  it('converts then runs import_dxf by default, forwarding only drawing params', async () => {
    const result = await applyExchangeToolCall(
      'import_dwg',
      { dwgBase64: 'QUJD', sourceUnit: 'mm', layers: ['A'], name: 'ignored' },
      deps(converter),
    );
    expect(result?.isError).toBeFalsy();
    expect(applied).toEqual([
      { name: 'import_dxf', params: { text: 'DXF(QUJD)', sourceUnit: 'mm', layers: ['A'] } },
    ]);
  });

  it('runs import_survey_dxf for target survey and reads path files', async () => {
    const result = await applyExchangeToolCall(
      'import_dwg',
      { path: 'a.dwg', target: 'survey', name: 'Topo', keepZeroElevation: true },
      deps(converter),
    );
    expect(result?.isError).toBeFalsy();
    expect(applied[0]).toEqual({
      name: 'import_survey_dxf',
      params: { text: 'DXF(RklMRQ==)', name: 'Topo', keepZeroElevation: true },
    });
  });

  it('explains how to enable the converter when none is configured', async () => {
    for (const none of [null, undefined]) {
      const result = await applyExchangeToolCall('import_dwg', { dwgBase64: 'QUJD' }, deps(none));
      expect(result?.isError).toBe(true);
      expect(textOf(result)).toMatch(/libredwg-tools/);
    }
    expect(applied).toEqual([]);
  });

  it('rejects bad input and surfaces converter failures without changing the document', async () => {
    const bad = await applyExchangeToolCall('import_dwg', { target: 'x' }, deps(converter));
    expect(bad?.isError).toBe(true);
    const missing = await applyExchangeToolCall('import_dwg', {}, deps(converter));
    expect(textOf(missing)).toMatch(/dwgBase64 or path/);
    const noDir = await applyExchangeToolCall(
      'import_dwg',
      { path: 'a.dwg' },
      deps({ convertDwg: converter.convertDwg }),
    );
    expect(textOf(noDir)).toMatch(/LLULL_EXCHANGE_DIR/);
    const failing = await applyExchangeToolCall(
      'import_dwg',
      { dwgBase64: 'QUJD' },
      deps({ convertDwg: () => Promise.reject(new Error('Not a DWG file')) }),
    );
    expect(failing?.isError).toBe(true);
    expect(textOf(failing)).toMatch(/import_dwg failed: Not a DWG file/);
    expect(applied).toEqual([]);
  });
});

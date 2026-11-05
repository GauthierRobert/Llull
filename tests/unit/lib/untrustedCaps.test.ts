/** VC-INT-21 (TR-INT-12): untrusted archives and XML run under explicit caps; a cap hit is a stable code, never a big allocation. */
import { describe, expect, it } from 'vitest';
import { deflateRaw } from '@lib/deflate';
import { inflateRaw } from '@lib/inflate';
import { LimitError } from '@lib/limitError';
import { readXlsx } from '@lib/xlsxRead';
import { readXml } from '@lib/xmlRead';
import { zipStore } from '@lib/zip';
import { unzip } from '@lib/zipRead';
import { parse3mf } from '@lib/meshFormats/threeMf';
import { NO_LIMITS } from '@lib/meshFormats/types';
import { readBcfArchive } from '@core/commands/exchange/bcf/bcfRead';

const MIB = 2 ** 20;
const DECLARED = 900_000_000;

/**
 * A ~1 kB zip with one DEFLATE entry whose headers (central directory and local) declare `declared` bytes: the hostile archive of VC-INT-21
 * (the real stream inflates to `actual` zero bytes only).
 */
export function hostileZip(name: string, declared: number = DECLARED, actual = 100_000): Uint8Array {
  const bytes = zipStore([{ name, data: deflateRaw(new Uint8Array(actual)) }]);
  const view = new DataView(bytes.buffer);
  const nameLength = new TextEncoder().encode(name).length;
  const central = view.getUint32(bytes.length - 22 + 16, true);
  view.setUint16(8, 8, true);
  view.setUint32(22, declared, true);
  view.setUint16(central + 10, 8, true);
  view.setUint32(central + 24, declared, true);
  expect(central + 46 + nameLength + 22).toBe(bytes.length);
  return bytes;
}

const limitOf = (run: () => unknown): LimitError => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(LimitError);
    return error as LimitError;
  }
  throw new Error('expected a LimitError');
};

/** Resident-set growth of `run` in bytes. */
function growth(run: () => void): number {
  const before = process.memoryUsage().rss;
  run();
  return process.memoryUsage().rss - before;
}

describe('the zip reader', () => {
  it('refuses a ~1 kB zip declaring 900 MB from its header, with the limit and the declared size, without allocating it', () => {
    const bytes = hostileZip('a.model');
    expect(bytes.length).toBeLessThan(10_000);
    let error: LimitError | undefined;
    const rss = growth(() => {
      error = limitOf(() => unzip(bytes));
    });
    expect(error?.code).toBe('ZIP_LIMIT_EXCEEDED');
    expect(error?.limit).toBe(256 * MIB);
    expect(error?.declared).toBe(DECLARED);
    expect(error?.message).toMatch(/^ZIP_LIMIT_EXCEEDED: .*900000000.*268435456/);
    expect(rss).toBeLessThan(800 * MIB);
  });

  it('defaults to 256 MiB even with the ratio cap lifted, and a call site that names a bigger budget gets it', () => {
    const bytes = hostileZip('a.model');
    expect(limitOf(() => unzip(bytes, { maxRatio: 1e9 })).limit).toBe(256 * MIB);
    expect(unzip(bytes, { maxBytes: 1024 * MIB, maxRatio: 1e9 })[0]?.data.length).toBe(100_000);
  });

  it('refuses an entry that declares more than 200 times what it holds, and takes it once a call site names a higher ratio', () => {
    const bytes = hostileZip('a.model', 5 * MIB, 100_000);
    const error = limitOf(() => unzip(bytes));
    expect(error.code).toBe('ZIP_LIMIT_EXCEEDED');
    expect(error.message).toContain('200x expansion');
    expect(error.declared).toBe(5 * MIB);
    expect(unzip(bytes, { maxRatio: 100_000 })[0]?.data.length).toBe(100_000);
  });

  it('stops inflating at the ratio cap, whatever the header declares', () => {
    const bytes = hostileZip('a.model', 10, 5 * MIB);
    const error = limitOf(() => unzip(bytes, { maxRatio: 50 }));
    expect(error.code).toBe('ZIP_LIMIT_EXCEEDED');
    expect(error.message).toContain('inflates beyond');
    expect(error.declared).toBe(10);
    expect(unzip(bytes)[0]?.data.length).toBe(5 * MIB);
  });
});

describe('the inflater', () => {
  it('defaults to 256 MiB and stops at an explicit cap with INFLATE_LIMIT_EXCEEDED, the limit and the size it would have reached', () => {
    const stream = deflateRaw(new Uint8Array(MIB));
    const error = limitOf(() => inflateRaw(stream, 1000));
    expect(error.code).toBe('INFLATE_LIMIT_EXCEEDED');
    expect(error.limit).toBe(1000);
    expect(error.declared).toBeGreaterThan(1000);
    expect(inflateRaw(stream).length).toBe(MIB);
  });
});

describe('every importer that reads zips refuses the hostile archive', () => {
  it('3MF: MESH_IMPORT_PARSE naming ZIP_LIMIT_EXCEEDED', () => {
    let result: ReturnType<typeof parse3mf> | undefined;
    const rss = growth(() => {
      result = parse3mf(hostileZip('3D/3dmodel.model'), NO_LIMITS);
    });
    expect(result).toMatchObject({ code: 'MESH_IMPORT_PARSE' });
    expect(JSON.stringify(result)).toContain('ZIP_LIMIT_EXCEEDED');
    expect(rss).toBeLessThan(800 * MIB);
  });

  it('XLSX: XLSX_TOO_LARGE naming ZIP_LIMIT_EXCEEDED', () => {
    const result = readXlsx(hostileZip('xl/worksheets/sheet1.xml'));
    expect(result).toMatchObject({ ok: false, code: 'XLSX_TOO_LARGE' });
    expect(JSON.stringify(result)).toContain('ZIP_LIMIT_EXCEEDED');
  });

  it('BCF: VIS_BCF_PARSE naming ZIP_LIMIT_EXCEEDED', () => {
    const result = readBcfArchive(hostileZip('bcf.version'));
    expect(result).toMatchObject({ ok: false, code: 'VIS_BCF_PARSE' });
    expect(JSON.stringify(result)).toContain('ZIP_LIMIT_EXCEEDED');
  });
});

describe('the XML reader under hostile input', () => {
  it('refuses 50 000 nested elements with XML_TOO_DEEP', () => {
    const result = readXml('<a>'.repeat(50_000) + '</a>'.repeat(50_000));
    expect(result).toMatchObject({ ok: false, error: { code: 'XML_TOO_DEEP' } });
  });

  it('refuses a 20 MiB attribute value with XML_ATTRIBUTE_TOO_LARGE, and takes 1 MiB', () => {
    const big = readXml(`<a v="${'x'.repeat(20 * MIB)}"/>`);
    expect(big).toMatchObject({ ok: false, error: { code: 'XML_ATTRIBUTE_TOO_LARGE' } });
    expect(readXml(`<a v="${'x'.repeat(MIB)}"/>`).ok).toBe(true);
  });
});

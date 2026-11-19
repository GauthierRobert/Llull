/** PERF1 item 6: the byte-scanning OBJ reader, the preallocated binary STL reader, the row-wise edge count and the grouped base64 decoder give the results of the ones they replaced. */
import { describe, expect, it } from 'vitest';
import { fastMeasure } from '@core/geometry/mesh/fastMeasure';
import type { MeshData } from '@core/model/types';
import { base64ToUint8Array } from '@lib/base64';
import { parseMeshFile } from '@lib/meshFormats';
import { parseObj } from '@lib/meshFormats/obj';
import { parseBinaryStl } from '@lib/meshFormats/stl';
import type { MeshParseFailure, ParsedMeshFile } from '@lib/meshFormats/types';
import { legacyBase64ToUint8Array, legacyFastMeasure, legacyParseBinaryStl, legacyParseObj } from '../../helpers/legacyMeshImport';
import { icosphere, torus } from '../../helpers/meshFixtures';
import { MESSY_OBJ } from '../../helpers/messyObj';

/** Deterministic generator (mulberry32). */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(next: () => number, items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;

/** Numbers written so that 0 and -0, and every bit of a double, differ. */
const bits = (values: readonly number[]): string => Buffer.from(new Float64Array(values).buffer).toString('hex');
const exact = (value: unknown): unknown =>
  typeof value === 'number'
    ? `${Object.is(value, -0) ? '-0' : value}`
    : Array.isArray(value)
      ? value.map(exact)
      : typeof value === 'object' && value !== null
        ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, exact(entry)]))
        : value;
const frozen = (result: ParsedMeshFile | MeshParseFailure): unknown =>
  'code' in result
    ? result
    : {
        ...result,
        bodies: result.bodies.map((body) => ({ ...body, positions: bits(body.positions), triangles: body.triangles.join(' ') })),
      };

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const objBoth = (bytes: Uint8Array): { now: unknown; before: unknown } => ({
  now: frozen(parseObj(bytes)),
  before: frozen(legacyParseObj(new TextDecoder().decode(bytes))),
});

describe('OBJ reader against the per-line reader it replaced', () => {
  it('reads a messy file to the same bodies, groups and dropped attributes', () => {
    for (const text of [MESSY_OBJ, `${MESSY_OBJ}\n`, MESSY_OBJ.replaceAll('\n', '\r\n'), MESSY_OBJ.replaceAll('\n', '\r\r\n')]) {
      const { now, before } = objBoth(utf8(text));
      expect(now).toEqual(before);
      expect((now as { bodies: unknown[] }).bodies).toHaveLength(1);
    }
    const parsed = parseObj(utf8(MESSY_OBJ)) as ParsedMeshFile;
    expect(parsed.dropped).toEqual([
      'material libraries: 1',
      'normals: 2',
      'texture coordinates: 2',
      'parameter vertices: 1',
      'material references: 1',
    ]);
    expect(parsed.bodies[0]?.groups.map((group) => group.name)).toEqual(['side a b', 'group1', 'second object']);
    expect(Object.is(parsed.bodies[0]?.positions[5], -0)).toBe(true);
  });

  it('refuses with the same code and message', () => {
    const cases = [
      'v 0 x 0\n',
      'v 1 2\n',
      'v\n',
      'v 1 2 3x\n',
      'v 1e400 0 0\n',
      'v 1 2 NaN\n',
      'v 0x10 0 0\n',
      'v 1e 0 0\n',
      'v 1e+ 0 0\n',
      'v . 0 0\n',
      'v - 0 0\n',
      'v 1e12345 0 0\n',
      'v 1\rv 2 3 4\n',
      'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 9\n',
      'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2\n',
      'v 0 0 0\nv 1 0 0\nv 0 1 0\nf\n',
      'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 0 1 2\n',
      'v 0 0 0\nv 1 0 0\nv 0 1 0\nf -0 1 2\n',
      'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 -4\n',
      'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 /3\n',
      'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 12345678901\n',
      'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 x\n',
      'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 -\n',
      'v 0 0 0\r\n\r\nv 1 0 0\r\nv 0 1 0\r\n# c\r\nf 1 2 3\r\nf 3 2 7\r\n',
      '',
      '\n\n',
      '# only a comment',
      'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3',
    ];
    for (const text of cases) {
      const { now, before } = objBoth(utf8(text));
      expect(now, JSON.stringify(text)).toEqual(before);
    }
    expect(parseObj(utf8('v 0 0 0\nv 1 0 0\nf 1 2 9\n'))).toEqual({
      code: 'MESH_IMPORT_PARSE',
      message: 'face at line 3 references vertex "9" outside 1..2',
    });
  });

  it('reads every number form to the bits Number gives', () => {
    const next = random(7);
    const forms: string[] = [
      '0',
      '-0',
      '0.0',
      '-0.000',
      '1e22',
      '1e23',
      '1e-22',
      '1e-23',
      '9007199254740993',
      '123456789012345',
      '1234567890123456',
    ];
    for (let k = 0; k < 4000; k++) {
      const value = (next() - 0.5) * 10 ** Math.floor(next() * 40 - 20);
      const digits = Math.floor(next() * 21);
      forms.push(pick(next, [String(value), value.toFixed(digits), value.toExponential(digits), value.toPrecision(digits + 1)]));
      forms.push(
        `${next() < 0.5 ? '+' : '-'}${Math.floor(next() * 1e9)}.${String(Math.floor(next() * 1e9)).padStart(pick(next, [1, 6, 9, 12]), '0')}`,
      );
      forms.push(`${Math.floor(next() * 1e6)}e${Math.floor(next() * 60 - 30)}`, `.${Math.floor(next() * 1e6)}E+${Math.floor(next() * 30)}`);
    }
    const text = `${forms.map((form) => `v ${form} ${form} ${form}`).join('\n')}\nf 1 2 3\n`;
    const { now, before } = objBoth(utf8(text));
    expect(now).toEqual(before);
    const parsed = parseObj(utf8(text)) as ParsedMeshFile;
    expect(bits(parsed.bodies[0]?.positions ?? [])).toBe(bits(forms.flatMap((form) => [Number(form), Number(form), Number(form)])));
  });

  it('agrees on generated files: every blank, line end, keyword, reference form and stray byte', () => {
    const next = random(20261118);
    const numbers = [
      '0',
      '-0',
      '1',
      '+1',
      '-1.5',
      '.5',
      '-.5',
      '5.',
      '1e3',
      '1E-3',
      '-1.25e+2',
      '00012.50',
      '+.5e1',
      '2.5',
      '-3.75',
      '0.000001',
    ];
    const badNumbers = [
      '1e',
      'e5',
      '1.2.3',
      '0x10',
      'Infinity',
      '-Infinity',
      'NaN',
      '1_000',
      '.',
      '-',
      '+',
      '1,5',
      '\u0663',
      '1e400',
      '1\u00a0',
      '',
    ];
    const blanks = [' ', ' ', ' ', '  ', '\t', ' \t ', '\v', '\f', '\r', '\u00a0', '\u2028', '\u3000', '\ufeff'];
    const ends = ['\n', '\n', '\n', '\r\n', '\r\n', '\r', '\r\r\n'];
    const badReferences = ['0', '-0', '999', '-999', '/1', '1/x', '3abc', '1.5', '12345678901', 'x', '1/\u00a0/2', '-', '+', '2/', '1//'];
    const others = [
      'vn 0 0 1',
      'vt 0 1',
      'vp 1',
      'vn',
      'vt\t1',
      'g a b',
      'o',
      'g',
      'usemtl m',
      'mtllib a.mtl',
      's 1',
      '# c',
      '',
      'vx 1 2 3',
    ];
    const odd = [
      'V 1 2 3',
      'fo 1 2 3',
      'v',
      'f',
      'vnx 1',
      '#v 1 2 3',
      '\uff56 1 2 3',
      'v1 2 3',
      'f1 2 3',
      'vn\u00a01',
      '\u00a0# c',
      '\u00a0',
    ];
    let failures = 0;
    for (let file = 0; file < 1500; file++) {
      const dirty = file % 3 === 0;
      const blank = (): string => pick(next, dirty ? blanks : blanks.slice(0, 9));
      const lines: string[] = [];
      let vertices = 0;
      const lineCount = 1 + Math.floor(next() * (dirty ? 8 : 40));
      for (let k = 0; k < lineCount; k++) {
        const roll = next();
        let line: string;
        if (roll < 0.45) {
          const count = dirty && next() < 0.2 ? Math.floor(next() * 6) : 3 + (next() < 0.1 ? 2 : 0);
          const fields = Array.from({ length: count }, () =>
            dirty && next() < 0.08
              ? pick(next, badNumbers)
              : next() < 0.5
                ? pick(next, numbers)
                : ((next() - 0.5) * 20).toFixed(Math.floor(next() * 8)),
          );
          line = ['v', ...fields].join(blank());
          vertices++;
        } else if (roll < 0.8) {
          const count = dirty && next() < 0.2 ? Math.floor(next() * 3) : 3 + Math.floor(next() * next() * 5);
          const fields = Array.from({ length: count }, () => {
            if (dirty && next() < 0.1) return pick(next, badReferences);
            const index = 1 + Math.floor(next() * Math.max(vertices, 1));
            const reference = next() < 0.3 ? `${index - Math.max(vertices, 1) - 1}` : next() < 0.1 ? `+${index}` : `${index}`;
            return reference + pick(next, ['', '', '', '/1', '/1/1', '//1', '/', '//']);
          });
          line = ['f', ...fields].join(blank());
        } else line = pick(next, dirty && next() < 0.5 ? odd : others);
        lines.push((next() < 0.2 ? blank() : '') + line + (next() < 0.2 ? blank() : '') + pick(next, ends));
      }
      let bytes = utf8((file % 50 === 0 ? '\ufeff' : '') + lines.join(''));
      if (dirty && next() < 0.3) {
        const stray = pick(next, [[0xff], [0xc3], [0xe2, 0x80], [0x00], [0xc2, 0xa0], [0xef, 0xbb, 0xbf]]);
        const at = Math.floor(next() * (bytes.length + 1));
        bytes = Uint8Array.from([...bytes.subarray(0, at), ...stray, ...bytes.subarray(at)]);
      }
      const { now, before } = objBoth(bytes);
      expect(now, JSON.stringify(new TextDecoder().decode(bytes))).toEqual(before);
      if (typeof now === 'object' && now !== null && 'code' in now) failures++;
    }
    expect(failures).toBeGreaterThan(200);
    expect(failures).toBeLessThan(1300);
  });

  it('reads a file given through the sniffing entry point from its bytes', () => {
    const sphere = icosphere(5, 2);
    const text = [
      ...Array.from({ length: sphere.positions.length / 3 }, (_, v) => `v ${sphere.positions.slice(v * 3, v * 3 + 3).join(' ')}`),
      ...Array.from(
        { length: sphere.indices.length / 3 },
        (_, f) =>
          `f ${sphere.indices
            .slice(f * 3, f * 3 + 3)
            .map((i) => i + 1)
            .join(' ')}`,
      ),
    ].join('\n');
    const parsed = parseMeshFile(utf8(text)) as ParsedMeshFile;
    expect(parsed.format).toBe('obj');
    expect(bits(parsed.bodies[0]?.positions ?? [])).toBe(bits(sphere.positions));
    expect(parsed.bodies[0]?.triangles).toEqual(sphere.indices);
  });
});

describe('binary STL reader against the pushing reader it replaced', () => {
  const stl = (facets: number, next: () => number): Uint8Array => {
    const bytes = new Uint8Array(84 + facets * 50);
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(next() * 256);
    const view = new DataView(bytes.buffer);
    view.setUint32(80, facets, true);
    for (let f = 0; f < facets; f++)
      for (let k = 0; k < 12; k++)
        view.setFloat32(84 + f * 50 + k * 4, pick(next, [0, -0, 1e-40, 3.4e38, (next() - 0.5) * 100, Math.fround(next())]), true);
    return bytes;
  };

  it('gives the same body, and the same refusal for a non-finite coordinate', () => {
    const next = random(3);
    for (const facets of [0, 1, 2, 7, 300]) {
      const bytes = stl(facets, next);
      expect(frozen(parseBinaryStl(bytes))).toEqual(frozen(legacyParseBinaryStl(bytes)));
      for (const bad of [NaN, Infinity, -Infinity]) {
        if (facets === 0) continue;
        const broken = bytes.slice();
        const at = 84 + Math.floor(next() * facets) * 50 + 12 + Math.floor(next() * 9) * 4;
        new DataView(broken.buffer).setFloat32(at, bad, true);
        const refusal = parseBinaryStl(broken);
        expect(refusal).toEqual(legacyParseBinaryStl(broken));
        expect(refusal).toMatchObject({ code: 'MESH_IMPORT_PARSE', message: expect.stringContaining(`(byte ${at})`) });
      }
    }
    const shifted = new Uint8Array(84 + 50 * 3 + 1).subarray(1);
    shifted.set(stl(3, next));
    expect(frozen(parseBinaryStl(shifted))).toEqual(frozen(legacyParseBinaryStl(shifted)));
    expect(parseBinaryStl(new Uint8Array(90))).toEqual(legacyParseBinaryStl(new Uint8Array(90)));
  });
});

describe('fastMeasure against the single edge sort it replaced', () => {
  const same = (mesh: MeshData): void => expect(exact(fastMeasure(mesh))).toEqual(exact(legacyFastMeasure(mesh)));

  it('closed, open, flipped, non-manifold and degenerate meshes', () => {
    const sphere = icosphere(10, 3);
    same(sphere);
    expect(fastMeasure(sphere)).toMatchObject({ closed: true, boundaryEdges: 0, nonManifoldEdges: 0, inconsistentEdges: 0 });
    same(torus(10, 3, 24, 12));
    same({ positions: sphere.positions, indices: sphere.indices.slice(3) });
    expect(fastMeasure({ positions: sphere.positions, indices: sphere.indices.slice(3) }).boundaryEdges).toBe(3);
    const flipped = [...sphere.indices];
    [flipped[0], flipped[1]] = [flipped[1] as number, flipped[0] as number];
    same({ positions: sphere.positions, indices: flipped });
    expect(fastMeasure({ positions: sphere.positions, indices: flipped }).inconsistentEdges).toBe(3);
    same({ positions: sphere.positions, indices: [...sphere.indices, ...sphere.indices.slice(0, 3)] });
    same({ positions: sphere.positions, indices: [...sphere.indices, 0, 0, 1, 2, 2, 2] });
    same({ positions: [], indices: [] });
    same({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1] });
  });

  it('a vertex with more edges than a short row (a double cone of 200 segments)', () => {
    const segments = 200;
    const positions = [0, 0, 1, 0, 0, -1];
    const indices: number[] = [];
    for (let k = 0; k < segments; k++) {
      const angle = (k / segments) * Math.PI * 2;
      positions.push(Math.cos(angle), Math.sin(angle), 0);
      const [a, b] = [2 + k, 2 + ((k + 1) % segments)];
      indices.push(0, a, b, 1, b, a);
    }
    same({ positions, indices });
    expect(fastMeasure({ positions, indices })).toMatchObject({ closed: true, inconsistentEdges: 0, faces: 2 * segments });
    same({ positions, indices: indices.slice(0, -6) });
    same({ positions, indices: [...indices, 0, 2, 3, 0, 3, 2, 0, 2, 3] });
  });

  it('random triangle soups, also with indices that are not vertex numbers', () => {
    const next = random(11);
    for (let run = 0; run < 600; run++) {
      const vertexCount = 1 + Math.floor(next() * 12);
      const positions = Array.from({ length: vertexCount * 3 }, () => Math.round((next() - 0.5) * 8));
      const faces = Math.floor(next() * 30);
      const indices = Array.from({ length: faces * 3 + (run % 7 === 0 ? 1 : 0) }, () => Math.floor(next() * vertexCount));
      same({ positions, indices });
      if (run % 4 === 0 && indices.length > 0) {
        const broken = [...indices];
        broken[Math.floor(next() * broken.length)] = pick(next, [-1, vertexCount, vertexCount + 5, 0.5, NaN, 2 ** 32, -0]);
        same({ positions, indices: broken });
        same({ positions: positions.slice(0, -1), indices });
      }
    }
  });
});

describe('base64 decoder against the per-character one it replaced', () => {
  const same = (text: string): void => {
    const [now, before] = [base64ToUint8Array(text), legacyBase64ToUint8Array(text)];
    expect(now === null ? null : Buffer.from(now).toString('hex'), JSON.stringify(text)).toBe(
      before === null ? null : Buffer.from(before).toString('hex'),
    );
  };

  it('decodes every length and refuses what the old one refused', () => {
    const next = random(5);
    for (let length = 0; length < 70; length++) {
      const bytes = Uint8Array.from({ length }, () => Math.floor(next() * 256));
      const text = Buffer.from(bytes).toString('base64');
      expect(Buffer.from(base64ToUint8Array(text) ?? []).equals(Buffer.from(bytes))).toBe(true);
      same(text);
      for (let mutation = 0; mutation < 40; mutation++) {
        const at = Math.floor(next() * (text.length + 1));
        const piece = pick(next, ['=', '==', '-', '_', ' ', '\n', '\u00e9', '\u0100', '\uffff', 'A', '+', '/', '']);
        same(text.slice(0, at) + piece + text.slice(at + (next() < 0.7 ? piece.length : 0)));
        same(text.slice(0, at));
      }
    }
    for (const text of [
      '=',
      '==',
      '===',
      '====',
      'A===',
      'AA==',
      'AAA=',
      'AAAA====',
      'AA==AAAA',
      '=AAA',
      'A=AA',
      'AB=C',
      'AA=A',
      '\u0141AA=',
      'A\u0141==',
      'AA\u0141=',
    ])
      same(text);
    expect(base64ToUint8Array('AA\u0141=')).toBeNull();
    expect(base64ToUint8Array('A\u0141==')).toBeNull();
  });
});

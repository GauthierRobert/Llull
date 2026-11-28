/** Hostile-input table: image headers (PNG, JPEG, Radiance HDR) and the import_texture command (RV1 RV-M1). */
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { readImageHeader } from '@lib/imageHeader';
import { hdrBytes, jpegBytes, pngBytes, toBase64 } from '../imageHeaderFixtures';
import { asBytes, type HostileReader } from './types';

const padded = (head: Uint8Array, records: number): Uint8Array => {
  const out = new Uint8Array(head.length + records);
  out.set(head);
  return out;
};

const isHeader = (result: unknown): boolean => typeof result === 'object' && result !== null && 'format' in result;

export const IMAGE_READERS: readonly HostileReader[] = [
  {
    name: 'image: readImageHeader (png, trailing bytes)',
    covers: ['core/src/lib/imageHeader.ts:readImageHeader'],
    input: 'bytes',
    build: (records) => padded(pngBytes(64, 64), records),
    extra: [
      {
        name: 'jpeg: 200000 fill bytes before the frame',
        input: () => Uint8Array.from([0xff, 0xd8, ...new Array<number>(200_000).fill(0xff), 0xc0]),
      },
      {
        name: 'jpeg: many empty segments',
        input: () => Uint8Array.from([0xff, 0xd8, ...Array.from({ length: 50_000 }, () => [0xff, 0xe0, 0, 2]).flat()]),
      },
      {
        name: 'hdr: header comment lines without a blank line',
        input: () => new TextEncoder().encode('#?RADIANCE\n' + '#c\n'.repeat(100_000)),
      },
      {
        name: 'hdr: a resolution line of 100000 digits',
        input: () => new TextEncoder().encode(`#?RADIANCE\n\n-Y ${'9'.repeat(100_000)} +X 1\n`),
      },
      { name: 'jpeg and hdr samples', input: () => padded(jpegBytes(5, 5), 100) },
      { name: 'hdr sample', input: () => hdrBytes(5, 5) },
    ],
    read: (input) => readImageHeader(asBytes(input)),
    accepts: isHeader,
  },
  {
    name: 'image: readImageHeader (hdr, newline run)',
    covers: ['core/src/lib/imageHeader.ts:readImageHeader'],
    input: 'bytes',
    build: (records) => new TextEncoder().encode('#?RADIANCE' + '\n'.repeat(records)),
    extra: [{ name: 'hdr: a header made of only newlines', input: () => new TextEncoder().encode('#?RADIANCE' + '\n'.repeat(65_526)) }],
    read: (input) => readImageHeader(asBytes(input)),
    accepts: (result) => result === null,
  },
  {
    name: 'image: import_texture (execute, png as base64)',
    covers: ['import_texture'],
    input: 'bytes',
    build: (records) => padded(pngBytes(64, 64), records),
    read: (input) => execute(createEmptyDocument(), 'import_texture', { name: 'hostile', base64: toBase64(asBytes(input)) }),
    accepts: (result) => (result as { affected: string[] }).affected.length > 0,
  },
];

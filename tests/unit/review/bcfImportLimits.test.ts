/** import_bcf provenance, comment dedup and decompression limits (review round 1 of VIS-M5b). */
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { uint8ArrayToBase64 } from '@lib/base64';
import { type ZipEntry, zipStore } from '@lib/zip';
import { unzip } from '@lib/zipRead';
import { createEmptyDocument } from '@core/model/types';

const GUID_A = '11111111-1111-4111-8111-111111111111';
const HEAD = '<?xml version="1.0" encoding="UTF-8"?>';
const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

function archive(entries: ZipEntry[]): string {
  return uint8ArrayToBase64(zipStore([{ name: 'bcf.version', data: enc(`${HEAD}<Version VersionId="2.1" />`) }, ...entries]));
}

const comment = (guid: string, author: string, text: string): string =>
  `<Comment Guid="${guid}"><Date>2020-01-01T00:00:00Z</Date><Author>${author}</Author><Comment>${text}</Comment></Comment>`;

describe('imported comments', () => {
  it('keep the BCF Author as importedAuthor (never human), write it back, and dedup on text plus author', () => {
    const topic =
      `${HEAD}<Markup><Topic Guid="${GUID_A}"><Title>t</Title></Topic>` +
      comment('22222222-2222-4222-8222-222222222222', 'ann@x.y', 'same') +
      comment('33333333-3333-4333-8333-333333333333', 'bob@x.y', 'same') +
      comment('44444444-4444-4444-8444-444444444444', 'ann@x.y', 'same') +
      '</Markup>';
    const bcf = archive([{ name: `${GUID_A}/markup.bcf`, data: enc(topic) }]);
    const first = execute(createEmptyDocument(), 'import_bcf', { bcf });
    const comments = Object.values(first.document.review?.comments ?? {});
    expect(comments.map((c) => [c.author, c.importedAuthor])).toEqual([
      ['agent', 'ann@x.y'],
      ['agent', 'bob@x.y'],
    ]);
    const again = execute(first.document, 'import_bcf', { bcf, mergePolicy: 'update' });
    expect(again.data).toMatchObject({ comments: 0 });
    const data = execute(first.document, 'export_bcf', { snapshots: false }).data as { base64: string };
    const markup = unzip(Buffer.from(data.base64, 'base64')).find((entry) => entry.name.endsWith('markup.bcf'));
    const xml = Buffer.from(markup?.data ?? []).toString();
    expect(xml).toContain('<Author>ann@x.y</Author>');
    expect(xml).toContain('<Author>bob@x.y</Author>');
  });

  it('refuses an importedAuthor of the wrong type on load', async () => {
    const { reviewProblems } = await import('@core/commands/persistence/reviewValidation');
    const first = execute(createEmptyDocument(), 'import_bcf', {
      bcf: archive([
        {
          name: `${GUID_A}/markup.bcf`,
          data: enc(`${HEAD}<Markup><Topic Guid="${GUID_A}"><Title>t</Title></Topic>${comment(GUID_A, 'a', 'x')}</Markup>`),
        },
      ]),
    });
    const review = JSON.parse(JSON.stringify(first.document.review)) as { comments: Record<string, Record<string, unknown>> };
    expect(reviewProblems(review)).toEqual([]);
    const key = Object.keys(review.comments)[0] ?? '';
    (review.comments[key] as Record<string, unknown>)['importedAuthor'] = 7;
    expect(reviewProblems(review)[0]).toContain('importedAuthor');
  });
});

describe('import_bcf unsafe names and decompression bombs', () => {
  it('refuses a drive, a backslash and percent-encoded dots or separators in an entry name', () => {
    const data = enc(`${HEAD}<Markup><Topic Guid="${GUID_A}"><Title>t</Title></Topic></Markup>`);
    for (const name of ['C:x/markup.bcf', 'a\\markup.bcf', '%2e%2e/markup.bcf', '%2E%2E%2Fx/markup.bcf', 'a/%5c../markup.bcf'])
      expect(execute(createEmptyDocument(), 'import_bcf', { bcf: archive([{ name, data }]) }).error?.code, name).toBe('VIS_BCF_PARSE');
  });

  it('refuses a high-ratio deflate bomb before inflating it fully', () => {
    const size = 120_000_000;
    const packed = deflateRawSync(Buffer.alloc(size));
    const name = Buffer.from('bcf.version');
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    name.copy(central, 46);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length, 12);
    end.writeUInt32LE(local.length + packed.length, 16);
    expect(packed.length * 200 + 65536).toBeLessThan(size);
    const result = execute(createEmptyDocument(), 'import_bcf', { bcf: Buffer.concat([local, packed, central, end]).toString('base64') });
    expect(result.error?.code).toBe('VIS_BCF_PARSE');
    expect(result.summary).toMatch(/exceed|limit|size/i);
  });
});

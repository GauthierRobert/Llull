/**
 * `llull pack OUT.zip [--doc FILE] [--with-scans] [--store DIR] [--max-bytes N]` and `llull unpack ARCHIVE.zip [--to FILE] [--store DIR] [--force]`:
 * the document with the point-cloud assets it references, as one archive (plant 10 §13.9). Files only: the desktop app's open document is saved
 * first (`--doc` names the file). The CLI moves bytes; the document is never changed.
 */

import path from 'node:path';
import { packDocument, unpackDocument } from '../scan/scanPack';
import { scanCacheDir } from '../scan/scanStore';
import { type ParsedArgv, booleanFlag, cliTarget, stringFlag } from './argv';

export interface PackCliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
}

const OK = 0;
const FAILED = 1;
const USAGE = 2;

function maxBytesOf(args: ParsedArgv): number | undefined | null {
  const raw = stringFlag(args, 'max-bytes');
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/** Exit code: 0 done, 1 refused (`SCN_PACK_*`), 2 bad usage. */
export function runPackCli(args: ParsedArgv, io: PackCliIo): number {
  const verb = args.positionals[0];
  const file = args.positionals[1];
  const json = booleanFlag(args, 'json');
  const say = (value: unknown, text: string): void => io.stdout(json ? JSON.stringify(value) : text);
  const store = stringFlag(args, 'store') ?? scanCacheDir({ ...process.env, ...io.env });
  const maxBytes = maxBytesOf(args);
  if (file === undefined || file.startsWith('--')) {
    io.stderr(
      verb === 'pack'
        ? 'pack needs the archive to write: llull pack OUT.zip [--doc FILE] [--with-scans]'
        : 'unpack needs an archive: llull unpack ARCHIVE.zip [--to FILE]',
    );
    return USAGE;
  }
  if (maxBytes === null) {
    io.stderr('--max-bytes needs a positive integer.');
    return USAGE;
  }
  if (cliTarget(args, io.env).server !== undefined) {
    io.stderr(`${verb} works on files: save the document in the app and pass --doc FILE (no --app / --server).`);
    return USAGE;
  }
  if (verb === 'pack') {
    const result = packDocument({
      document: cliTarget(args, io.env).doc,
      out: file,
      withScans: booleanFlag(args, 'with-scans'),
      store,
      ...(maxBytes !== undefined ? { maxBytes } : {}),
    });
    if (!result.ok) {
      io.stderr(`${result.code}: ${result.message}`);
      return FAILED;
    }
    say(
      result,
      `pack: ${result.out} (${result.bytes} bytes): the document and ${result.included.length} of ${result.assetKeys.length} referenced scan asset(s)` +
        `${result.included.length < result.assetKeys.length ? ' (pass --with-scans to carry the scans)' : ''}.`,
    );
    return OK;
  }
  const documentOut =
    stringFlag(args, 'to') ?? path.join(path.dirname(path.resolve(file)), `${path.basename(file, path.extname(file))}.llull`);
  const result = unpackDocument({
    archive: file,
    documentOut,
    store,
    overwrite: booleanFlag(args, 'force'),
    ...(maxBytes !== undefined ? { maxBytes } : {}),
  });
  if (!result.ok) {
    io.stderr(`${result.code}: ${result.message}`);
    return FAILED;
  }
  say(
    result,
    `unpack: ${result.documentOut}; installed ${result.installed.length} scan asset(s) in ${store}` +
      `${result.alreadyPresent.length > 0 ? `, ${result.alreadyPresent.length} already there` : ''}` +
      `${result.notIncluded.length > 0 ? `; ${result.notIncluded.length} referenced asset(s) were not packed: llull scan import <source> on this machine` : ''}.`,
  );
  return OK;
}

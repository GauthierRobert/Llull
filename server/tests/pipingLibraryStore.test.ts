/**
 * Private piping libraries on the host (plant 01 PSC CAT-FU): the file-system `PipingLibraryProvider` behind `import_piping_library`, end to end
 * through the CLI (`--doc`, in-process) and the backend (`--server`, `POST /command`).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deserializeDocument } from '@core/commands/persistence/serialization';
import { createEmptyDocument } from '@core/model/types';
import { setPipingLibraryProvider } from '@aec/index';
import { sha256Hex } from '@lib/sha256';
import { EXIT_COMMAND_ERROR, EXIT_OK, runCli, type CliIo } from '../src/cli/main';
import { writeDocumentFile } from '../src/documentFile';
import { app } from '../src/index';
import { _resetHistory } from '../src/commandBus';
import { _resetLiveDoc, getLiveDoc } from '../src/liveDocument';
import { createPipingLibraryProvider, installPipingLibraryProvider, MAX_PIPING_LIBRARY_BYTES } from '../src/libraries/pipingLibraryStore';

const text = JSON.stringify({
  format: 'llull-piping-catalog',
  schemaVersion: 1,
  id: 'acme-private',
  version: '2',
  licence: 'licensed-no-redistribution',
  families: [
    {
      id: 'acme-pipe',
      type: 'pipe',
      standard: 'ACME 1',
      unit: 'mm',
      sizes: [{ dn: 175, outsideDiameter: 190, wall: 5, schedule: 'S', provenance: { citation: 'ACME catalogue 2026' } }],
    },
  ],
});

let directory = '';
let docPath = '';
const previous = process.env['LLULL_PIPING_LIBRARIES_DIR'];

const capture = (): { io: CliIo; out: string[]; err: string[] } => {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    readStdin: () => Promise.resolve(''),
    env: {},
    // what cliProcess.prepareKernel does for a local command
    prepareKernel: () => Promise.resolve(installPipingLibraryProvider()),
  };
  return { io, out, err };
};

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'llull-piping-libs-'));
  process.env['LLULL_PIPING_LIBRARIES_DIR'] = directory;
  docPath = path.join(directory, 'part.llull.json');
  writeDocumentFile(docPath, createEmptyDocument());
  _resetLiveDoc(createEmptyDocument());
  _resetHistory();
});

afterEach(() => {
  setPipingLibraryProvider(null);
  if (previous === undefined) delete process.env['LLULL_PIPING_LIBRARIES_DIR'];
  else process.env['LLULL_PIPING_LIBRARIES_DIR'] = previous;
  rmSync(directory, { recursive: true, force: true });
});

const place = (name = 'acme-private@2.llull-piping.json', body = text): void => writeFileSync(path.join(directory, name), body);
const importArgs = ['import_piping_library', 'libraryId=acme-private', 'version=2'];

describe('createPipingLibraryProvider', () => {
  it('reads <id>@<version>.llull-piping.json of the environment directory, and is null for anything else', () => {
    place();
    const provider = createPipingLibraryProvider();
    expect(provider.get('acme-private', '2')).toBe(text);
    expect(provider.get('acme-private', '3')).toBeNull();
    expect(provider.get('other', '2')).toBeNull();
    expect(
      createPipingLibraryProvider({ LLULL_PIPING_LIBRARIES_DIR: path.join(directory, 'nowhere') }).get('acme-private', '2'),
    ).toBeNull();
  });

  it('refuses an id or version that could leave the directory, even when the target file exists', () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'llull-piping-outside-'));
    try {
      writeFileSync(path.join(outside, 'evil@1.llull-piping.json'), text);
      mkdirSync(path.join(directory, 'sub'));
      writeFileSync(path.join(directory, 'sub', 'x@1.llull-piping.json'), text);
      const provider = createPipingLibraryProvider();
      const escape = path.relative(directory, outside).split(path.sep).join('/');
      for (const [id, version] of [
        [`${escape}/evil`, '1'],
        ['..\\evil', '1'],
        ['sub/x', '1'],
        ['acme-private', '../2'],
        ['acme-private', '2/../2'],
        ['', '2'],
        ['a'.repeat(65), '2'],
      ] as const)
        expect(provider.get(id, version), `${id}@${version}`).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('treats an oversize file and a directory in its place as absent', () => {
    place('acme-private@2.llull-piping.json', 'x'.repeat(MAX_PIPING_LIBRARY_BYTES + 1));
    expect(createPipingLibraryProvider().get('acme-private', '2')).toBeNull();
    mkdirSync(path.join(directory, 'acme-private@3.llull-piping.json'));
    expect(createPipingLibraryProvider().get('acme-private', '3')).toBeNull();
  });
});

describe('import_piping_library through llull --doc', () => {
  it('resolves the library of the machine and stores only the reference', async () => {
    place();
    const run = capture();
    expect(await runCli([...importArgs, '--doc', docPath], run.io)).toBe(EXIT_OK);
    const stored = readFileSync(docPath, 'utf8');
    expect(deserializeDocument(stored).plant?.catalog?.libraries).toEqual({
      'acme-private': { libraryId: 'acme-private', version: '2', sha256: sha256Hex(text) },
    });
    expect(stored).not.toContain('ACME catalogue');
  });

  it('a missing file answers PSC_LIBRARY_UNRESOLVED and the document is unchanged', async () => {
    const run = capture();
    expect(await runCli([...importArgs, '--json', '--doc', docPath], run.io)).toBe(EXIT_COMMAND_ERROR);
    expect(run.out.join('')).toContain('PSC_LIBRARY_UNRESOLVED');
    expect(deserializeDocument(readFileSync(docPath, 'utf8')).plant?.catalog?.libraries).toBeUndefined();
  });

  it('a traversal attempt is refused as unresolved, not read', async () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'llull-piping-outside-'));
    try {
      writeFileSync(path.join(outside, 'evil@2.llull-piping.json'), text);
      const escape = path.relative(directory, outside).split(path.sep).join('/');
      const run = capture();
      expect(await runCli(['import_piping_library', `libraryId=${escape}/evil`, 'version=2', '--json', '--doc', docPath], run.io)).toBe(
        EXIT_COMMAND_ERROR,
      );
      expect(run.out.join('')).toMatch(/PSC_CATALOG_INVALID|PSC_LIBRARY_UNRESOLVED/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('import_piping_library through the backend (POST /command)', () => {
  let server: Server;
  let url = '';

  beforeAll(async () => {
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it('resolves once the backend installed the provider (startServer does), and refuses before', async () => {
    place();
    const before = capture();
    expect(await runCli([...importArgs, '--json', '--server', url], before.io)).toBe(EXIT_COMMAND_ERROR);
    expect(before.out.join('')).toContain('PSC_LIBRARY_UNRESOLVED');

    installPipingLibraryProvider();
    const after = capture();
    expect(await runCli([...importArgs, '--json', '--server', url], after.io)).toBe(EXIT_OK);
    expect(getLiveDoc().plant?.catalog?.libraries?.['acme-private']?.sha256).toBe(sha256Hex(text));

    rmSync(path.join(directory, 'acme-private@2.llull-piping.json'));
    const gone = capture();
    expect(
      await runCli(['import_piping_library', 'libraryId=acme-private', 'version=2', 'replace=true', '--json', '--server', url], gone.io),
    ).toBe(EXIT_COMMAND_ERROR);
    expect(gone.out.join('')).toContain('PSC_LIBRARY_UNRESOLVED');
  });
});

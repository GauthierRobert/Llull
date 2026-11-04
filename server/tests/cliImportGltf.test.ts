/** `llull import_gltf file=<path>` reads the glTF / GLB bytes from disk (VIS-M8d: one FILE_PARAMS row) and imports them through the command. */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deserializeDocument } from '@core/commands/persistence/serialization';
import { EXIT_COMMAND_ERROR, EXIT_OK, runCli, type CliIo } from '../src/cli/main';
import { glb, triangleBytes, triangleGltf } from '../../tests/helpers/gltfFixtures';

function capture(): { io: CliIo; out: string[] } {
  const out: string[] = [];
  return {
    out,
    io: {
      stdout: (text) => out.push(text),
      stderr: (text) => out.push(text),
      readStdin: () => Promise.resolve(''),
      env: {},
      prepareKernel: () => Promise.resolve(),
    },
  };
}

describe('llull CLI: glTF files', () => {
  it('import_gltf file= imports a .glb into the document', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'llull-gltf-'));
    const file = path.join(dir, 'tri.glb');
    const doc = path.join(dir, 'a.llull');
    writeFileSync(file, glb(triangleGltf({ buffers: [{ byteLength: 44 }] }), triangleBytes()));
    const imported = capture();
    expect(await runCli(['import_gltf', `file=${file}`, '--doc', doc], imported.io)).toBe(EXIT_OK);
    expect(imported.out.join('')).toMatch(/Imported glTF: 1 mesh entity/);
    const saved = deserializeDocument(readFileSync(doc, 'utf8'));
    expect(Object.values(saved.entities).map((e) => [e.kind, e.name])).toEqual([['mesh', 'tri']]);
  });

  it('import_gltf file= of a .gltf with an external buffer is refused with GLTF_EXTERNAL_URI and the document stays empty', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'llull-gltf-'));
    const file = path.join(dir, 'tri.gltf');
    const doc = path.join(dir, 'a.llull');
    writeFileSync(file, JSON.stringify(triangleGltf({ buffers: [{ byteLength: 44, uri: 'tri.bin' }] })));
    const refused = capture();
    expect(await runCli(['import_gltf', `file=${file}`, '--doc', doc], refused.io)).toBe(EXIT_COMMAND_ERROR);
    expect(refused.out.join('')).toMatch(/GLTF_EXTERNAL_URI/);
  });
});

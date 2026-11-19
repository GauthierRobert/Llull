/** PERF1 item 6: `import_mesh_file` gives the document, data and summary it gave before the faster readers (digests taken with the previous implementation). */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { createEmptyDocument } from '@core/model/types';
import { memoryMeshAssets } from '../../helpers/memoryMeshAssets';
import { icosphere } from '../../helpers/meshFixtures';
import { MESSY_OBJ } from '../../helpers/messyObj';

const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const digest = (result: CommandResult): string =>
  sha256(JSON.stringify([result.document, result.summary, result.affected, result.data ?? null, result.rejected ?? false]));

const sphere = icosphere(10, 7);
const triangleCount = sphere.indices.length / 3;

function sphereStl(): Uint8Array {
  const bytes = new Uint8Array(84 + triangleCount * 50);
  const view = new DataView(bytes.buffer);
  view.setUint32(80, triangleCount, true);
  for (let t = 0; t < triangleCount; t++)
    for (let k = 0; k < 3; k++)
      for (let a = 0; a < 3; a++)
        view.setFloat32(84 + t * 50 + 12 + k * 12 + a * 4, sphere.positions[(sphere.indices[t * 3 + k] as number) * 3 + a] as number, true);
  return bytes;
}

/** The sphere as OBJ: full-precision and rounded coordinates, a normal per vertex, `a//a`, plain and negative references, CR LF. */
function sphereObj(): Uint8Array {
  const vertexCount = sphere.positions.length / 3;
  const lines: string[] = ['# sphere', 'mtllib sphere.mtl', 'o sphere'];
  for (let v = 0; v < vertexCount; v++) {
    const [x, y, z] = [sphere.positions[v * 3] as number, sphere.positions[v * 3 + 1] as number, sphere.positions[v * 3 + 2] as number];
    lines.push(v % 2 === 0 ? `v ${x} ${y} ${z}` : `v ${x.toFixed(6)} ${y.toFixed(6)} ${z.toExponential(8)}`);
    lines.push(`vn ${(x / 10).toFixed(4)} ${(y / 10).toFixed(4)} ${(z / 10).toFixed(4)}`);
  }
  for (let t = 0; t < triangleCount; t++) {
    if (t === triangleCount / 2) lines.push('g upper half', 'usemtl steel');
    const corners = [0, 1, 2].map((k) => (sphere.indices[t * 3 + k] as number) + 1);
    lines.push(
      t % 3 === 0
        ? `f ${corners.map((c) => `${c}//${c}`).join(' ')}`
        : t % 3 === 1
          ? `f ${corners.join('  ')}`
          : `f ${corners.map((c) => c - vertexCount - 1).join('\t')}`,
    );
  }
  return new TextEncoder().encode(lines.join('\r\n'));
}

const PINNED = {
  messyText: 'd51aee55b75083c8cf908a8a77973febe3186fa5439d80a841b5af68d3765c0b',
  sphereStl: '4de48708a7beccdecec68472b0620d6c7a155e6aa37890833e8910c015c5b795',
  sphereObj: 'e53491b07f86473e867ac0b1d62c3ed4691170ce83ae43a06e717fff2bcdec88',
};

describe('import_mesh_file results pinned before PERF1 item 6', () => {
  it('a messy OBJ given as text', () => {
    const result = execute(createEmptyDocument(), 'import_mesh_file', { text: MESSY_OBJ, units: 'cm', name: 'messy' });
    expect(result.rejected).not.toBe(true);
    expect(digest(result)).toBe(PINNED.messyText);
    const assets = memoryMeshAssets();
    const ctx: ExecutionContext = { ...defaultContext(), meshAssets: assets };
    const bytes = new TextEncoder().encode(MESSY_OBJ);
    for (const params of [{ base64: Buffer.from(bytes).toString('base64') }, { fileKey: assets.putFile(bytes) }]) {
      const other = execute(createEmptyDocument(), 'import_mesh_file', { ...params, units: 'cm', name: 'messy' }, ctx);
      expect(other.document.entities).toEqual(result.document.entities);
      expect(other.data).toEqual(result.data);
    }
  });

  it('a 327 680-triangle binary STL through the asset store (welded mesh key, display LOD, measures)', () => {
    const assets = memoryMeshAssets();
    const ctx: ExecutionContext = { ...defaultContext(), meshAssets: assets };
    const bytes = sphereStl();
    const result = execute(createEmptyDocument(), 'import_mesh_file', { fileKey: assets.putFile(bytes), units: 'mm', name: 'scan' }, ctx);
    expect(result.summary).toContain(`stl-binary -> 1 mesh (mesh-1.1), ${triangleCount} triangles`);
    expect(digest(result)).toBe(PINNED.sphereStl);

    let hostHashes = 0;
    const hashing: ExecutionContext = {
      ...ctx,
      meshAssets: {
        ...assets,
        sha256: (input) => {
          hostHashes++;
          return sha256(input);
        },
      },
    };
    const params = { fileKey: assets.putFile(bytes), units: 'mm', name: 'scan' };
    expect(digest(execute(createEmptyDocument(), 'import_mesh_file', params, hashing))).toBe(PINNED.sphereStl);
    expect(hostHashes).toBe(1);
    const pinned = execute(createEmptyDocument(), 'import_mesh_file', { ...params, sourceSha256: sha256(bytes).toUpperCase() }, hashing);
    expect(pinned.summary).toContain('verified against the pinned sha256');
    const refused = execute(createEmptyDocument(), 'import_mesh_file', { ...params, sourceSha256: 'ab'.repeat(32) }, hashing);
    expect(refused.summary).toContain(`the file sha256 is ${sha256(bytes)}, not the pinned`);
    expect(refused.affected).toEqual([]);
  });

  it('the same sphere as a 20 MB OBJ with normals, groups and three reference forms', () => {
    const assets = memoryMeshAssets();
    const ctx: ExecutionContext = { ...defaultContext(), meshAssets: assets };
    const result = execute(createEmptyDocument(), 'import_mesh_file', { fileKey: assets.putFile(sphereObj()), units: 'in' }, ctx);
    expect(result.summary).toContain(`obj -> 1 mesh (mesh-1.1), ${triangleCount} triangles`);
    expect(digest(result)).toBe(PINNED.sphereObj);
  });
});

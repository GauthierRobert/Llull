/**
 * VC-IMP-31 / TR-IMP-12 (05 IMP M6): the implicit functions of `export_3mf implicit: 'levelset'` validate against the pinned 3MF Implicit extension
 * schema (docs/design/05-implicit-lattice/validation/data/3mf). Needs a JDK (`java`); skipped with a logged reason otherwise.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { base64ToUint8Array } from '@lib/base64';
import { unzip } from '../../tests/helpers/unzipStore';

const DATA = resolve(__dirname, '../../docs/design/05-implicit-lattice/validation/data/3mf');
const hasJava = spawnSync('java', ['-version']).status === 0;
if (!hasJava) console.warn('threeMfImplicit: java not found, schema validation skipped');
const withJava = hasJava ? it : it.skip;

function step(
  doc: CadDocument,
  name: string,
  params: Record<string, unknown>,
): { doc: CadDocument; id: string; data: Record<string, unknown> } {
  const result = execute(doc, name, params);
  if (result.error !== undefined) throw new Error(`${name}: ${result.summary}`);
  return { doc: result.document, id: result.affected[0] ?? '', data: (result.data ?? {}) as Record<string, unknown> };
}

describe('3MF implicit schema', () => {
  withJava(
    'every function of a blended, lattice, shell and chamfered body validates',
    () => {
      const a = step(createEmptyDocument(), 'add_field_primitive', { shape: 'sphere', radius: 4 });
      const b = step(a.doc, 'add_field_primitive', { shape: 'box', size: [5, 5, 5], position: [3, 0, 0], rounding: 0.5 });
      const quad = step(b.doc, 'combine_fields', { op: 'union', a: a.id, b: b.id, blend: { kind: 'quadratic', radius: 1.5 } });
      const exp = step(quad.doc, 'combine_fields', { op: 'subtract', a: quad.id, b: a.id, blend: { kind: 'exponential', radius: 1 } });
      const chamfer = step(exp.doc, 'combine_fields', { op: 'union', a: a.id, b: b.id, blend: { kind: 'chamfer', radius: 1 } });
      const gyroid = step(chamfer.doc, 'add_tpms_lattice', { kind: 'gyroid', form: 'sheet', thickness: 0.6, cellSize: 4, region: a.id });
      const solid = step(gyroid.doc, 'add_box', { size: [6, 6, 6] });
      const fromSolid = step(solid.doc, 'field_from_solid', { entityId: solid.id });
      const shell = step(fromSolid.doc, 'shell_field', { field: fromSolid.id, thickness: 1 });
      let doc = shell.doc;
      const bodies: string[] = [];
      for (const field of [quad.id, exp.id, chamfer.id, gyroid.id, shell.id]) {
        const made = step(doc, 'create_implicit_body', { field, voxel: 0.5 });
        doc = made.doc;
        bodies.push(made.id);
      }
      const exported = step(doc, 'export_3mf', { entityIds: bodies, implicit: 'levelset' });
      const model = new TextDecoder().decode(
        unzip(base64ToUint8Array(exported.data['base64'] as string) ?? new Uint8Array()).get('3D/3dmodel.model'),
      );
      const functions = [...model.matchAll(/<i:implicitfunction[\s\S]*?<\/i:implicitfunction>/g)].map((m) => m[0]);
      expect(functions).toHaveLength(5);
      const dir = mkdtempSync(join(tmpdir(), 'llull-3mf-'));
      try {
        const files = functions.map((fn, index) => {
          const file = join(dir, `fn${index}.xml`);
          const rooted = fn.replace(
            '<i:implicitfunction',
            '<i:implicitfunction xmlns:i="http://schemas.3mf.io/3dmanufacturing/implicit/2023/12" xmlns:v="http://schemas.3mf.io/3dmanufacturing/volumetric/2022/01"',
          );
          writeFileSync(file, rooted);
          return file;
        });
        const run = spawnSync('java', ['-Duser.language=en', join(DATA, 'Validate.java'), DATA, ...files], { encoding: 'utf8' });
        expect(run.stdout).not.toContain('INVALID');
        expect(run.stdout.match(/VALID/g)).toHaveLength(5);
        expect(run.status).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});

describe('3MF beam lattice schema', () => {
  withJava(
    'the beam-lattice objects of a strut lattice export validate against the pinned Beam Lattice schema, with and without a representation mesh',
    () => {
      const block = step(createEmptyDocument(), 'add_field_primitive', { shape: 'box', size: [10, 10, 10], position: [5, 5, 5] });
      const lattice = step(block.doc, 'add_strut_lattice', {
        cell: 'octet',
        cellSize: 5,
        radius: 0.3,
        origin: [0, 0, 0],
        region: block.id,
      });
      const body = step(lattice.doc, 'create_implicit_body', { field: lattice.id, voxel: 0.3 });
      const dir = mkdtempSync(join(tmpdir(), 'llull-3mf-bl-'));
      try {
        const files = [false, true].map((representation) => {
          const exported = step(body.doc, 'export_3mf', { entityIds: [body.id], beamLattice: true, beamRepresentation: representation });
          const model = new TextDecoder().decode(
            unzip(base64ToUint8Array(exported.data['base64'] as string) ?? new Uint8Array()).get('3D/3dmodel.model'),
          );
          const found = /<b:beamlattice[\s\S]*?<\/b:beamlattice>/.exec(model);
          expect(found, 'a b:beamlattice element').not.toBeNull();
          expect(model.includes('representationmesh=')).toBe(representation);
          const file = join(dir, `lattice-${representation ? 'with' : 'without'}.xml`);
          writeFileSync(
            file,
            (found?.[0] ?? '').replace(
              '<b:beamlattice',
              '<b:beamlattice xmlns:b="http://schemas.microsoft.com/3dmanufacturing/beamlattice/2017/02" xmlns:b2="http://schemas.microsoft.com/3dmanufacturing/beamlattice/balls/2020/07"',
            ),
          );
          return file;
        });
        const run = spawnSync('java', ['-Duser.language=en', '-Dschema=beamlattice.xsd', join(DATA, 'Validate.java'), DATA, ...files], {
          encoding: 'utf8',
        });
        expect(run.stdout).not.toContain('INVALID');
        expect(run.stdout.match(/VALID/g)).toHaveLength(2);
        expect(run.status).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});

/** Curved-face detection of the faceted FEA geometry path (Manifold tessellation): a box has none, curved solids have. */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { FeaHost } from '@protocol/index';
import { createEmptyDocument, type CadDocument, type Entity, type MeshData } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { GeometryKernel } from '@core/geometry/kernel';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { createFeArtifactStore } from '../src/fea/artifactStore';
import { caeHooks } from '../src/fea/caeHooks';
import { isCurvedPart } from '../src/fea/curvedFaces';
import { partGeometry } from '../src/fea/feaGeometry';
import { runFeaMesh } from '../src/fea/feaMesh';

let kernel: GeometryKernel;
beforeAll(async () => {
  kernel = await createManifoldKernel();
}, 60_000);

function curvedOf(command: string, params: Record<string, unknown>): boolean | string {
  const added = execute(createEmptyDocument(), command, params);
  const geometry = partGeometry(added.document, added.affected[0] ?? '', kernel);
  return 'code' in geometry ? geometry.code : geometry.kind === 'stl' ? geometry.curved : 'step';
}

describe('hasCurvedFaces through partGeometry', () => {
  it('a plain box is not curved (no faceted-geometry warning)', () => {
    expect(curvedOf('add_box', { size: [10, 20, 30] })).toBe(false);
  });
  it('a thin offset plate is not curved', () => {
    expect(curvedOf('add_box', { size: [100, 1, 100], position: [3, 4, 5] })).toBe(false);
  });
  it('a cylinder is curved', () => {
    expect(curvedOf('add_cylinder', { radius: 5, height: 20 })).toBe(true);
  });
  it('a sphere is curved', () => {
    expect(curvedOf('add_sphere', { radius: 5 })).toBe(true);
  });
});

const prismMesh = (sides: number): MeshData => {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < sides; i++) {
    const angle = (2 * Math.PI * i) / sides;
    positions.push(Math.cos(angle) * 5, Math.sin(angle) * 5, 0, Math.cos(angle) * 5, Math.sin(angle) * 5, 20);
  }
  positions.push(0, 0, 0, 0, 0, 20);
  const bottom = sides * 2;
  const top = bottom + 1;
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    indices.push(2 * i, 2 * j, 2 * i + 1, 2 * j, 2 * j + 1, 2 * i + 1, bottom, 2 * j, 2 * i, top, 2 * i + 1, 2 * j + 1);
  }
  return { positions, indices };
};
const entityOf = (command: string, params: Record<string, unknown>): Entity => {
  const added = execute(createEmptyDocument(), command, params);
  return added.document.entities[added.affected[0] ?? ''] as Entity;
};

describe('isCurvedPart: recipe signal first, dihedral heuristic as fallback', () => {
  const cylinder = entityOf('add_cylinder', { radius: 5, height: 20 });
  const box = entityOf('add_box', { size: [10, 10, 10] });
  it.each([8, 10, 12])('a %i-sided polygonal cylinder is curved because its recipe says cylinder', (sides) => {
    expect(isCurvedPart(cylinder, prismMesh(sides))).toBe(true);
  });
  it.each([6, 8, 10])('the same %i-sided prism as an untyped box/mesh stays ambiguous (not curved)', (sides) => {
    expect(isCurvedPart(box, prismMesh(sides))).toBe(false);
  });
  it('a fine 32-sided prism is curved by the dihedral fallback even without a recipe', () => {
    expect(isCurvedPart(box, prismMesh(32))).toBe(true);
  });
  it('an extruded 10-gon profile is an intended prism: not curved', () => {
    const ring = Array.from({ length: 10 }, (_, i) => [5 * Math.cos((2 * Math.PI * i) / 10), 5 * Math.sin((2 * Math.PI * i) / 10)]);
    const added = execute(createEmptyDocument(), 'extrude_profile', { profile: ring, depth: 20 });
    expect(curvedOf2(added.document, added.affected[0] ?? '')).toBe(false);
  });
});
function curvedOf2(doc: CadDocument, id: string): boolean | string {
  const geometry = partGeometry(doc, id, kernel);
  return 'code' in geometry ? geometry.code : geometry.kind === 'stl' ? geometry.curved : 'step';
}

describe('runFeaMesh faceted-geometry note', () => {
  const analysisFor = (command: string, params: Record<string, unknown>): { doc: CadDocument; analysisId: string } => {
    let doc = createEmptyDocument();
    const solid = execute(doc, command, params);
    doc = solid.document;
    const partId = solid.affected[0] ?? '';
    doc = execute(doc, 'create_material', { name: 'st', density: 0.0078 }).document;
    doc = execute(doc, 'assign_material', { materialName: 'st', entityIds: [partId] }).document;
    const created = execute(doc, 'create_analysis', { name: 'a', analysisType: 'static' });
    const analysisId = created.affected[0] ?? '';
    doc = execute(created.document, 'set_part_idealization', { analysisId, entityId: partId }).document;
    doc = execute(doc, 'add_fea_constraint', {
      analysisId,
      name: 'fix',
      kind: 'fixed',
      target: { entityId: partId, facesNear: [[0, 0, 0]] },
    }).document;
    return { doc, analysisId };
  };

  async function meshNote(command: string, params: Record<string, unknown>): Promise<{ summary: string; faceted: unknown }> {
    const { doc, analysisId } = analysisFor(command, params);
    const store = createFeArtifactStore(mkdtempSync(path.join(tmpdir(), 'llull-faceted-')));
    const host: FeaHost = { getDoc: () => doc, applyCommand: () => ({ summary: 'recorded.', affected: [analysisId], isError: false }) };
    const result = await runFeaMesh(analysisId, host, {
      bridge: () => Promise.resolve({ ok: true, nodes: [[1, 0, 0, 0]], blocks: [], nodeSets: {}, faceSets: {}, targets: {} }),
      store,
      hooks: caeHooks,
      kernel: () => kernel,
    });
    return { summary: result.summary, faceted: (result.data as { facetedParts: unknown }).facetedParts };
  }

  it('a plain box meshed from a tessellation gets no warning and no faceted part', async () => {
    const { summary, faceted } = await meshNote('add_box', { size: [10, 10, 10] });
    expect(faceted).toEqual([]);
    expect(summary).not.toContain('WARNING');
  });

  it('a cylinder warns that curved faces are polygons with errors of either sign, and names the part', async () => {
    const { summary, faceted } = await meshNote('add_cylinder', { radius: 5, height: 20 });
    expect(faceted).toHaveLength(1);
    expect(summary).toContain(`WARNING: ${String((faceted as string[])[0])} meshed from a faceted tessellation`);
    expect(summary).toContain('off by several % (either sign)');
    expect(summary).not.toContain('read high');
  });
});
